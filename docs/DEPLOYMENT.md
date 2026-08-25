# Deployment

## First run

```bash
cp .env.example .env
```

Fill in two things:

### 1. Claude credentials

On a machine where you are already signed in to Claude Code:

```bash
claude setup-token
```

Paste the result into `.env`:

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

This is what makes Metaclaude bill against your **Pro or Max subscription**
rather than per token. The token is long-lived; Metaclaude passes it only to the
CLI subprocess it spawns.

`ANTHROPIC_API_KEY` works as a fallback for pay-as-you-go billing, and is only
consulted when the subscription token is absent.

### 2. The owner account

```bash
METACLAUDE_BOOTSTRAP_USER=owner
METACLAUDE_BOOTSTRAP_PASSWORD=<at least 12 characters>
```

Used exactly once, to create the account. Blank them out afterwards if you like.

### Start

```bash
docker compose up -d
docker compose logs -f app
```

Open **https://localhost**. The default `METACLAUDE_DOMAIN=localhost` makes Caddy
issue a local self-signed certificate, so your browser asks once — and the app's
`Secure` cookies work from the very first request, which they would not over
plain HTTP.

First thing after signing in: **Settings → Security → set up two-factor
authentication.**

---

## Reaching it from your phone

### Private network (recommended)

Put the host on Tailscale or WireGuard, then:

```bash
METACLAUDE_DOMAIN=metaclaude.your-tailnet.ts.net
METACLAUDE_TLS_EMAIL=you@example.com
```

Caddy fetches a real certificate, and the service has no public attack surface at
all. This is meaningfully better than any hardening in the codebase.

### Public hostname

Point an A/AAAA record at the host, open 80 and 443, and set `METACLAUDE_DOMAIN`
to that name. Caddy handles ACME automatically. Read
[SECURITY.md](SECURITY.md#deployment-advice) first.

### Install as an app

Open the site on your phone and choose **Add to Home Screen**. It installs as a
standalone PWA with its own icon and no browser chrome. The service worker caches
the shell so a cold start with a flaky connection still renders — but never
caches API responses, because stale state about what your agent is doing is worse
than no state.

---

## Volumes and backup

| Volume | Holds | Losing it means |
|---|---|---|
| `metaclaude-data` | database, master key, artifacts | everything except your files |
| `metaclaude-workspaces` | your project files | your work |
| `metaclaude-home` | the Claude CLI's session store | existing conversations start cold |

### Backup

```bash
docker compose stop app

docker run --rm \
  -v metaclaude_metaclaude-data:/data:ro \
  -v metaclaude_metaclaude-workspaces:/workspaces:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/metaclaude-$(date +%F).tar.gz" -C / data workspaces

docker compose start app
```

Stopping first matters: SQLite in WAL mode is crash-safe, but a copy taken
mid-write can capture a `-wal` file the backup does not include. The app
checkpoints WAL on shutdown, so a stopped container's database file is
self-contained.

**Back up `master.key`** (inside `metaclaude-data`) or set
`METACLAUDE_MASTER_KEY` explicitly. Without it, stored MCP secrets are
unrecoverable.

### Restore

```bash
docker compose down
docker run --rm \
  -v metaclaude_metaclaude-data:/data \
  -v metaclaude_metaclaude-workspaces:/workspaces \
  -v "$PWD/backups:/backup" \
  alpine sh -c "rm -rf /data/* /workspaces/* && tar xzf /backup/<file>.tar.gz -C /"
docker compose up -d
```

---

## Using an existing project directory

Bind-mount it instead of using the managed volume:

```yaml
services:
  app:
    volumes:
      - metaclaude-data:/var/lib/metaclaude
      - /home/you/code:/var/lib/metaclaude/workspaces
      - metaclaude-home:/home/metaclaude
```

The container runs as uid 10001, so:

```bash
sudo chown -R 10001:10001 /home/you/code
```

The entrypoint probes writability at boot and fails with an explicit message
rather than a stack trace if this is wrong.

---

## Tuning

| Variable | Default | Notes |
|---|---|---|
| `METACLAUDE_MAX_CONCURRENT_RUNS` | 4 | Each run is a CLI subprocess. Raise only with RAM to match. |
| `METACLAUDE_RUN_TIMEOUT_MS` | 2700000 | 45 minutes. Raise for long refactors. |
| `METACLAUDE_CPU_LIMIT` / `_MEMORY_LIMIT` | 4 / 4g | A run compiling a large project will use them. |
| `METACLAUDE_EMBEDDINGS` | `hash` | `local` downloads ~90 MB for better recall. Re-index after switching. |
| `LOG_LEVEL` | `info` | `debug` includes CLI stderr. |

Per-workspace settings — model, effort, permission mode, turn and cost ceilings,
and whether learning is on — live in the UI, under the workspace's settings
dialog.

---

## Upgrading

```bash
git pull
docker compose build app
docker compose up -d app
```

Migrations run automatically at boot, inside a transaction, recorded in
`_migrations`. They are append-only: a shipped migration is never edited, so an
upgrade cannot corrupt an existing database. Back up first anyway.

One upgrade does more than add a column. Migration 4 moves MCP **header values**
into the encrypted vault — they used to sit in plaintext on the server row, which
mattered because an HTTP MCP server authenticates through `Authorization`. The
column can only hold names after that, but migrations run before the vault key is
loaded, so the values are drained on the first boot of the new version instead:
the registry seals each one, records its name, and empties the old column. It
logs how many servers it converted and is a no-op on every boot afterwards. The
practical consequence is that this upgrade needs `master.key` to be present —
which it must be anyway, or no secret would decrypt.

The Claude CLI version is pinned in the Dockerfile (`CLAUDE_CLI_VERSION`).
Bumping it is a deliberate, reviewable change — an upstream CLI update should not
silently alter how your agent behaves.

---

## Health and troubleshooting

```bash
docker compose ps                  # health status
docker compose logs -f app         # application logs
curl -k https://localhost/api/health
```

Settings → System shows uptime, memory, disk, whether the CLI is present and
authenticated, active and queued runs, and the embedding provider in use.

**"Agent runs fail immediately"** — check Settings → System. If authentication
shows "none configured", the token is missing or was not picked up; check `.env`
and restart.

**"Cannot create /var/lib/metaclaude"** — the volume is not writable by uid
10001. See the bind-mount section above.

**"The vault could not decrypt some entries"** — `METACLAUDE_MASTER_KEY` does not
match the one used to write them. Restore the original key, or delete and
re-enter the affected MCP secrets.

**A run seems stuck** — it is probably waiting on a permission prompt. The
dashboard shows pending approvals across every workspace. Unanswered prompts are
declined after ten minutes.

---

## Running without Docker

```bash
pnpm install
pnpm build

METACLAUDE_DATA_DIR=/var/lib/metaclaude \
METACLAUDE_WORKSPACES_DIR=/var/lib/metaclaude/workspaces \
METACLAUDE_WEB_DIR=$PWD/apps/web/dist \
CLAUDE_CODE_OAUTH_TOKEN=... \
node apps/api/dist/index.js
```

Requires Node ≥ 22.11, `git`, and the `claude` CLI on `PATH`. Put a TLS-
terminating reverse proxy in front of it and set `METACLAUDE_TRUST_PROXY=1`, or
the `Secure` cookies will not be sent.
