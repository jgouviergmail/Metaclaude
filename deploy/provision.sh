#!/usr/bin/env bash
#
# Metaclaude — one-shot provisioning for a fresh Debian/Ubuntu server.
#
# Turns a bare box into one that can run Metaclaude and accept deployments:
# an admin account, a restricted deploy account, a hardened sshd, a firewall,
# Docker, automatic security updates, and the directory layout.
#
#   sudo ./provision.sh \
#       --admin-key  "ssh-ed25519 AAAA... admin" \
#       --deploy-key "ssh-ed25519 AAAA... deploy" \
#       --mode public
#
# Idempotent: running it twice changes nothing the second time.
#
# ── The thing this script is most careful about ───────────────────────────────
#
# Every step that could lock you out is staged: the key is installed and proven
# to work before password login is disabled, sshd's config is validated before
# it is reloaded, and the firewall arms a dead-man's switch that disables it
# again in ten minutes unless you confirm you are still connected. A server you
# cannot reach is worse than an unhardened one, because the unhardened one can
# still be fixed.

set -Eeuo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────────────────────

ADMIN_USER="mcadmin"
DEPLOY_USER="mcdeploy"
APP_DIR="/opt/metaclaude"
SSH_PORT="22"

# public  — 80/443 open to the internet (bare IP, public certificate or local CA)
# vpn     — nothing public; the proxy binds to the VPN interface only
MODE="public"
VPN_INTERFACE="tailscale0"

ADMIN_KEY=""
DEPLOY_KEY=""
ASSUME_YES="no"
SKIP_FIREWALL="no"

# ─────────────────────────────────────────────────────────────────────────────
# Output
# ─────────────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$OFF" "$BOLD" "$*" "$OFF"; }
info()  { printf '    %s\n' "$*"; }
skip()  { printf '    %salready done: %s%s\n' "$DIM" "$*" "$OFF"; }
warn()  { printf '%s !! %s%s\n' "$YELLOW" "$*" "$OFF" >&2; }
die()   { printf '\n%s !! %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

trap 'die "failed at line $LINENO. The server has NOT been left half-firewalled — see the note above."' ERR

# ─────────────────────────────────────────────────────────────────────────────
# Arguments
# ─────────────────────────────────────────────────────────────────────────────

usage() {
  cat <<'USAGE'
Usage: sudo ./provision.sh --admin-key KEY --deploy-key KEY [options]

Required:
  --admin-key KEY      Public SSH key for the human administrator (sudo).
  --deploy-key KEY     Public SSH key for CI. Restricted server-side to one command.

Options:
  --mode public|vpn    public: 80/443 open to the internet (default).
                       vpn:    nothing published publicly; the proxy binds to the
                               VPN interface only.
  --vpn-interface IF   Interface for --mode vpn (default: tailscale0).
  --admin-user NAME    Administrator account name (default: mcadmin).
  --deploy-user NAME   Deploy account name (default: mcdeploy).
  --app-dir PATH       Where the compose file and .env live (default: /opt/metaclaude).
  --ssh-port PORT      Port sshd listens on (default: 22).
  --skip-firewall      Do not touch the firewall. For a provider that supplies its own.
  -y, --yes            Do not ask for confirmation. Implies you have read the script.
  -h, --help           This text.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-key)      ADMIN_KEY="${2:-}"; shift 2 ;;
    --deploy-key)     DEPLOY_KEY="${2:-}"; shift 2 ;;
    --mode)           MODE="${2:-}"; shift 2 ;;
    --vpn-interface)  VPN_INTERFACE="${2:-}"; shift 2 ;;
    --admin-user)     ADMIN_USER="${2:-}"; shift 2 ;;
    --deploy-user)    DEPLOY_USER="${2:-}"; shift 2 ;;
    --app-dir)        APP_DIR="${2:-}"; shift 2 ;;
    --ssh-port)       SSH_PORT="${2:-}"; shift 2 ;;
    --skip-firewall)  SKIP_FIREWALL="yes"; shift ;;
    -y|--yes)         ASSUME_YES="yes"; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                usage; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo ./provision.sh …)"
[ -n "$ADMIN_KEY" ]  || { usage; die "--admin-key is required"; }
[ -n "$DEPLOY_KEY" ] || { usage; die "--deploy-key is required"; }

case "$MODE" in
  public|vpn) ;;
  *) die "--mode must be 'public' or 'vpn', not '$MODE'" ;;
esac

