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

printf '\n%s%d passed, %d failed, %d skipped%s\n' "$BOLD" "$PASSED" "$FAILED" "$SKIPPED" "$OFF"
[ "$FAILED" -eq 0 ] || exit 1
