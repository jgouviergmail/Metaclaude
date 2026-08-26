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
HAS_IPV6="unknown"

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

# Group membership authorises sudo; it does not make sudo usable.
#
# `adduser --disabled-password` means exactly that — no password exists — and
# sudo authenticates the *invoking* user, not root. So the administrator account
# was in the sudo group and could never satisfy the prompt: an account created
# to administer the box, unable to. It surfaces only when someone logs in and
# tries, which is far too late.
#
# NOPASSWD is not a loosening here, it is what makes the design coherent. The
# boundary protecting this account is the SSH key; a password that was never set
# protects nothing, and the alternative — inventing one and shipping it to the
# operator — would be a real weakening.
SUDOERS="/etc/sudoers.d/00-metaclaude-admin"
printf '# Written by Metaclaude provision.sh.\n%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$ADMIN_USER" > "$SUDOERS"
chmod 0440 "$SUDOERS"
# A malformed file here breaks sudo for everyone, so it is validated in place
# and removed if it does not parse. Never leave a broken sudoers behind.
if ! visudo -cf "$SUDOERS" >/dev/null 2>&1; then
  rm -f "$SUDOERS"
  die "the sudoers snippet for $ADMIN_USER did not validate; nothing was left behind"
fi
info "$ADMIN_USER may sudo without a password (it has none — the key is the boundary)"

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
# `expiry-time` turns key rotation from an intention into a date the server
# enforces. Eighteen months: long enough not to be a nuisance, short enough
# that a forgotten key does not outlive the project.
DEPLOY_KEY_EXPIRY="$(date -u -d '+18 months' +%Y%m%d 2>/dev/null || echo '')"
DEPLOY_KEY_OPTIONS="restrict,command=\"$APP_DIR/bin/metaclaude-deploy\""
[ -n "$DEPLOY_KEY_EXPIRY" ] && DEPLOY_KEY_OPTIONS="$DEPLOY_KEY_OPTIONS,expiry-time=\"$DEPLOY_KEY_EXPIRY\""

install_key "$DEPLOY_USER" "$DEPLOY_KEY" "$DEPLOY_KEY_OPTIONS"
info "deploy key installed, restricted to $APP_DIR/bin/metaclaude-deploy"
[ -n "$DEPLOY_KEY_EXPIRY" ] && info "it stops working on $DEPLOY_KEY_EXPIRY — rotate before then"

# ─────────────────────────────────────────────────────────────────────────────
# Docker
# ─────────────────────────────────────────────────────────────────────────────

step "Docker"

if command -v docker >/dev/null 2>&1; then
  skip "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else
  # Docker does not publish packages for a distribution release on the day it
  # ships, and the codename goes straight into the repository URL. Checked
  # before the source is written so a gap is one clear sentence here rather than
  # an apt failure forty lines later that reads like a broken network.
  if ! curl -fsI --max-time 20 \
       "https://download.docker.com/linux/${ID}/dists/${VERSION_CODENAME}/Release" >/dev/null 2>&1; then
    die "Docker publishes nothing for ${ID} ${VERSION_CODENAME} yet.
     See https://download.docker.com/linux/${ID}/dists/ for what exists.
     Install Docker by another route and re-run this — it skips Docker when
     one is already present."
  fi

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

# Docker 28 is a floor, not a preference: it drops unsolicited inbound traffic
# to container IPs by default, and closes the older hole where a port published
# on 127.0.0.1 was still reachable from other hosts on the same L2 segment.
DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)"
if [ "${DOCKER_VERSION%%.*}" -lt 28 ] 2>/dev/null; then
  warn "Docker $DOCKER_VERSION is older than 28.0, which had weaker default"
  warn "network isolation. Upgrade before exposing this host."
fi

mkdir -p /etc/docker
if [ -f /etc/docker/daemon.json ]; then
  skip "/etc/docker/daemon.json exists — leaving it alone"
  grep -q host_binding_ipv4 /etc/docker/daemon.json \
    || warn "it has no default host binding; a forgotten -p publishes to the world"
