<div align="center">

<img src="apps/web/public/icon.svg" width="88" alt="" />

# Metaclaude

**A private, self-hosted agentic OS built entirely on the Claude CLI — with an
agent of its own to run it.**

Talk to Claude Code from your laptop, tablet or phone — through an interface that
remembers what it learned, chooses its own model, runs on a schedule, asks
before it does anything it cannot undo, and keeps a steward that reads its own
code, tends its own board and tells you what is wrong before you look.

</div>

---

## What this is

Claude Code is excellent in a terminal. This gives it the rest of an operating
system around it — and it has grown in three moves. First an interface with a
memory, a schedule and a policy that learns which model suits which work.
Then a system that explains itself: every choice the loop makes is drawn where
it was made, the guide and the doctor ship inside, and retrieval matches
*meaning*, on a model that runs on your server. And now a system that stewards
itself: Metaclaude has a workspace of its own where the agent acts on the
application rather than on a project — reads everything, changes what you
could undo, and stops at what you could not.

What that gives you, in one list:

- **A real interface**, on every device you own. Installable as a PWA, usable
  one-handed on a phone — in English or in French.
- **Memory that persists** across sessions and projects — and that is retrieved
  automatically into the runs where it helps, by meaning rather than by
  keyword: a sentence-transformer (bge-m3, French and English alike) ships in
  the image and runs on your server, so nothing leaves the machine. Three
  shelves: a **convention** you stated reaches every run whatever it is about,
  a **durable** lesson is recalled when relevant, a **volatile** fact fades
  fast and is replaced when it changes. And a gate: what the machine proposes
  to remember is judged before it is written, two notes per run at most, with
  every refusal one press from being overturned.
- **A knowledge library the agent quotes.** Drop reference documents — a
  contract, a spec, a runbook — globally or per workspace; runs retrieve the
  relevant passages (hybrid semantic + exact-word search) and cite them by
  document and section, with the transcript showing exactly what was
  consulted. Retrieval quality is *measured*, not asserted: a labelled corpus
  and a recall/MRR/nDCG harness ship with it.
- **A policy that learns.** Which model and effort level actually works for which
  kind of task, measured rather than guessed.
- **Loops.** Automations that run on a schedule, including continuous ones that
  keep the same session and accumulate context indefinitely.
- **A board that works itself.** Fill the To do column, switch the autopilot
  on, and cards get worked one at a time into Review — with a quota guard
  that pauses automatic starts near the plan's ceiling. Whatever lands in
  Review is assigned to you; assign the agent on a review card and it takes
  the work back.
- **Permission prompts you can actually read**, with the literal command shown
  and a risk assessment attached.
- **Push notifications, self-hosted.** The phone buzzes when a run waits on
  your approval or when a run you started ends — end-to-end encrypted, keys
  generated on your server, and the app icon badges while decisions wait.
- **Backups that take themselves.** A nightly host-side timer stops the app
  for seconds, archives every volume, and leaves a marker the in-app doctor
  watches — so backups that quietly stop become a visible warning, and
  `metaclaude-backup restore` puts everything back.
- **A steward you can talk to.** Metaclaude has a workspace of its own,
  prepared at every start with the running version's instructions, the
  documentation and the *source code* it is running, tests included, and a
  composer on the Dashboard that opens a conversation with it. It reads
  everything the interface shows, makes reversible changes at once under
  its own audit name — memories, insights, automations, sessions, cards on
  its own board, proposals for yours — and says precisely what it would do,
  and stops, when the right course is irreversible. No shell, no file
  editor, and no way to widen its own reach; how much it asks you first is
  your setting, and under *Don't ask* it works alone. Its first weeks in
  production it reported three defects of its own tooling, with file and
  line; all three are fixed.
- **An advisor that studies the system itself.** On request or once a day
  per workspace, a run reads recent activity, the board and the registry,
  then creates backlog tickets and disabled automations directly — and
  leaves skills, subagents and MCP servers from vetted publishers in an
  inbox that takes one click to accept. Everything it would do is inert
  until a human decides.
- **A library to start from, for work and for life.** A curated shelf of
  skills and subagents — code review, tests, debugging and security on one
  side; meals, paperwork, budgets, trips, study, the household, tax, a
  tenancy, a job search, a move and caring for a parent on the other —
  installed with one click, disabled until you switch each one on. Nothing
  here is specific to code, and the shelf finally says so.
