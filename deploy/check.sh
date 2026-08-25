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
