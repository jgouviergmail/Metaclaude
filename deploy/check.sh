#!/usr/bin/env bash
#
# Check the deployment layer, without a server.
#
#     ./deploy/check.sh
#
# The scripts in this directory are the only code in the repository that can
# lock the owner out of their own machine, and until now nothing verified them.
# They are also the hardest to test, because what they do is provision a host —
# so this checks the parts that can be checked off-box: that they parse, that
# the linter is happy, that compose accepts the file under every TLS mode, that
# a secret containing awkward characters survives the trip into .env and back
# out of it on a re-run, and that the SSH forced command refuses everything it
# is supposed to refuse.
#
# That last section actually *runs* bin/metaclaude-deploy. Every case it drives
# exits before the script reaches docker, so it needs no daemon and no network —
# and it is the difference between reading a grammar and agreeing it looks
# strict, and watching it say no.
#
# What it deliberately does not check: anything requiring root, a firewall, or
# a real host. That is deploy/verify.sh, run from a laptop against the server.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; DIM=""; OFF=""
fi

PASSED=0; FAILED=0; SKIPPED=0
ok()      { PASSED=$((PASSED+1)); printf '  %sok%s   %s\n' "$GREEN" "$OFF" "$1"; }
bad()     { FAILED=$((FAILED+1)); printf '  %sFAIL%s %s%s\n' "$RED" "$OFF" "$1" "${2:+ — $2}"; }
skip()    { SKIPPED=$((SKIPPED+1)); printf '  %sskip%s %s — %s\n' "$DIM" "$OFF" "$1" "$2"; }
section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

# Derived, not listed. The hand-written list had already quietly lost
# dns-setup.sh, and uninstall.sh would have arrived unchecked the same way —
# the exact drift the TLS-mode loop below was cured of.
SCRIPTS=()
while IFS= read -r script; do
  SCRIPTS+=("$script")
