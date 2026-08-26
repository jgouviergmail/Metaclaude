#!/usr/bin/env bash
#
# Point a name at this server, in Cloudflare, without editing anything already
# there.
#
#     ./deploy/dns-setup.sh --fqdn agent.example.com
#
# Asks for a Cloudflare API token, finds the zone, shows what already exists for
# that name, and creates the record only if nothing does. It never updates and
# never deletes: the only write it can make is a POST, which Cloudflare refuses
# when a record of that name and type is already present.
#
# Why a script rather than a few curl lines: the curl lines are correct and
# still fragile. A line ending in a backslash pasted one line at a time leaves
# the shell at a continuation prompt, and every command typed afterwards is
# swallowed as part of the unfinished one — including the next correct command.
# Here the token is typed once, into a prompt, and no quoting is involved.
#
# The token is read into a variable and passed to curl through a header. It is
# never written to disk, never printed, and never put on a command line where
# `ps` could see it.

set -Eeuo pipefail

FQDN=""
IP=""
IPV6=""
API="${CF_API:-https://api.cloudflare.com/client/v4}"

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
Usage: ./deploy/dns-setup.sh --fqdn NAME [options]

  --fqdn NAME     The full name to create, e.g. agent.example.com
  --ip ADDR       IPv4 to point at. Default: this machine's public address.
  --ipv6 ADDR     Also create an AAAA record. Optional.
  -h, --help

Creates only. An existing record of the same name and type is reported and left
exactly as it is.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fqdn) FQDN="${2:-}"; shift 2 ;;
    --ip)   IP="${2:-}"; shift 2 ;;
    --ipv6) IPV6="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

