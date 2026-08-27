# Settings and security

The Settings screen is small on purpose: most decisions live where they act —
per workspace, per message. What remains here is identity, credentials and the
machine.

## Your account

- **Two-factor authentication.** Enrol by scanning the QR code (or typing the
  setup key), confirm one code, store the recovery codes. Codes are single-use
  in the strict sense: two simultaneous sign-ins cannot share one. Re-enrolling
  replaces the authenticator and issues fresh recovery codes.
- **Sessions.** Every signed-in device is listed and individually revocable.

## Claude pairing

The agent runs on your Claude subscription, and pairing it happens entirely
from this screen — no shell anywhere. Press **Start pairing**: Metaclaude
runs the same OAuth flow `claude setup-token` would, and hands you the
sign-in link. Open it (on this device, or copy it to any other), approve
with your Pro or Max account, and paste back the code Claude displays. The
server exchanges that code for a year-long token, seals it in the encrypted
vault, and the very next run uses it — no restart. The token itself never
passes through your browser.

The link stays valid for ten minutes and one attempt exists at a time;
starting again simply replaces it. If Claude rejects the code, paste it
again or start afresh — a code belongs to the link that produced it.

Pasting a ready-made credential still works below the wizard: a
`sk-ant-oat…` token from `claude setup-token` on any signed-in machine, or
a `sk-ant-api…` key for per-token Console billing — Metaclaude tells them
apart on its own. The **System** card shows what is actually live: CLI
version, authentication mode, and where the credential came from.

A third source exists: the CLI's own account sign-in (`claude auth login`,
run once in the container), which is what claude.ai session sync requires —
see the sessions chapter. The card reports it, says when runs are using it,
and warns when a paired token is overriding it, because removing a token is
sometimes the upgrade.

## Appearance

Light, dark, or follow the system. The whole interface is built on one token
set, so both themes are first-class — including the charts.

## System, doctor and updates

The System tab shows the server's vitals — version, uptime, memory, disk, and
the Claude CLI's state. For the owner, two more cards:

**Doctor** runs every self-check the system knows in one pass — database
integrity, the audit chain, the secrets vault, disk space on both volumes,
the CLI and its credential, and any automation the failure guard switched
off. Each check answers with a verdict and its evidence, and nothing is
changed by running it.

**Updates** compares this version against the latest published release
(`METACLAUDE_UPDATE_REPO`; set it empty to disable the check) — and, on a
server whose installer set up the updater, an **Apply** button runs it.
Applying never gives the app any power over the host: it writes the bare
version into an exchange directory, and a host-side systemd unit composes
the image from the server's own pinned repository and runs the same
health-gated, auto-rolling-back deploy the CI path uses. The app restarts
mid-deploy — the page rides out the gap and reloads itself on the new
version — and a deploy that does not go healthy rolls back by itself, with
the failure shown on the card. Without the host updater (re-run
`deploy/install-app.sh` to add it) the card stays informational, exactly
as before.

## What protects you (the short version)

- **TLS is mandatory** — the app refuses to be less than a secure context.
- **Secrets are sealed** — MCP credentials and the Claude token live in an
  AES-256-GCM vault whose master key is not in the database that holds the
  ciphertext.
- **Every consequential action is audited** — sign-ins, runs, permission
  decisions, settings changes — in an append-only, hash-chained log the
  server can verify end to end.
- **The agent is jailed** — file access stays inside the workspace, the
  master key is structurally out of its reach, and widening access is a
  server-side policy decision, not a conversational one.

The operator-level detail — deployment, backups, the master key, uninstalling
— lives in the repository's `docs/` for whoever runs the server.