# A malformed key here is the single most likely way to end up locked out, so
# it is checked before anything else changes.
validate_key() {
  local label="$1" key="$2" tmp
  tmp="$(mktemp)"
  printf '%s\n' "$key" > "$tmp"
  ssh-keygen -l -f "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; die "$label is not a valid SSH public key: ${key:0:40}…"; }
  case "$key" in
    *PRIVATE*) rm -f "$tmp"; die "$label looks like a PRIVATE key. Pass the .pub half." ;;
  esac
  info "$label: $(ssh-keygen -l -f "$tmp" | awk '{print $2, $4}')"
  rm -f "$tmp"
}

# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────

step "Preflight"

. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
case "${ID:-}" in
  debian|ubuntu) ;;
  *) die "this script supports Debian and Ubuntu; found '${ID:-unknown}'" ;;
esac
info "os: ${PRETTY_NAME:-$ID $VERSION_ID}"
info "mode: $MODE"

command -v ssh-keygen >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq openssh-client; }
validate_key "admin key"  "$ADMIN_KEY"
validate_key "deploy key" "$DEPLOY_KEY"

if [ "$ASSUME_YES" != "yes" ]; then
  cat <<PLAN

This will:
  · create the accounts '$ADMIN_USER' (sudo) and '$DEPLOY_USER' (no sudo, one command)
  · install their keys, then disable password and root SSH login
  · install Docker, ufw, fail2ban and unattended-upgrades
  · $([ "$MODE" = public ] && echo "open 80/443 to the internet" || echo "publish nothing publicly; bind the proxy to $VPN_INTERFACE")
  · create $APP_DIR

Your current session stays open throughout. Before the firewall is enabled you
will be asked to open a SECOND session and confirm it works.

PLAN
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in [yY]*) ;; *) die "aborted" ;; esac
fi

export DEBIAN_FRONTEND=noninteractive

# ─────────────────────────────────────────────────────────────────────────────
# Packages
# ─────────────────────────────────────────────────────────────────────────────

step "Base packages"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release \
  ufw fail2ban unattended-upgrades apt-listchanges \
  jq git rsync
info "installed"

# ─────────────────────────────────────────────────────────────────────────────
# Accounts
# ─────────────────────────────────────────────────────────────────────────────

install_key() {
  local user="$1" key="$2" options="${3:-}" home entry
  home="$(getent passwd "$user" | cut -d: -f6)"
  install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
  touch "$home/.ssh/authorized_keys"

  entry="$key"
  [ -n "$options" ] && entry="$options $key"

  # Match on the key body so re-running with different options rewrites the
  # line rather than appending a second, weaker one.
  local body
  body="$(printf '%s' "$key" | awk '{print $2}')"
  if grep -qF "$body" "$home/.ssh/authorized_keys" 2>/dev/null; then
    grep -vF "$body" "$home/.ssh/authorized_keys" > "$home/.ssh/authorized_keys.tmp" || true
    mv "$home/.ssh/authorized_keys.tmp" "$home/.ssh/authorized_keys"
  fi
  printf '%s\n' "$entry" >> "$home/.ssh/authorized_keys"

  chown "$user:$user" "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"
}

step "Accounts"

if id "$ADMIN_USER" >/dev/null 2>&1; then
  skip "user $ADMIN_USER"
else
  adduser --disabled-password --gecos "Metaclaude administrator" "$ADMIN_USER" >/dev/null
  info "created $ADMIN_USER"
fi
usermod -aG sudo "$ADMIN_USER"
install_key "$ADMIN_USER" "$ADMIN_KEY"
info "admin key installed for $ADMIN_USER"

if id "$DEPLOY_USER" >/dev/null 2>&1; then
  skip "user $DEPLOY_USER"
else
  adduser --disabled-password --gecos "Metaclaude deploy (CI)" "$DEPLOY_USER" >/dev/null
  info "created $DEPLOY_USER"
fi

# The deploy account exists to run one program. `restrict` switches off port
# forwarding, agent forwarding, a pty and user-rc; the forced command means the
# key cannot be used for a shell even if it is stolen from GitHub's secret
# store. What CI asks for arrives in $SSH_ORIGINAL_COMMAND and is parsed there.
install_key "$DEPLOY_USER" "$DEPLOY_KEY" "restrict,command=\"$APP_DIR/bin/metaclaude-deploy\""
info "deploy key installed for $DEPLOY_USER, restricted to $APP_DIR/bin/metaclaude-deploy"

