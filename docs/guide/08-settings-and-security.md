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

The agent runs on your Claude subscription. Pair it here by pasting a
setup-token from a machine where you are signed in — the token is stored in
the encrypted vault, used only to run the CLI, and survives restarts. The
**System** card shows what is actually live: CLI version, authentication mode,
and where the credential came from.

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
