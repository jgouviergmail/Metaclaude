#!/usr/bin/env bash
#
# Verify a Metaclaude deployment from the outside.
#
# Run this from your laptop, never on the server. That is the whole point: the
# tools on the box agree with themselves, and a firewall that believes it is
# closed is not evidence that it is. Only a probe from somewhere else settles it.
#
#     ./deploy/verify.sh 203.0.113.10 --ipv6 2001:db8::1
#
# Exit code is non-zero if anything that should be shut is open, or anything
# that should answer does not.

set -uo pipefail

HOST=""
IPV6=""
SSH_PORT="22"
ADMIN_USER="mcadmin"
ADMIN_KEY="$HOME/.ssh/metaclaude_admin"
MODE="public"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; DIM=""; OFF=""
fi

PASSED=0; FAILED=0; SKIPPED=0
APP_ANSWERED="unknown"
ok()    { PASSED=$((PASSED+1)); printf '  %sok%s   %s\n' "$GREEN" "$OFF" "$1"; }
bad()   { FAILED=$((FAILED+1)); printf '  %sFAIL%s %s%s\n' "$RED" "$OFF" "$1" "${2:+ — $2}"; }
skip()  { SKIPPED=$((SKIPPED+1)); printf '  %sskip%s %s — %s\n' "$DIM" "$OFF" "$1" "$2"; }
note()  { printf '       %s%s%s\n' "$DIM" "$1" "$OFF"; }
section(){ printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

usage() {
  cat <<'USAGE'
Usage: ./deploy/verify.sh HOST [options]

  HOST                 IPv4 address or hostname of the server.

Options:
  --ipv6 ADDR          Also probe this IPv6 address. Do not skip it: ufw,
                       iptables and Docker keep separate v4 and v6 rulesets.
  --mode public|vpn    What to expect (default: public).
  --ssh-port PORT      Default 22.
  --admin-user NAME    Default mcadmin.
  --key PATH           Default ~/.ssh/metaclaude_admin.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ipv6)       IPV6="${2:-}"; shift 2 ;;
    --mode)       MODE="${2:-}"; shift 2 ;;
    --ssh-port)   SSH_PORT="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:-}"; shift 2 ;;
    --key)        ADMIN_KEY="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           usage; echo "unknown option: $1" >&2; exit 2 ;;
    *)            HOST="$1"; shift ;;
  esac
done

[ -n "$HOST" ] || { usage; exit 2; }

printf '%sVerifying %s from the outside%s\n' "$BOLD" "$HOST" "$OFF"
note "run from your laptop; on-box tools cannot answer these questions"

# ─────────────────────────────────────────────────────────────────────────────
section "SSH"
# ─────────────────────────────────────────────────────────────────────────────

if [ -f "$ADMIN_KEY" ]; then
  if ssh -i "$ADMIN_KEY" -o BatchMode=yes -o ConnectTimeout=10 \
         -o StrictHostKeyChecking=accept-new -p "$SSH_PORT" \
         "$ADMIN_USER@$HOST" true 2>/dev/null; then
    ok "the admin key opens a session"
  else
    bad "the admin key does not open a session" "check the key, the user, and that provisioning finished"
  fi
else
  skip "admin key login" "no key at $ADMIN_KEY"
fi

# The single most important negative result. `-o PreferredAuthentications` and
# `PubkeyAuthentication=no` force the server to offer what it actually allows;
# a server that still offers `password` here has not been hardened.
methods="$(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
              -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive \
              -p "$SSH_PORT" "nobody-$RANDOM@$HOST" true 2>&1 || true)"
if printf '%s' "$methods" | grep -qi 'permission denied (publickey)'; then
  ok "password authentication is refused (publickey only)"
elif printf '%s' "$methods" | grep -qiE 'password|keyboard-interactive'; then
  bad "the server still offers password authentication" "$(printf '%s' "$methods" | head -1)"
else
  skip "password authentication" "inconclusive: $(printf '%s' "$methods" | head -1)"