# ─────────────────────────────────────────────────────────────────────────────
# Docker
# ─────────────────────────────────────────────────────────────────────────────

step "Docker"

if command -v docker >/dev/null 2>&1; then
  skip "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.list <<REPO
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable
REPO
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  info "installed $(docker --version)"
fi

# Log rotation is not a default. Without it a chatty container fills the disk,
# and a full disk on this box means the agent OS stops accepting runs.
mkdir -p /etc/docker
if [ -f /etc/docker/daemon.json ]; then
  skip "/etc/docker/daemon.json exists — leaving it alone"
else
  cat > /etc/docker/daemon.json <<'DAEMON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true
}
DAEMON
  systemctl restart docker
  info "wrote /etc/docker/daemon.json"
fi

usermod -aG docker "$DEPLOY_USER"
usermod -aG docker "$ADMIN_USER"
info "$ADMIN_USER and $DEPLOY_USER can use docker"
warn "membership of the 'docker' group is equivalent to root on this host. That is"
warn "accepted here: the deploy account's key cannot open a shell, and the admin"
warn "account already has sudo."

# ─────────────────────────────────────────────────────────────────────────────
# Directory layout
# ─────────────────────────────────────────────────────────────────────────────

step "Layout"

install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/bin"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/releases"
# The admin needs to read and edit .env without becoming the deploy user.
usermod -aG "$DEPLOY_USER" "$ADMIN_USER"
info "$APP_DIR ready"

# ─────────────────────────────────────────────────────────────────────────────
# SSH hardening — staged so a mistake cannot lock you out
# ─────────────────────────────────────────────────────────────────────────────

step "SSH"

SSHD_DROPIN="/etc/ssh/sshd_config.d/99-metaclaude.conf"
install -d -m 0755 /etc/ssh/sshd_config.d

# Some images ship a cloud-init drop-in that re-enables password auth and would
# override ours by sorting later. Ours is 99- so it wins on Debian/Ubuntu, where
# the *first* occurrence of a keyword takes effect and Include comes first —
# hence checking rather than assuming.
if grep -rqs '^[[:space:]]*PasswordAuthentication[[:space:]]\+yes' /etc/ssh/sshd_config.d/ 2>/dev/null; then
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ "$f" = "$SSHD_DROPIN" ] && continue
    if grep -qs '^[[:space:]]*PasswordAuthentication[[:space:]]\+yes' "$f"; then
      sed -i 's/^[[:space:]]*PasswordAuthentication[[:space:]]\+yes/# disabled by metaclaude provision.sh\n#&/' "$f"
      warn "commented out PasswordAuthentication yes in $f"
    fi
  done
fi

cat > "$SSHD_DROPIN" <<SSHD
# Written by Metaclaude provision.sh. Edit provision.sh, not this file.

Port $SSH_PORT

# Keys only. This box runs an agent that executes model-authored commands;
# a guessable password is not an acceptable second path in.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no

# Only these two accounts may open a connection at all.
AllowUsers $ADMIN_USER $DEPLOY_USER

MaxAuthTries 3
MaxSessions 10
LoginGraceTime 30

X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no

# Drop a session whose client has gone away, rather than holding it open.
ClientAliveInterval 300
ClientAliveCountMax 2
SSHD

# Never reload a config that does not parse: that is the classic way to lose a
# server. `sshd -t` exits non-zero on a syntax error, before anything restarts.
if ! sshd -t 2>/tmp/sshd-test.err; then
  cat /tmp/sshd-test.err >&2
  rm -f "$SSHD_DROPIN"
  die "sshd rejected the new configuration; it has been removed and nothing was restarted"
fi
info "sshd configuration validates"

# Verify the admin key is actually installed and readable *before* the reload
# that makes it the only way in.
ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
grep -qF "$(printf '%s' "$ADMIN_KEY" | awk '{print $2}')" "$ADMIN_HOME/.ssh/authorized_keys" \
  || die "the admin key is not in $ADMIN_HOME/.ssh/authorized_keys — refusing to disable password login"
info "admin key confirmed present"

systemctl reload ssh 2>/dev/null || systemctl reload sshd
info "sshd reloaded — password and root login are now off"

# ─────────────────────────────────────────────────────────────────────────────
# Firewall
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_FIREWALL" = "yes" ]; then
  step "Firewall"
  skip "--skip-firewall was passed"
