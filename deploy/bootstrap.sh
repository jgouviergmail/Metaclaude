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
TLS_EMAIL=""
IMAGE=""
BUILD=0
APP_DIR="/opt/metaclaude"
EXTRA=()

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi
step() { printf '\n%s━━ %s%s%s\n' "$GREEN" "$BOLD" "$*" "$OFF"; }
info() { printf '    %s\n' "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$OFF"; }
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
  --site ADDR         What browsers will type. A hostname that already resolves
                      here gets a publicly trusted Let's Encrypt certificate; a
                      bare IP falls back to Caddy's own CA, which every device
                      must then be taught to trust. Defaults to this host's IP.
  --email ADDR        Required with a hostname: where Let's Encrypt sends expiry
                      warnings. Never shown to visitors.
  --image REF         Container image to run. Defaults to the GHCR image CI
                      built for this checkout's commit, so what runs is the code
                      you are standing on. If that image cannot be pulled, the
                      same code is built here instead — no token, ever.
  --build             Skip the registry and build the image on this machine.
                      Slower, needs no network beyond the base image, and is
                      the only way to deploy an uncommitted change.
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
    --email)      TLS_EMAIL="${2:-}"; shift 2 ;;
    --image)      IMAGE="${2:-}"; shift 2 ;;
    --build)      BUILD=1; shift ;;
    --app-dir)    APP_DIR="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            usage; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root"

# An empty value here is almost never a forgotten flag. It is
# `--admin-key "$(cat ~/.ssh/metaclaude_admin.pub)"` where the file is not on
# this machine: cat writes its complaint to stderr, the substitution yields
# nothing, and the flag arrives present but empty. "both keys are required" then
# reads like an accusation of not passing them.
for pair in "admin:$ADMIN_KEY" "deploy:$DEPLOY_KEY"; do
  case "${pair#*:}" in
    "")
      usage
      die "--${pair%%:*}-key is empty.
     If you used \"\$(cat ~/.ssh/…​.pub)\", that file is not on this machine —
     the keys live wherever you generated them. Paste the public key itself:

       --${pair%%:*}-key \"ssh-ed25519 AAAA… comment\"" ;;
    ssh-ed25519*|ssh-rsa*|ecdsa-sha2-*|sk-ssh-ed25519*|sk-ecdsa-sha2-*) ;;
    *)
      die "--${pair%%:*}-key does not look like an SSH *public* key.
     It must be one line beginning with ssh-ed25519 (or ssh-rsa). A path is not
     accepted here, and the private half — the file without .pub, starting
     '-----BEGIN OPENSSH PRIVATE KEY-----' — must never leave your machine." ;;
  esac
done

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
#
# Except this one, which is generated exactly once. Minting a fresh key on a
# re-run and writing it over the old one is silent, total data loss: every
# stored MCP credential was encrypted under the previous key, and nothing
# fails — the server starts, reports healthy, and the secrets are simply gone.
# A re-run is the normal way to fix a half-finished deploy, so it must not be
# the way to destroy one.
MASTER_KEY="$(sed -n 's/^METACLAUDE_MASTER_KEY="\{0,1\}\([0-9a-fA-F]\{64\}\)"\{0,1\}$/\1/p' \
  "$ENV_FILE" 2>/dev/null | head -1)"
if [ -n "$MASTER_KEY" ]; then
  MASTER_KEY_REUSED="yes"
  info "keeping the encryption key already in $ENV_FILE"
else
  MASTER_KEY_REUSED="no"
  MASTER_KEY="$(openssl rand -hex 32)"
fi

# Reads a value back out of .env, undoing exactly what env_quote did to it.
#
# Re-running this script is the normal way to finish a deploy that stopped, and
# it used to demand every answer again — including a hundred-character token,
# retyped on a console whose keyboard layout does not match the operator's. The
# values are already on disk. Asking for them a second time is not a safeguard,
# it is an obstacle, and it is where people give up.
#
# Unescape in the reverse order to env_quote: dollars, then quotes, then
# backslashes. Any other order corrupts a value containing more than one of them.
get_env() {
  local raw
  raw="$(sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1)"
  case "$raw" in
    '"'*'"')
      raw="${raw#\"}"; raw="${raw%\"}"
      raw="${raw//\$\$/\$}"; raw="${raw//\\\"/\"}"; raw="${raw//\\\\/\\}" ;;
  esac
  printf '%s' "$raw"
}

OLD_TOKEN="$(get_env CLAUDE_CODE_OAUTH_TOKEN)"
OLD_USER="$(get_env METACLAUDE_BOOTSTRAP_USER)"
OLD_PASS="$(get_env METACLAUDE_BOOTSTRAP_PASSWORD)"

