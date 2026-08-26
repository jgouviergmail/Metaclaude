# Architecture

## The shape of the thing

Metaclaude is a single Node process that supervises Claude CLI subprocesses,
plus a React app that talks to it. Everything else — memory, learning, the
scheduler — is bookkeeping arranged around one operation: **run the agent, then
learn something from having run it.**

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (PWA)                                                       │
│  React 19 · TanStack Query (server state) · Zustand (live state)     │
└──────────────┬───────────────────────────────┬───────────────────────┘
               │ REST (JSON)                   │ WebSocket (multiplexed)
┌──────────────▼───────────────────────────────▼───────────────────────┐
│  Fastify                                                             │
│  helmet → cookie → rate-limit → auth guard → CSRF guard → routes     │
├──────────────────────────────────────────────────────────────────────┤
│  KERNEL                                                              │
│    admission → classify → policy → recall → execute → record → learn │
│    PermissionBroker · EventBus · concurrency scheduler               │
├───────────────┬──────────────────┬───────────────────────────────────┤
│  LEARNING     │  SERVICES        │  SECURITY                         │
│  embeddings   │  workspaces      │  auth · TOTP · vault              │
│  memory       │  files (jailed)  │  audit (hash-chained)             │
│  bandit       │  git             │  path jailing                     │
│  classifier   │  registry        │  rate limiting                    │
│  reflexion    │  scheduler/cron  │                                   │
├───────────────┴──────────────────┴───────────────────────────────────┤
│  SQLite (WAL) — single connection, synchronous, transactional        │
└──────────────────────────────────────────────────────────────────────┘
               │
               │ spawns
┌──────────────▼───────────────────────────────────────────────────────┐
│  claude (the real CLI)  ──▶ Anthropic, on your subscription          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Why the Claude CLI, and not the API

Metaclaude never calls the Anthropic API. `@anthropic-ai/claude-agent-sdk`
spawns the actual `claude` binary and speaks to it over a control protocol.

That choice buys three things that would otherwise have to be rebuilt, badly:

1. **Subscription billing.** A Pro or Max plan authenticates the CLI, not the
   API. Going through the binary means no per-token charges.
2. **The whole Claude Code feature set.** `CLAUDE.md` discovery, skills, plugins,
   MCP, the tool implementations, compaction, checkpointing — all of it already
   works, and keeps working as the CLI is updated.
3. **A stable seam.** The SDK's message stream is a documented contract. The
   supervisor translates it; nothing else in the codebase knows the CLI exists.

The cost is a subprocess per run. At the concurrency a personal deployment needs
(default 4), that is the right trade.

---

## The kernel

`apps/api/src/kernel/` is where a prompt becomes a run.

### Admission
`Kernel.submit()` refuses a second concurrent run on the same session — the CLI
resumes a session by id, and two writers on one session id would interleave. It
classifies the prompt, chooses a policy, creates the run row, and returns
immediately. The HTTP response does not wait for the agent; everything after
that point is observed over the event bus.

### Scheduling
A FIFO queue behind a semaphore of `METACLAUDE_MAX_CONCURRENT_RUNS`. Each run
holds a slot for its whole lifetime, including the time it spends waiting for a
human to answer a permission prompt — deliberately, because a run blocked on
approval still owns a live subprocess.

### Execution
`AgentSupervisor` builds SDK `Options` from the run policy plus workspace
settings, then consumes the message stream:

| SDK message | Becomes |
|---|---|
| `system` / `init` | the Claude session id, persisted so the session can resume |
| `assistant` (text) | an `assistant_text` transcript event |
| `assistant` (thinking) | a `thinking` event |
| `assistant` (tool_use) | a `tool_call` event, status `running` |
| `user` (tool_result) | the matching `tool_call` updated to `ok` / `error` |
| `stream_event` | an ephemeral `delta` frame — broadcast, never persisted |
| `result` | usage, cost, and the terminal status |

**Streaming without double-writing.** Deltas arrive many times a second; writing
each to SQLite would be wasteful, and a partial block is not a fact worth
storing. So deltas are broadcast only, keyed by an id derived deterministically
from `(message id, block index)`. When the block completes, the authoritative
transcript event carries *that same id*, and the client's streaming buffer is
replaced rather than duplicated. A `result` event clears any orphaned buffers, so
a block that never completed cannot linger.

### Permissions
`canUseTool` from the SDK becomes a pending promise plus an approval card pushed
to every subscribed client. Two properties are non-negotiable:

- **An unanswered prompt cannot wedge the run.** It resolves as a denial after
  ten minutes, with a message telling the model to take a different approach.
- **A denial must be actionable.** Returning a bare "denied" makes the model
  retry the identical call in a loop; the message explicitly says not to.

Decisions can be remembered for the rest of a session — except for high-risk
calls, where "always allow" is withheld by design.

### Recovery
A crash leaves runs marked `running` and sessions marked busy. Both repositories
expose `recoverOrphaned()`, called once at boot, which marks them interrupted.
History stays truthful and the UI does not show a phantom live run.

