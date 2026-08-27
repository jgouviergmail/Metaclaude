#!/usr/bin/env bash
#
# Uninstall the Metaclaude application from this server.
#
#     sudo ./deploy/uninstall.sh                 # stop the stack, keep all data
#     sudo ./deploy/uninstall.sh --purge-data    # ...and delete the volumes
#     sudo ./deploy/uninstall.sh --keep-images   # leave the built images behind
#
# ── What this deliberately does NOT undo ──────────────────────────────────────
#
# provision.sh hardened the *operating system*: accounts, sshd, ufw, fail2ban,
# Docker itself. None of that is Metaclaude's to remove, and a script that
# edits sshd_config and firewall rules on its way out is a script that can lock
# you out on its way out. The dead man's switch that guards provisioning has no
# counterpart here, on purpose: the safe way to undo provisioning is the one
# provision.sh cannot offer — reinstall the OS image from your provider's
# console. Everything an uninstaller can safely remove, this removes.
#
# ── The two irreversible things, and their guards ─────────────────────────────
#
# The volumes hold the database (sessions, transcripts, the sealed vault), the
# workspaces (the agent's files), and the CLI's own session transcripts. They
# are only removed under --purge-data, and only after this script has printed
# what exists and asked. `.env` holds the master key and the Claude token; it
# is saved to a root-only file OUTSIDE the tree being deleted, because the day
# someone reinstalls, the master key is the one line that cannot be
# regenerated — restoring a database without it silently mints a new key and
# every stored MCP credential is quietly gone.

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/metaclaude}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-metaclaude}"
PURGE_DATA=0
KEEP_IMAGES=0
ASSUME_YES=0

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[ -t 1 ] || { BOLD=""; RED=""; GREEN=""; DIM=""; OFF=""; }

info()  { printf '%s*%s %s\n' "$GREEN" "$OFF" "$*"; }
skip()  { printf '%s-%s %s\n' "$DIM" "$OFF" "$*"; }
warn()  { printf '%s!%s %s\n' "$RED" "$OFF" "$*"; }
die()   { printf '%sERROR:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/uninstall.sh [options]

Options:
  --purge-data    Also delete the named volumes: the database, the sealed
                  vault, every workspace, and the CLI session transcripts.
                  Irreversible. Without it, the data survives and a later
                  reinstall picks it straight back up.
  --keep-images   Leave the metaclaude images in Docker's store.
  --yes           Do not ask for confirmation. For automation only; the
                  interactive prompt exists because --purge-data is the most
                  destructive thing this repository can do.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge-data)  PURGE_DATA=1; shift ;;
    --keep-images) KEEP_IMAGES=1; shift ;;
    --yes)         ASSUME_YES=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root: sudo ./deploy/uninstall.sh"
command -v docker >/dev/null 2>&1 || die "docker is not installed — nothing to uninstall?"

# ── Show what exists before touching any of it ────────────────────────────────

printf '\n%sWhat is currently installed%s\n' "$BOLD" "$OFF"
docker ps -a --filter "name=${COMPOSE_PROJECT}-" \
  --format '  container  {{.Names}}  ({{.Status}})' 2>/dev/null || true
docker volume ls --format '{{.Name}}' 2>/dev/null \
  | grep "^${COMPOSE_PROJECT}_" | sed 's/^/  volume     /' || true
[ -d "$APP_DIR" ] && printf '  files      %s\n' "$APP_DIR"

