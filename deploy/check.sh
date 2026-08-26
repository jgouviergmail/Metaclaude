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

SCRIPTS=(
  "$REPO_ROOT/deploy/bootstrap.sh"
  "$REPO_ROOT/deploy/provision.sh"
  "$REPO_ROOT/deploy/install-app.sh"
  "$REPO_ROOT/deploy/verify.sh"
  "$REPO_ROOT/deploy/check.sh"
  "$REPO_ROOT/deploy/bin/metaclaude-deploy"
)

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
patterns="$(python3 - "$REPO_ROOT" <<'PY'
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
seen = []
# `grep 'x'`, `grep -i 'x'`, `grep -E 'a|b'` — single-quoted only, which is how
# every documented invocation is written. The flags are captured because they
# decide what the pattern means: `|` is an alternation under -E and a literal
# pipe character under the default BRE.
call = re.compile(r"\bgrep\s+((?:-[A-Za-z]+\s+)*)'([^']+)'")
for doc in sorted((root / "docs").glob("*.md")) + [root / "README.md"]:
    if not doc.exists():
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

# ─────────────────────────────────────────────────────────────────────────────

printf '\n%s%d passed, %d failed, %d skipped%s\n' "$BOLD" "$PASSED" "$FAILED" "$SKIPPED" "$OFF"
[ "$FAILED" -eq 0 ] || exit 1
