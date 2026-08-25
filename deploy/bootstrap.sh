#!/usr/bin/env bash
#
# One command, from a fresh root shell to a running Metaclaude.
#
#     ./deploy/bootstrap.sh --admin-key "ssh-ed25519 AAAA…" --deploy-key "ssh-ed25519 AAAA…"
#
# Runs provision.sh and install-app.sh in order, then asks for the handful of
# secrets that cannot be generated, writes .env, and starts the stack.
#
# Everything it does is in the two scripts it calls; this exists so the sequence
# cannot be got wrong, not to hide it. The lockout guards in provision.sh —
# including the confirmation from a second SSH session before the firewall is
# armed — are still there and still interactive. Do not run this in a context
# where you cannot answer them.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

ADMIN_KEY=""
DEPLOY_KEY=""
MODE="public"
SITE=""
APP_DIR="/opt/metaclaude"
EXTRA=()

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; OFF=""
fi
step() { printf '\n%s━━ %s%s%s\n' "$GREEN" "$BOLD" "$*" "$OFF"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s !! %s%s\n' "$YELLOW" "$*" "$OFF" >&2; }
die()  { printf '\n%s !! %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: ./deploy/bootstrap.sh --admin-key KEY --deploy-key KEY [options]

Required:
  --admin-key KEY     Public SSH key for you. Keep the private half on your laptop.
  --deploy-key KEY    Public SSH key for CI. Private half goes to a GitHub secret.

Options:
  --mode public|vpn   Default public.
  --site ADDR         What browsers will type. Defaults to this host's public IP.
  --app-dir PATH      Default /opt/metaclaude.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-key)  ADMIN_KEY="${2:-}"; shift 2 ;;
    --deploy-key) DEPLOY_KEY="${2:-}"; shift 2 ;;
    --mode)       MODE="${2:-}"; shift 2 ;;
    --site)       SITE="${2:-}"; shift 2 ;;
    --app-dir)    APP_DIR="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            usage; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root"
if [ -z "$ADMIN_KEY" ] || [ -z "$DEPLOY_KEY" ]; then
  usage
  die "both keys are required"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "1/5  Provisioning the host"
# ─────────────────────────────────────────────────────────────────────────────

EXTRA=(--mode "$MODE" --app-dir "$APP_DIR")
"$REPO_ROOT/deploy/provision.sh" \
  --admin-key "$ADMIN_KEY" --deploy-key "$DEPLOY_KEY" "${EXTRA[@]}"

# ─────────────────────────────────────────────────────────────────────────────
step "2/5  Installing the application files"
# ─────────────────────────────────────────────────────────────────────────────

"$REPO_ROOT/deploy/install-app.sh" --app-dir "$APP_DIR"

# ─────────────────────────────────────────────────────────────────────────────
step "3/5  Configuration"
# ─────────────────────────────────────────────────────────────────────────────

ENV_FILE="$APP_DIR/.env"

if [ -z "$SITE" ]; then
  # Ask the host itself rather than an external service: the answer is what
  # Caddy will be asked to certify, and a wrong value there is an outage.
  SITE="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  [ -n "$SITE" ] || die "could not determine this host's public address; pass --site"
  info "detected address: $SITE"
fi

# Compose interpolates the values in .env before handing them to the container.
# Written raw, a token containing a dollar sign is expanded against the
# environment on the way through: `sk-ant-oat01-$HOME-x` arrives as
# `sk-ant-oat01-/root-x`, and the only symptom is that authentication fails with
# nothing in any log to say why. An unknown name expands to nothing at all, so
# the character simply disappears from a password.
#
# A value that *begins* with a quote is worse than mangled — the parser reads an
# unterminated quoted value and rejects the entire file, so one such password
# takes every other setting down with it.
#
# Double quotes make the leading-quote case unremarkable, and inside them
# doubling the dollar is what compose reads back as one. Escape order matters:
# backslashes first, or the ones added for the quotes get doubled too.
env_quote() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//\$/\$\$}"
  printf '"%s"' "$v"
}

set_env() {
  local key="$1" quoted
  quoted="$(env_quote "$2")"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # `|` as the delimiter, and the value passed through the environment rather
    # than interpolated, so a token containing / or & cannot corrupt the file.
    VALUE="$quoted" perl -pi -e "s|^\Q${key}\E=.*|${key}=\$ENV{VALUE}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$quoted" >> "$ENV_FILE"
  fi
}

# Anything that can be generated, is. A prompt is reserved for what only the
# operator knows.
MASTER_KEY="$(openssl rand -hex 32)"

