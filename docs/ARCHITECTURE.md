# Architecture

## The shape of the thing

Metaclaude is a single Node process that supervises Claude CLI subprocesses,
plus a React app that talks to it. Everything else — memory, learning, the
scheduler — is bookkeeping arranged around one operation: **run the agent, then
learn something from having run it.** One workspace is special: the system's
own, where the same pipeline runs an agent whose tools act on the application
itself (see *The steward*, below), through the same broker, audit log and
memory as every other run.

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
│  embeddings   │  workspaces      │  auth · TOTP · passkeys · vault   │
│  (bge-m3)     │  files (jailed)  │  audit (hash-chained)             │
│  memory       │  git · registry  │  path jailing                     │
│  knowledge    │  scheduler/cron  │  rate limiting                    │
│  bandit       │  board · advisor │  tool grants · directory review   │
│  classifier   │  steward · MCP   │                                   │
│  reflexion    │  gateway         │                                   │
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

A workspace's **pre-approved tools** are the standing version of that, and the
seam they are answered at is the design decision worth recording. Telling the
CLI about a pre-approval makes it auto-approve the tool *before* `canUseTool`
runs at all — measured, in `Ask` mode, with no card shown — which would delete
that mode's whole promise. So the broker answers them in every mode except one,
which keeps the decision and its transcript line inside Metaclaude; `dontAsk` is
the exception, because there the CLI refuses on its own before the broker can be
reached, and it is told through `managedSettings.permissions.allow` rather than
`allowedTools`: a search executes upstream rather than in the CLI, and only a
permission rule reaches it. `plan` pre-approves nothing.

`result.permission_denials` — the CLI's own record of what it refused without
asking — is read at the end of every run and written to the transcript as one
line. It used to be dropped, leaving the agent's closing paragraph as the only
trace, which nobody reads on an unattended run.

### Two ceilings on a run
`runTimeoutMs` measured elapsed time and nothing else, which is the wrong
question: it punishes a run for working, and a loop, a long refactor and a
two-hour automation are indistinguishable from a wedged subprocess to a clock.
So the ceiling that normally fires is an **idle** one — no message from the CLI
for N minutes — re-armed on every message the stream carries. That silence is a
usable signal because it was measured: during a tool call that ran for 100
seconds the CLI emitted `tool_progress` every 30 seconds, so ten minutes of
nothing carries a factor of twenty over the heartbeat and needs no special case
for a tool being in flight. It needs exactly one special case, and it was found
in production: while an approval card waits for a person the CLI is blocked
inside `canUseTool` and emits nothing, so a run whose `Glob` needed a card was
stopped "for reporting nothing" with the card still on the Dashboard — the
card's own timeout is the same ten minutes and lost the race by two seconds.
`canUseTool` therefore holds the idle clock through `LiveRun.holdIdle` for as
long as the broker has not answered. The absolute ceiling remains as the
backstop for what silence cannot see — a tool that never returns — and is
measured in hours.

Zero means *no timer*, never a timer of zero: a zero-delay abort fires before
`query()` is called, an already-aborted signal reaches no listener, and the run
would then end as a success having been stopped.

The delegation waiter derives from the absolute ceiling rather than restating
it. It was a constant of fifty minutes with a comment claiming it outlasted the
run timeout — true against the forty-five minute default of the day, false the
moment anyone raised it, and the waiter giving up first turns "the delegated run
hit its limit" into "the delegation timed out".

### Settings that change while it runs
`RuntimeSettings` resolves **stored override > environment > schema default**,
and that order is forced rather than chosen: `compose.yml` names every
operational setting with a default of its own, so the environment is always
present and an environment-wins design would be inert in every real deployment.
The price is a second source of truth, paid by reporting provenance on every
record — what is in force, and what it would fall back to.

Nothing is pushed. Consumers hold a getter (`runTimeoutMs: () => number`, the
same lazy shape as `broker`) and read at the point of use, so a change applies
to the next run with no notification graph to keep in step. The one exception is
a setting whose effect lives outside anything that will look it up again — the
log level sits on the logger object — and those declare `applies` and are
replayed at boot.

### Recovery
A crash leaves runs marked `running` and sessions marked busy. Both repositories
expose `recoverOrphaned()`, called once at boot, which marks them interrupted.
History stays truthful and the UI does not show a phantom live run.