done < <(find "$REPO_ROOT/deploy" -maxdepth 2 -type f \( -name '*.sh' -o -path '*/bin/*' \) | sort)
[ "${#SCRIPTS[@]}" -ge 6 ] || { echo "FATAL: found only ${#SCRIPTS[@]} deploy scripts — the glob broke"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ─────────────────────────────────────────────────────────────────────────────
section "Syntax"
# ─────────────────────────────────────────────────────────────────────────────

for script in "${SCRIPTS[@]}"; do
  name="${script#"$REPO_ROOT"/}"
  if [ ! -f "$script" ]; then bad "$name" "missing"; continue; fi
  if bash -n "$script" 2>/dev/null; then ok "$name parses"; else bad "$name" "$(bash -n "$script" 2>&1 | head -1)"; fi
  [ -x "$script" ] || bad "$name" "not executable"
done

# ─────────────────────────────────────────────────────────────────────────────
section "Shellcheck"
# ─────────────────────────────────────────────────────────────────────────────

# `warning` rather than the default: the style and info notes here are about
# backticks inside comments and `ls` in a progress line, and failing a release
# on those would teach everyone to stop reading the output.
if command -v shellcheck >/dev/null 2>&1; then
  for script in "${SCRIPTS[@]}"; do
    name="${script#"$REPO_ROOT"/}"
    [ -f "$script" ] || continue
    if out="$(shellcheck -x --severity=warning "$script" 2>&1)"; then
      ok "$name"
    else
      bad "$name"
      printf '%s\n' "$out" | sed 's/^/       /'
    fi
  done
else
  skip "shellcheck" "not installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Heredocs do not execute their own prose"
# ─────────────────────────────────────────────────────────────────────────────

# `cat > file <<EOF` — delimiter unquoted — expands its body, and a backtick in
# a *comment* inside that body is a command substitution. provision.sh wrote
# "there is no `Port` here" into an sshd config and the shell dutifully ran
# `Port`, which is how a paragraph explaining a lockout became the thing that
# stopped provisioning. Shellcheck does not look inside heredoc bodies.
#
# Only bare backticks count: an escaped one is already text.
if out="$(python3 "$REPO_ROOT/deploy/.heredoc-check.py" "${SCRIPTS[@]}" 2>&1)"; then
  ok "no bare backtick inside an unquoted heredoc"
else
  bad "prose inside a heredoc will be executed by the shell"
  printf '%s\n' "$out" | sed 's/^/     /'
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Compose, under every TLS mode"
# ─────────────────────────────────────────────────────────────────────────────

if docker compose version >/dev/null 2>&1; then
  # Derived from the directory rather than listed here. compose will mount any
  # `docker/tls/<name>.caddy` an operator names in METACLAUDE_TLS_MODE, so a
  # hand-maintained list means a new mode ships unvalidated — which is the state
  # `acme-dns-staging` would have arrived in.
  modes="$(cd "$REPO_ROOT/docker/tls" && ls -1 ./*.caddy 2>/dev/null | sed 's|^\./||; s|\.caddy$||')"
  [ -n "$modes" ] || bad "enumerating the TLS modes" "docker/tls holds no .caddy snippet"
  for mode in $modes; do
    snippet="$REPO_ROOT/docker/tls/$mode.caddy"
    if [ ! -f "$snippet" ]; then
      bad "TLS mode $mode" "docker/tls/$mode.caddy does not exist, but compose can be pointed at it"
      continue
    fi
    if out="$(METACLAUDE_TLS_MODE="$mode" docker compose -f "$REPO_ROOT/compose.yml" --env-file /dev/null config 2>&1)"; then
      # The mount is what makes the mode real; a mode that resolves to the
      # wrong snippet would still validate.
      if printf '%s' "$out" | grep -q "docker/tls/$mode.caddy"; then
        ok "TLS mode $mode"
        # Not about this mode, but this is the loop that already has compose
        # resolved. A client reaching the server by address sends no SNI (RFC
        # 6066 forbids IP literals there), and Caddy then picks a certificate by
        # the connection's local address — the container's, behind published
        # ports, which nothing certifies. Without default_sni the handshake dies
        # before any log line and only SNI-sending clients get through.
        if [ "$mode" = "internal" ] && ! grep -q '^\s*default_sni ' "$REPO_ROOT/docker/Caddyfile"; then
          bad "docker/Caddyfile sets no default_sni" "a browser reaching this server by IP gets a TLS alert"
        fi
      else
        bad "TLS mode $mode" "compose is valid but does not mount $mode.caddy"
      fi
    else
      bad "TLS mode $mode" "$(printf '%s' "$out" | head -1)"
    fi
  done
else
  skip "compose validation" "docker compose not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Secrets survive the trip into .env"
# ─────────────────────────────────────────────────────────────────────────────

# The regression this exists for: compose interpolates .env values, so a token
# or password containing `$` was expanded against the environment before the
# container ever saw it, and one starting with a quote was read as an
# unterminated quoted value and took the whole file down. Both failed silently.
#
# The functions come out of bootstrap.sh rather than being restated here, so
# this tests the code that ships.
if docker compose version >/dev/null 2>&1; then
  sed -n '/^env_quote() {/,/^}/p; /^set_env() {/,/^}/p' "$REPO_ROOT/deploy/bootstrap.sh" > "$WORK/funcs.sh"
  if [ "$(grep -c '^}' "$WORK/funcs.sh")" -ne 2 ]; then
    bad "extracting env_quote/set_env from bootstrap.sh" "the definitions moved; this check needs updating"
  elif ! grep -q 'set_env METACLAUDE_IMAGE' "$REPO_ROOT/deploy/bootstrap.sh"; then
    # compose defaults to `metaclaude:latest`, which exists nowhere. Left unset,
    # bootstrap provisions the host, arms the firewall, and only then fails at
    # `up` with `pull access denied`.
    bad "bootstrap.sh never sets METACLAUDE_IMAGE" "the stack would start with an image that does not exist"
  else
    cat > "$WORK/drive.sh" <<'DRIVE'
set -euo pipefail
ENV_FILE="$1"; source "$2"
: > "$ENV_FILE"
set_env V_PLAIN      'sk-ant-oat01-AbCd1234'
set_env V_DOLLAR     'tok-$HOME-$PATH-${x}-end'
set_env V_SQUOTE     "'starts-with-quote"
set_env V_DQUOTE     '"starts-with-dquote'
set_env V_MIXED      "pa'ss\"wo'rd"
set_env V_BACKSL     'pass\word\'
set_env V_HASH       'pass #word #2'
set_env V_SPACES     '  pad ded  '
set_env V_BACKTICK   'pass`id`word'
set_env V_EMPTY      ''
# and the rewrite path, which takes a different branch to the append above
set_env V_PLAIN      'rewritten-$HOME-"x"-\y'
DRIVE
    cat > "$WORK/expect.py" <<'PY'
import json, sys
want = {
  "V_DOLLAR":   "tok-$HOME-$PATH-${x}-end",
  "V_SQUOTE":   "'starts-with-quote",
  "V_DQUOTE":   '"starts-with-dquote',
  "V_MIXED":    "pa'ss\"wo'rd",
  "V_BACKSL":   "pass\\word\\",
  "V_HASH":     "pass #word #2",
  "V_SPACES":   "  pad ded  ",
  "V_BACKTICK": "pass`id`word",
  "V_EMPTY":    "",
  "V_PLAIN":    'rewritten-$HOME-"x"-\\y',
}
try:
    got = json.load(sys.stdin)["services"]["probe"]["environment"]
except Exception:
    print("       compose rejected the file outright"); sys.exit(1)
bad = 0
for k, v in want.items():
    # `config` doubles every $ on the way out so its output round-trips as a
    # compose file; undo that to compare against the value itself.
    actual = got.get(k, "<missing>").replace("$$", "$")
    if actual != v:
        bad += 1
        print("       %-10s want=%r got=%r" % (k, v, actual))
sys.exit(1 if bad else 0)
PY
    printf 'services:\n  probe:\n    image: busybox\n    environment:\n' > "$WORK/compose.yml"
    while IFS= read -r key; do
      printf '      %s: ${%s:-}\n' "$key" "$key" >> "$WORK/compose.yml"
    done < <(grep -oE '^set_env [A-Z_]+' "$WORK/drive.sh" | awk '{print $2}' | sort -u)

    if bash "$WORK/drive.sh" "$WORK/.env" "$WORK/funcs.sh" 2>/dev/null; then
      if (cd "$WORK" && docker compose config --format json 2>/dev/null) | python3 "$WORK/expect.py"; then
        ok "10 awkward secrets round-trip intact through set_env"
      else
        bad "a secret was mangled between set_env and the container"
      fi
    else
      bad "set_env could not write .env"
    fi
  fi
else
  skip "secret round-trip" "needs docker compose to resolve the .env"
fi

# Re-running bootstrap.sh is the normal way to finish a deploy that stopped
# halfway. It must therefore never be the way to destroy one: a freshly minted
# METACLAUDE_MASTER_KEY written over the old one orphans every stored MCP
# credential, and nothing fails — the server starts and reports healthy.
#
# Driven rather than grepped, using the line bootstrap.sh actually ships, so
# this fails if the extraction stops recognising what set_env writes.
printf 'ENV_FILE="$1"\n' > "$WORK/mk.sh"
sed -n '/^MASTER_KEY="\$(sed -n/,/head -1)"$/p' "$REPO_ROOT/deploy/bootstrap.sh" >> "$WORK/mk.sh"
printf 'printf %%s "$MASTER_KEY"\n' >> "$WORK/mk.sh"
if ! grep -q '^MASTER_KEY=' "$WORK/mk.sh"; then
  bad "extracting the master-key reader from bootstrap.sh" "the line moved; this check needs updating"
else
  KEY_A="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  reuse_fail=""
  # An existing key is found whether set_env quoted it or a human did not.
  for form in "METACLAUDE_MASTER_KEY=\"$KEY_A\"" "METACLAUDE_MASTER_KEY=$KEY_A"; do
    printf '%s\n' "$form" > "$WORK/mk.env"
    got="$(bash "$WORK/mk.sh" "$WORK/mk.env")"
    [ "$got" = "$KEY_A" ] || reuse_fail="$reuse_fail [kept:$form]"
  done
  # An absent, empty or malformed one is not mistaken for a key to keep.
  for form in "METACLAUDE_MASTER_KEY=" "METACLAUDE_MASTER_KEY=\"\"" "METACLAUDE_MASTER_KEY=\"nope\"" ""; do
    printf '%s\n' "$form" > "$WORK/mk.env"
    got="$(bash "$WORK/mk.sh" "$WORK/mk.env")"
    [ -z "$got" ] || reuse_fail="$reuse_fail [invented:$form]"
  done
  if [ -z "$reuse_fail" ]; then
    ok "re-running bootstrap keeps the existing METACLAUDE_MASTER_KEY"
  else
    bad "the master key is not preserved across a re-run:$reuse_fail" \
        "every stored MCP credential would decrypt to nothing, silently"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Pinned upstream versions exist"
# ─────────────────────────────────────────────────────────────────────────────

# `node:22.20.1-bookworm-slim` sat in the Dockerfile for real, and was never a
# published tag — every build of the image failed at the first FROM. Nothing
# caught it because the image job had never run. The Caddy pin in compose.yml is
# the same hazard with a worse ending: it fails on the server, at `up`, with the
# proxy that terminates TLS never starting.
#
# Asked over the registry APIs rather than by pulling: no layers, no daemon, no
# credentials, and it works from a laptop.
hub_tag() {
  local repo="$1" tag="$2" body
  body="$(curl -sS --max-time 20 "https://hub.docker.com/v2/repositories/library/${repo}/tags/${tag}" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    skip "$repo:$tag" "could not reach Docker Hub"
  elif printf '%s' "$body" | grep -q '"name"'; then
    ok "$repo:$tag"
  else
    bad "$repo:$tag is not a published tag" "a build or a deploy will fail on this pin"
  fi
}

# Official images pinned in compose.yml. `${VAR:-...}` references start with a
# dollar and are skipped by the pattern, which is what we want — those are ours.
while IFS= read -r ref; do
  hub_tag "${ref%%:*}" "${ref#*:}"
done < <(grep -oE '^[[:space:]]*image:[[:space:]]+[a-z0-9]+:[A-Za-z0-9._-]+' "$REPO_ROOT/compose.yml" | awk '{print $2}')

# The Dockerfile's base image, with the variant taken from the FROM line rather
# than assumed, so this stays right if bookworm-slim ever changes.
NODE_PIN="$(grep -oE '^ARG NODE_VERSION=[A-Za-z0-9._-]+' "$REPO_ROOT/docker/Dockerfile" | head -1 | cut -d= -f2)"
NODE_FROM="$(grep -oE '^FROM node:\$\{NODE_VERSION\}[A-Za-z0-9._-]*' "$REPO_ROOT/docker/Dockerfile" | head -1)"
if [ -n "$NODE_PIN" ] && [ -n "$NODE_FROM" ]; then
  hub_tag node "${NODE_PIN}${NODE_FROM#FROM node:\$\{NODE_VERSION\}}"
else
  bad "reading the Node pin out of docker/Dockerfile" "the ARG or the FROM line moved"
fi

# The Claude CLI, which the runtime stage installs globally — the Agent SDK
# spawns it as a subprocess, so a bad version here is an image that builds
# nothing and an agent that cannot run.
CLI_PIN="$(grep -oE '^ARG CLAUDE_CLI_VERSION=[A-Za-z0-9._-]+' "$REPO_ROOT/docker/Dockerfile" | head -1 | cut -d= -f2)"
if [ -z "$CLI_PIN" ]; then
  bad "reading CLAUDE_CLI_VERSION out of docker/Dockerfile" "the ARG moved"
else
  cli_body="$(curl -sS --max-time 20 "https://registry.npmjs.org/@anthropic-ai/claude-code/${CLI_PIN}" 2>/dev/null || true)"
  if [ -z "$cli_body" ]; then
    skip "@anthropic-ai/claude-code@$CLI_PIN" "could not reach the npm registry"
  elif printf '%s' "$cli_body" | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"${CLI_PIN}\""; then
    ok "@anthropic-ai/claude-code@$CLI_PIN"
  else
    bad "@anthropic-ai/claude-code@$CLI_PIN is not published" "the runtime stage will fail"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The defaults start on the smallest plausible host"
# ─────────────────────────────────────────────────────────────────────────────

# Docker does not clamp a cpus limit to what the host has — it refuses to create
# the container at all. A default of 4 therefore made the stack unstartable on
# any 2-vCPU VPS, which is the size most people buy, and the failure arrives at
# `up` on the server rather than anywhere earlier.
CPU_DEFAULT="$(grep -oE "cpus: '\\\$\\{METACLAUDE_CPU_LIMIT:-[0-9.]+\\}'" "$REPO_ROOT/compose.yml" \
               | grep -oE ':-[0-9.]+' | tr -d ':-')"
if [ -z "$CPU_DEFAULT" ]; then
  bad "reading the default cpus limit out of compose.yml" "the line moved; this check needs updating"
elif awk -v v="$CPU_DEFAULT" 'BEGIN { exit !(v <= 2) }'; then
  ok "default cpus limit is $CPU_DEFAULT — starts on a 2-vCPU host"
else
  bad "default cpus limit is $CPU_DEFAULT" "Docker refuses to create the container on a host with fewer cores"
fi

# `metaclaude-deploy` gates a release on `compose up --wait`, which is only as
# strong as the healthchecks it waits for: a service without one is "healthy" as
# soon as its container is running. The proxy had none, so `--wait` returned
# before Caddy had a certificate and the release probe failed against a perfectly
# good deployment.
if docker compose version >/dev/null 2>&1; then
  missing_hc=""
  for service in $(METACLAUDE_TLS_MODE=internal docker compose -f "$REPO_ROOT/compose.yml" --env-file /dev/null config --services 2>/dev/null); do
    METACLAUDE_TLS_MODE=internal docker compose -f "$REPO_ROOT/compose.yml" --env-file /dev/null config 2>/dev/null \
      | python3 -c "
import sys, yaml
svc = yaml.safe_load(sys.stdin)['services']['$service']
sys.exit(0 if svc.get('healthcheck', {}).get('test') else 1)
" || missing_hc="$missing_hc $service"
  done
  if [ -z "$missing_hc" ]; then
    ok "every service declares a healthcheck, so \`up --wait\` means something"
  else
    bad "services with no healthcheck:$missing_hc" "\`up --wait\` returns as soon as they are merely running"
  fi
else
  skip "healthcheck coverage" "docker compose not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section ".env.example stays in step with compose.yml"
# ─────────────────────────────────────────────────────────────────────────────

# install-app.sh warns when a deployed .env is missing a key the example has
# grown. That only helps if the example itself is complete.
missing=""
while IFS= read -r key; do
  grep -qE "^${key}=" "$REPO_ROOT/.env.example" || missing="$missing $key"
done < <(grep -oE '\$\{METACLAUDE_[A-Z0-9_]+' "$REPO_ROOT/compose.yml" | sed 's/^\${//' | sort -u)

if [ -z "$missing" ]; then
  ok "every METACLAUDE_* setting compose reads is documented in .env.example"
else
  bad "settings compose reads but .env.example never mentions:$missing"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Quality ratchets"
# ─────────────────────────────────────────────────────────────────────────────

# Tests prove the code works today. A ratchet is what stops tomorrow quietly
# costing what today bought: a suite that shrinks, a bundle that creeps back,
# a raw palette class that reappears and breaks the light theme for one
# component. Every number here may only move in the improving direction.
if command -v node >/dev/null 2>&1; then
  if out="$(node "$REPO_ROOT/deploy/ratchets.mjs" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^  /     /'
    ok "no ratchet regressed"
  else
    bad "a quality ratchet regressed"
    printf '%s\n' "$out" | sed 's/^/     /'
  fi
else
  skip "quality ratchets" "node is not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Two site blocks never claim the same address"
# ─────────────────────────────────────────────────────────────────────────────

# Caddy refuses an entire Caddyfile that defines one address twice —
# "ambiguous site definition" — so a collision between the two site blocks'
# *defaults* is not a warning, it is a stack that does not start on a stock
# .env. Caught exactly once, by adapting the file with everything unset.
#
# Static rather than adapting, because CI has no caddy binary. The property is
# simple enough to assert directly: whatever the defaults are, they must differ.
site_default() {
  grep -oE "^\{\\\$${1}:[^}]+\} \{" "$REPO_ROOT/docker/Caddyfile" | head -1 | sed "s/^{\\\$${1}://; s/} {$//"
}
PRIMARY="$(site_default METACLAUDE_SITE)"
ALTERNATE="$(site_default METACLAUDE_ALT_SITE)"
if [ -z "$PRIMARY" ] || [ -z "$ALTERNATE" ]; then
  bad "reading the site block defaults out of docker/Caddyfile" "the blocks moved; this check needs updating"
elif [ "$PRIMARY" = "$ALTERNATE" ]; then
  bad "both site blocks default to '$PRIMARY'" \
      "Caddy refuses the whole file with 'ambiguous site definition' — nothing starts"
else
  ok "site defaults differ: '$PRIMARY' and '$ALTERNATE'"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The smoke test deploys something a server would recognise"
# ─────────────────────────────────────────────────────────────────────────────

# The proxy healthcheck dials https://127.0.0.1/ and busybox wget puts that
# literal into SNI. With the smoke job's site *also* named 127.0.0.1 the two
# matched by coincidence, so every run was green while a real deployment — where
# the site is an address or a name of its own — could not complete a single
# handshake and never went healthy.
#
# The guard is the inequality itself: the moment the smoke site equals the probe
# address, the job stops testing the thing it exists to test.
SMOKE_SITE="$(grep -oE "^[[:space:]]*echo 'METACLAUDE_SITE=[^']+'" "$REPO_ROOT/.github/workflows/ci.yml" \
              | head -1 | sed "s/.*METACLAUDE_SITE=//; s/'$//")"
