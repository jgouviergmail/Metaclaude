# Settings and security

The Settings screen is small on purpose: most decisions live where they act —
per workspace, per message. What remains here is identity, credentials and the
machine.

## Your account

- **Two-factor authentication.** Enrol by scanning the QR code (or typing the
  setup key), confirm one code, store the recovery codes. Codes are single-use
  in the strict sense: two simultaneous sign-ins cannot share one. Re-enrolling
  replaces the authenticator and issues fresh recovery codes.
- **Passkeys.** Sign in with the device's own unlock — Face ID, a fingerprint,
  a security key — instead of the password. Adding one costs your password
  (so does removing one), the password keeps working either way, and the
  sign-in screen offers the passkey button once any device is enrolled. One
  honest limit: the WebAuthn standard scopes a passkey to a **domain name**,
  so a deployment you reach by IP address cannot use them — the card says so
  and points at `METACLAUDE_SITE` — and a passkey enrolled at one address
  only answers at that address. A passkey sign-in also ignores the password
  lockout on purpose: it is your way back in while someone else hammers the
  password form.
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

**It also says when that sign-in ends**, and the difference between the two
sources is worth knowing before you choose one. An account sign-in is held in
the container's home volume and lapses on a fixed date a few weeks out —
measured on a real deployment, the date did not move across a day of use, so
activity does not extend it. A paired token lives a year, sits in the sealed
vault, and therefore rides along in the nightly backup: losing the home volume
costs you a sign-in but not a paired token. Session sync is the one thing only
the account sign-in can do.

## Notifications

The System tab's **Notifications** card makes the phone part of the loop:
enable it on a device and Metaclaude pushes when a run **waits on your
approval** — the one moment the whole system is blocked on you — and when
a run **you started** ends, with its outcome. Automations, loops and
delegated runs never push, by design: they work while you sleep, and a
channel that wakes you for them gets disabled within a week.

Everything stays self-hosted: the signing keys are generated on your
server and sealed in the vault, the payload is encrypted end-to-end
(RFC 8291) so the browser vendor's relay sees nothing readable, and it
carries only a title, a short line and the link to open — never prompt
text or tool input. **Send a test** proves the whole path to the lock
screen. On iPhone and iPad, install the app to the Home Screen first
(Share → Add to Home Screen); push needs the installed app.

While approvals wait, the installed app's icon also carries a **badge**
with their count — it clears the moment the last one is decided.

## Appearance

**Language.** The interface speaks English and French; the switch lives here,
the choice sticks to this browser, and a browser already set to French starts
in French. Each language names itself in itself, so you can always find the
way back. The guide you are reading and the changelog stay in English for
now, as does text the server or the CLI produces (error messages, doctor
verdicts, transcripts).

**Theme.** Light, dark, or follow the system. The whole interface is built on
one token set, so both themes are first-class — including the charts.

## Configuration

Owner only. The operational settings this server runs on — how long a run may
go quiet before it is stopped, how many may run at once, when the quota guard
pauses automatic starts, how long finished runs are kept, and what the server
writes to its own log. A value saved here applies to the **next run**, with no
restart.

Two things are worth knowing before you change one.

**A saved value outranks the environment**, and the row says what it is
shadowing. That order is not arbitrary: the compose file names every one of
these with a default of its own, so the environment is always set and a screen
that deferred to it would never do anything. The cost of winning is honesty, so
each row reports where the value in force came from — saved here, from the
environment, or the built-in default — and offers **Use the environment's
value** to hand it back. You do not have to remember what the `.env` said; the
row tells you.

**Anything that is a security decision is deliberately not here.** Bypass mode,
allowed origins, proxy trust, the master key, the bootstrap account: those stay
in the environment, because what protects them is being unreachable from a
signed-in browser. The server refuses any key that is not on this short list,
so the absence is a property of the API and not of the form. The data
directories and the embedder are absent for a different reason — they cannot
change while the process runs, and switching the embedder would leave every
stored memory unreadable to the new one.

## System, doctor and updates

The System tab shows the server's vitals — version, uptime, memory, disk, and
the Claude CLI's state. For the owner, two more cards:

**Doctor** runs every self-check the system knows in one pass — database
integrity, the audit chain, the secrets vault, disk space on both volumes,
the age of the last completed backup, whether anything can reach the internet
from this container, the CLI and how long its credential has left, and any
automation the failure guard switched off. Each check answers with a verdict and its
evidence, and nothing is changed by running it. The backup check reads the
marker the host's nightly backup writes after each completed archive; a
warning there means backups have quietly stopped — or never started — which
is exactly the day-late news you want a day early.

The network check is a `fail` rather than a warning, because with no egress
nothing the product does works at all: the CLI cannot reach the API, `git
clone` cannot resolve a remote, and no HTTP MCP server connects. It is the
first thing to look at when runs fail for no visible reason — it separates
"this server has no network" from "the model was refused", which otherwise
look identical from a transcript.

A credential the server can date gets counted down: two weeks before a CLI
account sign-in ends, the check turns to a warning naming the days left, and to
a failure once it has passed. That matters because the end is a wall rather
than a rolling window — using the deployment does not push it back — and
because everything works perfectly right up to the moment it does not. A pasted
token carries no date this server can read, so nothing is claimed about one.

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

## Connections

Owner only: connections Metaclaude authorises for itself, starting with
**Google**. The full walkthrough lives in the extensions chapter beside the
MCP registry it feeds — the short version is that you register your own OAuth
application (the screen shows the exact redirect URI to paste into the Google
Cloud console), tick what the agent may do grant by grant, and consent once
in your own browser. The refresh token lands in the vault, the
Gmail/Calendar/Drive server ships inside the image, and it appears under
Agents & skills disabled until you switch it on.

Two honest notes the screen also tells you. Reading mail or Drive uses
scopes Google classes *restricted*: on a consent screen still in "Testing"
the refresh token expires after seven days, so publish the app as Internal
(a Workspace account) or leave those grants unticked. And **Disconnect is
local** — it erases what Metaclaude stored, but Google keeps listing the
grant until you revoke it yourself at myaccount.google.com/permissions.

### Letting other applications in

The same tab holds the other direction: **MCP access**, where you mint the
token another application uses to reach this agent. The extensions chapter has
the walkthrough; what belongs here is the shape of the decision. A token is not
a second account — it names the workspaces it can reach (there is no "all
workspaces", deliberately), what it may do, and a **ceiling** on what a run it
starts may do on its own. It expires on a date you choose, it is shown once,
and revoking it stops everything using it immediately.

Treat one like a password with a blast radius: anything holding it can ask this
agent to work, and the agent runs commands. The listing shows when each token
was last used, which is how an integration you have forgotten becomes visible
again.

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