### Where the usage went
Analytics could already scope to one workspace at a time. That answers "how much
did this one cost" and never "which one is eating the quota" — and on a
subscription with a weekly ceiling, the second question is the one that matters.
It needs every workspace on screen at once, so it cannot be a filter; the
summary now carries `byWorkspace` and the page draws a ranked, proportional
comparison from it.

Two decisions about how that chart tells the truth. The bars are scaled against
the *heaviest* workspace rather than the total, because against the total four
similar workspaces are four short stubs and the chart says nothing; the share of
the whole is then stated as a number beside it, since "twice as long as the
other one" reads too easily as "half the quota". And a lone workspace gets no
percentage at all — one bar at 100% looks like a finding, and it is the absence
of anything to compare.

The ranking falls back to tokens when no cost was reported, because a
subscription reports none: ordering purely by money would leave every row at
zero and the order arbitrary, on exactly the plan the view exists for.

### Delegated work
The transcript recorded each subagent's `status` and never rendered it, so a
subagent that failed looked identical to one that succeeded. That matters more
here than almost anywhere: a subagent's work is summarised rather than streamed,
so if the summary does not mention the failure, nothing does — and the parent
run's own result is still a success.

Subagent events are also scattered through the transcript wherever the
delegation happened, which answers "what happened next" and never "what did this
run farm out". A strip above each run answers the second question in one line,
collapsing repeats by name and reporting the *worst* status of each group: seven
of eight succeeding is not a success, and taking the last one would report
whichever happened to finish last.

### The MCP gateway — work asked for from outside

Delegation is one workspace's agent asking another's. The gateway is the same
primitive with the caller outside the process: `POST /api/gateway/mcp` speaks
Streamable HTTP, and `ask_workspace` starts a run in a named workspace and
waits for its answer over the mechanism delegation already used. That reuse is
the design — the final text of a run exists nowhere but memory when it settles,
so both callers stash it the same way, and both declare at submission that they
intend to wait (`SubmitOptions.awaited`; a `start_run` that walks away keeps
nothing).

Three properties are specific to a caller nobody is watching:

- **The permission mode is capped, never prompted.** `capPermissionMode`
  replaces every interactive mode and `bypassPermissions` with the token's
  ceiling, and never widens a workspace that is already narrower. A prompt with
  no one to answer it expires after ten minutes and fails, which is a worse
  answer than a refusal.
- **Scope is enforced on one path and answers identically for "not yours" and
  "does not exist".** Confirming the difference leaks the deployment's map.
  Delegation is withheld from these runs outright: it reaches *other*
  workspaces by design, which would put the whole scope one prompt away.
- **The endpoint is stateless.** A fresh MCP server and transport per request,
  so there is no session table to grow and nothing carries between two tokens.
- **The standing session is bounded.** One session per token per workspace, so
  an integration's asks build on each other — but past `MCP_SESSION_MAX_EVENTS`
  of transcript the next call opens a fresh one. A token used every minute for
  a year has no natural end, and nobody is watching the context grow.
- **The rate budget is per token and measured.** The global limiter counts by
  IP, which one integration shares with the interface. One complete exchange
  costs five HTTP requests — the protocol negotiation before anything is asked
  — and the bucket is sized from that figure, which a test pins.

Authentication is its own credential and its own guard: the path sits in
`BEARER_PATHS` rather than `PUBLIC_PATHS` — authenticated *differently*, not
less — and the session cookie is refused there even when valid, because the
route carries no CSRF token. See `docs/SECURITY.md`.

### What Claude offers, asked rather than assumed
Metaclaude used to describe Claude's capabilities from lists written when the
pages were built: three model names and their prices in the composer, and no way
at all to see whether a configured MCP server had actually connected. A mistyped
server command was indistinguishable from an agent choosing not to use its tools.

`AgentSupervisor.catalogue(workspacePath)` asks the CLI instead — models with
their effort levels, slash commands, subagents, MCP runtime status with the
error text, and which account is signed in. It is asked *in the workspace
directory*, because that is what the answer depends on: skills, subagents and
MCP servers are all discovered relative to `cwd`.

Each question is asked independently and a failure costs only its own answer; an
older CLI supports some of these control requests and not others, and losing the
whole catalogue to one missing method is the wrong trade. What failed is
reported by name in `unavailable`, because an empty list means something
different depending on whether the question failed or the answer was genuinely
empty — and only one of those is worth telling the operator about.