### Rewind
A workspace with file checkpointing on can undo a run's file changes after the
fact.

The mechanism is the CLI's, not ours — `enableFileCheckpointing` on the way in,
`Query.rewindFiles()` on the way back — but it needs an address, and that is the
part with no second source. The CLI files each user message under a uuid and
sends it back once, as a replay acknowledgement mid-stream. The supervisor picks
it off the wire and it is stored on the run as `rewind_point`; the *first*
acknowledgement only, so that a follow-up typed into a steerable run does not
move the anchor forward and quietly shrink what "undo this run" restores. Null
means the run cannot be rewound, and the UI offers nothing rather than a button
that fails.

Rewinding a *finished* run is the interesting case, and the only one that
matters — an operator does not know a run made a mess until it is over. Every
other control method acts on a handle that exists only while the subprocess
runs. So `AgentSupervisor.rewind()` opens a new session, resumed onto the same
CLI session id with checkpointing enabled, purely to issue one control request:
the checkpoints belong to the session rather than to the process. That session
is drained (the control channel is pumped by consuming the message stream, so an
un-iterated handle waits forever on a reply nobody is reading), then closed
*and* aborted — closing the input asks the subprocess to exit, and aborting is
teardown that does not depend on it agreeing.

Every rewind is previewed first, by the CLI's own dry run rather than by a
second implementation that could disagree with the real one. The route is
owner-only and `dryRun` defaults to true, so a request that forgets its body
previews rather than destroys.

---

## Automations and time

The scheduler ticks once a minute and fires whatever is due. Three rules make
that safe to leave running unattended:

- **A missed window fires once, not once per missed slot.** A server down for a
  day must not wake up and run a nightly job twenty-four times.
- **A firing is skipped, not queued, when the previous one is still in flight.**
  Otherwise a job slower than its own interval builds an unbounded backlog. The
  check is against the session the *previous* firing used, deliberately: a
  one-shot automation mints a fresh session each time, so asking the new one
  whether it is busy always answers "no" and the guard never fires.
- **Repeated unattended failures disable the automation** and raise a
  notification, so a loop that has started failing stops burning budget. A human
  pressing "Run now" is exempt: debugging an automation should not switch it off
  underneath you.

Cron expressions are parsed and projected in-process (`services/cron.ts`) rather
than through a library, because the scheduler needs the next fire time from an
*arbitrary* instant — for catch-up after downtime and for the "next run" the UI
shows — and most small cron libraries only offer a callback timer.

The subtlety worth stating is daylight saving. Fire times are built from local
calendar fields, never by stepping a cursor minute by minute, because stepping a
`Date` steps *wall-clock* minutes:

- **Spring forward.** Local 02:00–02:59 does not exist. A stepping cursor goes
  01:59 → 03:00 and never visits them, so `30 2 * * *` silently skips that day —
  and in a zone whose transition is at midnight, `@daily` loses a whole day.
  Building the candidate from local fields normalises it onto the first instant
  that does exist, which is what Vixie cron does.
- **Fall back.** Local 02:00–02:59 happens twice. Constructing from local fields
  resolves to the first occurrence and never offers the second, so an automation
  cannot run twice because a clock moved backwards.

---

## Data model

SQLite in WAL mode, one synchronous connection. For a single-user OS this is a
feature: no pool, no interleaving, and transactions are trivially correct.

```
users ──< auth_sessions
workspaces ──< sessions ──< runs ──< transcript_events
                                 └─< memory_usages >── memories
workspaces ──< memories, policy_arms, task_exemplars, insights,
               skills, agents, mcp_servers, automations
secrets (AES-256-GCM)      audit_log (hash-chained)      kv
```

**Transcript events are the source of truth.** A run is rendered purely from its
ordered event list, so reload, replay and live streaming share one code path.
There is no separate "message" table that could drift.

`memories` carries its embedding as a `BLOB` of little-endian `Float32` and is
mirrored into an FTS5 index by triggers. Retrieval reads both.

---

## Realtime

One WebSocket per client, multiplexed by topic:

- `session:<id>` — transcript, deltas, run lifecycle for one session
- `workspace:<id>` — session list changes, automations
- `system` — approvals, notifications, metrics, across the whole OS

Frames are Zod-validated in both directions. Authentication rides on the session
cookie (sent on the upgrade request); the first frame must then present the CSRF
token, which is what stops a cross-origin page from opening an authenticated
socket — `WebSocket` ignores CORS entirely.

### Resuming after a drop

A phone suspends a background tab within seconds, so a dropped socket is the
normal case, not the edge one. The bus keeps a bounded per-topic ring buffer
(256 frames, 60 seconds) and the protocol has a cursor to read it with:

1. Every frame the bus publishes goes on the wire with its **sequence number**
   alongside it — outside the frame union, so all fourteen variants need not
   carry it.
2. The client records the highest sequence it has applied.
3. On reconnect it re-subscribes with `since: <cursor>`, and the server replays
   that topic's buffered frames before attaching the live listener. The
   `subscribed` acknowledgement reports how many were replayed.