- **Your Google account, without an intermediary.** Register your own OAuth
  app, consent once in your browser, and Metaclaude keeps the refresh token
  in its vault and runs its own Gmail/Calendar/Drive MCP server from inside
  the image — per-capability grants, created disabled, no third party in the
  path.
- **Passkeys.** Sign in with Face ID, a fingerprint or a security key —
  phishing-resistant WebAuthn, self-hosted, with password + TOTP intact
  underneath. (Needs a domain name: the standard cannot scope a passkey to
  an IP address, and the app says so instead of failing.)

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

Open **https://localhost**. Caddy signs with its own certificate authority by
default, so your browser will ask once. Sign in with the bootstrap credentials
and turn on two-factor authentication under Settings → Security.

To reach it from a server, and from your phone, see
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. The first decision it walks you
through is how you obtain a certificate, because this app needs a *secure
context* — a `Secure` cookie and a service worker — and over plain HTTP it does
not degrade, it stops working. With no domain name there are three real answers
and they trade off very differently; `deploy/provision.sh` and the CI/CD
workflows cover the rest. The same document covers the whole lifecycle:
upgrading (a rebuild and `docker compose up -d`; migrations run themselves),
logs and diagnostics, backups, and uninstalling (`deploy/uninstall.sh`, which
keeps your data unless told twice not to).

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
    ├─▶ consult knowledge ─▶ which reference passages bear on this request?
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

Every one of those steps is inspectable and resettable from the UI — and
since 0.23.0 the loop is *drawn where it ran*: each exchange in a transcript
carries the classification, the arm the policy stood on and the memories that
were actually injected. A self-modifying system you cannot read is not one you
should trust.

Since 0.45.0 the loop also has an operator of its own. The steward's runs go
through exactly the same pipeline as yours — classified, recalled into,
scored, reflected on — but its tools act on the system: it reads the same
memories, insights, health and audit trail you do, and what it learns about
running Metaclaude is stored where every later conversation with it starts.

Full detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** ·
**[docs/LEARNING.md](docs/LEARNING.md)** · **[docs/SECURITY.md](docs/SECURITY.md)** ·
where it is going: **[docs/ROADMAP.md](docs/ROADMAP.md)** ·
what changed: **[CHANGELOG.md](CHANGELOG.md)**

---

## Features

### Sessions
Streaming token-by-token output, collapsible reasoning blocks, compact tool-call
cards that expand on demand, live plan checklists, inline diffs, and per-run
cost and token accounting. Model, effort and permission mode are per-message
controls, not buried settings — and so is **Ultracode**, the CLI's standing
multi-agent orchestration: one toggle fans the message out across sub-agents at
maximum effort, offered only when the chosen model can actually do it.

Sessions the CLI already holds for a workspace's directory — terminal
conversations included — can be **adopted**: one click binds the transcript to
a Metaclaude session, and resuming, steering and accounting work as if it had
started here.

### Permissions
Every tool call that writes, deletes, runs a command or reaches the network can
require approval. The prompt shows the **literal** command — not a paraphrase —
with a heuristic risk badge. High-risk calls (matching `rm -rf`, `curl | sh`,
force pushes, `sudo`, …) never offer "always allow". Deny is always the focused
button.

Six modes, from **Plan** (research only, nothing executes) through **Ask**,
**Accept edits**, **Auto** and **Don't ask**, to **Bypass** — which is disabled
at deployment level unless you explicitly enable it.

**Don't ask** never waits: nothing prompts, and nothing that would have
prompted runs. What it *may* run is a per-workspace list of **pre-approved
tools** — exactly the tools that can raise a prompt, ticked one by one. That is
what makes an unattended run useful at all, because an automation firing at 3am
and a call arriving through the MCP gateway have nobody to answer a card. A
ticked tool skips its approval card in every mode but Plan, and the run's
timeline says so each time one is used; whatever a run *was* refused, it ends
with one line naming it.

**A run may work for as long as it needs to.** Two ceilings bound it and they
ask different questions: one stops a run that has reported *nothing* for ten
minutes — the agent speaks every half minute while a tool runs, so silence that
long means it stopped — and a second, measured in hours, backstops the case
silence cannot see. A run waiting on one of *your* approval cards is not
silent: that clock is held until the card is answered or expires. Elapsed
time is deliberately not a limit on how long work
may take; a loop or an overnight refactor is normal, and what bounds the *work*
is the workspace's own turn and cost ceilings.

A pending approval also reaches you: a push notification (see Settings →
Notifications) with a ten-minute lifetime matching the approval's own, and a
badge on the installed app's icon that clears when the last decision is made.