else
  # `default-network-opts` inverts the failure mode of a forgotten `-p 8080:80`:
  # it binds to loopback instead of every interface, so a mistake is unreachable
  # rather than world-open. It does NOT retrofit existing networks — recreate
  # them with `docker compose down && up` for it to take effect.
  #
  # Deliberately absent: `"iptables": false`. It stops Docker writing any rules,
  # which also removes the MASQUERADE the agent needs to reach the network at
  # all. The DOCKER-USER chain is the supported way to filter, and it is what
  # the firewall section uses.
  cat > /etc/docker/daemon.json <<'DAEMON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3", "compress": "true" },
  "live-restore": true,
  "no-new-privileges": true,
  "default-network-opts": {
    "bridge": { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" }
  }
}
DAEMON
  systemctl restart docker
  info "wrote /etc/docker/daemon.json (published ports default to loopback)"
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

# Ownership here is a security boundary, not tidiness.
#
# The deploy account runs a forced command and must not be able to rewrite it,
# nor compose.yml — otherwise a stolen CI key edits the very file that is
# supposed to constrain it, and the next deploy runs whatever it likes as root.
# So: root owns the executables and the compose file; the deploy user owns only
# its own state.
install -d -m 0755 -o root -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 0755 -o root -g root "$APP_DIR/bin"
install -d -m 0755 -o root -g root "$APP_DIR/docker"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/releases"
install -d -m 0750 -o root -g "$DEPLOY_USER" "$APP_DIR/certs"

# The admin edits .env; the deploy user only reads it.
usermod -aG "$DEPLOY_USER" "$ADMIN_USER"
info "$APP_DIR ready (bin/ and compose.yml stay root-owned)"

# ─────────────────────────────────────────────────────────────────────────────
# SSH hardening — staged so a mistake cannot lock you out
# ─────────────────────────────────────────────────────────────────────────────

step "SSH"

# The filename has to sort FIRST, and this is the opposite of the usual
# convention.
#
# sshd_config(5): "for each keyword, the first obtained value will be used".
# `Include /etc/ssh/sshd_config.d/*.conf` sits at the top of the main file and
# expands in lexical order, so a `99-` file loses every contested keyword to
# the `50-cloud-init.conf` that most provider images ship — and those commonly
# set `PasswordAuthentication yes`. `00-` wins instead.
SSHD_DROPIN="/etc/ssh/sshd_config.d/00-metaclaude.conf"
install -d -m 0755 /etc/ssh/sshd_config.d

# Clean up the previous, wrongly-named file if this script created one before.
rm -f /etc/ssh/sshd_config.d/99-metaclaude.conf

cat > "$SSHD_DROPIN" <<SSHD
# Written by Metaclaude provision.sh. Edit provision.sh, not this file.
#
# Note there is no Port directive here. On Debian 13 and Ubuntu 22.10+, sshd is
# socket activated: ssh.socket owns the listener, and Port in sshd_config is read
# and then ignored. Writing it here and opening only that port in the firewall
# is a guaranteed lockout. The port is set below, on the socket, and verified.

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

# Assert on the *parsed* configuration, not on the file we wrote. This is what
# catches a drop-in ordering surprise, a distro default we did not expect, or a
# keyword the running sshd does not support.
effective="$(sshd -T 2>/dev/null || true)"
for expected in "permitrootlogin no" "passwordauthentication no" "pubkeyauthentication yes"; do
  printf '%s\n' "$effective" | grep -qi "^$expected$" \
    || die "sshd's effective config does not have '$expected'. Nothing else was changed; inspect /etc/ssh/sshd_config.d/."
done
printf '%s\n' "$effective" | grep -qi "^allowusers .*$ADMIN_USER" \
  || die "sshd's effective AllowUsers does not include $ADMIN_USER"
info "verified against \`sshd -T\`: keys only, no root login, $ADMIN_USER allowed"