printf '\n'
if [ -n "$OLD_TOKEN" ]; then
  printf '  %sThe Claude token%s is already set (%s characters). Press Enter to keep it,\n' \
    "$BOLD" "$OFF" "${#OLD_TOKEN}"
  printf '  or paste a new one to replace it.\n\n'
  read -r -p "  CLAUDE_CODE_OAUTH_TOKEN [keep]: " CLAUDE_TOKEN
  CLAUDE_TOKEN="${CLAUDE_TOKEN:-$OLD_TOKEN}"
else
  printf '  %sThe Claude token.%s Run `claude setup-token` on a machine where you are\n' "$BOLD" "$OFF"
  printf '  signed in to Claude Code, and paste the result. This is what bills the\n'
  printf '  agent against your Pro/Max subscription instead of per-token API usage.\n'
  printf '  Leave it empty to fill in later; agent runs will fail until you do.\n\n'
  read -r -p "  CLAUDE_CODE_OAUTH_TOKEN: " CLAUDE_TOKEN
fi

printf '\n  %sThe owner account%s created on first boot.\n\n' "$BOLD" "$OFF"
read -r -p "  username [${OLD_USER:-owner}]: " OWNER_USER
OWNER_USER="${OWNER_USER:-${OLD_USER:-owner}}"

# Only the account's first creation needs a password typed. Once one is stored,
# an empty answer keeps it — the account already exists in the database anyway,
# and this variable no longer changes it.
if [ -n "$OLD_PASS" ]; then
  read -r -s -p "  password (Enter to keep the current one): " OWNER_PASS; printf '\n'
  if [ -z "$OWNER_PASS" ]; then
    OWNER_PASS="$OLD_PASS"
    info "keeping the password already configured"
  fi
fi

# Every failing path clears OWNER_PASS, because the loop's condition is what
# decides whether to ask again: leaving a rejected value in place would exit the
# loop with the very password that was just refused.
while [ -z "${OWNER_PASS:-}" ]; do
  read -r -s -p "  password (12+ chars): " OWNER_PASS; printf '\n'
  if [ "${#OWNER_PASS}" -lt 12 ]; then
    warn "at least 12 characters"; OWNER_PASS=""; continue
  fi
  read -r -s -p "  again: " OWNER_PASS2; printf '\n'
  if [ "$OWNER_PASS" != "$OWNER_PASS2" ]; then
    warn "they do not match"; OWNER_PASS=""; continue
  fi
done

set_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
set_env METACLAUDE_BOOTSTRAP_USER "$OWNER_USER"
set_env METACLAUDE_BOOTSTRAP_PASSWORD "$OWNER_PASS"
set_env METACLAUDE_MASTER_KEY "$MASTER_KEY"
set_env METACLAUDE_SITE "$SITE"

# A hostname and a bare IP are not the same deployment, and the difference is
# not cosmetic — it decides whether a browser trusts the certificate at all.
#
# With a name that resolves here, Let's Encrypt will issue for it over http-01,
# which is publicly trusted: nothing to install on any device, the PWA installs
# on iOS, and HSTS is meaningful from the first visit. With only an IP, Caddy
# signs with its own CA and every device has to be taught to trust it.
#
# Detected rather than asked, because the answer is already in --site.
HOST_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)"

if printf '%s' "$SITE" | grep -qE '^[0-9]+(\.[0-9]+){3}$|:'; then
  set_env METACLAUDE_TLS_MODE "internal"
  # Chrome refuses QUIC against a locally-signed certificate, so under
  # `internal` advertising h3 only buys a declined handshake and an open UDP
  # port.
  set_env METACLAUDE_PROTOCOLS "h1 h2"
  # The site *is* the address, so there is no second one to keep alive. The
  # alternate block stays on its inert, unresolvable default — it must not be
  # `localhost`, which would collide with the site's own default.
  set_env METACLAUDE_ALT_SITE "alt.metaclaude.invalid"
  set_env METACLAUDE_SNI_DEFAULT "$SITE"
  info "TLS: internal (a bare address has no other option) — install the CA on each device"
else
  [ -n "$TLS_EMAIL" ] || die "--site $SITE is a hostname, so ACME needs --email for expiry notices"
  set_env METACLAUDE_TLS_MODE "acme-dns"
  set_env METACLAUDE_TLS_EMAIL "$TLS_EMAIL"
  # A publicly trusted certificate is the one case where advertising HTTP/3
  # actually gets used, and a phone on a weak connection is where it pays.
  set_env METACLAUDE_PROTOCOLS "h1 h2 h3"
  info "TLS: Let's Encrypt for $SITE — nothing to install on any device"
  info "     the name must already resolve to this server, and 80/443 must be reachable"

  # Keep the address working too. Until the domain existed, the IP was the only
  # way in; moving the certificate to the name without this turns every
  # bookmark, every saved PWA and the emergency route into a handshake failure —
  # which is exactly what happened, and it is not a trade the operator agreed to.
  if [ -n "$HOST_IP" ]; then
    set_env METACLAUDE_ALT_SITE "$HOST_IP"
    set_env METACLAUDE_SNI_DEFAULT "$HOST_IP"
    info "     https://$HOST_IP keeps working under the internal CA"
  else
    set_env METACLAUDE_ALT_SITE "alt.metaclaude.invalid"
    set_env METACLAUDE_SNI_DEFAULT "$SITE"
    warn "could not detect this host's IPv4; only $SITE will be reachable"
  fi
