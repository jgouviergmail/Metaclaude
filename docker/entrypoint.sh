#!/bin/sh
#
# Container entrypoint.
#
# Fails fast on the misconfigurations that would otherwise surface much later as
# confusing agent errors, then hands off to the application.

set -eu

log() { printf '[entrypoint] %s\n' "$1" >&2; }

# ── Writable state ───────────────────────────────────────────────────────────
# A read-only or wrongly-owned volume is the single most common deployment
# mistake; catching it here beats a stack trace from the migration runner.
for dir in "${METACLAUDE_DATA_DIR:-/var/lib/metaclaude}" \
           "${METACLAUDE_WORKSPACES_DIR:-/var/lib/metaclaude/workspaces}"; do
  if ! mkdir -p "$dir" 2>/dev/null; then
    log "FATAL: cannot create $dir."
    log "The data volume is not writable by uid $(id -u). Check its ownership."
    exit 1
  fi
  if ! touch "$dir/.write-probe" 2>/dev/null; then
    log "FATAL: $dir is not writable by uid $(id -u)."
    log "Run: chown -R 10001:10001 <host path for $dir>"
    exit 1
  fi
  rm -f "$dir/.write-probe"
done

# ── Claude credentials ───────────────────────────────────────────────────────
# Not fatal: the operator may want the UI up in order to read this warning, and
# everything except starting a run works without credentials.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  log "WARNING: no Claude credentials found."
  log "  For a Pro or Max subscription, run 'claude setup-token' on a machine"
  log "  where you are signed in, then set CLAUDE_CODE_OAUTH_TOKEN in .env."
  log "  For pay-as-you-go, set ANTHROPIC_API_KEY instead."
  log "  Agent runs will fail until one of these is present."
fi

# ── Master key ───────────────────────────────────────────────────────────────
# Generated on first boot and persisted under the data volume when absent.
# Losing it means losing every stored MCP secret, so say so loudly once.
if [ -z "${METACLAUDE_MASTER_KEY:-}" ]; then
  key_file="${METACLAUDE_DATA_DIR:-/var/lib/metaclaude}/master.key"
  if [ ! -f "$key_file" ]; then
    log "No METACLAUDE_MASTER_KEY set; one will be generated and stored at $key_file."
    log "Back that file up with your data volume — without it, stored secrets are unrecoverable."
  fi
fi

# ── git identity ─────────────────────────────────────────────────────────────
# The agent commits on the operator's behalf; without an identity git refuses.
if [ ! -f "${HOME:-/home/metaclaude}/.gitconfig" ]; then
  git config --global user.name "${GIT_AUTHOR_NAME:-Metaclaude}" || true
  git config --global user.email "${GIT_AUTHOR_EMAIL:-metaclaude@localhost}" || true
  # Workspaces are owned by this uid, but a bind-mounted host directory may not
  # be; without this git refuses to operate on it at all.
  git config --global --add safe.directory '*' || true
fi

log "starting Metaclaude"
exec "$@"