if [ -z "$SMOKE_SITE" ]; then
  bad "reading METACLAUDE_SITE out of the smoke job" "the line moved; this check needs updating"
elif [ "$SMOKE_SITE" = "127.0.0.1" ] || [ "$SMOKE_SITE" = "localhost" ]; then
  bad "the smoke job names the site '$SMOKE_SITE'" \
      "that is the address its own healthcheck probes, so an SNI mismatch cannot be caught"
elif ! grep -q 'fallback_sni' "$REPO_ROOT/docker/Caddyfile"; then
  bad "docker/Caddyfile sets no fallback_sni" \
      "a client naming an unmatched SNI gets alert 80 — the healthcheck is such a client"
else
  ok "smoke site '$SMOKE_SITE' differs from the probe address, and fallback_sni covers the gap"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Every variable the Caddyfile reads actually reaches the proxy"
# ─────────────────────────────────────────────────────────────────────────────

# The check above asserted that `fallback_sni` exists. It did — and it was
# inert, because `METACLAUDE_SNI_DEFAULT` was never forwarded to the container.
# Caddy reads `{$VAR}` from its own *process* environment; compose reads .env
# for `${VAR}` interpolation of the compose file itself, which is a different
# thing entirely. A variable documented in .env.example, written into .env by
# bootstrap.sh, and named in the Caddyfile can still be, from Caddy's point of
# view, unset — and it then silently takes the Caddyfile's own default.
#
# That cost a red CI and a proxy that never went healthy: the site was named,
# the certificate was obtained, and every handshake died before a log line
# because `fallback_sni` had quietly resolved to `localhost`.
#
# So the assertion is the general one rather than the two names that bit:
# whatever the Caddyfile and the TLS snippets read, the proxy's environment
# block must forward. A new `{$METACLAUDE_...}` fails here the day it is added.
CADDY_FILES=("$REPO_ROOT/docker/Caddyfile" "$REPO_ROOT"/docker/tls/*.caddy)
caddy_vars="$(grep -ohE '\{\$METACLAUDE_[A-Z0-9_]+' "${CADDY_FILES[@]}" 2>/dev/null \
              | sed 's/^{\$//' | sort -u)"
if [ -z "$caddy_vars" ]; then
  bad "reading {\$METACLAUDE_*} out of docker/Caddyfile" "the syntax changed; this check needs updating"
elif ! docker compose version >/dev/null 2>&1; then
  skip "proxy environment forwarding" "docker compose not available"
else
  # The resolved config, so a variable forwarded through an anchor or an
  # extension still counts. --env-file /dev/null keeps a developer's own .env
  # out of it; every value then falls back to the compose file's default.
  proxy_env="$(METACLAUDE_TLS_MODE=internal docker compose -f "$REPO_ROOT/compose.yml" \
                 --env-file /dev/null config --format json 2>/dev/null \
               | python3 -c 'import json,sys; print("\n".join((json.load(sys.stdin)["services"]["proxy"].get("environment") or {}).keys()))' 2>/dev/null)"
  if [ -z "$proxy_env" ]; then
    bad "resolving the proxy environment block" "docker compose config produced nothing"
  else
    missing=""
    for var in $caddy_vars; do
      printf '%s\n' "$proxy_env" | grep -qx "$var" || missing="$missing $var"
    done
    if [ -n "$missing" ]; then
      bad "the proxy never receives:$missing" \
          "Caddy falls back to the {\$VAR:default} written in the Caddyfile, silently"
    else
      ok "all $(printf '%s\n' "$caddy_vars" | wc -l | tr -d ' ') Caddyfile variables are forwarded to the proxy"
    fi
  fi
fi

# The forwarded value has to name a certificate that exists, too. `default_sni`
# and `fallback_sni` select among the *configured* sites; naming one that no
# site block declares is the same alert-80 failure with a different cause.
SNI_DEFAULT_FALLBACK="$(grep -oE '^\s*default_sni \{\$METACLAUDE_SNI_DEFAULT:[^}]+\}' "$REPO_ROOT/docker/Caddyfile" \
                        | head -1 | sed 's/.*METACLAUDE_SNI_DEFAULT://; s/}$//')"
if [ -z "$SNI_DEFAULT_FALLBACK" ]; then
  bad "reading the default_sni fallback out of docker/Caddyfile" "the line moved; this check needs updating"
elif [ "$SNI_DEFAULT_FALLBACK" = "$PRIMARY" ] || [ "$SNI_DEFAULT_FALLBACK" = "$ALTERNATE" ]; then
  ok "the SNI default falls back to '$SNI_DEFAULT_FALLBACK', which a site block declares"
else
  bad "the SNI default falls back to '$SNI_DEFAULT_FALLBACK'" \
      "no site block serves that name, so there is no certificate to fall back to"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "A deploy never stops to ask for a credential"
# ─────────────────────────────────────────────────────────────────────────────

# bootstrap.sh used to prompt for a GitHub token when the GHCR package turned
# out to be private — halfway through, after provisioning, on a machine that was
# already holding the source the image would be built from. It stopped real
# deploys dead, repeatedly, for nothing: the fallback is the same code.
#
# The registry is allowed to be an optimisation. It is not allowed to be a
# gate, so no registry credential may reappear here.
#
# Narrow on purpose. bootstrap.sh does prompt for CLAUDE_CODE_OAUTH_TOKEN, and
# that is a different thing entirely: it is what the product needs to work at
# all, it is asked for once, and no fallback can invent it. What is banned is
# specifically a *registry* credential, which only ever buys a download.
#
# `docker login` is matched only where a command could start — at the beginning
# of a line or after a pipe or a semicolon — so the sentence that tells an
# operator they may run it themselves is not mistaken for the script doing it.
offenders=""
if grep -qE 'read [^#]*(GH_TOKEN|GITHUB_TOKEN|GHCR_TOKEN|REGISTRY_TOKEN)' \
     "$REPO_ROOT/deploy/bootstrap.sh"; then
  offenders="$offenders a-prompt-for-a-registry-token"
fi
if grep -qE '(^[[:space:]]*|[|;&][[:space:]]*)docker login' "$REPO_ROOT/deploy/bootstrap.sh"; then
  offenders="$offenders docker-login"
fi

if [ -n "$offenders" ]; then
  bad "bootstrap.sh can block on a credential:$offenders" \
      "a deploy must never need one — it can build the image from the checkout"
elif ! grep -q '^build_locally() {' "$REPO_ROOT/deploy/bootstrap.sh"; then
  bad "bootstrap.sh has no build_locally fallback" "a failed pull would leave it with no image"
elif ! grep -q -- '--build)' "$REPO_ROOT/deploy/bootstrap.sh"; then
  bad "bootstrap.sh has no --build flag" "there would be no way to deploy an uncommitted change"
else
  ok "bootstrap.sh falls back to building locally and never prompts for a token"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The forced command refuses what it should"
# ─────────────────────────────────────────────────────────────────────────────

# Everything above this line reads the scripts. This *runs* one of them.
#
# `bin/metaclaude-deploy` is the whole of the server's attack surface for a
# stolen CI key: it is an SSH forced command on an account in the docker group,
# so anything it agrees to run, it runs as root. Reading it and agreeing that
# the grammar looks strict is not the same as watching it say no.
#
# Only refusals are exercised. Every one of them exits before the script reaches
# `docker`, so this needs no daemon, no image and no network — and a request it
# wrongly accepts is caught by the absence of "refusing", not by waiting to see
# what a pull does.

DEPLOY_CMD="$REPO_ROOT/deploy/bin/metaclaude-deploy"
FAKE_APP="$WORK/app"
# `releases/` is what install-app.sh creates on a real host; the lock lives in
# it and is taken before the request is validated.
mkdir -p "$FAKE_APP/releases"

# Judged against a documentation-only namespace, never a real one.
TEST_PREFIX="ghcr.io/example/metaclaude"

# Run the forced command with $1 as the request; echo whatever it said.
try_request() {
  METACLAUDE_APP_DIR="$FAKE_APP" \
  ALLOWED_IMAGE_PREFIX="$TEST_PREFIX" \
  SSH_ORIGINAL_COMMAND="$1" \
    timeout 20 "$DEPLOY_CMD" 2>&1 || true
}

# `what` is the human name; `request` is fed in verbatim.
refuses() {
  local what="$1" request="$2" output
  output="$(try_request "$request")"
  case "$output" in
    *refusing*|*"no command"*) ok "refuses $what" ;;
    *) bad "accepts $what" "$(printf '%s' "$output" | head -1)" ;;
  esac
}

# The other half, and it is not optional: a rule that refuses everything passes
# every test above. These two must get *past* the allow-list — far enough to log
# "deploying" — and then fail on the pull, which is where a host with no such
# image is supposed to fail.
accepts() {
  local what="$1" request="$2" output
  output="$(try_request "$request")"
  case "$output" in
    *deploying*) ok "still accepts $what" ;;
    *) bad "no longer accepts $what" "$(printf '%s' "$output" | head -1)" ;;
  esac
}

if [ ! -x "$DEPLOY_CMD" ]; then
  skip "forced-command refusals" "deploy/bin/metaclaude-deploy is missing"
else
  refuses "an empty request"              ""
  refuses "an unknown verb"               "destroy"
  refuses "deploy with no image"          "deploy"
  refuses "a trailing shell command"      "deploy $TEST_PREFIX:latest; id"
  refuses "a pipeline"                    "deploy $TEST_PREFIX:latest | sh"
  refuses "command substitution"          "deploy \$(id)"
  refuses "a second line"                 "$(printf 'status\nrollback')"
  # `[[:space:]]` matched a newline too, so `deploy\n<image>` used to be a
  # legal request. Never exploitable — the image still faced the allow-list —
  # but the grammar now means what its comment says.
  refuses "a newline where the space should be" "$(printf 'deploy\n%s:latest' "$TEST_PREFIX")"
  refuses "a tab where the space should be"     "$(printf 'deploy\t%s:latest' "$TEST_PREFIX")"
  refuses "arguments after a bare verb"   "status --now"
  refuses "a leading flag as an image"    "deploy --privileged"
  refuses "another owner's image"         "deploy ghcr.io/someone-else/metaclaude:latest"
  refuses "a path traversal"              "deploy ../../etc/passwd"
  refuses "an image with no tag"          "deploy $TEST_PREFIX"

  # The one that matters most, and the reason this section exists. A bare
  # prefix match accepts a *different repository* whose name merely starts with
  # the allowed one — and on this host that is a root shell for whoever holds
  # the deploy key. The separator has to be part of what is matched.
  refuses "a repository that only shares the prefix" "deploy ${TEST_PREFIX}-evil:latest"
  refuses "a prefix-sharing repo by digest" \
    "deploy ${TEST_PREFIX}x@sha256:$(printf '0%.0s' $(seq 64))"

  # A half-finished install is a real state: provisioning can die between
  # creating the app directory and creating releases/. What the operator gets
  # then should name the command that fixes it, not a redirection error about a
  # lock file they have never heard of.
  bare="$WORK/bare-app"
  mkdir -p "$bare"
  half="$(METACLAUDE_APP_DIR="$bare" ALLOWED_IMAGE_PREFIX="$TEST_PREFIX" \
          SSH_ORIGINAL_COMMAND="status" timeout 20 "$DEPLOY_CMD" 2>&1 || true)"
  case "$half" in
    *install-app.sh*) ok "a half-installed host is told how to finish" ;;
    *) bad "a half-installed host gets a confusing error" "$(printf '%s' "$half" | head -1)" ;;
  esac

  accepts "the allowed repository by tag" "deploy $TEST_PREFIX:sha-abc123"
  accepts "the allowed repository by digest" \
    "deploy $TEST_PREFIX@sha256:$(printf 'a%.0s' $(seq 64))"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "A re-run reads back exactly what it wrote"
# ─────────────────────────────────────────────────────────────────────────────

# The section above proves a secret reaches the *container* intact. This proves
# it reaches the *next run of this script* intact, which is a different path and
# was untested.
#
# Re-running bootstrap.sh is the documented way to finish a deploy that stopped
# halfway, and it recovers the token, the owner name and the password from .env
# with get_env so the operator does not have to retype a hundred-character
# secret on a console. get_env has to undo env_quote exactly — dollars, then
# quotes, then backslashes, and in that order. Get the order wrong and a token
# containing two of them comes back subtly altered: the deploy still succeeds,
# the container still starts, and every agent run fails to authenticate with
# nothing anywhere saying why.

if ! sed -n '/^env_quote() {/,/^}/p; /^set_env() {/,/^}/p; /^get_env() {/,/^}/p' \
     "$REPO_ROOT/deploy/bootstrap.sh" > "$WORK/roundtrip.sh"; then
  bad "extracting the .env helpers from bootstrap.sh" "could not read the script"
elif [ "$(grep -c '^}' "$WORK/roundtrip.sh")" -ne 3 ]; then
  bad "extracting env_quote/set_env/get_env" "the definitions moved; this check needs updating"
else
  (
    # shellcheck source=/dev/null
    . "$WORK/roundtrip.sh"
    ENV_FILE="$WORK/roundtrip.env"
    : > "$ENV_FILE"

    # Every one of these has broken a naive quoter at some point.
    mangled=""
    n=0
    while IFS= read -r secret; do
      n=$((n+1))
      set_env "V_$n" "$secret"
      got="$(get_env "V_$n")"
      [ "$got" = "$secret" ] || mangled="$mangled V_$n"
    done <<'SECRETS'
sk-ant-oat01-plain
with spaces and	a tab
double"quote
single'quote
back\slash
dollar$VAR and ${BRACED}
both\"backslash-and-quote
$dollar-then\backslash"and-quote
#hash-leading
trailing-space 
=equals=in=value=
`backtick` $(command) ${sub}
newline-safe--but-no-actual-newline
100%percent
a-very-long-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SECRETS

    if [ -n "$mangled" ]; then
      printf 'MANGLED:%s\n' "$mangled" > "$WORK/roundtrip.result"
    else
      printf 'OK:%d\n' "$n" > "$WORK/roundtrip.result"
    fi
  )

  result="$(cat "$WORK/roundtrip.result" 2>/dev/null || echo 'MANGLED: the subshell died')"
  case "$result" in
    OK:*) ok "${result#OK:} awkward secrets survive set_env -> get_env unchanged" ;;
    *)    bad "a secret changed between set_env and get_env" "${result#MANGLED:}" ;;
  esac

  # And the reason the reuse matters at all: a value that round-trips must also
  # not be re-quoted on the way back out. Writing a recovered value a second
  # time has to be a fixed point, or every re-run adds another layer of escaping.
  (
    # shellcheck source=/dev/null
    . "$WORK/roundtrip.sh"
    ENV_FILE="$WORK/fixedpoint.env"
    : > "$ENV_FILE"
    original='$dollar-then\backslash"and-quote'
    set_env FP "$original"
    once="$(get_env FP)"
    : > "$ENV_FILE"
    set_env FP "$once"
    twice="$(get_env FP)"
    [ "$original" = "$twice" ] && echo OK > "$WORK/fixedpoint.result" \
                               || echo BAD > "$WORK/fixedpoint.result"
  )
  if [ "$(cat "$WORK/fixedpoint.result" 2>/dev/null)" = "OK" ]; then
    ok "writing a recovered secret back is a fixed point"
  else
    bad "re-running adds a layer of escaping to a recovered secret"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The app can reach the internet, and still cannot be reached"
# ─────────────────────────────────────────────────────────────────────────────

# The failure this exists for is the quiet kind. `app` sat on `internal` alone,
# and a Docker network declared `internal: true` has no route off the host — so
# the Claude CLI could not call the Anthropic API, `git clone` could not resolve
# a remote, and no HTTP MCP server was reachable. Nothing said so: the container
# started, the health endpoint answered, `up --wait` was satisfied and the
# deploy's health gate passed. Every run then failed.
#
# The other half is the property that made the isolation worth having, so both
# are asserted together: egress must be possible, ingress must not.

if docker compose version >/dev/null 2>&1; then
  resolved="$(docker compose -f "$REPO_ROOT/compose.yml" --env-file /dev/null config 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    bad "resolving compose.yml" "docker compose config produced nothing"
  else
    # Networks the app joins, and which of those are internal-only.
    app_block="$(printf '%s' "$resolved" | sed -n '/^  app:/,/^  [a-z]/p')"
    app_networks="$(printf '%s' "$app_block" | sed -n '/^    networks:/,/^    [a-z]/p' \
                     | sed -n 's/^      \([a-z_-]*\):.*/\1/p')"

    if [ -z "$app_networks" ]; then
      bad "the app joins no network at all"
    else
      routable=""
      for net in $app_networks; do
        # A network is egress-capable unless it is declared internal.
        if ! printf '%s' "$resolved" \
             | sed -n "/^  $net:/,/^  [a-z]/p" | grep -q 'internal: true'; then
          routable="$routable $net"
        fi
      done
      if [ -n "$routable" ]; then
        ok "the app has a route out (via:$routable)"
      else
        bad "the app is on internal-only networks" \
            "no agent run, git clone or HTTP MCP call can work; the stack still reports healthy"
      fi
    fi

    # Egress must not have bought ingress. `app` publishes nothing; the proxy is
    # the only way in, which is what the internal network was protecting.
    if printf '%s' "$app_block" | grep -q '^    ports:'; then
      bad "the app publishes a port" "it must only be reachable through the proxy"
    else
      ok "the app still publishes no port of its own"
    fi
  fi
else
  skip "app network topology" "docker compose not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The firewall reset cannot discard the rules the script just wrote"
# ─────────────────────────────────────────────────────────────────────────────

# `ufw reset` means "back to installation defaults", and the files it restores
# include after.rules — where provision.sh writes the DOCKER-USER filtering that
# is the *only* thing standing between a published container port and the
# internet. ufw filters INPUT; Docker DNATs and forwards, so a packet for a
# published port never traverses INPUT and `ufw deny` is true and irrelevant.
#
# Resetting after writing therefore threw that filtering away, silently: ufw came
# up, reported active, listed every rule that had been asked for, and the chain
# that actually governs published ports was back to the packaged default.
#
# A line-order check rather than a behavioural one, because reproducing it needs
# root, ufw and a live host — all three of which this file refuses to require.

prov="$REPO_ROOT/deploy/provision.sh"
reset_line="$(grep -n 'ufw --force reset' "$prov" | head -1 | cut -d: -f1)"
write_line="$(grep -n 'AFTER_RULES=\|AFTER6_RULES=' "$prov" | head -1 | cut -d: -f1)"

if [ -z "$reset_line" ]; then
  # Not an error in itself — but the ordering below is then unverified, and
  # saying so is better than reporting a pass nobody checked.
  skip "ufw reset ordering" "provision.sh no longer calls 'ufw --force reset'"
elif [ -z "$write_line" ]; then
  skip "ufw reset ordering" "provision.sh no longer writes after.rules"
elif [ "$(grep -c 'ufw --force reset' "$prov")" -ne 1 ]; then
  bad "provision.sh resets ufw more than once" \
      "a second reset after after.rules is written discards the DOCKER-USER block"
elif [ "$reset_line" -lt "$write_line" ]; then
  ok "ufw is reset (line $reset_line) before after.rules is written (line $write_line)"
else
  bad "ufw is reset after after.rules is written" \
      "line $reset_line resets; line $write_line wrote the DOCKER-USER block that reset discards"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Rolling back twice does not reinstate the outage"
# ─────────────────────────────────────────────────────────────────────────────

# `record` keeps the two-entry history the rollback button reads. It ran for
# both actions, so a rollback filed the image it was *escaping* as the next
# rollback target: press the button twice and the broken image comes back.
#
# That is the button an operator presses repeatedly, during an incident,
# precisely because they are not sure the first press worked.
#
# The function is lifted out of the script rather than restated here, so this
# tests the code that ships.

if ! sed -n '/^record() {/,/^}/p' "$REPO_ROOT/deploy/bin/metaclaude-deploy" > "$WORK/record.sh"; then
  bad "extracting record() from metaclaude-deploy" "could not read the script"
elif [ "$(grep -c '^}' "$WORK/record.sh")" -ne 1 ]; then
  bad "extracting record()" "the definition moved; this check needs updating"
else
  # `record` reads ACTION, but it is sourced — shellcheck cannot see through
  # that and reports every assignment in here as dead.
  # shellcheck disable=SC2034
  (
    RELEASES="$WORK/releases"; CURRENT="$RELEASES/current"; PREVIOUS="$RELEASES/previous"
    ACTION="deploy"
    # shellcheck source=/dev/null
    . "$WORK/record.sh"

    record "img-A"                                 # first ever deploy
    record "img-B-broken"                          # B ships and breaks
    ACTION="rollback"; record "img-A"          # operator rolls back to A

    printf 'current=%s previous=%s\n' "$(cat "$CURRENT")" "$(cat "$PREVIOUS")" \
      > "$WORK/record.result"

    # And again, because that is what actually happens.
    ACTION="rollback"; record "$(cat "$PREVIOUS")"
    printf 'again=%s\n' "$(cat "$CURRENT")" >> "$WORK/record.result"
  )

  result="$(cat "$WORK/record.result" 2>/dev/null || echo 'the subshell died')"
  case "$result" in
    *"current=img-A previous=img-A"*)
      ok "a rollback leaves the known-good image as the rollback target" ;;
    *"previous=img-B-broken"*)
      bad "a rollback files the broken image as the next rollback target" \
          "pressing rollback twice redeploys it" ;;
    *) bad "record() behaved unexpectedly" "$(printf '%s' "$result" | tr '\n' ' ')" ;;
  esac

  case "$result" in
    *"again=img-A"*) ok "a second rollback is idempotent" ;;
    *) bad "a second rollback does not redeploy the same image" \
           "$(printf '%s' "$result" | tr '\n' ' ')" ;;
  esac
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Reclaiming disk never removes what rollback needs"
# ─────────────────────────────────────────────────────────────────────────────

