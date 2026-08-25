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
# the linter is happy, that compose accepts the file under every TLS mode, and
# that a secret containing awkward characters survives the trip into .env.
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
  for mode in internal acme-dns acme-ip file; do
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

printf '\n%s%d passed, %d failed, %d skipped%s\n' "$BOLD" "$PASSED" "$FAILED" "$SKIPPED" "$OFF"
[ "$FAILED" -eq 0 ] || exit 1
