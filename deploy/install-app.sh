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

# root owns everything the deploy account executes or is constrained by. A
# stolen CI key must not be able to rewrite its own forced command, nor the
# compose file that confines the container it starts.
install -d -m 0755 -o root -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 0755 -o root -g root "$APP_DIR/bin" "$APP_DIR/docker" "$APP_DIR/docker/tls"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/releases"
install -d -m 0750 -o root -g "$DEPLOY_USER" "$APP_DIR/docker/certs"

install -m 0644 -o root -g root "$REPO_ROOT/compose.yml"      "$APP_DIR/compose.yml"
install -m 0644 -o root -g root "$REPO_ROOT/docker/Caddyfile" "$APP_DIR/docker/Caddyfile"
for snippet in "$REPO_ROOT"/docker/tls/*.caddy; do
  install -m 0644 -o root -g root "$snippet" "$APP_DIR/docker/tls/$(basename "$snippet")"
done
install -m 0755 -o root -g root "$REPO_ROOT/deploy/bin/metaclaude-deploy" "$APP_DIR/bin/metaclaude-deploy"
install -m 0755 -o root -g root "$REPO_ROOT/deploy/bin/metaclaude-updater" "$APP_DIR/bin/metaclaude-updater"

info "compose.yml        $(sha256sum "$APP_DIR/compose.yml" | cut -c1-16)  root:root 0644"
info "docker/Caddyfile   $(sha256sum "$APP_DIR/docker/Caddyfile" | cut -c1-16)  root:root 0644"
info "docker/tls/        $(ls -1 "$APP_DIR/docker/tls" | tr '\n' ' ')"
info "bin/metaclaude-deploy                   root:root 0755 — deploy cannot write it"
info "bin/metaclaude-updater                  root:root 0755 — consumes in-app update requests"

# ─────────────────────────────────────────────────────────────────────────────

step "Deploy policy"

if [ -z "$IMAGE_PREFIX" ]; then
  remote="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo '')"
  # Accepts both https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
  slug="$(printf '%s' "$remote" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  [ -n "$slug" ] || die "could not derive the image prefix from the git remote; pass --image-prefix"
  IMAGE_PREFIX="ghcr.io/$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"
fi

# Read-only to the deploy account: it names the images that account may pull,
# so it must not be one the account can edit.
cat > "$APP_DIR/deploy.conf" <<CONF
# Read by bin/metaclaude-deploy. Written by install-app.sh.

# The only images this server will pull. Narrow on purpose: the deploy account
# is in the docker group, so being able to run an arbitrary image here is being
# able to run anything as root. A stolen CI key must not buy that.
ALLOWED_IMAGE_PREFIX="$IMAGE_PREFIX"

# How long a new container may take to report healthy before it is rolled back.
HEALTH_TIMEOUT_SECONDS=180
CONF
chown root:"$DEPLOY_USER" "$APP_DIR/deploy.conf"
chmod 0640 "$APP_DIR/deploy.conf"
info "images restricted to $IMAGE_PREFIX*"

# ─────────────────────────────────────────────────────────────────────────────

step "In-app updates"

# The exchange directory of the in-app update button. The container (uid
# 10001) writes request.json into it; the updater unit, running as the deploy
# account, consumes the request and writes status.json back. Group-writable
# and nothing more — neither side can touch the other's binaries or config.
install -d -m 0770 -o 10001 -g "$DEPLOY_USER" "$APP_DIR/updates"

if [ -d /run/systemd/system ]; then
  # Generated rather than shipped so APP_DIR and DEPLOY_USER are the real
  # ones, the same way deploy.conf is written.
  cat > /etc/systemd/system/metaclaude-updater.service <<UNIT
# Written by Metaclaude's deploy/install-app.sh — do not edit; re-run it instead.
[Unit]
Description=Metaclaude in-app update consumer

[Service]
Type=oneshot
User=$DEPLOY_USER
Environment=METACLAUDE_APP_DIR=$APP_DIR
ExecStart=$APP_DIR/bin/metaclaude-updater
UNIT
  cat > /etc/systemd/system/metaclaude-updater.path <<UNIT
# Written by Metaclaude's deploy/install-app.sh — do not edit; re-run it instead.
[Unit]
Description=Watch for Metaclaude in-app update requests

[Path]
PathExists=$APP_DIR/updates/request.json
Unit=metaclaude-updater.service

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now metaclaude-updater.path
  # The marker is what tells the app the button may be offered: the compose
  # bind mount creates the directory on any host, but only this install
  # leaves a consumer behind it.
  : > "$APP_DIR/updates/.updater-installed"
  chown 10001:"$DEPLOY_USER" "$APP_DIR/updates/.updater-installed"
  info "updates/ exchange directory ready; metaclaude-updater.path enabled"
else
  rm -f "$APP_DIR/updates/.updater-installed"
  warn "no systemd on this host — the in-app update button stays unavailable"
fi

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
  # The admin edits it, the deploy account only reads it: it holds the Claude
  # token and the master key.
  install -m 0640 -o root -g "$DEPLOY_USER" "$REPO_ROOT/.env.example" "$APP_DIR/.env"
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
    METACLAUDE_TLS_MODE         internal | acme-dns | acme-ip | file
    METACLAUDE_BIND             0.0.0.0 for a public IP, or the VPN address.
                                It defaults to 127.0.0.1, which is unreachable
                                from anywhere else — on purpose.
    METACLAUDE_MASTER_KEY       openssl rand -hex 32, and keep a copy in your
                                password manager. Left empty it is generated
                                into the same volume as the database it
                                encrypts, so one snapshot carries both.
    METACLAUDE_IMAGE            the image to run, e.g.
                                ghcr.io/<owner>/metaclaude:v1.0.0. .env.example
                                ships it empty and compose then falls back to
                                \`metaclaude:latest\`, which exists nowhere —
                                \`up\` fails with \`pull access denied\`.

  Then either push a version tag to deploy through CI, or start it by hand:

    sudo -u $DEPLOY_USER docker compose --project-directory $APP_DIR \\
      --env-file $APP_DIR/.env --env-file $APP_DIR/releases/.env.image up -d

  Both env files, in that order — the second is where a CI deploy records the
  image it chose. Omitting it on a host that has already deployed resolves
  METACLAUDE_IMAGE from .env alone and quietly reverts the box to whatever is
  written there.

DONE