fi

# Sized from this host rather than left at the conservative default. The default
# has to be startable on the smallest VPS anyone might use, which would otherwise
# cap a large server at 2 cores and 2 GB for no reason.
#
# Docker refuses outright to create a container whose cpus limit exceeds the
# host's core count, so this value must come from the machine, never a guess.
CPU_TOTAL="$(nproc 2>/dev/null || echo 2)"
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 2097152)"
# Three quarters of RAM, floored at 1 GB: the rest is the host, Caddy, and the
# page cache the database reads through.
MEM_LIMIT_MB=$(( MEM_KB * 3 / 4 / 1024 ))
[ "$MEM_LIMIT_MB" -lt 1024 ] && MEM_LIMIT_MB=1024
set_env METACLAUDE_CPU_LIMIT "$CPU_TOTAL"
set_env METACLAUDE_MEMORY_LIMIT "${MEM_LIMIT_MB}m"
info "resource limits: ${CPU_TOTAL} cpus, ${MEM_LIMIT_MB}m memory"
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
# Which image, and how this host is allowed to pull it
# ─────────────────────────────────────────────────────────────────────────────
#
# compose.yml defaults METACLAUDE_IMAGE to `metaclaude:latest`, which exists
# nowhere. Nothing set it and nothing logged in to the registry, so `up` failed
# with `pull access denied` — after provisioning, with the firewall already
# armed and the operator's shell already closed.
#
# The tag is this checkout's own commit. CI publishes `sha-<commit>` for every
# push, so deploying the commit you are standing on is the one choice that
# cannot silently run different code from the one you just read.
#
# Failing to derive it is not fatal any more: an archive download, a shallow
# copy or a checkout with no remote all land here, and every one of them still
# holds the source the image would be built from.
if [ -z "$IMAGE" ] && [ "$BUILD" -eq 0 ]; then
  REMOTE="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo '')"
  SLUG="$(printf '%s' "$REMOTE" | sed -E 's#^.*github\.com[:/]##; s#\.git$##' | tr '[:upper:]' '[:lower:]')"
  COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo '')"
  if [ -n "$SLUG" ] && [ -n "$COMMIT" ]; then
    IMAGE="ghcr.io/${SLUG}:sha-${COMMIT}"
  else
    note "no git remote here to name a published image — building from source"
    BUILD=1
  fi
fi
if [ "$BUILD" -eq 0 ]; then info "image: $IMAGE"; fi

# Building here rather than pulling. The source is already on this machine —
# the script is being run out of the checkout — so the registry is a
# convenience, never a requirement.
build_locally() {
  command -v docker >/dev/null || die "docker is not installed"
  [ -f "$REPO_ROOT/docker/Dockerfile" ] \
    || die "no docker/Dockerfile in $REPO_ROOT — is this a full checkout?"

  # The web build runs Vite and Rollup in Node. On a 1 GB box with no swap the
  # OOM killer takes the process and Docker reports only `exit code 137`, which
  # says nothing about why. Warn before the twenty minutes are spent.
  if [ "$MEM_KB" -lt 1800000 ]; then
    SWAP_KB="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    if [ "${SWAP_KB:-0}" -lt 512000 ]; then
      warn "this host has $(( MEM_KB / 1024 ))m of memory and little swap"
      note "The bundler may be OOM-killed (docker reports a bare 'exit code 137')."
      note "If that happens, add swap and re-run:"
      note "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
    fi
  fi

  IMAGE="metaclaude:local"
  info "building $IMAGE from $REPO_ROOT — this takes a few minutes"
  docker build -f "$REPO_ROOT/docker/Dockerfile" -t "$IMAGE" "$REPO_ROOT" \
    || die "the image did not build — the error is above"
  info "image built"
}

if [ "$BUILD" -eq 1 ]; then
  build_locally