Reading it spawns a subprocess, so `services/claude-catalogue.ts` caches it for
a minute per workspace and, more importantly, collapses concurrent callers onto
one read: without that, three panels mounting together are three CLI processes
for one answer. `refresh=true` skips the cache, for the operator who has just
fixed a server's command and wants to know whether it worked. The catalogue is
also on the client's never-poll list — on the default 30-second interval every
open tab would start a CLI twice a minute.

The composer's pickers are built from it and degrade to a static list, because
a composer that cannot offer a model is a session nobody can start. The effort
picker now offers only the levels the chosen model actually supports; it used to
offer all six for every model, so choosing one the model does not take was a run
that silently ignored the setting.

### What the CLI says about itself
The SDK's message union has around forty members. The supervisor translates
five of them into transcript events; the rest used to reach `default: return {}`
and disappear.

That was not a small omission, because the dropped messages are the ones that
*explain* a run. A run sitting still for thirty seconds is an API retry. An
agent that forgets what it was doing has been compacted. A session where
everything suddenly fails has an expired login. A model that changes mid-session
has fallen back after a refusal. And on a subscription, a run that stops working
has hit a rate limit. Every one of those looked like a fault in Metaclaude,
because Metaclaude said nothing.

`kernel/sdk-narrator.ts` maps each message to a sentence and a structured
payload — the payload matters: a rate limit's reset time is what lets the UI
render "resets in 2h 14m" instead of forcing it to parse English back into a
timestamp. It is a pure function with no SDK dependency, so the whole mapping is
tested without a CLI.

The other half is `IGNORED_SDK_MESSAGES`, which names what is deliberately *not*
recorded, and for two distinct reasons. Some messages arrive many times a second
— `tool_progress` is a heartbeat, `thinking_tokens` a running total — and one
row each would make a long run's transcript unreadable and grow the database
without bound. Others are state synchronisation for a client that keeps its own
model of the session, which Metaclaude does not: it renders from its own
transcript.

A test reads the `SDKMessage` union out of the installed SDK's `.d.ts` and
requires every member to be either narrated or named in the ignore list. That is
what stops the original bug recurring: dropping messages was never a decision
anyone made, it was a `default:` branch quietly absorbing whatever the SDK added
next. An upgrade that introduces a message type now fails that test by name.
(The test also asserts it parsed a plausible number of members, so a
reformat that broke the regex cannot turn it into a no-op that reports success
forever.)

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

## The built-in library

`library/catalog.ts` is a versioned constant: eight subagents and twelve
skills, each with a category from the shared `LibraryCategory` vocabulary.
Curating them *in the repository* rather than fetching them is the whole
trust story — what ships has been read and reviewed like any other code —
and `library/catalog.test.ts` holds the shelf to it: names the registry will
accept, unique across kinds (install is addressed by name), every category
covered, substance minima, a definition of done in every skill.
`library/service.ts` decorates the catalogue with an `installed` flag read
from *global* scope only, and installing copies an entry into the registry
**disabled**, where it becomes the operator's own record. The library keeps
the original, so a deleted copy is installable again.

## The knowledge library

`learning/knowledge.ts` is the memory store's deliberate opposite: reference
documents with no confidence, no decay and no reaping — what the operator
handed over must say tomorrow what it says today. Documents live in
`documents` (workspace-scoped or global) and are chunked on write by
`learning/chunker.ts` — paragraph-packed toward ~1100 characters,
heading-aware, overlapped at the seams — into `document_chunks`, each chunk
embedded with its document title and section prefixed and indexed in
`document_chunks_fts`. Retrieval is the memory shape (dense ∪ BM25, RRF, the
shared measured gates in `learning/retrieval.ts`) plus three of its own
measured guards: a dense-solo floor against stopword soak, lexical
abstention on function-word queries, and a per-document diversity cap. The
kernel injects the winning passages as cited quotations behind
`knowledgeEnabled`, budgeted, and credits only what was injected to
`document_usages` — which is what the run's genesis reads back.

Retrieval quality is measured rather than assumed: `learning/eval.ts` plus a
labelled corpus, guarded by `retrieval-quality.test.ts` and re-runnable with
`scripts/eval-retrieval.mjs`. Those measurements are why there is no
reranking stage — see docs/LEARNING.md.

## Keeping memory from repeating itself