printf '\n'
printf '  %sThe Claude token.%s Run `claude setup-token` on a machine where you are\n' "$BOLD" "$OFF"
printf '  signed in to Claude Code, and paste the result. This is what bills the\n'
printf '  agent against your Pro/Max subscription instead of per-token API usage.\n'
printf '  Leave it empty to fill in later; agent runs will fail until you do.\n\n'
read -r -p "  CLAUDE_CODE_OAUTH_TOKEN: " CLAUDE_TOKEN

printf '\n  %sThe owner account%s created on first boot.\n\n' "$BOLD" "$OFF"
read -r -p "  username [owner]: " OWNER_USER
OWNER_USER="${OWNER_USER:-owner}"

while :; do
  read -r -s -p "  password (12+ chars): " OWNER_PASS; printf '\n'
  [ "${#OWNER_PASS}" -ge 12 ] || { warn "at least 12 characters"; continue; }
  read -r -s -p "  again: " OWNER_PASS2; printf '\n'
  [ "$OWNER_PASS" = "$OWNER_PASS2" ] && break
  warn "they do not match"
done

set_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
set_env METACLAUDE_BOOTSTRAP_USER "$OWNER_USER"
set_env METACLAUDE_BOOTSTRAP_PASSWORD "$OWNER_PASS"
set_env METACLAUDE_MASTER_KEY "$MASTER_KEY"
set_env METACLAUDE_SITE "$SITE"
set_env METACLAUDE_TLS_MODE "internal"
# Chrome refuses QUIC against a locally-signed certificate, so under `internal`
# advertising h3 only buys a declined handshake and an open UDP port.
set_env METACLAUDE_PROTOCOLS "h1 h2"

if [ "$MODE" = "public" ]; then
  set_env METACLAUDE_BIND "0.0.0.0"
else
  BIND="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "$BIND" ] || die "vpn mode: could not read a Tailscale address. Run 'tailscale up' first."
  set_env METACLAUDE_BIND "$BIND"
  info "binding to the tailnet address $BIND"
fi

chmod 0640 "$ENV_FILE"
info "wrote $ENV_FILE"

# ─────────────────────────────────────────────────────────────────────────────
step "4/5  Starting"
# ─────────────────────────────────────────────────────────────────────────────

cd "$APP_DIR"
docker compose up -d --wait --wait-timeout 300 || {
  docker compose logs --tail 40
  die "the stack did not come up healthy — logs above"
}

for _ in $(seq 1 30); do
  if curl -fsS -k --max-time 5 https://127.0.0.1/api/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS -k --max-time 10 https://127.0.0.1/api/health \
  || die "the proxy is up but the health endpoint does not answer"
printf '\n'
info "health endpoint answers"

# ─────────────────────────────────────────────────────────────────────────────
step "5/5  What to do next"
# ─────────────────────────────────────────────────────────────────────────────

CA_FILE="/root/metaclaude-ca.crt"
docker compose exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > "$CA_FILE" 2>/dev/null || true

cat <<DONE

  ${BOLD}https://${SITE}${OFF}

  Sign in as ${BOLD}${OWNER_USER}${OFF}, then turn on two-factor authentication
  immediately — Settings → Two-factor authentication. One screen.

  ${BOLD}Your browser will warn the first time.${OFF} Caddy signed with its own
  authority, because a bare IP has no other way to get a certificate. Install it
  once per device:

    scp mcadmin@${SITE}:${CA_FILE} .

    macOS    open it, add to the login keychain, set to "Always Trust"
    iPhone   TWO steps, and skipping the second is the usual mistake:
             1. Settings → Profile Downloaded → Install
             2. Settings → General → About → Certificate Trust Settings,
                then enable full trust. Without this the origin is not
                secure and the PWA will not install.
    Android  Settings → Security → Encryption → Install a certificate → CA

  ${BOLD}Write this down somewhere that is not this server:${OFF}

    METACLAUDE_MASTER_KEY=${MASTER_KEY}

  It encrypts every stored MCP credential. It currently exists only in
  ${ENV_FILE}, on the same disk as the database it protects. Restoring a backup
  without it does not fail loudly — the server starts, reports healthy, and the
  credentials are simply gone.

  ${BOLD}Then, from your laptop:${OFF}

    ./deploy/verify.sh ${SITE} --ipv6 <your-ipv6>

  On-box tools agree with themselves. Only a probe from elsewhere settles
  whether the firewall is actually closed.

DONE