else
  case "$IMAGE" in
    ghcr.io/*)
      # A package attached to a private repository is private too, so an
      # anonymous pull gets denied. Try first — if the owner has made the
      # package public, or `docker login ghcr.io` has already been run here,
      # this is the whole story.
      if docker pull "$IMAGE" >/dev/null 2>&1; then
        info "image pulled"
      else
        # No token prompt. Being asked for a GitHub credential in the middle of
        # a deploy — on a machine that already holds the source it would build
        # from — is friction for nothing, and it stopped a deploy dead more than
        # once. The registry is an optimisation; the fallback is the same code.
        #
        # Still worth saying *which* failure this is, because the two look
        # identical from `docker pull` and only one of them is worth fixing.
        REPO_PATH="${IMAGE#ghcr.io/}"; REPO_PATH="${REPO_PATH%%:*}"; REPO_PATH="${REPO_PATH%%@*}"
        ANON="$(curl -sS --max-time 20 \
          "https://ghcr.io/token?scope=repository:${REPO_PATH}:pull&service=ghcr.io" 2>/dev/null \
          | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"

        printf '\n'
        if [ -n "$ANON" ]; then
          warn "$IMAGE is not in the registry"
          note "The package is public, so this is not an access problem: CI has"
          note "not published this commit — it may still be running, or it failed."
        else
          warn "$IMAGE cannot be pulled anonymously"
          note "The package is private. Note that a public *repository* does not"
          note "make its packages public — they are separate settings, and this is"
          note "the one everybody misses:"
          note "  https://github.com/users/${REPO_PATH%%/*}/packages/container/${REPO_PATH##*/}/settings"
          note "  Danger Zone -> Change visibility -> Public"
          note "Or run 'docker login ghcr.io' yourself before this script, and the"
          note "pull above will succeed."
        fi
        note "Neither is worth waiting for. Building the image here instead."
        printf '\n'
        build_locally
      fi
      ;;
  esac
fi

set_env METACLAUDE_IMAGE "$IMAGE"

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

cat <<DONE

  ${BOLD}https://${SITE}${OFF}

  Sign in as ${BOLD}${OWNER_USER}${OFF}, then turn on two-factor authentication
  immediately — Settings → Two-factor authentication. One screen.
DONE

# Only the internal CA needs installing, and saying so unconditionally taught
# operators to expect a warning that a publicly trusted certificate never shows.
if grep -q '^METACLAUDE_TLS_MODE="internal"' "$ENV_FILE"; then
  # Not /root: that directory is 0700 root:root on Debian and Ubuntu and this
  # script does not change it, so the `scp mcadmin@host:...` printed below could
  # never work. And `>` truncates before the export runs, so a failed export
  # left a 0-byte file that the next paragraph presented as the certificate.
  CA_FILE="$APP_DIR/metaclaude-ca.crt"
  if docker compose exec -T proxy cat /data/caddy/pki/authorities/local/root.crt \
       > "$CA_FILE.tmp" 2>/dev/null && [ -s "$CA_FILE.tmp" ]; then
    mv "$CA_FILE.tmp" "$CA_FILE"
    chmod 0644 "$CA_FILE"
  else
    rm -f "$CA_FILE.tmp" "$CA_FILE"
    warn "could not export the CA certificate — see docs/DEPLOYMENT.md for the manual command"
  fi
  cat <<DONE

  ${BOLD}Your browser will warn the first time.${OFF} Caddy signed with its own
  authority, because a bare address has no other way to get a certificate.
  Install it once per device:

    scp mcadmin@${SITE}:${CA_FILE} .

    macOS    open it, add to the login keychain, set to "Always Trust"
    iPhone   TWO steps, and skipping the second is the usual mistake:
             1. Settings → Profile Downloaded → Install
             2. Settings → General → About → Certificate Trust Settings,
                then enable full trust. Without this the origin is not
                secure and the PWA will not install.
    Android  Settings → Security → Encryption → Install a certificate → CA
DONE
else
  cat <<DONE

  ${BOLD}The certificate is publicly trusted${OFF} — Let's Encrypt issued it for
  ${SITE}. Nothing to install on any device, and the PWA installs on iOS.

  If the browser cannot reach it, check the name still resolves to this host and
  that 80 and 443 are open: http-01 validation needs 80, and Let's Encrypt will
  not issue without it.
DONE
fi

cat <<DONE

  ${BOLD}Write this down somewhere that is not this server:${OFF}

    METACLAUDE_MASTER_KEY=${MASTER_KEY}

  It encrypts every stored MCP credential. It currently exists only in
  ${ENV_FILE}, on the same disk as the database it protects. Restoring a backup
  without it does not fail loudly — the server starts, reports healthy, and the
  credentials are simply gone.

  $([ "$MASTER_KEY_REUSED" = yes ] \
    && echo "This is the key that was already there, not a new one: re-running this
  script never replaces it." \
    || echo "Generated just now, on this run.")

  ${BOLD}Then, from your laptop:${OFF}

    ./deploy/verify.sh ${SITE} --ipv6 <your-ipv6>

  On-box tools agree with themselves. Only a probe from elsewhere settles
  whether the firewall is actually closed.

DONE