### Configuration, changed while it runs
**Settings → Configuration** (owner only) holds the operational knobs — the two
run ceilings, how many runs at once, the quota guard, run retention, the log
level — and a value saved there applies to the next run with no restart. It
outranks the environment, because the compose file names every one of these
with a default of its own and a screen that deferred to it would never do
anything; the cost of winning is honesty, so each row says where the value in
force came from and offers one action to hand it back.

Security decisions are deliberately absent: bypass mode, allowed origins, proxy
trust, the master key. What protects those is being unreachable from a
signed-in browser, and the server refuses any key not on the short list — so
the absence is a property of the API rather than of the form.

### Memory
Three kinds — episodic, semantic, procedural — retrieved by hybrid search:
dense vectors for paraphrase, BM25 for exact identifiers, fused by reciprocal
rank, then weighted by confidence and recency. Memories that get retrieved into
runs that succeed gain confidence; the rest decay on a forgetting curve until
the janitor collects them.

Two tiers, and the list is grouped by them: a memory belongs to one workspace,
or to all of them. A run is given both. What the agent learns is always scoped
to the project it learned it in — deciding a lesson travels is yours, with one
press, and one press back.

Left alone a corpus repeats itself, so **Consolidate** shortlists memories that
sit close together, asks one cheap model call whether they genuinely say the
same thing, and files what it finds for you to decide on. It never merges
anything by itself — and it reports contradictions too, which matter more: two
memories that disagree were until now both handed to every run that matched
either.

Switch the app's language and Metaclaude switches with it — what it distils,
what it proposes, what a merge would keep. A workspace can override it.

Embeddings run **locally**, on the sentence-transformer shipped with the image
(bge-m3 — French and English alike), so a question reaches an answer that
shares no word with it and nothing ever leaves the machine. A hashing embedder
remains for hosts that cannot spare the gigabyte, at the cost of matching words
rather than meaning — and every screen that could imply otherwise says which.

### Learning
A contextual multi-armed bandit picks the model and effort for each task
category, using Thompson sampling over a Beta posterior. Reward combines
success, cost, latency and your explicit thumbs up/down — which overrides
everything else, because your judgement is the ground truth being learned.

The Analytics screen shows the posterior for every arm in plain language:
*"Across 34 runs, sonnet at high effort performs best (82% expected quality,
$0.041 and 47s on average)."* And a Reset button, because unlearning must be as
easy as learning.

### The loop, on screen
The intelligence is legible, not implied. A **genesis strip** between your
message and the answer names the category, the model and effort, and who chose
them — open it and you see the memories that were injected with their
retrieval strength, plus the Beta posterior of the exact arm the choice stood
on; on the run working right now, its segments cascade in as the decision is
made. The Memory page opens on a **constellation** where a star's size is its
confidence and its drift toward the rim *is* the forgetting curve. Analytics
draws posteriors as **curves rather than bars**, because the width of a belief
is why a trailing arm still gets trials. The Dashboard opens on the **system's
pulse**: what is running right now, beside a 24-hour heartbeat. Every pixel
encodes a datum the system genuinely holds; everything holds still under
`prefers-reduced-motion`.

### Automations
Cron, interval, manual or **event** triggers — a watcher fires on a failed or
succeeded run in its workspace, never on another automation's — with a
**continuous** mode that keeps one session alive across every firing so
context accumulates, and an opt-in push when a firing ends for the ones whose
point is to be read. Cron is read in the server's timezone, named beside the
field. Guard rails included: consecutive-failure limits that disable a runaway
loop, skipped rather than queued firings when the previous run is still going,
and no burst of catch-up runs after downtime.

### Workspaces
A directory, plus the agent policy that applies inside it. Optional git clone on
creation, a file browser with a real editor, and a source-control panel with
staging, diffs and commits.

### Rewind
Any finished run can be undone. With file checkpointing on, every run records
the point it started from, and the transcript offers a Restore control that
first shows you exactly which files would change and by how many lines — the
CLI's own dry run, not an estimate — before anything is written.

### The advisor
A run that studies a workspace — recent runs and failures, the board,
automations, the registry, the library — and proposes with graduated
autonomy: tickets straight to Backlog, automations created disabled,
everything that would *act* (skills, subagents, MCP servers, plugins)
parked in a Dashboard inbox until accepted. MCP proposals pass a
trusted-publisher allowlist curated in this repository, because a web page
saying "add this server" is what prompt injection looks like. The proposal
tools are mounted into every run, so any agent that spots a repeated chore
can suggest the automation on the spot.