fi

# Three outcomes, not two. "Not 'permission denied'" is not the same as "root
# got in": a refused connection, a timeout, an unresolvable name and a fail2ban
# ban all landed in the `else` and printed a false security claim — and
# provision.sh documents fail2ban's `Connection refused` as the one failure mode
# of this host that reads like a dead server. The password check above already
# has the third branch; this one did not.
rootout="$(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
               -p "$SSH_PORT" "root@$HOST" true 2>&1 || true)"
if printf '%s' "$rootout" | grep -qi 'permission denied'; then
  ok "root cannot log in"
elif printf '%s' "$rootout" | grep -qiE 'refused|timed out|timeout|no route|could not resolve|unreachable'; then
  skip "root login" "could not reach the host: $(printf '%s' "$rootout" | head -1)"
else
  bad "root login was not refused" "PermitRootLogin should be no"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Open ports"
# ─────────────────────────────────────────────────────────────────────────────

# A short list rather than a full scan, so this stays fast and needs no nmap.
# The full sweep is printed at the end as the thing to run properly.
probe_port() {
  local family="$1" addr="$2" port="$3"
  if command -v nc >/dev/null 2>&1; then
    nc "$family" -z -w 4 "$addr" "$port" >/dev/null 2>&1
  else
    timeout 5 bash -c "cat < /dev/null > /dev/tcp/$addr/$port" 2>/dev/null
  fi
}

expect_open() {
  if probe_port "$1" "$2" "$3"; then ok "$4 $3 open"; else bad "$4 $3 is CLOSED" "it should be reachable"; fi
}
expect_shut() {
  if probe_port "$1" "$2" "$3"; then bad "$4 $3 is OPEN" "nothing should answer here"; else ok "$4 $3 shut"; fi
}
# Neither state is a failure — the check is that you know which one you have.
# Used for HTTPS over v6, where both answers are legitimate deployments.
report_state() {
  if probe_port "$1" "$2" "$3"; then note "$4 $3 answers — $5"; else note "$4 $3 does not answer — $6"; fi
}

expect_open -4 "$HOST" "$SSH_PORT" "v4"
if [ "$MODE" = "public" ]; then
  expect_open -4 "$HOST" 80  "v4"
  expect_open -4 "$HOST" 443 "v4"
else
  expect_shut -4 "$HOST" 80  "v4"
  expect_shut -4 "$HOST" 443 "v4"
fi

# Ports that are commonly left open by accident, and would each be serious here.
for port in 2375 2376 5432 6379 8080 8787 9000 27017; do
  expect_shut -4 "$HOST" "$port" "v4"
done

# ─────────────────────────────────────────────────────────────────────────────
section "IPv6"
# ─────────────────────────────────────────────────────────────────────────────

if [ -n "$IPV6" ]; then
  # This is the gap people skip. v4 and v6 are separate rulesets in ufw, in
  # iptables and in Docker; a perfect v4 firewall next to an unmanaged v6 one
  # reads as "firewalled" and is not.
  expect_open -6 "$IPV6" "$SSH_PORT" "v6"

  # HTTPS over v6 is reported, not asserted, and that is a correction rather
  # than a softening.
  #
  # compose publishes `${METACLAUDE_BIND}:443:443`, and METACLAUDE_BIND holds
  # one address. Set to 0.0.0.0 — which is what bootstrap.sh writes in public
  # mode, and the only value that makes sense there — the host side of that
  # mapping is an IPv4 wildcard, so Docker binds v4 and nothing else. Asserting
  # the port *open* on v6 therefore failed on every correctly deployed public
  # host, and a check that always fails is a check people learn to skip.
  #
  # It is also not what this section is for. The gap it exists to catch is an
  # unmanaged v6 ruleset leaving something exposed — the loop below — not a
  # missing HTTPS listener. Serving over v6 is a deployment choice: it needs a
  # v6-capable publish *and* an AAAA record, and a name with only an A record
  # is never reached over v6 whatever the server binds.
  if [ "$MODE" = "public" ]; then
    report_state -6 "$IPV6" 443 "v6" \
      "the stack is published on v6 as well" \
      "v4 only, which is what METACLAUDE_BIND=0.0.0.0 gives you; fine unless the name has an AAAA record"
  else
    # In VPN mode the public v6 address must not serve the application at all,
    # and that *is* an assertion: it is the whole point of the mode.
    expect_shut -6 "$IPV6" 443 "v6"
  fi
  for port in 2375 5432 6379 8080 8787; do
    expect_shut -6 "$IPV6" "$port" "v6"
  done
