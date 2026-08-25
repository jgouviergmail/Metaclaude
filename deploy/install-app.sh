#!/usr/bin/env bash
#
# Install or update the files Metaclaude runs from on the server.
#
# Run from a checkout of this repository, as the administrator:
#
#     git clone https://github.com/jgouviergmail/Metaclaude.git
#     cd Metaclaude && sudo ./deploy/install-app.sh
#
# Copies compose.yml, the Caddyfile and the deploy command into $APP_DIR, and
# creates .env from the example if there is not one already.
#
# ── Why these files are not shipped inside the image ──────────────────────────
#
# It would be convenient: a release would carry its own compose file and the
# server would never drift. It would also be a hole. compose.yml is what
# confines the container — cap_drop, read_only, no host mounts — so an image
# that supplied its own could ask for `/:/host` and walk out of its own jail.
# The file that constrains the image must not come from the image.
#
# The cost is drift, and that is handled rather than ignored: `metaclaude-deploy`
# prints the checksum of what it is actually running with, and the deploy
# workflow compares it against the repository. When they differ, re-run this.

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/metaclaude}"
DEPLOY_USER="${DEPLOY_USER:-mcdeploy}"
IMAGE_PREFIX="${IMAGE_PREFIX:-}"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi
step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$OFF" "$BOLD" "$*" "$OFF"; }
info() { printf '    %s\n' "$*"; }
skip() { printf '    %s%s%s\n' "$DIM" "$*" "$OFF"; }
warn() { printf '%s !! %s%s\n' "$YELLOW" "$*" "$OFF" >&2; }
die()  { printf '\n !! %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/install-app.sh [options]

Options:
  --app-dir PATH       Where the files go (default: /opt/metaclaude).
  --deploy-user NAME   Owner of the files (default: mcdeploy).
  --image-prefix REF   Images the deploy key may pull. Defaults to the GHCR path
                       derived from this checkout's git remote.
  -h, --help           This text.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir)      APP_DIR="${2:-}"; shift 2 ;;
    --deploy-user)  DEPLOY_USER="${2:-}"; shift 2 ;;
    --image-prefix) IMAGE_PREFIX="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo ./deploy/install-app.sh)"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO_ROOT/compose.yml" ] || die "$REPO_ROOT does not look like a Metaclaude checkout"
id "$DEPLOY_USER" >/dev/null 2>&1 || die "no user '$DEPLOY_USER'. Run deploy/provision.sh first."

# ─────────────────────────────────────────────────────────────────────────────

step "Files"

install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/bin" "$APP_DIR/docker" "$APP_DIR/releases"

install -m 0640 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$REPO_ROOT/compose.yml"          "$APP_DIR/compose.yml"
install -m 0640 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$REPO_ROOT/docker/Caddyfile"     "$APP_DIR/docker/Caddyfile"
install -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$REPO_ROOT/deploy/bin/metaclaude-deploy" "$APP_DIR/bin/metaclaude-deploy"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/docker/certs"

info "compose.yml        $(sha256sum "$APP_DIR/compose.yml" | cut -c1-16)"
info "docker/Caddyfile   $(sha256sum "$APP_DIR/docker/Caddyfile" | cut -c1-16)"
info "bin/metaclaude-deploy"

# ─────────────────────────────────────────────────────────────────────────────

step "Deploy policy"

if [ -z "$IMAGE_PREFIX" ]; then
  remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo '')"
  # Accepts both https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
  slug="$(printf '%s' "$remote" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  [ -n "$slug" ] || die "could not derive the image prefix from the git remote; pass --image-prefix"
  IMAGE_PREFIX="ghcr.io/$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"
fi

cat > "$APP_DIR/deploy.conf" <<CONF
# Read by bin/metaclaude-deploy. Written by install-app.sh.

# The only images this server will pull. Narrow on purpose: the deploy account
# is in the docker group, so being able to run an arbitrary image here is being
# able to run anything as root. A stolen CI key must not buy that.
ALLOWED_IMAGE_PREFIX="$IMAGE_PREFIX"

# How long a new container may take to report healthy before it is rolled back.
HEALTH_TIMEOUT_SECONDS=180
CONF
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/deploy.conf"
chmod 0640 "$APP_DIR/deploy.conf"
info "images restricted to $IMAGE_PREFIX*"

# ─────────────────────────────────────────────────────────────────────────────

step "Configuration"

if [ -f "$APP_DIR/.env" ]; then
  skip ".env exists — left untouched"
  # Flag anything the example has grown that this .env has not, so a new
  # setting does not silently take its default forever.
  missing=""
  while IFS= read -r key; do
    grep -q "^${key}=" "$APP_DIR/.env" || missing="$missing $key"
  done < <(grep -oE '^[A-Z_][A-Z0-9_]*=' "$REPO_ROOT/.env.example" | tr -d '=')
  [ -n "$missing" ] && warn "new settings in .env.example not present in your .env:$missing"
else
  install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$REPO_ROOT/.env.example" "$APP_DIR/.env"
  info "created $APP_DIR/.env from the example"
  warn "it has no Claude token yet — agent runs will fail until you set one."
fi

# ─────────────────────────────────────────────────────────────────────────────

step "Ready"

cat <<DONE

  ${BOLD}Installed into $APP_DIR${OFF}

  Before the first deployment, edit ${BOLD}$APP_DIR/.env${OFF} and set:

    CLAUDE_CODE_OAUTH_TOKEN     from \`claude setup-token\` on a machine
                                where you are signed in
    METACLAUDE_BOOTSTRAP_USER   the owner account to create on first boot
    METACLAUDE_BOOTSTRAP_PASSWORD
    METACLAUDE_SITE             this server's IP, or a hostname
    METACLAUDE_TLS              internal | <email> | <cert> <key>

  Then either push a version tag to deploy through CI, or start it by hand:

    sudo -u $DEPLOY_USER docker compose --project-directory $APP_DIR up -d

DONE