if [ "$PURGE_DATA" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n%s--purge-data will delete the volumes above:%s the database, the sealed\n' "$RED" "$OFF"
  printf 'vault, every workspace the agent has written, and the CLI session\n'
  printf 'transcripts. There is no undo. Back up first (docs/DEPLOYMENT.md, Backups).\n\n'
  printf 'Type exactly "delete my data" to continue: '
  read -r answer
  [ "$answer" = "delete my data" ] || die "not confirmed — nothing was removed"
fi

# ── 1. Stop the stack ─────────────────────────────────────────────────────────

if [ -f "$APP_DIR/compose.yml" ]; then
  # The image env file may not exist on a host that never CI-deployed; compose
  # refuses a missing --env-file, so only pass it when it is real.
  compose_args=(--project-directory "$APP_DIR")
  [ -f "$APP_DIR/releases/.env.image" ] \
    && compose_args+=(--env-file "$APP_DIR/.env" --env-file "$APP_DIR/releases/.env.image")
  if [ "$PURGE_DATA" -eq 1 ]; then
    docker compose "${compose_args[@]}" down -v --remove-orphans
    info "stack stopped and volumes removed"
  else
    docker compose "${compose_args[@]}" down --remove-orphans
    info "stack stopped — volumes kept"
  fi
else
  # No compose file to drive it with; take the containers down directly, and
  # the volumes only under the flag.
  ids="$(docker ps -aq --filter "name=${COMPOSE_PROJECT}-" 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086  # ids are one-per-line container ids
    docker rm -f $ids >/dev/null && info "containers removed"
  else
    skip "no containers found"
  fi
  if [ "$PURGE_DATA" -eq 1 ]; then
    vols="$(docker volume ls --format '{{.Name}}' | grep "^${COMPOSE_PROJECT}_" || true)"
    if [ -n "$vols" ]; then
      # shellcheck disable=SC2086
      docker volume rm $vols >/dev/null && info "volumes removed"
    else
      skip "no volumes found"
    fi
  fi
fi

if [ "$PURGE_DATA" -ne 1 ]; then
  skip "volumes kept: $(docker volume ls --format '{{.Name}}' | grep -c "^${COMPOSE_PROJECT}_" || true) remain — a reinstall picks them up as-is"
fi

# ── 2. Save the secrets, then remove the application files ────────────────────

# The in-app updater units go with the files they point at — leaving a path
# unit watching a directory this script is about to delete would fire on
# nothing forever, or worse, on a future unrelated install.
if [ -d /run/systemd/system ]; then
  systemctl disable --now metaclaude-updater.path >/dev/null 2>&1 || true
  systemctl disable --now metaclaude-backup.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/metaclaude-updater.service /etc/systemd/system/metaclaude-updater.path \
        /etc/systemd/system/metaclaude-backup.service /etc/systemd/system/metaclaude-backup.timer
  systemctl daemon-reload
  info "removed the metaclaude-updater and metaclaude-backup systemd units"
fi

# Where the backup archives live — read from deploy.conf before the tree
# holding it is deleted, so the closing summary can name the right place.
#
# Guarded, not piped-and-hoped: under `set -Eeuo pipefail` an assignment from
# a failing command substitution exits the script, so on a host with no
# deploy.conf the one-liner version of this died HERE — after the units were
# removed, before the .env was saved and the tree deleted. CI's uninstall
# rehearsal caught it; local runs skip that section without root and did not.
BACKUP_DIR="/var/backups/metaclaude"
if [ -f "$APP_DIR/deploy.conf" ]; then
  conf_dir="$(sed -n 's/^METACLAUDE_BACKUP_DIR=//p' "$APP_DIR/deploy.conf" | tail -1)"
  conf_dir="${conf_dir%\"}"; conf_dir="${conf_dir#\"}"
  if [ -n "$conf_dir" ]; then BACKUP_DIR="$conf_dir"; fi
fi

if [ -f "$APP_DIR/.env" ]; then
  # Outside $APP_DIR, mode 0600, because the master key inside it is the one
  # value that cannot be regenerated. Deleting it with the tree turns a clean
  # uninstall into silent credential loss at the next install.
  saved="/root/metaclaude-env-$(date -u +%Y%m%d-%H%M%S).bak"
  install -m 0600 -o root -g root "$APP_DIR/.env" "$saved"
  info "saved .env (master key, Claude token) to $saved — delete it yourself once sure"
fi

if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR"
  info "removed $APP_DIR"
else
  skip "$APP_DIR does not exist"
fi

# ── 3. Images ─────────────────────────────────────────────────────────────────

if [ "$KEEP_IMAGES" -ne 1 ]; then
  imgs="$(docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E '^(metaclaude:|ghcr\.io/.*/metaclaude:)' || true)"
  if [ -n "$imgs" ]; then
    # shellcheck disable=SC2086
    docker rmi -f $imgs >/dev/null 2>&1 || true
    info "removed images: $(printf '%s' "$imgs" | tr '\n' ' ')"
  else
    skip "no metaclaude images found"
  fi
fi

# ── What remains, said plainly ────────────────────────────────────────────────

printf '\n%sDone.%s Still on this machine, deliberately:\n' "$BOLD" "$OFF"
cat <<REMAINS
  - the OS hardening from provision.sh: accounts mcadmin/mcdeploy, sshd
    settings, ufw rules, fail2ban, unattended-upgrades, Docker itself.
    Undoing that safely means reinstalling the OS image from your provider.
  - any clone of the repository under a home directory (remove it yourself).
$( [ "$PURGE_DATA" -ne 1 ] && echo '  - the named volumes: your data survives, and a reinstall resumes from it.' )
$( [ -d "$BACKUP_DIR" ] && echo "  - the backup archives in $BACKUP_DIR — they outlive even --purge-data;" \
   && echo '    delete them yourself once you are sure.' )
REMAINS