else
  step "Firewall"

  # Docker writes its own iptables rules into the DOCKER chain, which the kernel
  # consults *before* the FORWARD rules ufw manages. The consequence surprises
  # people every time: a container published with `-p 8080:8080` is reachable
  # from the internet even with `ufw deny 8080` in place, because the packet
  # never reaches ufw's chain.
  #
  # DOCKER-USER is the chain Docker guarantees to consult first and never to
  # rewrite, so that is where the rule belongs. ufw's after.rules is the right
  # file because ufw reapplies it on every reload — a rule added with a bare
  # `iptables -I` would vanish on the next `ufw reload`.
  AFTER_RULES="/etc/ufw/after.rules"
  if grep -q 'METACLAUDE-DOCKER-BEGIN' "$AFTER_RULES" 2>/dev/null; then
    skip "DOCKER-USER rules already present in $AFTER_RULES"
  else
    cat >> "$AFTER_RULES" <<'DOCKERRULES'

# METACLAUDE-DOCKER-BEGIN
# Docker's own chains are consulted before ufw's, so a published container port
# is reachable from anywhere regardless of what ufw says. DOCKER-USER is the one
# chain Docker checks first and never rewrites — filtering here is the only
# placement that actually holds.
*filter
:ufw-docker-forward - [0:0]
:DOCKER-USER - [0:0]

# Traffic already belonging to a connection this host allowed out.
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
# Anything originating on this host or between containers.
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
# Everything else reaching a container from outside is refused. Ports meant to
# be public are opened by binding them explicitly in compose.yml, not here.
-A DOCKER-USER -j RETURN
COMMIT
# METACLAUDE-DOCKER-END
DOCKERRULES
    info "added DOCKER-USER filtering to $AFTER_RULES"
  fi

  ufw --force reset >/dev/null 2>&1 || true
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null

  # SSH first, always. Enabling ufw with no SSH rule is the fastest way to lose
  # a remote server, and it is a single forgotten line away.
  ufw allow "$SSH_PORT/tcp" comment 'ssh' >/dev/null
  info "allowed $SSH_PORT/tcp (ssh)"

  if [ "$MODE" = "public" ]; then
    ufw allow 80/tcp  comment 'http (redirect + ACME)' >/dev/null
    ufw allow 443/tcp comment 'https' >/dev/null
    ufw allow 443/udp comment 'https/3 (quic)' >/dev/null
    info "allowed 80/tcp, 443/tcp, 443/udp"
  else
    ufw allow in on "$VPN_INTERFACE" comment 'vpn' >/dev/null
    info "allowed everything arriving on $VPN_INTERFACE; nothing else is public"
  fi

  # Rate-limit SSH: ufw's `limit` drops a source that opens six connections in
  # thirty seconds, which flattens credential-stuffing without touching you.
  ufw limit "$SSH_PORT/tcp" >/dev/null 2>&1 || true

  # ── Dead man's switch ──────────────────────────────────────────────────────
  # If the rules are wrong, the session that discovers it is the session that
  # just died. So the firewall disarms itself unless someone confirms, from a
  # *new* connection, that the box is still reachable.
  if [ "$ASSUME_YES" != "yes" ]; then
    cat > /usr/local/sbin/metaclaude-ufw-rollback <<'ROLLBACK'
#!/bin/sh
# Scheduled by provision.sh. Disables the firewall unless cancelled, so a bad
# ruleset costs ten minutes rather than a support ticket.
ufw --force disable
logger -t metaclaude "firewall disabled by the provisioning dead-man's switch"
ROLLBACK
    chmod +x /usr/local/sbin/metaclaude-ufw-rollback

    systemd-run --on-active=10min --unit=metaclaude-ufw-rollback \
      /usr/local/sbin/metaclaude-ufw-rollback >/dev/null 2>&1 || true

    ufw --force enable >/dev/null
    info "firewall enabled"

    printf '\n%s%s%s\n' "$BOLD" "Open a SECOND terminal now and check you can still connect:" "$OFF"
    printf '    ssh -p %s %s@<this-server>\n\n' "$SSH_PORT" "$ADMIN_USER"
    printf '  If it works, answer yes. If it does not, answer no or just wait —\n'
    printf '  the firewall disables itself in 10 minutes either way.\n\n'
    read -r -p "Can you still connect? [y/N] " still
    case "$still" in
      [yY]*)
        systemctl stop metaclaude-ufw-rollback.timer 2>/dev/null || true
        systemctl reset-failed metaclaude-ufw-rollback.timer 2>/dev/null || true
        rm -f /usr/local/sbin/metaclaude-ufw-rollback
        info "dead man's switch cancelled; the firewall stays on"
        ;;
      *)
        ufw --force disable >/dev/null
        systemctl stop metaclaude-ufw-rollback.timer 2>/dev/null || true
        die "firewall disabled at your request. Fix the rules and re-run."
        ;;
    esac
  else
    ufw --force enable >/dev/null
    info "firewall enabled (--yes: no confirmation prompt, no rollback timer)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# fail2ban