# The purge that shipped was `docker image prune --filter until=168h`. At
# several releases a day no image ever reaches seven days, so it removed
# nothing, ever: found on a real host at 97% full — 23 images and 19 GB, plus
# 15 GB of build cache on a box whose whole premise is that it never builds.
#
# Replacing an age with a count makes the opposite mistake possible, and it is
# the dangerous one: a purge that takes the image `previous` names leaves the
# rollback button with no target, which is discovered during an incident.
# Lifted out of the script, like record() above, so this tests what ships.

if ! sed -n '/^prune_images() {/,/^}/p' "$REPO_ROOT/deploy/bin/metaclaude-deploy" > "$WORK/prune.sh"; then
  bad "extracting prune_images() from metaclaude-deploy" "could not read the script"
elif [ "$(grep -c '^}' "$WORK/prune.sh")" -ne 1 ]; then
  bad "extracting prune_images()" "the definition moved; this check needs updating"
else
  pi_stub="$WORK/pi-stub"; pi_calls="$WORK/pi-calls.log"; pi_rel="$WORK/pi-releases"
  mkdir -p "$pi_stub" "$pi_rel"
  # `current` is a digest reference, as a real deployment records it, and the
  # image it resolves to also carries a version tag. A purge that spared only
  # the literal string would delete it through its other name.
  echo "ghcr.io/acme/metaclaude@sha256:aaa" > "$pi_rel/current"
  echo "ghcr.io/acme/metaclaude@sha256:bbb" > "$pi_rel/previous"

  cat > "$pi_stub/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$MC_CALLS"