### The steward
Metaclaude's own workspace, created at the first start and furnished again at
every boot: standing instructions generated from the running version, the
documentation, and under `code/` the TypeScript sources of that version with
their tests — so a question that goes deeper than the guide is answered from
what is actually deployed, cited by file and line. A composer on the
Dashboard opens a standing conversation with it; a **Morning review**
automation ships disabled, ready to brief you each day on what happened.

Its tools are drawn by reversibility. Ring 1 reads everything the interface
shows. Ring 2 changes what a person can undo in one gesture — memories and
their tier, insights and proposals, automations, sessions, operational
settings, cards on its own board, proposals filed for yours, runs asked of
other workspaces — audited as `metaclaude:<run>`, never as you. Ring 3 does
not exist: nothing that deletes, deploys, restores or hands out a credential
is in its table, and a test asserts the absence by name. All of ring 1 and 2
is pre-approved, so none of it opens a card; the permission mode of the
workspace is yours, from *Ask* to *Don't ask*, with *Bypass* never offered.
What is fixed is its reach: no shell, no file editor, no extra directory,
and the steward itself is refused every reach setting on every workspace.

### Extensibility
Skills (written to `.claude/skills/` before each run so the CLI discovers them),
custom subagents, and MCP servers with credentials held in an AES-256-GCM vault.
A built-in **library** ships a starter shelf of both — curated and versioned in
this very repository rather than fetched from a store, installed disabled with
one click. It has two halves: the work of building software, and the rest of a
week — the everyday (meals, trips, the week itself) and the expensive moments
beside it (tax, a tenancy, a move, an insurance claim, a job search, an ageing
parent). Every definition carries a **category** — engineering, writing, data,
ops, research, product, then home, health, money, learning, travel, career, and
general — so the registry stays findable as it grows. Entries in domains that
belong to a professional say so in their own working rules: the fitness plan
and the budget are explicitly not medical or financial advice, and a test
enforces it. Entries that lean on a national system open with a
`Jurisdiction: France` line naming the portal to confirm against, and a second
test refuses any that cite one without declaring it.

Beside the registry sits a **connector directory** — MCP endpoints whose
documentation this repository has read, with the exact URL and the exact name
of the credential each wants. It is narrower than a list of famous servers on
purpose: every entry authenticates with something you can paste, because a run
has no browser to complete an OAuth consent in. Adding one seals your
credential in the vault and writes the server disabled. A test runs every entry
through the same publisher allowlist the advisor uses, so the directory cannot
become a second, laxer trust surface.

For Google specifically the consent itself moves in-house: **Settings →
Connections** walks through registering your own Google Cloud OAuth app
(showing the exact redirect URI), takes the consent once in your browser, and
seals the refresh token in the vault. The Gmail/Calendar/Drive MCP server
ships inside the image and registers only the tools you granted — read and
send are separate checkboxes, Drive writing uses `drive.file` (only what the
app itself creates), and the callback authenticates by single-use state
because the session cookie deliberately does not survive a cross-site
redirect.

### Metaclaude as an MCP server
The registry above is Metaclaude *consuming* other people's servers. It also
exposes one of its own, so your other software can ask this agent to work:
one endpoint, and tools for running a prompt in a workspace and waiting for
the answer, starting one without waiting, searching a workspace's notes and
reading its board. A line of `claude mcp add --transport http` connects it;
so does anything else that speaks MCP.

The credential is minted under **Settings → Connections**, owner-only, and it
is a capability rather than a second account: an expiry that is never null, a
list of workspaces that is never a wildcard, and a **ceiling** on what a run it
starts may do unattended — because nobody is watching, and a permission prompt
with no one to answer it is a worse outcome than a refusal. The gateway
authenticates by bearer token and *ignores the session cookie entirely*, which
is the confused-deputy defence: it carries no CSRF token, so honouring ambient
cookie authority would hand any page on the internet a tool call in a signed-in
operator's name.

### Where the usage went
Analytics ranks every workspace against each other over the period — tokens,
runs, cost where one was reported, and each one's share of the whole. The
per-workspace filter tells you what one workspace cost; only this tells you
which one is spending the ceiling.

### Help that ships with the product
A Help screen whose content is the repository's own: the user guide, the
changelog, and search — plus **Ask Metaclaude about itself**, a plan-mode
session seeded with that same guide, answering with citations and executing
nothing. The deploy checks refuse a release whose docs disagree with its code.