else
  skip "IPv6" "no --ipv6 given. If this host has a global v6 address, this is the gap that matters"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "TLS and the application"
# ─────────────────────────────────────────────────────────────────────────────

if [ "$MODE" = "public" ]; then
  # -k first: under the `internal` TLS mode the certificate is signed by a CA
  # this laptop may not trust yet, and that is expected rather than a failure.
  #
  # `--proxy ""` matters more than it looks. Anything that intercepts TLS — a
  # corporate proxy, a captive portal, a sandbox — answers with headers of its
  # own, and several of them are the very headers checked below. Without this,
  # a machine behind such a proxy gets a clean bill of health for the proxy.
  CURL=(curl -sS -k --max-time 15 --proxy "")

  health="$("${CURL[@]}" "https://$HOST/api/health" 2>/dev/null || true)"
  if printf '%s' "$health" | grep -q '"status":"ok"'; then
    APP_ANSWERED="yes"
    ok "the health endpoint answers over TLS"
    note "/api/health returns ok unconditionally: it proves liveness, not that the"
    note "Claude CLI is authenticated. Send a real prompt to prove that."
  else
    APP_ANSWERED="no"
    bad "the health endpoint did not answer" "${health:0:80}"
  fi

  if "${CURL[@]}" -o /dev/null -w '%{http_code}' "http://$HOST/" 2>/dev/null | grep -qE '^30[18]$'; then
    ok "plain HTTP redirects to HTTPS"
  else
    bad "plain HTTP did not redirect" "everything must be a secure context"
  fi

  # Whether this laptop trusts the certificate says which TLS mode is live.
  if curl -sS --max-time 15 --proxy "" -o /dev/null "https://$HOST/api/health" 2>/dev/null; then
    ok "the certificate is trusted by this machine (public CA, or the local CA is installed)"
  else
    skip "certificate trust" "not trusted here — expected under METACLAUDE_TLS_MODE=internal until you install the root"
  fi

  # Only meaningful once we know we are talking to the application. Reporting on
  # headers from an unidentified responder is worse than reporting nothing: it
  # reads as a pass.
  if [ "$APP_ANSWERED" = "yes" ]; then
    headers="$("${CURL[@]}" -D - -o /dev/null "https://$HOST/" 2>/dev/null || true)"
    for header in "strict-transport-security" "x-content-type-options" "x-frame-options" "content-security-policy"; do
      if printf '%s' "$headers" | grep -qi "^$header:"; then
        ok "$header present"
      else
        bad "$header missing"
      fi
    done
    if printf '%s' "$headers" | grep -qi '^server:'; then
      bad "the Server header is being advertised"
    else
      ok "no Server header"
    fi
  else
    skip "security headers" "the application did not answer, so there is nothing of its to inspect"
  fi
else
  skip "TLS and application" "vpn mode — connect to the VPN and probe the tailnet address instead"
fi

# ─────────────────────────────────────────────────────────────────────────────

printf '\n%s%d passed, %d failed, %d skipped%s\n' "$BOLD" "$PASSED" "$FAILED" "$SKIPPED" "$OFF"

cat <<NEXT

${DIM}This checks a short list of ports. For the real answer, sweep every one:

  nmap -Pn -p- --min-rate 2000 $HOST${IPV6:+
  nmap -6 -Pn -p- $IPV6}
${OFF}
NEXT

[ "$FAILED" -eq 0 ] || exit 1