`memories.workspace_id` is nullable and the null is a *tier*: retrieval unions
a workspace's own rows with every global one, which is how a standing note
reaches every project. `MemoryStore.reconcile()` is the single primitive under
the three gestures that act on that — promote, confine and merge — because the
hard part is shared and doing it twice is how two copies drift. A memory is not
just its text; it carries the runs that used it, the reinforcement they earned
it and an operator's pin, so anything that ends a row has to say what becomes
of all of it. The usage rows are repointed before any delete, or a finished
run silently loses a memory it was demonstrably given.

`learning/consolidation.ts` is the semantic half, and it exists because a
cosine cannot do the job: on the shipped hashing embedder the highest
similarity between any two memories of a real corpus was 0.51 against a merge
threshold of 0.92, while a third of that corpus was redundant. The shape is
prefilter → arbitrate → propose: a *star* per memory (never a connected
component — transitivity swallows unrelated clusters), one group per cluster
(a group overlapping a kept one by more than half is dropped), one tool-less
`haiku` call per batch, and every verdict filed in the operator's existing
review queue. Nothing is merged without a press. The third verdict,
`contradictory`, is the one that pays for the pass: two memories that disagree
were until now both injected, side by side, with nothing noticing.

It runs seeded by the reflexion pass with only what that run just wrote, and in
full on demand. A proposal carries a fingerprint of the exact text it was drawn
against, so applying one whose members have moved since is refused rather than
merged over — the same discipline as crediting only what was injected.

## The advisor

`services/advisor.ts` is the part of the system that studies the system. It
composes a dossier server-side — recent runs and failures, the board, the
automations, the registry, what the built-in library still holds, what it
already proposed — and submits it as an ordinary kernel run in a persistent
per-workspace session, pinned to the Auto permission mode. The run acts
through `kernel/advisor-tools.ts`, an in-process MCP server mounted into
*every* run (like the board tools): automations are created directly but
disabled, and skills, agents, MCP servers and plugins become rows in
`advisor_proposals` that the Dashboard inbox accepts or dismisses. The
trusted-publisher allowlist for MCP proposals lives in the service, in
code, and is enforced at propose time and again at accept. A workspace can
opt into one automatic analysis per day (`advisorAuto`, default off); an
hourly sweep applies the 24-hour gate per workspace.

## The steward

Metaclaude's own workspace, and the tools that let a run there act on the
application rather than on a project. Three modules, one rule each.

`services/system-workspace.ts` makes the workspace *system*. It is
identified by a `kv` key rather than a slug — a slug is the operator's to
take — created once, and re-asserted at every boot: the three settings that
decide what an agent can reach (`allowedTools`, `disallowedTools`,
`additionalDirectories`) are rewritten if they drifted, and the routes
refuse to change them, archive the workspace or delete it with a 409.
`defaultPermissionMode` is not among them, since 0.48.0: with the shell
forbidden and the reach bounded to the pre-approved list, the mode decides
how much the operator is asked rather than what the agent can do, so it is
the operator's — `bypassPermissions` alone is refused and put back at boot.
Fixing it for three releases had made the steward unable to be autonomous
by anyone's choice. The guard compares *values*, not presence: the settings
dialog sends the whole object back, so a guard on presence would have
refused the operator's language change because the fixed lists rode along
with it.
The same boot writes the workspace's knowledge — `CLAUDE.md` generated from
the running version, `SYSTEM-MAP.md`, a copy of `docs/`, and under `code/`
the TypeScript sources of the running version (`SOURCE_TREES`: the API,
the shared contracts, the web app, tests beside them, and the repository's
own CLAUDE.md renamed `REPOSITORY-CLAUDE.md` so the CLI does not load it as
instructions) — through the path jail, and never touches `NOTES.md`, which
`CLAUDE.md` imports and which is the operator's. Copied rather than granted:
an extra directory is bounded to the workspaces root for every workspace,
the steward included, and the compiled output it used to be pointed at cost
an approval card per file. The runtime image carries `docs/` and `source/`
for exactly this, and `check.sh` holds the Dockerfile's list to the code's.

`services/steward.ts` is the facade behind the tools, and the only place
the rings are decided. Ring 1 reads, through compact projections that name
their fields — never a spread of a row, which is how a record that grows a
value field one day would start leaking. Ring 2 is what a person can undo
from the interface in one gesture; every verb is audited as
`metaclaude:<runId>`, so the log reads who did it and which run, never the
operator. Ring 3 is absent by construction, and `system-tools.test.ts`
checks the absence by name: no verb that deletes, purges, deploys,
restores or hands out a credential may appear in the table whatever it is
called. Two lines hold whatever the ring: the four reach settings are
refused on *every* workspace, and an approval of high risk is never
allowed — denying is always reversible, allowing a high-risk call is the
one decision an absent operator would want to have made themselves.