case "$1 ${2:-}" in
  "image inspect")
    case "$*" in
      *aaa*) printf 'sha256:idA\n' ;;
      *bbb*) printf 'sha256:idB\n' ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  "images "*|"images")
    # Newest first, as CreatedAt sorts. idA is current under a version tag,
    # idB is previous, and one image wears two tags at once.
    cat <<'ROWS'
2026-08-28 05:31:17 +0000 UTC	sha256:idA	ghcr.io/acme/metaclaude:v0.33.0
2026-08-28 05:08:19 +0000 UTC	sha256:idB	ghcr.io/acme/metaclaude:v0.32.15
2026-08-27 04:20:12 +0000 UTC	sha256:idC	ghcr.io/acme/metaclaude:v0.32.0
2026-08-26 04:20:12 +0000 UTC	sha256:idD	ghcr.io/acme/metaclaude:v0.31.0
2026-08-26 04:20:12 +0000 UTC	sha256:idD	ghcr.io/acme/metaclaude:latest
2026-08-25 04:20:12 +0000 UTC	sha256:idE	ghcr.io/acme/metaclaude:<none>
ROWS
    exit 0 ;;
esac
exit 0
STUB
  chmod +x "$pi_stub/docker"

  (
    PATH="$pi_stub:$PATH"; export MC_CALLS="$pi_calls"; : > "$pi_calls"
    CURRENT="$pi_rel/current"; PREVIOUS="$pi_rel/previous"
    # These four are `prune_images`'s inputs, read by the function sourced
    # below. Shellcheck cannot follow a function into a file it is told not to
    # read, so it sees four assignments nobody uses.
    # shellcheck disable=SC2034
    ALLOWED_IMAGE_PREFIX="ghcr.io/acme/metaclaude"
    # One, deliberately. At two, the newest two images happen to be current and
    # previous, so the ceiling alone would spare them and this would prove
    # nothing about the sparing. At one, idB survives only because `previous`
    # names it — which is the property worth having.
    # shellcheck disable=SC2034
    IMAGE_KEEP=1
    log() { :; }
    # shellcheck source=/dev/null
    . "$WORK/prune.sh"
    prune_images
  ) >/dev/null 2>&1

  pi_removed="$(grep -c '^docker rmi ' "$pi_calls" 2>/dev/null || echo 0)"
  if grep -qE '^docker rmi .*(v0\.33\.0|v0\.32\.15|idA|idB)' "$pi_calls"; then
    bad "the purge removed an image rollback needs" \
        "$(grep '^docker rmi' "$pi_calls" | tr '\n' ' ')"
  elif [ "$pi_removed" -eq 0 ]; then
    bad "the purge removed nothing" "the disk keeps filling, one image per release"
  else
    ok "the purge spares the images current and previous resolve to"
  fi

  # The untagged one can only be addressed by id; the double-tagged one needs
  # both of its names removed or its layers stay on disk.
  if grep -q '^docker rmi sha256:idE' "$pi_calls" \
     && grep -q '^docker rmi ghcr.io/acme/metaclaude:v0.31.0' "$pi_calls" \
     && grep -q '^docker rmi ghcr.io/acme/metaclaude:latest' "$pi_calls"; then
    ok "every reference of a doomed image is removed, by id when it has no tag"
  else
    bad "the purge left references behind" \
        "an image keeps its layers until its last tag goes: $(grep '^docker rmi' "$pi_calls" | tr '\n' ' ')"
  fi

  if grep -q '^docker builder prune' "$pi_calls"; then
    ok "the build cache is reclaimed on a host that never builds"
  else
    bad "the build cache is never reclaimed" "15 GB of it accumulated on a real host"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The sources the steward reads are the ones the image ships"
# ─────────────────────────────────────────────────────────────────────────────