### What Claude itself offers
A **From Claude** tab shows what the CLI reports for a workspace rather than
what Metaclaude assumes: the models this subscription grants and which of them
take an effort level, the slash commands and subagents available here, which
account is signed in, and — the part nothing else could tell you — whether each
configured MCP server actually connected, with the error text when it did not.
The composer's model and effort pickers are built from the same answer.

### Plugins
Full support for **Agent Plugins 1.0.0**, the vendor-neutral package format —
one directory holding a `plugin.json`, a `skills/` tree and an `mcp.json`, which
installs as a unit and contributes both to every workspace. Install by path;
the directory is copied rather than linked, so the source can be deleted
afterwards. Per the specification a broken component never stops the rest
loading, so the Plugins screen shows warnings *beside* a working plugin rather
than replacing it with an error.

And **marketplaces** — the CLI-native store. Add a source by GitHub repo or
`marketplace.json` URL, browse its catalogue, and enable plugins per workspace;
the CLI fetches and installs them itself at the start of a run, narrated in the
transcript. Owner-only to add, because a marketplace is a trust decision.

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
| **Network** | The app publishes no host port — inbound only through the TLS proxy. Outbound egress is open, because the CLI, git and HTTP MCP servers need it |
| **XSS** | Model output is rendered through an allow-list sanitiser with no raw HTML passthrough |
| **Machine tokens** | Bearer-only on their own path — the session cookie is refused there, any `Origin` is rejected, and every run they start is capped, marked `api` and audited under the token's name |
| **Tool grants** | A workspace pre-approves whole tool names and nothing else: scoped rules are refused (measured — on the flag channel they widen instead of narrowing), forbidding beats pre-approving, `Plan` grants nothing, and outside `Don't ask` the grant is applied by Metaclaude's own broker so the transcript records each use |

Details and threat model: **[docs/SECURITY.md](docs/SECURITY.md)**

---

## Development

```bash
pnpm install
pnpm --filter @metaclaude/shared build

# Terminal 1 — API on :8787
# The two roots are siblings, not nested: `loadConfig` refuses to start when
# either contains the other, because that would put every workspace one `..`
# from master.key. Both are already in .gitignore.
METACLAUDE_DATA_DIR=$PWD/data \
METACLAUDE_WORKSPACES_DIR=$PWD/workspaces \
METACLAUDE_INSECURE_COOKIES=1 \
METACLAUDE_BOOTSTRAP_USER=dev \
METACLAUDE_BOOTSTRAP_PASSWORD=dev-password-please-change \
NODE_ENV=development \
pnpm --filter @metaclaude/api dev

# Terminal 2 — web on :5173, proxying /api to the above
pnpm --filter @metaclaude/web dev
```

```bash
pnpm test:run    # 2507 unit + integration tests, ~60s
pnpm typecheck
pnpm build
```

Two further checks run against a real server, so they are kept out of
`pnpm test`. Their agent-driven cases need an authenticated Claude CLI; pass
`--no-agent` to run everything else without one.

```bash
pnpm --filter @metaclaude/api check:e2e      # HTTP + WebSocket, incl. a live run
pnpm build && pnpm --filter @metaclaude/api check:browser   # the PWA in Chromium
```

On Windows the browser check needs `PLAYWRIGHT_CHROMIUM` pointed at an
installed Chromium — `npx playwright install chromium` leaves one under
`%LOCALAPPDATA%\ms-playwright`.

**Stack:** Node 22 · Fastify 5 · SQLite (WAL) · TypeScript 5.9 · React 19 ·
Vite 8 · Tailwind v4 · Zod 4 · `@anthropic-ai/claude-agent-sdk`

---

## Layout

```
packages/shared/    Zod contracts shared by the API and the web app
apps/api/
  ├── kernel/       Run lifecycle, Agent SDK bridge, permissions, event bus
  ├── learning/     Embeddings, memory, bandit, classifier, reflexion
  ├── library/      The built-in shelf of subagents and skills
  ├── security/     Auth, TOTP, crypto, vault, audit, path jailing
  ├── services/     Workspaces, files, git, registry, scheduler, analytics, advisor, steward
  ├── scripts/      Live checks and the screenshot bench (run by hand)
  └── routes/       REST + WebSocket
apps/web/           React PWA
docker/             Dockerfile, Caddyfile, entrypoint
```

## Licence

MIT
