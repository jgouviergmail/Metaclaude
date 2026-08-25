<div align="center">

<img src="apps/web/public/icon.svg" width="88" alt="" />

# Metaclaude

**A private, self-hosted agentic OS built entirely on the Claude CLI.**

Talk to Claude Code from your laptop, tablet or phone — through an interface that
remembers what it learned, chooses its own model, runs on a schedule, and asks
before it does anything it cannot undo.

</div>

---

## What this is

Claude Code is excellent in a terminal. This gives it the rest of an operating
system around it:

- **A real interface**, on every device you own. Installable as a PWA, usable
  one-handed on a phone.
- **Memory that persists** across sessions and projects — and that is retrieved
  automatically into the runs where it helps.
- **A policy that learns.** Which model and effort level actually works for which
  kind of task, measured rather than guessed.
- **Loops.** Automations that run on a schedule, including continuous ones that
  keep the same session and accumulate context indefinitely.
- **Permission prompts you can actually read**, with the literal command shown
  and a risk assessment attached.

It runs on **your Claude Pro or Max subscription**. The Agent SDK spawns the real
`claude` binary, so everything your plan includes — models, skills, plugins,
MCP — works exactly as it does in your terminal. Metaclaude never talks to the
Anthropic API directly.

---

## Quick start

```bash
git clone <this repo> metaclaude && cd metaclaude
cp .env.example .env
```

Get a subscription token on a machine where you are already signed in:

```bash
claude setup-token
```

Paste it into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, set
`METACLAUDE_BOOTSTRAP_PASSWORD` to something at least 12 characters, then:

```bash
docker compose up -d
```

Open **https://localhost**. The certificate is self-signed on the default
`localhost` domain, so your browser will ask once. Sign in with the bootstrap
credentials and turn on two-factor authentication under Settings → Security.

To reach it from your phone, point `METACLAUDE_DOMAIN` at a hostname that
resolves to the machine — a Tailscale name works well — and Caddy fetches a real
certificate automatically.

---

## The idea

An agent that starts from zero every session is a very good autocomplete. An
agent that accumulates knowledge about *your* projects and *your* preferences is
something else. Metaclaude closes that loop explicitly:

```
  prompt
    │
    ├─▶ classify ──────────▶ what kind of task is this?
    │
    ├─▶ choose policy ─────▶ which model has worked best on this kind of task?
    │
    ├─▶ recall memory ─────▶ what do we already know about this project?
    │
    ├─▶ RUN (Claude CLI) ──▶ the agent works, asking before anything irreversible
    │
    ├─▶ score outcome ─────▶ success, cost, latency, and your rating
    │
    ├─▶ update policy ─────▶ Thompson sampling over (model, effort) arms
    │
    ├─▶ reinforce memory ──▶ memories that helped gain confidence; the rest decay
    │
    └─▶ reflect ───────────▶ a cheap, tool-less pass extracts durable lessons
```

Every one of those steps is inspectable and resettable from the UI. A
self-modifying system you cannot read is not one you should trust.

Full detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** ·
**[docs/LEARNING.md](docs/LEARNING.md)** · **[docs/SECURITY.md](docs/SECURITY.md)**

---

## Features

### Sessions
Streaming token-by-token output, collapsible reasoning blocks, compact tool-call
cards that expand on demand, live plan checklists, inline diffs, and per-run
cost and token accounting. Model, effort and permission mode are per-message
controls, not buried settings.

### Permissions
Every tool call that writes, deletes, runs a command or reaches the network can
require approval. The prompt shows the **literal** command — not a paraphrase —
with a heuristic risk badge. High-risk calls (matching `rm -rf`, `curl | sh`,
force pushes, `sudo`, …) never offer "always allow". Deny is always the focused
button.

Six modes, from **Plan** (research only, nothing executes) through **Ask**,
**Accept edits**, **Auto** and **Don't ask**, to **Bypass** — which is disabled
at deployment level unless you explicitly enable it.