`kernel/system-tools.ts` is one table — name, ring, description, schema,
handler — from which three things derive so they cannot drift: the MCP
server `metaclaude_system` the supervisor mounts, the exact names the
system workspace pre-approves in `allowedTools`, and the tool list
`CLAUDE.md` shows the agent, grouped by ring. The board and proposal
servers carry a catalogue of the same shape (`BOARD_TOOL_CATALOGUE`,
`ADVISOR_TOOL_CATALOGUE`), a test holds each against what its server
actually registers, and the system workspace pre-approves all three — the
whole reversible surface the supervisor mounts for its runs, so no ring-1
or ring-2 call ever opens an approval card while `WebFetch` still does.
Pre-approving less than is mounted was the defect: a mounted tool off the
list is a card in `default` mode and a refusal under `dontAsk`, which is how
the steward could not file a ticket on its own board. The supervisor
mounts the server for runs whose workspace *is* the system workspace and
only those a person or the schedule started there: an `api` run is
withheld because a token's scope is not a suggestion, a `delegation` run
because a project's agent must not steer the steward by asking it a
question.

The conversation is not a new surface. `POST /api/metaclaude/ask` finds or
opens a session titled *Conversation* in the system workspace — rotated at
the same event ceiling as the gateway's standing sessions — submits the
prompt as the operator, unawaited, and answers with where to look; the
client goes to the ordinary session page. A conversation still answering
is reported as a 409 with the session to open, rather than doubled beside
it. `GET /api/metaclaude` names the session the *next* message would land
in — the one answering, else the one with room, else the newest — because
two sessions rotated in the same millisecond share a timestamp and "most
recent" was not a total order (measured: a test failing two runs in five).

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
api_tokens (SHA-256 of the value only)
```

**Transcript events are the source of truth.** A run is rendered purely from its
ordered event list, so reload, replay and live streaming share one code path.
There is no separate "message" table that could drift.

`memories` carries its embedding as a `BLOB` of little-endian `Float32` and is
mirrored into an FTS5 index by triggers. Retrieval reads both. `workspace_id`
is nullable and the null is the global tier, unioned into every workspace's
retrieval — and it cascades on workspace delete, so which tier a memory sits on
decides whether it outlives its project.

`insights` carries the review queue, and a consolidation proposal is an
ordinary row in it: the `kind` column is plain text, so the pass needed no
migration, and the `status` the table already had does the work of remembering
what the operator answered. A "these are distinct" verdict is filed
pre-rejected — never shown, and the only thing stopping the pass paying to ask
the same question on every sweep.

`memory_usages` is written before a run executes and read back by
`GET /api/runs/:id/genesis`, which is the one endpoint that crosses all three
learning subsystems at once: the classifier's verdict and the policy's
provenance from the run row, the arm the run stood on from `policy_arms`, and
the memories actually injected from `memory_usages` joined live to
`memories` (so an edited memory shows its current title and a deleted one
simply drops out). It is immutable once a run has started, which is why the
client caches it forever — with one exception the UI handles: recall is
recorded moments before execution, so a still-queued run answers with an
empty list that fills in.

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

**The visual layer** is hand-written SVG on the theme's own tokens — no chart
library, and nothing that costs the entry bundle. Three rules make it
maintainable. *Every channel carries a datum*: in the memory constellation a
star's sector is its kind, its radius the log-scaled time since it was last
recalled, its size the confidence, its ring the pin. *Layout is a pure
function*, exported and tested apart from the component
(`constellationLayout`, `pulseBars`, `betaDensityPoints`) — the geometry is
the behaviour, so that is what the tests pin. *Positions are deterministic*:
the constellation seeds its jitter from a hash of the memory id rather than
running a force simulation, so the sky is stable across refetches and only
genuine reinforcement or decay moves a star — a simulation would spend a
phone's battery computing positions that mean nothing. Density curves are
sampled in log space (the direct Beta form overflows a float at trial counts
a busy workspace reaches), gradient and mask ids go through `useId()`, and
every animation is disabled under `prefers-reduced-motion`.

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