# ── The listening port, which is a separate question under socket activation ─
if [ "$SSH_PORT" != "22" ]; then
  if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then
    install -d -m 0755 /etc/systemd/system/ssh.socket.d
    # The bare `ListenStream=` is mandatory: it clears the inherited 22.
    # Without it the socket listens on both, and the firewall rule below then
    # closes the one you are connected through.
    printf '[Socket]\nListenStream=\nListenStream=%s\n' "$SSH_PORT" \
      > /etc/systemd/system/ssh.socket.d/10-metaclaude-port.conf
    systemctl daemon-reload
    systemctl restart ssh.socket
    info "ssh.socket moved to $SSH_PORT"
  fi
  # Refuse to firewall a port nothing answers on. This is the last chance to
  # catch the mismatch before ufw makes it permanent.
  ss -tlnp 2>/dev/null | grep -q ":$SSH_PORT " \
    || die "nothing is listening on port $SSH_PORT — refusing to build a firewall around it"
  info "confirmed sshd is listening on $SSH_PORT"
fi

info "password and root login are now off"

# ─────────────────────────────────────────────────────────────────────────────
# Firewall
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_FIREWALL" = "yes" ]; then
  step "Firewall"
  skip "--skip-firewall was passed"
else
  step "Firewall"

  # Reset FIRST, and never again below.
  #
  # `ufw reset` means "back to installation defaults", and the files it restores
  # include after.rules and after6.rules — the ones this step is about to write
  # the DOCKER-USER filtering into. Resetting afterwards therefore threw that
  # filtering away ninety lines after writing it, and said nothing: ufw came up,
  # reported active, `ufw status` listed every rule the script had asked for,
  # and the one chain that actually governs published container ports was back
  # to the packaged default.
  #
  # Order is the whole fix. Anything this script customises has to be written
  # after the point where ufw is allowed to overwrite it.
  ufw --force reset >/dev/null 2>&1 || true

  # ── The Docker/ufw bypass, and why the obvious fix is not one ─────────────
  #
  # ufw filters INPUT. Docker DNATs in nat/PREROUTING and filters in FORWARD, so
  # a packet for a published port is redirected and then *forwarded* — it never
  # traverses INPUT at all. `ufw deny 8080` is therefore true and irrelevant:
  # the container answers anyway.
  #
  # DOCKER-USER is the one chain Docker consults first and never rewrites, so
  # that is where a rule has to go. Two details decide whether it works:
  #
  #   · The rule must DROP. An earlier version of this script ended the chain
  #     with `-j RETURN` under a comment claiming it refused everything —
  #     RETURN falls through to Docker's own per-port ACCEPT, so the block was
  #     decorative.
  #   · Matching must use conntrack's --ctorigdstport, not --dport. By the time
  #     a packet reaches DOCKER-USER it has already been DNAT'd, so --dport
  #     reads the *container* port. --ctorigdstport reads what the client
  #     actually asked for, which is also the only value that survives
  #     recreating the container.
  #
  # after.rules is the right file because ufw reapplies it on every reload; a
  # bare `iptables -I` evaporates on the next `ufw reload` and on every
  # `systemctl restart docker`, which recreates DOCKER-USER empty.
  EXT_IF="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
  [ -n "$EXT_IF" ] || die "could not determine the external interface from the default route"
  info "external interface: $EXT_IF"

  AFTER_RULES="/etc/ufw/after.rules"

  # Remove any previous block, including the broken one, before writing.
  if grep -q 'METACLAUDE-DOCKER-BEGIN' "$AFTER_RULES" 2>/dev/null; then
    sed -i '/# METACLAUDE-DOCKER-BEGIN/,/# METACLAUDE-DOCKER-END/d' "$AFTER_RULES"
    info "removed the previous DOCKER-USER block"
  fi

  {
    printf '\n# METACLAUDE-DOCKER-BEGIN\n'
    printf '# Written by provision.sh. Docker bypasses ufw for published ports;\n'
    printf '# this chain is the only placement that actually filters them.\n'
    printf '*filter\n'
    printf ':DOCKER-USER - [0:0]\n\n'
    printf -- '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN\n'
    printf -- '-A DOCKER-USER -m conntrack --ctstate INVALID -j DROP\n\n'
    printf '# Host-local, inter-container, and VPN traffic.\n'
    printf -- '-A DOCKER-USER -s 172.16.0.0/12 -j RETURN\n'
    printf -- '-A DOCKER-USER -s 192.168.0.0/16 -j RETURN\n'
    printf -- '-A DOCKER-USER -s 10.0.0.0/8    -j RETURN\n'
    printf -- '-A DOCKER-USER -s 100.64.0.0/10 -j RETURN\n\n'
    if [ "$MODE" = "public" ]; then
      printf '# The only container ports the internet may open a connection to.\n'
      printf -- '-A DOCKER-USER -i %s -p tcp -m conntrack --ctorigdstport 443 --ctstate NEW -j RETURN\n' "$EXT_IF"
      printf -- '-A DOCKER-USER -i %s -p udp -m conntrack --ctorigdstport 443 --ctstate NEW -j RETURN\n' "$EXT_IF"
      printf -- '-A DOCKER-USER -i %s -p tcp -m conntrack --ctorigdstport 80  --ctstate NEW -j RETURN\n' "$EXT_IF"
    else
      printf '# vpn mode: no container port is reachable from the public interface.\n'
    fi
    printf -- '-A DOCKER-USER -i %s -j DROP\n\n' "$EXT_IF"
    printf -- '-A DOCKER-USER -j RETURN\n'
    printf 'COMMIT\n'
    printf '# METACLAUDE-DOCKER-END\n'
  } >> "$AFTER_RULES"
  info "wrote DOCKER-USER filtering to $AFTER_RULES ($MODE mode)"

  # ── IPv6 ──────────────────────────────────────────────────────────────────
  #
  # ufw, iptables and Docker keep entirely separate v4 and v6 rulesets, and a
  # host with a global v6 address is reachable over it whether or not anyone
  # thought about it. An impeccable v4 firewall beside an unmanaged v6 one is
  # the worst of the three states, because it reads as "firewalled".
  #
  # So v6 is configured symmetrically rather than warned about.
  if [ -f /proc/net/if_inet6 ] && ip -6 addr show scope global 2>/dev/null | grep -q inet6; then
    HAS_IPV6="yes"
    info "global IPv6 detected: $(ip -6 addr show scope global | awk '/inet6/{print $2; exit}')"

    # ufw ships with IPv6 on by default on current Debian/Ubuntu, but an image
    # that has been through a hosting panel often does not.
    if grep -q '^IPV6=no' /etc/default/ufw 2>/dev/null; then
      sed -i 's/^IPV6=no/IPV6=yes/' /etc/default/ufw
      info "enabled IPv6 in /etc/default/ufw"
    fi

    AFTER6_RULES="/etc/ufw/after6.rules"
    if grep -q 'METACLAUDE-DOCKER-BEGIN' "$AFTER6_RULES" 2>/dev/null; then
      sed -i '/# METACLAUDE-DOCKER-BEGIN/,/# METACLAUDE-DOCKER-END/d' "$AFTER6_RULES"
    fi
    {
      printf '\n# METACLAUDE-DOCKER-BEGIN\n'
      printf '# The v6 twin of the block in after.rules. Docker only populates\n'
      printf '# these chains when ip6tables is enabled, but the rules must exist\n'
      printf '# first: adding them after a container is already published is a\n'
      printf '# window, not a fix.\n'
      printf '*filter\n'
      printf ':DOCKER-USER - [0:0]\n\n'
      printf -- '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN\n'
      printf -- '-A DOCKER-USER -m conntrack --ctstate INVALID -j DROP\n\n'
      printf '# Link-local and unique-local traffic.\n'
      printf -- '-A DOCKER-USER -s fe80::/10 -j RETURN\n'
      printf -- '-A DOCKER-USER -s fc00::/7  -j RETURN\n\n'
      if [ "$MODE" = "public" ]; then
        printf '# The only container ports the internet may open a connection to.\n'
        printf -- '-A DOCKER-USER -i %s -p tcp -m conntrack --ctorigdstport 443 --ctstate NEW -j RETURN\n' "$EXT_IF"
        printf -- '-A DOCKER-USER -i %s -p udp -m conntrack --ctorigdstport 443 --ctstate NEW -j RETURN\n' "$EXT_IF"
        printf -- '-A DOCKER-USER -i %s -p tcp -m conntrack --ctorigdstport 80  --ctstate NEW -j RETURN\n' "$EXT_IF"
      else
        printf '# vpn mode: nothing reachable from the public interface.\n'
      fi
      printf -- '-A DOCKER-USER -i %s -j DROP\n\n' "$EXT_IF"
      printf -- '-A DOCKER-USER -j RETURN\n'
      printf 'COMMIT\n'
      printf '# METACLAUDE-DOCKER-END\n'
    } >> "$AFTER6_RULES"
    info "wrote the matching DOCKER-USER block to $AFTER6_RULES"
  else
    HAS_IPV6="no"
    info "no global IPv6 address on this host"
  fi

  # The reset happened at the top of this step, before after.rules was written.
  ufw default deny incoming >/dev/null
  # Outgoing stays open, deliberately and permanently. Metaclaude exists to call
  # out: the Claude API, MCP servers, webhooks, git remotes, package registries
  # the agent installs from. Egress filtering here would not be hardening, it
  # would be breaking the product — and it would not contain a compromised agent
  # anyway, since anything that can reach the Claude API can tunnel over it.
  # The controls that do bear weight are the approval flow and the container
  # confinement in compose.yml, not a port list.
  ufw default allow outgoing >/dev/null

  # SSH first, always. Enabling ufw with no SSH rule is the fastest way to lose
  # a remote server, and it is a single forgotten line away.
  ufw allow "$SSH_PORT/tcp" comment 'ssh' >/dev/null
  info "allowed $SSH_PORT/tcp (ssh)"

  if [ "$MODE" = "public" ]; then
    # These cover v4 and v6 together: ufw applies a rule with no address family
    # to both, which is what we want — asymmetry here is how a v6 hole opens.
    ufw allow 80/tcp  comment 'http (redirect + ACME http-01)' >/dev/null
    ufw allow 443/tcp comment 'https' >/dev/null
    ufw allow 443/udp comment 'https/3 (quic)' >/dev/null
    info "allowed 80/tcp, 443/tcp, 443/udp (v4 and v6)"
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
# `normal`, not `aggressive`, and the reason is the operator rather than the
# attacker. Aggressive counts publickey failures and closed connections, which
# is precisely what setting up generates: trying root before mcadmin, or the
# wrong key file, reaches maxretry in under a minute and bans the administrator
# for an hour — with the ban presenting as `Connection refused`, which reads
# like a dead server rather than a jail. Password authentication is already off,
# so the aggressive patterns were buying almost nothing against the threat this
# jail exists for: a bot filling the journal.
mode = normal
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