# The system workspace copies the trees `SOURCE_TREES` names into itself at
# boot, from `source/` under the image root. A tree named in the code and
# not COPY'd into the image copies nothing — silently, because a missing
# tree is also what a bare checkout looks like — and the steward is back to
# reading compiled output through an approval card per file. So the two
# lists are read from their files and held equal here.
src_trees="$(grep -oE "\{ from: '[^']+'" "$REPO_ROOT/apps/api/src/services/system-workspace.ts" | grep -oE "'[^']+'" | tr -d "'" || true)"
if [ -z "$src_trees" ]; then
  bad "reading SOURCE_TREES out of services/system-workspace.ts" "the table moved or changed shape"
else
  missing_src=""
  for tree in $src_trees; do
    grep -qE "^COPY .*[ /]${tree} \./source/${tree}$" "$REPO_ROOT/docker/Dockerfile" || missing_src="$missing_src $tree"
  done
  if [ -z "$missing_src" ]; then
    ok "every tree in SOURCE_TREES is copied into the image under source/"
  else
    bad "trees the steward expects and the image does not ship:$missing_src" \
        "the system workspace would silently copy nothing for them"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The agent's workspaces are not inside the data directory"
# ─────────────────────────────────────────────────────────────────────────────

# The data directory holds the database, the sealed vault and master.key. The
# workspaces directory is where the agent runs model-authored commands, and is
# what `additionalDirectories` can widen access to. The image shipped the second
# *inside* the first, so every workspace sat one `..` from the key — and any
# check phrased as "is this under the data directory?" was true for every
# legitimate workspace path.
#
# `loadConfig` refuses to start on a nested layout, so this is really a check
# that the shipped compose file can start at all. Asserted here too because a
# mount point is easy to change without running anything.
if docker compose version >/dev/null 2>&1; then
  mounts="$(METACLAUDE_TLS_MODE=internal docker compose -f "$REPO_ROOT/compose.yml"               --env-file /dev/null config --format json 2>/dev/null             | python3 -c '
import json, sys
app = json.load(sys.stdin)["services"]["app"]
for volume in app.get("volumes") or []:
    if volume.get("type") == "volume":
        print(volume["source"], volume["target"])
' 2>/dev/null)"

  data_target="$(printf '%s
' "$mounts"  | awk '$1=="metaclaude-data"{print $2}')"
  ws_target="$(printf '%s
' "$mounts"    | awk '$1=="metaclaude-workspaces"{print $2}')"

  if [ -z "$data_target" ] || [ -z "$ws_target" ]; then
    bad "reading the app's volume mounts" "the volume names moved; this check needs updating"
  # A trailing slash on each side so /var/lib/metaclaude-workspaces is not read
  # as being inside /var/lib/metaclaude.
  elif case "$ws_target/" in "$data_target"/*) true ;; *) false ;; esac; then
    bad "the workspaces volume is mounted inside the data directory"         "$ws_target is under $data_target — the agent would run one .. from master.key"
  elif case "$data_target/" in "$ws_target"/*) true ;; *) false ;; esac; then
    bad "the data volume is mounted inside the workspaces directory"         "$data_target is under $ws_target — the vault would sit where the agent writes"
  else
    ok "data ($data_target) and workspaces ($ws_target) are separate roots"
  fi
else
  skip "workspace/data separation" "docker compose not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "A host that has never CI-deployed can still be inspected"
# ─────────────────────────────────────────────────────────────────────────────

# `compose()` passes --env-file "$IMAGE_ENV" unconditionally, and that file is
# written by `bring_up` — so on a host brought up by bootstrap.sh, which starts
# the stack with a plain `docker compose up -d`, it did not exist. `status` then
# printed both release lines and died at `compose ps` with
#
#     couldn't find env file: .../releases/.env.image
#
# which is exactly the command .github/workflows/deploy.yml tells an operator to
# run after a failed deploy — so the diagnostic tool failed first, on the host
# where it was needed most.
#
# The existing forced-command cases all exit before reaching compose, and the
# half-installed case dies at the $RELEASES check in a bare directory, so none
# of them could see this.
if command -v docker >/dev/null 2>&1; then
  fresh="$WORK/fresh-host"
  mkdir -p "$fresh/releases"
  : > "$fresh/.env"
  cp "$REPO_ROOT/compose.yml" "$fresh/compose.yml" 2>/dev/null || true

  # Run only as far as the env-file preparation: driving `compose ps` itself
  # would need a daemon, and the bug is in the arguments, not the daemon.
  out="$(APP_DIR="$fresh" bash -c '
    set -uo pipefail
    RELEASES="$APP_DIR/releases"
    IMAGE_ENV="$RELEASES/.env.image"
    '"$(sed -n '/^\[ -f "\$IMAGE_ENV" \] ||/p' "$REPO_ROOT/deploy/bin/metaclaude-deploy")"'
    docker compose --project-directory "$APP_DIR" \
      --env-file "$APP_DIR/.env" --env-file "$IMAGE_ENV" config --services 2>&1
  ')"

  case "$out" in
    *"couldn't find env file"*|*"no such file"*)
      bad "status on a host that has never CI-deployed" \
          "compose refuses the missing releases/.env.image: $out" ;;
    *)
      ok "the image env file is created on demand, so every verb reaches compose" ;;
  esac

  [ -f "$fresh/releases/.env.image" ] \
    && ok "and it is left behind, so the next call is cheap" \
    || bad "the image env file was not created" "the guard did not run"
else
  skip "status on a fresh host" "docker not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Uninstalling keeps its promises"
# ─────────────────────────────────────────────────────────────────────────────

# Three promises, each load-bearing: without --purge-data the volumes survive;
# the .env (holding the unregenerable master key) is copied OUT of the tree
# before the tree is deleted; and --purge-data without --yes demands the exact
# phrase, so a reflexive "y<enter>" cannot destroy the database. Rehearsed
# against a real daemon rather than read, because the failure that matters is
# a docker flag, not a typo.
# The script insists on root — it deletes system paths and writes under /root —
# so the rehearsal must be root too. Locally that tends to be true already; on
# a CI runner it is not, and the first version of this section learned that the
# hard way: the script refused to run, one assertion failed on the surviving
# directory, and two others passed *because nothing had happened* — the volume
# was never touched and /root was simply unwritable. A rehearsal that cannot
# tell "the guard held" from "the script never ran" proves nothing, so this one
# escalates explicitly or says it skipped.
if [ "$(id -u)" -eq 0 ]; then
  as_root() { env "$@"; }
elif sudo -n true 2>/dev/null; then
  as_root() { sudo -n env "$@"; }
else
  as_root() { return 127; }
fi

if ! docker info >/dev/null 2>&1; then
  skip "uninstall rehearsal" "docker not available"
elif ! as_root true 2>/dev/null; then
  skip "uninstall rehearsal" "needs root or passwordless sudo, and this shell has neither"
else
  fake_app="$(mktemp -d)"
  mkdir -p "$fake_app/releases"
  printf 'METACLAUDE_MASTER_KEY=cafe\n' > "$fake_app/.env"
  docker volume create mccheck_data >/dev/null

  as_root APP_DIR="$fake_app" COMPOSE_PROJECT=mccheck "$REPO_ROOT/deploy/uninstall.sh" --yes \
    >/dev/null 2>&1 || true
  if docker volume ls -q | grep -q '^mccheck_data$'; then
    ok "without --purge-data, the volumes survive"
  else
    bad "uninstall deleted a volume it promised to keep" "mccheck_data is gone"
  fi
  if as_root sh -c 'ls /root/metaclaude-env-*.bak' >/dev/null 2>&1; then
    ok "the .env is saved outside the deleted tree"
  else
    bad "the .env was not saved" "the master key would be lost with the tree"
  fi
  [ ! -d "$fake_app" ] && ok "the application directory is removed" \
    || bad "the application directory survived" "$fake_app still exists"

  mkdir -p "$fake_app"
  if printf 'y\n' | as_root APP_DIR="$fake_app" COMPOSE_PROJECT=mccheck \
       "$REPO_ROOT/deploy/uninstall.sh" --purge-data >/dev/null 2>&1; then
    bad "--purge-data accepted a bare \"y\"" "the confirmation phrase is not enforced"
  else
    docker volume ls -q | grep -q '^mccheck_data$' \
      && ok "--purge-data without the exact phrase refuses, and destroys nothing" \
      || bad "the refusal still deleted the volume" "guard ran too late"
  fi

  docker volume rm mccheck_data >/dev/null 2>&1 || true
  rm -rf "$fake_app"
  as_root sh -c 'rm -f /root/metaclaude-env-*.bak' 2>/dev/null || true
fi

# ─────────────────────────────────────────────────────────────────────────────
section "A backup is a stopped app, a complete archive, and a fresh marker"
# ─────────────────────────────────────────────────────────────────────────────

# bin/metaclaude-backup is rehearsed end to end — the real script, real tar,
# real archives — against a stub `docker` that resolves volume mountpoints to
# scratch directories and logs every call. No daemon, no root: everything the
# daemon would do is the stub's, everything the script does is real.
#
# The ordering proof is stateful rather than read from a log: the stub's
# `stop app` plants a file in the fake data volume and `start app` removes it,
# so the archive contains that file if and only if tar ran while the app was
# stopped. And per the uninstall lesson above, the first check is that the
# script ran at all — every later assertion would pass on the inert outcome.
bk_stub="$WORK/bk-stub"; bk_vols="$WORK/bk-vols"; bk_calls="$WORK/bk-calls.log"
bk_app="$WORK/bk-app"; bk_dir="$WORK/bk-archives"
mkdir -p "$bk_stub" "$bk_app/releases" \
  "$bk_vols/metaclaude-data" "$bk_vols/metaclaude-workspaces" \
  "$bk_vols/metaclaude-home" "$bk_vols/caddy-data"
: > "$bk_app/.env"; : > "$bk_calls"
echo "the-database" > "$bk_vols/metaclaude-data/db.sentinel"
echo "a-workspace-file" > "$bk_vols/metaclaude-workspaces/ws.sentinel"
echo "a-cli-transcript" > "$bk_vols/metaclaude-home/home.sentinel"
echo "the-private-ca" > "$bk_vols/caddy-data/ca.sentinel"

cat > "$bk_stub/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$MC_CALLS"
if [ "${1:-}" = "volume" ] && [ "${2:-}" = "inspect" ]; then
  name="${*: -1}"; d="$MC_VOLS/${name#metaclaude_}"
  [ -d "$d" ] || exit 1
  printf '%s' "$d"; exit 0
fi
case "$*" in
  # The archive count at stop time is what proves retention ran *before* the
  # new archive was written — see the lowered-ceiling check further down.
  *" stop app"|*" stop")
    touch "$MC_VOLS/metaclaude-data/stopped-while-copying"
    ls -1 "$MC_BKDIR"/metaclaude-backup-*.tar.gz 2>/dev/null | wc -l > "$MC_VOLS/count-at-stop"
    ;;
  *" start app"|*" start") rm -f "$MC_VOLS/metaclaude-data/stopped-while-copying" ;;
esac
exit 0
STUB
chmod +x "$bk_stub/docker"

run_backup() {
  PATH="$bk_stub:$PATH" MC_CALLS="$bk_calls" MC_VOLS="$bk_vols" MC_BKDIR="$bk_dir" \
  METACLAUDE_APP_DIR="$bk_app" METACLAUDE_BACKUP_DIR="$bk_dir" \
  METACLAUDE_BACKUP_KEEP="${1:-14}" \
  METACLAUDE_BACKUP_MIN_FREE_BYTES="${MC_MIN_FREE:-}" \
    "$REPO_ROOT/deploy/bin/metaclaude-backup" "${@:2}"
}

if run_backup 14 backup >/dev/null 2>&1; then
  ok "a backup runs to completion against a stubbed daemon"
else
  bad "the backup script did not run" "everything below would pass on the inert outcome"
fi

bk_archive="$(ls -1t "$bk_dir"/metaclaude-backup-*.tar.gz 2>/dev/null | head -1)"
bk_listing="$(tar -tzf "$bk_archive" 2>/dev/null)"

bk_missing=""
for want in ./manifest.json ./metaclaude-data/db.sentinel ./metaclaude-workspaces/ws.sentinel \
            ./metaclaude-home/home.sentinel ./caddy-data/ca.sentinel; do
  printf '%s\n' "$bk_listing" | grep -qx "$want" || bk_missing="$bk_missing $want"
done
[ -z "$bk_missing" ] && ok "the archive carries all four volumes and the manifest" \
  || bad "the archive is incomplete" "missing:$bk_missing"

if printf '%s\n' "$bk_listing" | grep -qx "./metaclaude-data/stopped-while-copying"; then
  ok "the volumes are copied while the app is stopped"
else
  bad "the copy did not happen between stop and start" "the database can be caught mid-write"
fi

if grep -qE '"archive":"'"$(basename "$bk_archive")"'"' "$bk_vols/metaclaude-data/backup-marker.json" 2>/dev/null \
   && grep -qE '"at":[0-9]+' "$bk_vols/metaclaude-data/backup-marker.json"; then
  ok "the marker the doctor reads names the archive it attests"
else
  bad "backup-marker.json is wrong or absent" "the doctor would warn forever — or never"
fi

# The archives moved off the system disk onto a volume the container does not
# mount, so nothing inside the app can measure it. This figure is the doctor's
# only view of it.
if grep -qE '"freeBytes":[0-9]+' "$bk_vols/metaclaude-data/backup-marker.json" 2>/dev/null; then
  ok "the marker carries the space left where the archives are kept"
else
  bad "backup-marker.json records no free space" "a filling backup volume would be invisible to the doctor"
fi

# Archive names carry second resolution, so consecutive runs need a beat.
sleep 1; run_backup 2 backup >/dev/null 2>&1
sleep 1; run_backup 2 backup >/dev/null 2>&1
bk_count="$(ls -1 "$bk_dir"/metaclaude-backup-*.tar.gz 2>/dev/null | wc -l)"
[ "$bk_count" -eq 2 ] && ok "retention keeps the newest 2 of 3" \
  || bad "retention did not prune" "expected 2 archives, found $bk_count"

# Retention is applied before the new archive is written, not only after it.
# Lowering the ceiling on a host whose volume is nearly full has to free the
# room on the very next run, rather than needing one more archive's worth of
# space first. Proven by what the daemon stub counted at stop time: with two
# archives on disk and a ceiling of one, exactly one may remain by then.
rm -f "$bk_vols/count-at-stop"
sleep 1; run_backup 1 backup >/dev/null 2>&1
bk_at_stop="$(cat "$bk_vols/count-at-stop" 2>/dev/null || echo -1)"
[ "$bk_at_stop" -eq 1 ] && ok "a lowered retention ceiling frees room before the next archive is written" \
  || bad "retention runs only after the archive" "expected 1 archive on disk at stop time, found $bk_at_stop"

# A backup that cannot fit must say so while the app is still serving. The
# knob is the injection point: no test can shrink a real filesystem, and a
# guard that cannot be exercised is a guard nobody knows is broken.
#
# The refusal's *reason* is asserted, not merely its exit code. Without that
# this check passed against a script with no guard at all: the run before it
# had just written an archive, this one collided with that second-resolution
# name, and "refused, and the app was never stopped" was true for entirely
# the wrong reason. Hence the sleep, and hence the grep.
sleep 1
: > "$bk_calls"
bk_before="$(ls -1 "$bk_dir"/metaclaude-backup-*.tar.gz 2>/dev/null | wc -l)"
bk_refusal="$(MC_MIN_FREE=999999999999999 run_backup 14 backup 2>&1 >/dev/null)" && bk_ran=1 || bk_ran=0
if [ "$bk_ran" = 1 ]; then
  bad "a backup ran with no room for it" "the archive would be truncated and the marker would still advance"
else
  bk_after="$(ls -1 "$bk_dir"/metaclaude-backup-*.tar.gz 2>/dev/null | wc -l)"
  if ! printf '%s' "$bk_refusal" | grep -qi "free"; then
    bad "the backup refused for some other reason" "the space guard was not what stopped it: $bk_refusal"
  elif grep -q " stop" "$bk_calls"; then
    bad "a doomed backup still stopped the app" "an outage bought nothing"
  elif [ "$bk_after" -ne "$bk_before" ]; then
    bad "the refused backup left an archive behind" "found $bk_after where there were $bk_before"
  else
    ok "too little free space refuses before the app is stopped"
  fi
fi

mv "$bk_vols/caddy-data" "$bk_vols/caddy-data.gone"
: > "$bk_calls"
if run_backup 14 backup >/dev/null 2>&1; then
  bad "a backup with a missing volume claimed success" "a restore would need what it silently skipped"
else
  grep -q " stop" "$bk_calls" \
    && bad "a doomed backup still stopped the app" "volumes must resolve before anything is touched" \
    || ok "a missing volume refuses before the app is touched"
fi
mv "$bk_vols/caddy-data.gone" "$bk_vols/caddy-data"

bk_archive="$(ls -1t "$bk_dir"/metaclaude-backup-*.tar.gz | head -1)"
: > "$bk_calls"
if run_backup 14 restore "$bk_archive" >/dev/null 2>&1; then
  bad "restore without --yes proceeded" "a mistyped verb would replace the database"
else
  if [ "$(cat "$bk_vols/metaclaude-data/db.sentinel")" = "the-database" ] \
     && ! grep -q " stop" "$bk_calls"; then
    ok "restore without --yes refuses and touches nothing"
  else
    bad "the refusal still touched something" "guard ran too late"
  fi
fi

echo "corrupted" > "$bk_vols/metaclaude-data/db.sentinel"
echo "junk" > "$bk_vols/metaclaude-data/extra-file"
: > "$bk_calls"
run_backup 14 restore "$bk_archive" --yes >/dev/null 2>&1
bk_rc=$?
if [ "$bk_rc" -eq 0 ] \
   && [ "$(cat "$bk_vols/metaclaude-data/db.sentinel")" = "the-database" ] \
   && [ ! -e "$bk_vols/metaclaude-data/extra-file" ] \
   && [ "$(cat "$bk_vols/caddy-data/ca.sentinel")" = "the-private-ca" ]; then
  ok "restore --yes replaces the volumes with the archive's bytes, extras included"
else
  bad "restore --yes did not faithfully restore" "rc=$bk_rc"
fi
grep -q " stop$" "$bk_calls" && ok "restore stops the whole stack, not just the app" \
  || bad "restore stopped only part of the stack" "caddy would hold its CA open while it is replaced"

# The script exists on servers because install-app.sh puts it there, nightly
# because it leaves a timer, and gone when uninstall.sh removes the units.
if grep -q "deploy/bin/metaclaude-backup" "$REPO_ROOT/deploy/install-app.sh" \
   && grep -q "metaclaude-backup.timer" "$REPO_ROOT/deploy/install-app.sh"; then
  ok "install-app.sh ships the script and enables the nightly timer"
else
  bad "install-app.sh does not install the backup tooling" "servers would have no backups at all"
fi
if grep -q "metaclaude-backup.timer" "$REPO_ROOT/deploy/uninstall.sh"; then
  ok "uninstall.sh removes the backup units with the tree they point at"
else
  bad "uninstall.sh leaves the backup timer behind" "it would fire against a deleted tree forever"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "A container probed through docker exec has something to reap the probe"
# ─────────────────────────────────────────────────────────────────────────────

# Docker runs a healthcheck through `docker exec`. A `CMD-SHELL` probe forks,
# and whatever outlives its shell is reparented to PID 1 *inside* the container.
# If PID 1 does not reap — and a server process has no reason to — every probe
# leaks one task, for good.
#
# Nothing about that is visible until the cgroup's pids ceiling is reached: at a
# 5s interval, about five hours. Then `runc exec` can no longer fork into the
# full cgroup, fails with `procReady not received`, and the healthcheck can
# never pass again. The container is `unhealthy` forever while serving
# perfectly, `up --wait` fails, and the deploy script's health gate fails with
# it. Found in production at 3643 tasks of a 3647 ceiling.
#
# So: a service with a healthcheck needs a reaper. `init: true` is one; an image
# whose entrypoint is tini is the other, which is what the app image ships.
if command -v python3 >/dev/null 2>&1; then
  reaper_report="$(python3 - "$REPO_ROOT" <<'PY' | tr -d '\r'
import pathlib, re, sys, yaml

root = pathlib.Path(sys.argv[1])
compose = yaml.safe_load((root / "compose.yml").read_text(encoding="utf-8"))

# An image built here counts as reaped only if its Dockerfile actually says so.
def dockerfile_reaps(build):
    if not isinstance(build, dict):
        build = {"dockerfile": "Dockerfile", "context": build or "."}
    path = root / build.get("context", ".") / build.get("dockerfile", "Dockerfile")
    if not path.exists():
        return False
    return re.search(r"^ENTRYPOINT\s*\[[^]]*tini", path.read_text(encoding="utf-8"), re.M) is not None

for name, service in (compose.get("services") or {}).items():
    if "healthcheck" not in service:
        continue
    if service.get("init") is True:
        print(f"ok {name} declares init: true")
    elif "build" in service and dockerfile_reaps(service["build"]):
        print(f"ok {name} runs tini as its image entrypoint")
    else:
        print(f"bad {name} is probed by docker exec with no reaper as PID 1 — "
              f"every probe leaks a task and the cgroup fills in hours")
PY
)" || reaper_report="bad the reaper check did not run"

  if [ -z "$reaper_report" ]; then
    bad "checking for a reaper" "no service declares a healthcheck; the check found nothing to verify"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        ok\ *)  ok "${line#ok }" ;;
        *)      bad "a healthcheck with nothing to reap it" "${line#bad }" ;;
      esac
    done <<EOF
$reaper_report
EOF
  fi
else
  skip "reaper check" "python3 not available"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The boot warning about credentials knows about all three sources"
# A deployment authenticates from one of three places: a token in the sealed
# vault, one in the environment, or the CLI's own account sign-in under $HOME.
# The entrypoint could only see the second, so it warned on every boot of a
# server that was perfectly paired — and an alarm that is always on is an alarm
# nobody reads on the day it means something. The vault cannot be inspected
# from a shell; the CLI store can, and that is the gap this closes.
if grep -q 'credentials.json' "$REPO_ROOT/docker/entrypoint.sh"; then
  ok "the entrypoint consults the CLI's own credential store"
else
  bad "the entrypoint only reads the environment — it will warn on a paired server"
fi
if grep -q 'refreshToken' "$REPO_ROOT/docker/entrypoint.sh"; then
  ok "it tests the refresh token, not merely the file a logout leaves behind"
else
  bad "the entrypoint treats a logged-out store as a live sign-in"
fi

section "The documentation the product ships agrees with the product"
# ─────────────────────────────────────────────────────────────────────────────

# The Help screen renders CHANGELOG.md and states APP_VERSION beside it. A
# release whose version has no changelog entry would show the user a "What's
# new" that does not know what is new — so the agreement is asserted here,
# where every push runs, rather than remembered at tag time.
app_version="$(grep -oE "APP_VERSION = '[^']+'" "$REPO_ROOT/packages/shared/src/constants.ts" | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
if [ -z "$app_version" ]; then
  bad "reading APP_VERSION" "packages/shared/src/constants.ts no longer declares it where this check looks"
elif grep -q "^## \[$app_version\]" "$REPO_ROOT/CHANGELOG.md" 2>/dev/null; then
  ok "CHANGELOG.md has an entry for the running version ($app_version)"
else
  bad "CHANGELOG.md has no entry for $app_version" "the in-app What's new would not know what is new"
fi

# The version is declared in five places — APP_VERSION plus four package.json
# files — and deploy/bump.mjs moves them together. Drift means a hand edit
# missed some of them, and whichever one a given surface reads would then lie.
if [ -n "$app_version" ]; then
  drifted=""
  for pkg in package.json apps/api/package.json apps/web/package.json packages/shared/package.json; do
    pkg_version="$(grep -oE '"version":[[:space:]]*"[^"]+"' "$REPO_ROOT/$pkg" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
    [ "$pkg_version" = "$app_version" ] || drifted="$drifted $pkg=$pkg_version"
  done
  if [ -z "$drifted" ]; then
    ok "all four package.json files agree with APP_VERSION ($app_version)"
  else
    bad "package.json versions drifted from APP_VERSION $app_version:$drifted" "run node deploy/bump.mjs, or align them by hand"
  fi
fi

# The CI version-guard job delegates its comparison to version-guard.sh.
# Prove the guard can actually fail — a check that only ever passes proves
# nothing (see the uninstall-rehearsal lesson).
if "$REPO_ROOT/deploy/version-guard.sh" 1.2.3 1.2.4 >/dev/null 2>&1 \
  && "$REPO_ROOT/deploy/version-guard.sh" 0.9.9 0.10.0 >/dev/null 2>&1 \
  && ! "$REPO_ROOT/deploy/version-guard.sh" 1.2.3 1.2.3 >/dev/null 2>&1 \
  && ! "$REPO_ROOT/deploy/version-guard.sh" 1.3.0 1.2.9 >/dev/null 2>&1; then
  ok "version-guard.sh accepts increases (incl. 0.9.9→0.10.0) and rejects equal/lower"
else
  bad "version-guard.sh comparison is wrong" "the CI guard would wave through a version that did not increase"
fi

# A bare tag is not a release: the in-app update check asks /releases/latest,
# and a repository that is only ever tagged answers 404 there forever — which
# is exactly the bug this guards against returning.
if ! grep -q 'gh release create' "$REPO_ROOT/.github/workflows/ci.yml"; then
  bad "ci.yml never publishes a GitHub release" \
      "the in-app update check asks /releases/latest, and a tag alone answers 404"
elif ! grep -q -- '--verify-tag' "$REPO_ROOT/.github/workflows/ci.yml"; then
  bad "the release step does not verify its tag" \
      "a release created before the tag exists would point at nothing"
else
  ok "ci.yml publishes a verified GitHub release for each version tag"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "The in-app update button reaches a consumer that cannot be steered"
# ─────────────────────────────────────────────────────────────────────────────

# The app's apply button writes a version into updates/; the host's updater
# composes the image from its own pinned prefix. Rehearsed here with a stub
# deploy that records what it was asked to run — the rehearsal must prove the
# updater executed, not merely that nothing exploded (the uninstall lesson).
updater_dir="$(mktemp -d)"
mkdir -p "$updater_dir/updates" "$updater_dir/bin"
cat > "$updater_dir/bin/stub-deploy" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$(dirname "$0")/../deploy-calls.log"
exit 0
STUB
chmod +x "$updater_dir/bin/stub-deploy"
printf 'ALLOWED_IMAGE_PREFIX="ghcr.io/example/metaclaude"\n' > "$updater_dir/deploy.conf"

run_updater() {
  METACLAUDE_APP_DIR="$updater_dir" \
  METACLAUDE_DEPLOY_BIN="$updater_dir/bin/stub-deploy" \
    "$REPO_ROOT/deploy/bin/metaclaude-updater"
}

printf '{"version":"v1.2.3","requestedBy":"check","at":1}\n' > "$updater_dir/updates/request.json"
run_updater
if grep -q '^deploy ghcr.io/example/metaclaude:v1.2.3$' "$updater_dir/deploy-calls.log" 2>/dev/null \
  && grep -q '"state":"succeeded"' "$updater_dir/updates/status.json" \
  && [ ! -f "$updater_dir/updates/request.json" ]; then
  ok "a well-formed request deploys the pinned repository at that version, once"
else
  bad "the updater rehearsal did not deploy as expected" \
      "calls: $(cat "$updater_dir/deploy-calls.log" 2>/dev/null || echo none); status: $(cat "$updater_dir/updates/status.json" 2>/dev/null || echo none)"
fi

# A request naming an image instead of a version must never reach the deploy:
# the version field is the only input, and the regex is the parser.
: > "$updater_dir/deploy-calls.log"
printf '{"version":"ghcr.io/evil/image:latest"}\n' > "$updater_dir/updates/request.json"
run_updater
if [ ! -s "$updater_dir/deploy-calls.log" ] \
  && grep -q '"state":"failed"' "$updater_dir/updates/status.json"; then
  ok "a request that is not a bare vX.Y.Z is refused without touching docker"
else
  bad "the updater accepted a malformed request" \
      "calls: $(cat "$updater_dir/deploy-calls.log" 2>/dev/null || echo none)"
fi
rm -rf "$updater_dir"

# The Apply button composes ghcr…:v<version> — an image tag only the CI
# container job publishes (release-tag's GITHUB_TOKEN pushes trigger no
# workflows, so nothing else ever will). Found on a real host as "not found".
if grep -q 'steps.appver.outputs.version' "$REPO_ROOT/.github/workflows/ci.yml" \
  && grep -q 'Read the app version' "$REPO_ROOT/.github/workflows/ci.yml"; then
  ok "CI tags the container image with the app version on main pushes"
else
  bad "ci.yml never tags the image with v<version>" \
      "the in-app Apply button would compose an image reference nobody pushes"
fi

# `install -o 10001` aborts on any host whose passwd cannot name the
# container uid — which is every host. The numeric chown is the one that works.
if grep -qE 'install .*-o 10001' "$REPO_ROOT/deploy/install-app.sh"; then
  bad "install-app.sh sets ownership via install -o with a raw uid" \
      "install refuses a uid /etc/passwd cannot name; use chown"
else
  ok "install-app.sh assigns the container uid with chown, not install -o"
fi

if ! grep -q 'updates:/var/lib/metaclaude-updates' "$REPO_ROOT/compose.yml"; then
  bad "compose.yml does not mount the updates exchange directory" \
      "the app cannot hand a request to the host updater without it"
elif ! grep -q 'METACLAUDE_UPDATES_DIR' "$REPO_ROOT/compose.yml"; then
  bad "compose.yml does not tell the app where the exchange directory is"
elif ! grep -q 'metaclaude-updater' "$REPO_ROOT/deploy/install-app.sh"; then
  bad "install-app.sh never installs the updater" "the button would write requests nobody consumes"
else
  ok "compose mounts the exchange directory and install-app.sh installs its consumer"
fi

# The release notes come from the changelog by the same extraction the job
# runs; prove it finds the current version's section on the real file.
release_notes="$(awk -v v="$app_version" '
  $0 ~ "^## \\[" v "\\]" { on=1; next }
  on && /^## \[/ { exit }
  on { print }
' "$REPO_ROOT/CHANGELOG.md")"
if [ -n "$release_notes" ]; then
  ok "the changelog carries a section for $app_version — the release will have notes"
else
  bad "no changelog section for $app_version" "the published release would say nothing"
fi

# The user guide names environment variables; a renamed variable must take its
# documentation with it. Scoped to docs/guide/ — the trap list in CLAUDE.md
# legitimately discusses names that no longer exist.
guide_vars="$(grep -rhoE 'METACLAUDE_[A-Z_]+' "$REPO_ROOT/docs/guide" 2>/dev/null | sort -u)"
if [ -n "$guide_vars" ]; then
  missing_vars=""
  while IFS= read -r var; do
    grep -q "^$var=" "$REPO_ROOT/.env.example" || grep -q "$var" "$REPO_ROOT/compose.yml" \
      || missing_vars="$missing_vars $var"
  done <<EOF
$guide_vars
EOF
  if [ -n "$missing_vars" ]; then
    bad "the guide documents a setting that does not exist" "$missing_vars"
  else
    ok "every setting the guide names exists in .env.example or compose.yml"
  fi
else
  ok "the guide names no settings, so none can be stale"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Every log line the documentation says to grep for is one the code writes"
# ─────────────────────────────────────────────────────────────────────────────

# A runbook that says `docker compose logs app | grep '<phrase>'` is only useful
# while the code still writes that phrase. Nothing links the two, and the
# failure mode is silent in the worst way: the operator runs the command, sees
# no output, and concludes all is well.
#
# It has already happened once. Three cases were documented for the workspace
# relocation and only two shared the `workspaces root moved` prefix the
# operator was told to grep for, so the third — a workspace that could *not* be
# repaired — was unreachable through the documented command.
#
# The patterns are lifted out of the docs rather than listed here, so a new one
# is covered the day it is written.
patterns="$(python3 - "$REPO_ROOT" <<'PY' | tr -d '\r'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
seen = []
# `grep 'x'`, `grep -i 'x'`, `grep -E 'a|b'` — single-quoted only, which is how
# every documented invocation is written. The flags are captured because they
# decide what the pattern means: `|` is an alternation under -E and a literal
# pipe character under the default BRE.
call = re.compile(r"\bgrep\s+((?:-[A-Za-z]+\s+)*)'([^']+)'")
# `docs/superpowers/` is excluded, and the reason is the check's own intent:
# it asserts that documentation telling a *reader* to grep the API source stays
# true. That directory holds design specs and implementation plans — working
# documents written for an engineer, whose shell examples target apps/web, the
# scripts, or the locale catalogue. Asserting those against apps/api/src makes
# the check fail on a document that never claimed anything about it.
for doc in sorted((root / "docs").rglob("*.md")) + [root / "README.md"]:
    if not doc.exists() or "superpowers" in doc.parts:
        continue
    for flags, pattern in call.findall(doc.read_text(encoding="utf-8")):
        # A backslash means the author is writing a regex — `\|` for BRE
        # alternation, most often. There is no literal to assert, and splitting
        # it up would produce a fragment that happens to match something else.
        if "\\" in pattern:
            continue
        extended = "E" in flags or "P" in flags
        for alternative in pattern.split("|") if extended else [pattern]:
            alternative = alternative.strip()
            if alternative and not re.search(r"[\^$*+?\[\]()]", alternative):
                seen.append(alternative)
print("\n".join(dict.fromkeys(seen)))
PY
)"

if [ -z "$patterns" ]; then
  bad "extracting the documented grep patterns" "found none — the extractor is broken"
else
  missing=""
  count=0
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    count=$((count + 1))
    grep -rqF -- "$pattern" "$REPO_ROOT/apps/api/src" 2>/dev/null \
      || missing="$missing
    $pattern"
  done <<EOF
$patterns
EOF
  if [ -n "$missing" ]; then
    bad "a documented grep pattern matches nothing in the source" "$missing"
  else
    ok "all $count documented log phrases still exist in apps/api/src"
  fi
fi

section "Every screen the guide sends the reader to still exists"

# The same family as the log-phrase check above, for the *other* half of the
# product surface: prose that navigates. A chapter saying "Settings → MCP"
# for a screen that lives under Agents & skills is not a typo — it is a
# reader who cannot find the thing, and nothing in a test suite notices.
#
# Two such drifts shipped before this check existed: the advisor chapter sent
# people to Settings for a toggle that lives in the workspace's own settings,
# and the MCP chapter named a Settings screen that has never existed.
#
# Scope: the user guide and the README, which describe *this app's* UI.
# docs/DEPLOYMENT.md is deliberately excluded — its "Settings → General →
# About" paths are iOS and Android, not Metaclaude.
#
# The claim asserted is narrow on purpose: the first segment after
# "Settings →" must appear somewhere in SettingsPage.tsx, tab label or card
# title. That is enough to catch a screen that is not there at all, without
# pretending to parse the route tree.
paths="$(python3 - "$REPO_ROOT" <<'PY' | tr -d '\r'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
sources = sorted((root / "docs" / "guide").glob("*.md")) + [root / "README.md"]
seen = []
cite = re.compile(r"Settings\s*→\s*([^*\n.;,)]+)")
for doc in sources:
    if not doc.exists():
        continue
    for raw in cite.findall(doc.read_text(encoding="utf-8")):
        # "System → Doctor → Run checks" — only the first hop is a Settings
        # screen; what it contains is that screen's business.
        first = raw.split("→")[0].strip().rstrip("*").strip()
        # Prose that continues past the screen name ("Security and turn on…").
        first = re.split(r"\s+(?:and|then|to|for|which|where)\b", first)[0].strip()
        if first:
            seen.append(first)
print("\n".join(dict.fromkeys(seen)))
PY
)"

settings_page="$REPO_ROOT/apps/web/src/pages/SettingsPage.tsx"
if [ ! -f "$settings_page" ]; then
  bad "locating the settings screen" "$settings_page is missing"
elif [ -z "$paths" ]; then
  # Not a pass: the guide has always named at least one Settings screen, so
  # finding none means the extractor broke, not that the prose got cleaner.
  bad "extracting the documented Settings paths" "found none — the extractor is broken"
else
  missing_paths=""
  path_count=0
  while IFS= read -r screen; do
    [ -n "$screen" ] || continue
    path_count=$((path_count + 1))
    grep -qF -- "$screen" "$settings_page" 2>/dev/null \
      || missing_paths="$missing_paths
    Settings → $screen"
  done <<EOF
$paths
EOF
  if [ -n "$missing_paths" ]; then
    bad "the guide sends the reader to a Settings screen that does not exist" "$missing_paths"
  else
    ok "all $path_count documented Settings screens exist in SettingsPage.tsx"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────

printf '\n%s%d passed, %d failed, %d skipped%s\n' "$BOLD" "$PASSED" "$FAILED" "$SKIPPED" "$OFF"
[ "$FAILED" -eq 0 ] || exit 1