[ -n "$FQDN" ] || { usage; die "--fqdn is required"; }
command -v curl >/dev/null || die "curl is not installed"
command -v python3 >/dev/null || die "python3 is not installed"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# Reads one value out of a JSON document on stdin. Kept to python3 rather than
# jq: python3 is on every Debian and Raspberry Pi OS image, jq is not.
jget() { python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('__PARSE_ERROR__'); sys.exit(0)
$1
"; }

cf() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$data" "${API}${path}"
  else
    curl -sS -X "$method" -H "Authorization: Bearer ${CF_TOKEN}" "${API}${path}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
step "1/5  The token"
# ─────────────────────────────────────────────────────────────────────────────

printf '\n  Paste your Cloudflare API token and press Enter.\n'
printf '  %sNothing will echo as you paste — that is deliberate.%s\n\n  token: ' "$DIM" "$OFF"
IFS= read -rs CF_TOKEN
printf '\n'
[ -n "$CF_TOKEN" ] || die "no token entered"
info "received ${#CF_TOKEN} characters"

codes() { printf '%s' "$1" | jget "
for e in d.get('errors', []) or []: print('       %s  %s' % (e.get('code'), e.get('message')))
"; }

# Deliberately not fatal.
#
# /user/tokens/verify is a courtesy endpoint, and failing it does not mean the
# token is useless: an account-owned token verifies under /accounts/<id>/tokens
# instead, and a legacy Global API Key does not use bearer auth at all. Killing
# the run here refused tokens that could have done the job perfectly well.
#
# The honest test is the operation actually needed — reading the zone — so that
# is what decides.
VERIFY="$(cf GET /user/tokens/verify)"
if [ "$(printf '%s' "$VERIFY" | jget "print(d.get('success'))")" = "True" ]; then
  info "the token verifies"
else
  warn "the token could not verify itself:"
  codes "$VERIFY" >&2
  note "not necessarily fatal — what counts is whether it can read the zone."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "2/5  The zone"
# ─────────────────────────────────────────────────────────────────────────────

# Matched by longest suffix rather than by stripping the first label, so a name
# several levels deep lands in the right zone.
ZONES="$(cf GET '/zones?per_page=50')"
if [ "$(printf '%s' "$ZONES" | jget "print(d.get('success'))")" != "True" ]; then
  warn "the token cannot list zones:"
  codes "$ZONES" >&2
  die "Cloudflare refused. What the codes above usually mean:

       1000  the token string is not recognised. Re-copy it — a truncated paste
             looks exactly like this. It reported ${#CF_TOKEN} characters; a
             Cloudflare API token is normally around 40.
       6003  wrong kind of credential. This needs an API *Token*
             (My Profile -> API Tokens -> Create Token), not the Global API Key,
             which uses a different authentication scheme entirely.
       9109  the token is real but lacks Zone:Read on this zone. Edit it and add
             Zone -> Zone -> Read, plus Zone -> DNS -> Edit for the record.
       Nothing at all above: the request never reached Cloudflare — check the
             machine's outbound network."
fi

read -r ZONE_ID ZONE_NAME <<EOF
$(printf '%s' "$ZONES" | jget "
fqdn = '$FQDN'
best = None
for z in d.get('result', []) or []:
    n = z['name']
    if fqdn == n or fqdn.endswith('.' + n):
        if best is None or len(n) > len(best['name']):
            best = z
print(best['id'], best['name']) if best else print('', '')
")
EOF

[ -n "$ZONE_ID" ] || die "no zone in this account covers $FQDN — check the token's zone permissions"
info "zone $ZONE_NAME"

# ─────────────────────────────────────────────────────────────────────────────
step "3/5  What is already there"
# ─────────────────────────────────────────────────────────────────────────────

EXISTING="$(cf GET "/zones/${ZONE_ID}/dns_records?name=${FQDN}")"
EXISTING_TYPES="$(printf '%s' "$EXISTING" | jget "
rows = d.get('result', []) or []
for r in rows:
    print('%s %s %s proxied=%s' % (r.get('type'), r.get('name'), r.get('content'), r.get('proxied')))
")"

if [ -n "$EXISTING_TYPES" ]; then
  warn "$FQDN already exists in Cloudflare:"
  printf '%s\n' "$EXISTING_TYPES" | sed 's/^/       /'
  printf '\n'
  note "Nothing has been changed, and this script will not change it."
  note "If the address is right, you are done — go straight to bootstrap.sh."
  note "If it is wrong, edit it in the Cloudflare dashboard yourself."
  exit 0
fi
info "nothing exists for that name yet"

# ─────────────────────────────────────────────────────────────────────────────
step "4/5  Creating"
# ─────────────────────────────────────────────────────────────────────────────

if [ -z "$IP" ]; then
  # Asking a third party for "my address" is the wrong answer when this runs on
  # the server itself: what matters is the address the server actually answers
  # on, which the routing table knows.
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)"
  [ -n "$IP" ] || die "could not detect this machine's IPv4; pass --ip"
  info "detected this machine's address: $IP"
  note "If you are running this on a laptop or a Pi rather than on the server,"
  note "that is the wrong address — pass --ip with the server's."
fi

create_record() {
  local type="$1" content="$2" label="${FQDN%%.*}"
  local body result
  # proxied=false is not a preference. Cloudflare's proxy terminates TLS, so it
  # would read every request in clear; and it drops idle WebSockets after about
  # 100 seconds on the free plan, which is exactly the shape of an agent run
  # that goes quiet during a long tool call.
  body="$(python3 -c "
import json
print(json.dumps({'type': '$type', 'name': '$label', 'content': '$content',
                  'ttl': 300, 'proxied': False}))")"
  result="$(cf POST "/zones/${ZONE_ID}/dns_records" "$body")"
  if [ "$(printf '%s' "$result" | jget "print(d.get('success'))")" = "True" ]; then
    info "created $type $FQDN -> $content (DNS only, not proxied)"
  else
    printf '%s\n' "$(printf '%s' "$result" | jget "
for e in d.get('errors', []) or []: print('   ', e.get('code'), e.get('message'))
")" >&2
    die "Cloudflare refused to create the $type record"
  fi
}

create_record A "$IP"
[ -n "$IPV6" ] && create_record AAAA "$IPV6"

# ─────────────────────────────────────────────────────────────────────────────
step "5/5  Does it resolve"
# ─────────────────────────────────────────────────────────────────────────────

RESOLVED=""
for _ in $(seq 1 20); do
  if command -v dig >/dev/null 2>&1; then
    RESOLVED="$(dig +short "$FQDN" A 2>/dev/null | head -1)"
  else
    RESOLVED="$(getent ahostsv4 "$FQDN" 2>/dev/null | awk 'NR==1{print $1}')"
  fi
  [ -n "$RESOLVED" ] && break
  sleep 3
done

if [ "$RESOLVED" = "$IP" ]; then
  info "$FQDN resolves to $IP"
elif [ -n "$RESOLVED" ]; then
  warn "$FQDN resolves to $RESOLVED, not $IP — a stale cache, or another record"
else
  warn "$FQDN does not resolve yet. It usually takes under a minute; re-check with:"
  note "dig +short $FQDN"
fi

cat <<DONE

  ${BOLD}Next, on the server itself${OFF} — not on this machine unless this is it:

    sudo ./deploy/bootstrap.sh \\
      --admin-key  "\$(cat ~/.ssh/metaclaude_admin.pub)" \\
      --deploy-key "\$(cat ~/.ssh/metaclaude_deploy.pub)" \\
      --site  ${FQDN} \\
      --email you@example.com

  Let's Encrypt validates over http-01, so port 80 has to be reachable and the
  name has to resolve here. Both are true above before you start.

DONE