# What is listening is the ground truth; the firewall is only intent.
printf '\n%sListening on this host:%s\n' "$BOLD" "$OFF"
ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/' | sed 's/^/    /'

printf '\n%sFirewall:%s\n' "$BOLD" "$OFF"
ufw status verbose 2>/dev/null | sed 's/^/    /' || echo "    (not managed)"

# The one failure mode of this host that looks exactly like a dead server.
# fail2ban rejects rather than drops, so a banned address gets `Connection
# refused` — indistinguishable from sshd being down unless you know to look.
printf '\n%sIf SSH starts answering "Connection refused":%s\n' "$BOLD" "$OFF"
printf '    You are probably banned by this box'"'"'s own fail2ban. Five failed\n'
printf '    attempts in ten minutes — the wrong user, the wrong key — is a\n'
printf '    one-hour ban, and it rejects rather than drops, so it reads as a\n'
printf '    dead server. From this console, which is never affected:\n\n'
printf '      fail2ban-client status sshd            # is your address listed\n'
printf '      fail2ban-client unban --all            # release every ban\n'

printf '\n%sIPv6:%s\n' "$BOLD" "$OFF"
case "$HAS_IPV6" in
  yes)
    printf '    managed — ufw covers v6 and after6.rules mirrors the v4 filtering\n'
    printf '    listening on v6 right now:\n'
    ss -tlnp 2>/dev/null | awk '/LISTEN/ && ($4 ~ /\[/ || $4 ~ /::/)' | sed 's/^/      /' \
      || printf '      (nothing)\n'
    printf '\n'
    printf '    %sVerify this from another machine, not from here:%s\n' "$YELLOW" "$OFF"
    printf '      nmap -6 -Pn -p- <your-ipv6>\n'
    ;;
  no)      printf '    no global IPv6 on this host; nothing to manage\n' ;;
  unknown) printf '    not examined (--skip-firewall)\n' ;;
esac

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