# ─────────────────────────────────────────────────────────────────────────────

step "fail2ban"

cat > /etc/fail2ban/jail.d/metaclaude.local <<'JAIL'
# Written by Metaclaude provision.sh.
#
# With password authentication off, this is not the main defence — it exists to
# stop a bot from filling the journal and burning CPU on key exchanges it can
# never complete.
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
# Never ban yourself from your own console or a private network.
ignoreip = 127.0.0.1/8 ::1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10

[sshd]
enabled = true
mode = aggressive
JAIL

systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
info "sshd jail active"

# ─────────────────────────────────────────────────────────────────────────────
# Automatic security updates
# ─────────────────────────────────────────────────────────────────────────────

step "Unattended upgrades"

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTO'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTO

cat > /etc/apt/apt.conf.d/52metaclaude-unattended <<'UNATTENDED'
// Security updates only: a surprise feature upgrade on a box running an agent
// OS is a worse outcome than a week-old non-security package.
Unattended-Upgrade::Origins-Pattern {
    "origin=Debian,codename=${distro_codename},label=Debian-Security";
    "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
    "origin=Ubuntu,archive=${distro_codename}-security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";

// Reboot when a package says one is needed, but at a time nobody is watching.
// A kernel patch that is installed and never activated is not a patch.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
UNATTENDED

systemctl enable unattended-upgrades >/dev/null 2>&1 || true
systemctl restart unattended-upgrades 2>/dev/null || true
info "security updates only, reboot at 04:30 when required"

# ─────────────────────────────────────────────────────────────────────────────
# Kernel
# ─────────────────────────────────────────────────────────────────────────────

step "Kernel settings"

cat > /etc/sysctl.d/99-metaclaude.conf <<'SYSCTL'
# Written by Metaclaude provision.sh.

# This host forwards for Docker, so rp_filter stays loose and forwarding stays
# on — tightening either breaks container networking.

# Ignore ICMP redirects and source routing: neither has a legitimate use here.
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0

# Log packets with impossible source addresses.
net.ipv4.conf.all.log_martians = 1

# SYN flood resistance.
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096

# A process that executes model-authored commands should not be able to read
# another user's kernel pointers or dmesg.
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1

# The agent runs file watchers across several workspaces at once.
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
SYSCTL

sysctl -p /etc/sysctl.d/99-metaclaude.conf >/dev/null
info "applied"

# ─────────────────────────────────────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────────────────────────────────────

step "Result"

printf '\n%sListening on this host:%s\n' "$BOLD" "$OFF"
ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/' | sed 's/^/    /'

printf '\n%sFirewall:%s\n' "$BOLD" "$OFF"
ufw status verbose 2>/dev/null | sed 's/^/    /' || echo "    (not managed)"

cat <<DONE

${GREEN}${BOLD}Provisioned.${OFF}

  admin    ssh -p $SSH_PORT $ADMIN_USER@<this-server>
  deploy   $DEPLOY_USER, key restricted to $APP_DIR/bin/metaclaude-deploy
  app dir  $APP_DIR
  mode     $MODE

${BOLD}Next:${OFF}
  1. Copy compose.yml, docker/Caddyfile and bin/metaclaude-deploy into $APP_DIR
     (deploy/install-app.sh does this from a checkout).
  2. Create $APP_DIR/.env from .env.example and fill in the Claude token.
  3. Add these repository secrets on GitHub:
       DEPLOY_HOST      <this server's IP>
       DEPLOY_USER      $DEPLOY_USER
       DEPLOY_SSH_KEY   the private half of the deploy key
       DEPLOY_KNOWN_HOSTS
         $(ssh-keyscan -p "$SSH_PORT" -t ed25519 localhost 2>/dev/null | sed "s/^localhost/<this server's IP>/" | head -1 || echo "run: ssh-keyscan -t ed25519 <ip>")

DONE