### Memory
Three kinds — episodic, semantic, procedural — retrieved by hybrid search:
dense vectors for paraphrase, BM25 for exact identifiers, fused by reciprocal
rank, then weighted by confidence and recency. Memories that get retrieved into
runs that succeed gain confidence; the rest decay on a forgetting curve until
the janitor collects them.

Embeddings run **locally**. The default needs no model download at all.

### Learning
A contextual multi-armed bandit picks the model and effort for each task
category, using Thompson sampling over a Beta posterior. Reward combines
success, cost, latency and your explicit thumbs up/down — which overrides
everything else, because your judgement is the ground truth being learned.

The Analytics screen shows the posterior for every arm in plain language:
*"Across 34 runs, sonnet at high effort performs best (82% expected quality,
$0.041 and 47s on average)."* And a Reset button, because unlearning must be as
easy as learning.

### Automations
Cron or interval triggers, with a **continuous** mode that keeps one session
alive across every firing so context accumulates. Guard rails included:
consecutive-failure limits that disable a runaway loop, skipped rather than
queued firings when the previous run is still going, and no burst of catch-up
runs after downtime.

### Workspaces
A directory, plus the agent policy that applies inside it. Optional git clone on
creation, a file browser with a real editor, and a source-control panel with
staging, diffs and commits.

### Extensibility
Skills (written to `.claude/skills/` before each run so the CLI discovers them),
custom subagents, and MCP servers with credentials held in an AES-256-GCM vault.

---

## Security

This runs an agent that executes model-authored commands against your files. The
posture reflects that:

| Layer | What it does |
|---|---|
| **Auth** | scrypt (N=2¹⁶) passwords, TOTP 2FA with recovery codes, opaque session tokens stored only as hashes |
| **CSRF** | `SameSite=Strict` + Origin check + double-submit token — three independent failures required |
| **Sandbox** | Non-root container, all capabilities dropped, `no-new-privileges`, read-only rootfs, resource limits |
| **Path jailing** | Every filesystem operation resolves through a jail check, symlinks included, before an fd is opened |
| **Secrets** | AES-256-GCM with AAD binding each ciphertext to its slot; values never returned by any endpoint |
| **Audit** | Hash-chained log — any edit invalidates every entry after it, verifiable from the UI |
| **Network** | The app binds to an internal Docker network only; nothing reaches it except through the TLS proxy |
| **XSS** | Model output is rendered through an allow-list sanitiser with no raw HTML passthrough |

Details and threat model: **[docs/SECURITY.md](docs/SECURITY.md)**

---

## Development

```bash
pnpm install
pnpm --filter @metaclaude/shared build

# Terminal 1 — API on :8787
METACLAUDE_DATA_DIR=$PWD/.data \
METACLAUDE_WORKSPACES_DIR=$PWD/.data/workspaces \
METACLAUDE_INSECURE_COOKIES=1 \
METACLAUDE_BOOTSTRAP_USER=dev \
METACLAUDE_BOOTSTRAP_PASSWORD=dev-password-please-change \
NODE_ENV=development \
pnpm --filter @metaclaude/api dev

# Terminal 2 — web on :5173, proxying /api to the above
pnpm --filter @metaclaude/web dev
```

```bash
pnpm test:run    # 427 tests
pnpm typecheck
pnpm build
```

**Stack:** Node 22 · Fastify 5 · SQLite (WAL) · TypeScript 5.9 · React 19 ·
Vite 8 · Tailwind v4 · Zod 4 · `@anthropic-ai/claude-agent-sdk`

---

## Layout

```
packages/shared/    Zod contracts shared by the API and the web app
apps/api/
  ├── kernel/       Run lifecycle, Agent SDK bridge, permissions, event bus
  ├── learning/     Embeddings, memory, bandit, classifier, reflexion
  ├── security/     Auth, TOTP, crypto, vault, audit, path jailing
  ├── services/     Workspaces, files, git, registry, scheduler, analytics
  └── routes/       REST + WebSocket
apps/web/           React PWA
docker/             Dockerfile, Caddyfile, entrypoint
```

## Licence

MIT