Replayed frames carry their own sequence, so the cursor advances past them and a
second reconnect does not receive the same window again. Delta frames are
excluded from the buffer entirely: they are superseded by the transcript event
that follows, so replaying them would duplicate text already on screen.

Anything older than the buffer falls outside this mechanism. The session page
covers that separately — it refetches whenever the socket transitions back to
`open`, so a long disconnect resyncs from the database instead of silently
showing a run that finished ten minutes ago as still in flight.

---

## Filesystem safety

Every path the client supplies passes through `resolveInside(root, userPath)`
before an fd is opened. It:

1. rejects NUL bytes,
2. treats a leading `/` as workspace-relative, not filesystem-root,
3. resolves the result and checks containment with `path.relative` — not string
   prefixing, which would accept `/data/workspaces-evil` as inside
   `/data/workspaces`,
4. **resolves symlinks**, walking up to the nearest existing ancestor for paths
   that do not exist yet, so a link planted inside a workspace cannot point out
   of it,
5. rejects a small deny-list of reserved names (`.git-credentials`, `.netrc`,
   `master.key`).

The test suite includes a real symlink escape against a real temporary directory.

---

## Plugins

Metaclaude implements **Agent Plugins 1.0.0**, the vendor-neutral package format
published by Amazon, Cursor, Microsoft, OpenAI and Vercel. A plugin is one
directory: a `plugin.json` manifest, immediate subdirectories of `skills/` each
holding a `SKILL.md`, and an optional `mcp.json`.

The specification is enforced rather than assumed. `services/plugins.ts` reads a
single plugin and holds it to the spec — `skills/` is searched one level deep
and no deeper, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in a server's
args, env and cwd, unknown top-level fields are reported but not fatal, and
`extensions` is passed through unvalidated because the spec says a client must
not interpret it. Each component is loaded in isolation: a malformed skill
produces a warning attached to the plugin, never a failed install.

`services/plugin-registry.ts` owns the installed set. Three decisions are
load-bearing:

- **Copied, not referenced.** The source is usually a clone the operator will
  delete, and a plugin that stops working when a temporary directory is cleaned
  was never installed. The copy is also what makes `PLUGIN_ROOT` a path this
  server controls.
- **Data is a sibling of the code.** `<name>.data` sits next to `<name>/`, so
  replacing the code wholesale does not take the plugin's state with it.
- **The manifest is stored whole.** A row projecting today's ten columns would
  discard both `extensions` and whatever 1.1 adds.

Two containment rules, because a plugin is third-party code:

1. The declared paths are checked against the plugin root through `realpath`,
   as the spec requires.
2. Symlinks are judged **on the way in**. `cp` preserves them, so a link
   pointing outside the source becomes an ordinary path inside the installed
   plugin — and skill directories are later copied wholesale into a workspace
   the agent can read. Installing a plugin would otherwise be an arbitrary-file
   read for whoever wrote it. Links that stay inside are kept: sharing one file
   between two skills is legitimate, so the rule is "no symlinks that leave",
   not "no symlinks".

Name collisions are resolved deterministically and *reported*: the first plugin
by name order keeps a contested skill, and the loser is named in the warnings —
a plugin that appears installed and silently does nothing is the worst outcome
available. MCP servers avoid the question entirely by being namespaced
`<plugin>__<server>` before they reach a run.

Workspace-level skills and MCP servers are merged over plugin ones, so a
workspace can always override what a plugin provides.

---

## Frontend

**Server state** lives in TanStack Query. **Live state** — the transcript on
screen, streaming buffers, pending approvals — lives in a Zustand store, because
it updates many times a second and must not invalidate query caches.

The socket is owned by the app shell, not by a page. Notifications and run
lifecycle keep arriving on every screen, which is the difference between a chat
window and an OS.

Model output is rendered through a hand-written allow-list sanitiser: `marked`
produces HTML, that HTML is parsed into a detached `<template>`, and the tree is
walked with an explicit tag and attribute allow-list. Raw HTML from the model is
dropped entirely, and URLs are scheme-checked after stripping control characters
(so `java\nscript:` cannot slip through). Images are never fetched — an `<img>`
is a request to an arbitrary host.

---

## Deployment

```
Internet ──▶ Caddy (TLS) ──▶ [internal docker network] ──▶ app
                                                            │
                                            volumes: data, workspaces, home
```

The app publishes no port. The only route in is the proxy, so TLS cannot be
forgotten. The container runs as uid 10001, drops every capability, sets
`no-new-privileges`, and mounts a read-only rootfs with a writable `/tmp`.

`$HOME` is a **named volume, not tmpfs** — the Claude CLI stores session
transcripts under `$HOME/.claude` and Metaclaude resumes them by id. On tmpfs,
every conversation would start cold after a restart.

`/tmp` is mounted `nosuid` but deliberately **not** `noexec`: build tooling the
agent legitimately runs (node-gyp, cargo, pip) executes helpers it writes there,
and forbidding that breaks ordinary work rather than an attack.
