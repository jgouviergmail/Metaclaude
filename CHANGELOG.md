# Changelog

All notable changes to Metaclaude. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). Each entry links the commit that carries the full
story — the commit messages in this repository are written to be read.

This file is part of the product surface: the in-app changelog renders from it,
and Metaclaude maintains it as part of shipping a change (see docs/ROADMAP.md,
"The system that documents itself").

## [Unreleased]

## [0.47.0] — 2026-09-05

### Fixed

- **Metaclaude can now act on its own board and file proposals without an
  approval card.** Its workspace pre-approved the `system_*` tools and
  nothing else, while every run of it was also given the board and proposal
  servers — so creating, moving or annotating a card asked the operator in
  the conversation, and was refused outright when the Morning review ran on
  the schedule under *Don't ask*. The pre-approved list is now the whole
  reversible surface by exact name: its own table, the seven board tools and
  the five proposal tools. Each server exports a catalogue with its rings, a
  test holds it to what the server actually registers, and the standing
  instructions list all of them together and say which tools (`WebFetch`,
  `WebSearch`) still ask. The permission mode stays fixed at *Ask*: nothing
  in it needed to change, and it is what keeps everything else behind a card.

- **The steward's memory, insight and automation tools now carry their
  provenance.** `sourceRunId` and `createdAt` on a memory, `runId` on an
  insight, `sessionId` on an automation were in the rows, on the Dashboard,
  and dropped by the projections the steward reads through — its first real
  investigation in production reconstructed them from ULID timestamps.
  Reported by Metaclaude itself.

### Added

- **Metaclaude reads the source code of the version it runs.** The image
  ships `apps/api/src`, `packages/shared/src` and `apps/web/src` under
  `source/`, and the system workspace copies them into its own `code/` at
  every boot, tests included, beside the documentation — with the
  repository's CLAUDE.md renamed `REPOSITORY-CLAUDE.md` so the CLI does not
  load it as instructions. Copied, not granted: an extra directory is bounded
  to the workspaces root for every workspace, the steward included, and the
  compiled output it used to be pointed at cost an approval card per file.
  `check.sh` holds the Dockerfile's list to the code's.


## [0.46.1] — 2026-09-05

### Fixed

- **Toggling the embeddings setting twice no longer loads the model twice.**
  Found in the cold review of 0.46.0: switching local → hash → local within a
  minute created a second sentence-transformer beside the first, about a
  gigabyte each. The switch now keeps one local provider, hands it back to
  the stores while it is loading or once loaded, and reloads only a provider
  that has given up — which is also how fixing missing model files needs no
  restart. `learning/embedder-switch.ts`, with the rule tested in isolation.

- **A document embedded under a previous provider now shows *Vectors
  pending*.** The badge only knew about documents written without a model;
  after a change of embedder, the ones waiting for the rebuild looked current.
  The Memory page hands the section the embedder in force and any other id
  is pending.

### Changed

- **Operations: the reference host runs a 4 GB swap file**, persistent, with
  `vm.swappiness=10`, so a memory spike under the model and two long runs slows
  the box rather than letting the kernel kill the app. docs/DEPLOYMENT.md
  carries the exact commands and the reason.


## [0.46.0] — 2026-09-05

### Added

- **Retrieval is semantic, and the model ships with the image.** Memory and
  knowledge search used to run on a hashing embedder that matched words: on
  six questions sharing no content word with their answer, it found none.
  bge-m3 — multilingual, quantised, pinned by revision, fetched at build time
  by `deploy/fetch-embedding-model.sh` and loaded offline — finds all six on
  its dense arm. It was chosen on the repository's own retrieval bench
  against five candidates; the model the code named as its `local` default
  did not separate French at all. docs/LEARNING.md carries the table.

- **One retrieval profile per family of vector space.** Every gate in
  retrieval was a measurement of the hashing embedder and was wrong for a
  sentence-transformer by a factor of two: the consolidation floor would have
  shortlisted an entire corpus, and equal-weight fusion demoted passages the
  model had ranked first. `retrievalProfile(family)` now chooses the floors,
  the automatic-merge threshold and the fusion rule — dense-first under a
  model — and a test pins each number to the band it was measured in.

- **Embeddings is a hot setting.** Settings → Configuration switches between
  the model and the hashing embedder without a restart; every stored vector is
  rebuilt in the background afterwards, and the choice outlives a restart. The
  health endpoint carries a `retrieval` block — embedder, state, whether it is
  semantic, how many vectors still wait — and Settings, the Memory page and
  the Dashboard read it, so "semantic" is claimed in exactly one place and
  only when true.

### Changed

- **A model that does not load leaves retrieval explicitly lexical.** The
  provider keeps its own id and writes no vectors; the doctor warns with the
  reason; a push notification says so once. It used to fall back silently to
  hashing and re-embed the whole corpus in that space — and back again at the
  next boot that loaded. Nothing writes or compares a vector under a provider
  that is not ready: memories, documents and classifier exemplars are stored
  pending, found by their words meanwhile, and rebuilt the moment the model
  answers.

- **A large document is indexed in two steps.** Its text and fts index are
  written inside the request; its vectors are computed by the background
  rebuild, and the document carries a *Vectors pending* badge until they are.
  Measured: a hundred chunks take about thirty seconds on the server, which
  was one synchronous request.

- **Re-index rebuilds every store.** The maintenance button, and the rebuild
  after a change of embedder, used to rebuild memories alone; documents and
  the classifier's exemplars stayed under the old model and silently stopped
  counting.

- **The steward reads the retrieval regime rather than assuming it.** Its
  overview carries the embedder, its state and the sentence to repeat; the
  memory-search tool no longer calls itself semantic on a deployment where it
  is not — the steward itself reported that, in production, on its first day.


## [0.45.2] — 2026-09-05

### Changed

- **The roadmap says what the steward is and what its third ring will be.**
  The "resident workspace" item was half built by 0.45.0; it now reads as two:
  the pending-action queue with an approval card (and the host bridge behind
  it), and the system drafting its own fixes, which is still not built.


## [0.45.1] — 2026-09-05

### Fixed

- **The steward validated nothing it was handed for a workspace's settings.**
  Found in the cold review of 0.45.0, before it reached anyone: the
  `system_workspace_update` tool took a record of unknowns and the repository
  merges whatever it is given, so an unknown key or a number where a model
  alias belongs would have been stored. The facade now parses the patch
  through the same schema the route uses, strips what it does not know, and
  refuses the rest with the field named.

- **"The last ten failed runs" meant "the failures among the last ten runs".**
  The status filter ran after the limit, so on a day that went well until the
  evening the steward answered that nothing had failed. The filter now looks
  through a wider window and the limit applies to what matched.

- **The design bench stopped at the first tab on a French machine.** It reads
  English tab names while the interface follows the browser's locale, which
  headless Chromium takes from the system. The bench now pins `en-US`.

### Changed

- **Route tests share one booted server.** Ten of them carried the same forty
  lines — temp directory, config, context, server, login, cookies, CSRF. The
  two new ones use `src/test/server-harness.ts`; the others can follow. The
  harness is excluded from the shipped build, which `tsconfig.build.json` now
  says.


## [0.45.0] — 2026-09-05

### Added

- **Metaclaude has a workspace of its own, and you can talk to it.** A
  workspace called *Metaclaude* is created at the first start and kept system
  from then on: its permission mode, tool lists and extra directories are fixed
  by the server and re-asserted at every boot, it cannot be archived or
  deleted, and its settings dialog shows those controls locked rather than let
  you discover the rule from a failed save. Its standing instructions are
  regenerated at every start from the running version, with the documentation
  copied beside them, so it is never a release behind; a `NOTES.md` in the
  workspace is yours and is never rewritten.

  A composer on the Dashboard opens the conversation. The answer is an
  ordinary session of that workspace titled *Conversation* — transcript,
  approval cards, steering and rewind as everywhere else — kept from one
  question to the next, and opened rather than doubled while it is still
  answering.

  What it can do is drawn by reversibility, in three rings. It reads
  everything the interface shows, through tools of its own that never carry a
  secret value. It makes reversible changes at once — memories and their
  tiers, insights and proposals, automations, sessions, operational settings,
  a workspace's ordinary settings, approvals of low or medium risk, runs asked
  or started in other workspaces — every one audited under `metaclaude:<run>`,
  never under your name. Nothing irreversible exists in its tool table, and a
  test asserts the absence by name: when deleting, updating, a high-risk
  approval or a change to any workspace's reach is the right course, it says
  precisely what would happen and stops. The tools are mounted for runs you or
  the schedule start in that workspace only — not for a token's run, not for
  a delegated one.

  A *Morning review* automation ships in the workspace, disabled: enable it
  and every morning it reads the last twenty-four hours, acts on what is
  reversible and briefs you on the rest. The guide has a chapter on all of it.

- **The runtime image now carries `docs/`.** Until now only the web build
  read it, one stage up; the system workspace copies it at boot so the agent
  can read how the thing it stewards works.

### Fixed

- **The system workspace's guard refused every save of its own settings.**
  Caught in review before it shipped, and worth recording: the settings dialog
  sends the whole settings object back with one field changed, so a guard
  written as "refuse a patch naming a safety setting" turned a language change
  into a 409. It now refuses a *different* value, never presence, and a test
  sends the stored object back unchanged.


## [0.44.0] — 2026-09-05

### Added

- **Metaclaude writes in the language the app is set to.** Every pass that
  produces prose an operator reads — a distilled lesson, a merged note, a
  drafted skill — carried no opinion about which language that should be. The
  run's own answers followed the operator, because `WorkspaceSettings.language`
  reaches the run's system prompt; everything the system wrote *about* the run
  followed whatever the transcript happened to be in. Measured on a French
  deployment: twenty-two memories, every one of them in English.

  The decision is server-side and deliberately not the interface's language: a
  browser preference cannot decide what a shared corpus is written in, because
  two people reading one store of text in two languages is not a thing that
  exists. So a deployment setting (`METACLAUDE_LANGUAGE`, hot, with provenance
  like every other), which any workspace may override, resolved at the point of
  use — a change takes effect on the next run rather than the next restart.

  It stays one control: switching the language under Settings → Appearance
  writes the deployment setting too, for an owner. A viewer's own reading
  language is still theirs, and a refused write leaves the deployment writing
  as it did before.

  The directive is worded for a *structured* call rather than a conversation,
  and both halves are load-bearing: it says the language governs the values and
  not the field names — a model told only "write in French" will translate the
  keys and make its own answer unparseable — and it exempts what must survive
  verbatim, because a procedure whose entire value is `pnpm test:run` is worth
  nothing translated. The consolidation pass batches by language before size, so
  no single call is ever asked to reply in two.

### Fixed

- **A consolidation pass that could not run no longer reports a clean corpus.**
  Seen in production on the first press: the arbiter answered with an error, the
  sweep caught it as it must — maintenance never fails its caller — and the
  screen said no memory in the corpus repeats or contradicts another. It had not
  asked. "Could not ask" and "asked, and the answer was no" are different facts,
  and the result now carries which one it is.

- **A runtime setting with no words on the configuration screen was invisible.**
  `if (!copy) return null` is right for a setting the server has stopped
  exposing and silent for the opposite case: one *added* to the server and
  forgotten there simply does not render, with nothing failing. It happened on
  the first try with `language`. A test now holds the screen's copy against
  `RuntimeSettingKey`, so the next one fails the build instead.


## [0.43.0] — 2026-09-05

### Added

- **Memory has two tiers, and the screen finally says which is which.**
  Retrieval has always handed a run its own workspace's memories *and* every
  global one — `workspace_id = ? OR workspace_id IS NULL`, which is right, and
  which is what makes a standing note reach every project. The Memory page then
  sorted that union by pinned, then confidence, then recency, and drew it as one
  list. The two tiers were interleaved with nothing to tell them apart, and the
  same union had already caused a visible bug once: the page rendered more rows
  than the total beside them.

  The list is now grouped: Global first, headed and counted, then one section
  per workspace. Every card carries its tier as well, because a card is reached
  directly — from the constellation, from a notification link — and one that
  cannot be read on its own is not much of a card. `ScopeBadge` is one component
  shared with the knowledge library, which had this right from the start; the
  vocabulary and the colour now exist once rather than twice.

- **A memory can be promoted to the global tier, and confined back.**
  Nothing could move one before: `MemoryStore.update`, the route's patch schema
  and the API client all stopped at the memory's own content, so a lesson was
  born in a workspace and died there. The reflexion pass writes
  `workspaceId: run.workspaceId` every time, so in practice the global tier was
  unreachable — measured on the live deployment: twenty-two memories, none of
  them global.

  `POST /api/memory/:id/scope` is its own verb rather than a field on `PATCH`,
  deliberately: every other field there is what the memory says, while this one
  decides which projects recall it at all. It gets its own audit line and its
  own confirmation, because promoting changes what every *other* workspace's
  runs are given and that consequence is invisible from the screen it is pressed
  on. Promotion also outlives the project — `memories.workspace_id` cascades on
  workspace delete, so the tier a memory sits on decides whether it survives.

- **Consolidation: the pass that notices the corpus repeating itself.**
  `remember` folds a write into a near-duplicate above 0.92 cosine, and on the
  hashing embedder this deployment ships that threshold is unreachable. Measured
  on the production corpus: the *highest* similarity between any two of its
  twenty-two memories was 0.51, while four of them said the workspace works in
  French and five described the same quota behaviour. A third of the corpus was
  redundant, nothing could see it, and the injection budget is eight memories —
  so four rows took half of every run's recall to say one thing.

  No threshold fixes that. Swept over the same corpus, catching every real
  duplicate needs a floor of 0.15, which also admits fifty-eight unrelated pairs
  out of seventy-seven. The cosine cannot be the decision; it can only be the
  shortlist. So: a star per memory (its own nearest neighbours above 0.25,
  capped at four), one tool-less `haiku` call to judge, and every verdict filed
  in the operator's existing review queue. Nothing is ever merged without a
  press.

  Two shapes were tried and measured before this one. Union-find over the same
  neighbour graph swallowed eight unrelated memories into a single component at
  0.25 and fifteen of twenty-two at 0.20, because "somewhat similar" is
  transitive and meaning is not. And a star per seed alone produced *fourteen*
  groups for twenty-two memories — four of them about the same French cluster —
  which is four model calls for one question and, worse, four competing
  proposals of which applying any one leaves the other three stale. A group is
  now dropped when it shares more than half its members with one already kept;
  on that same corpus, fourteen groups become seven, one per cluster.

- **`contradictory` is the verdict that pays for the pass.** Two memories close
  enough to be retrieved together that tell the agent opposite things are far
  more dangerous than two that repeat, and today both are injected side by side
  with nothing anywhere noticing. The same shortlist finds them and the same
  call classifies them, for the same price. There is no merge button on one:
  which is right is a judgement only the operator can make.

- **The doctor reports the shape of the memory corpus.** `findNearDuplicate`
  compares a write against the newest 2000 rows *in its scope*, and a
  workspace's scope is its own rows plus the global tier. Past that ceiling the
  oldest stop being compared and duplicates accumulate again, with nothing
  failing and nothing logged. A ceiling nobody can see is not a ceiling.

- **Where a memory came from, as somewhere to go.** `source_run_id` has been
  stored since the table existed and shown nowhere, because a run id alone is
  not a destination — runs are read inside their session. The listing now
  resolves it, and a run past its retention window simply has no link rather
  than a dead one.

- **The i18n table check sees a list, not only a record.** Every "copy table"
  measure scanned object literals, so an *array* of rows — the maintenance
  actions on the Memory page, the sections in the git panel, the navigation in
  the shell — was not scanned at all, and adding an untranslated row to a
  translated table of four was invisible. Judged one property at a time,
  because the two shapes differ in where the identifiers live: a record puts
  them in the keys, an array puts them in values beside the copy, and treating
  those together indicts every route path, cron expression and enum key in the
  app. With a capital first letter required, the same rule `SENTENCE` rests on,
  it finds nothing today and turns red the moment a row is added without one.

### Changed

- **Deduplication stops partitioning by kind.** The classification is a guess
  the reflector makes from one run and it is not stable: production held the
  same observation about the workspace's language as `semantic` on one row and
  `procedural` on another, so one fact could live once per kind, and did.
  Duplication is a property of meaning; the surviving row keeps its own kind.

- **A workspace write is compared against the global tier too.** A fact the
  global tier already carries is reachable from the workspace already, so
  writing a local copy of it creates a duplicate spanning two tiers — which
  `workspace_id IS ?` could never see. The reverse is still refused: a global
  write only ever matches another global, or a fact that belongs everywhere
  would be quietly demoted into whichever workspace observed it first.

- **`remember` and the merge path are one write path.** Folding a duplicate now
  goes through `reconcile`, which already knows how to rewrite a surviving row
  and re-embed only when the text moved. Two copies of that is how they drift.

- **Vectors are rebuilt at boot when the embedder changed.** An embedding is
  only comparable to one from the same provider, so switching
  `METACLAUDE_EMBEDDINGS` — or having `local` fall back to `hash` because the
  optional package is absent — silently turned off dense retrieval *and*
  duplicate detection until somebody happened to press Re-index. The count is
  one cheap query and the work runs in the background, because a rebuild must
  not hold up the health endpoint the deploy gate waits on.

### Fixed

- **The consolidation pass is reproducible.** Its read ordered by
  `updated_at DESC` alone, and several memories written by one run share a
  millisecond — so the order was not total, and the order decides which memory
  anchors a cluster, hence which members its group holds, hence its key. Two
  sweeps over an unchanged corpus could form *different* groups, and the key
  that suppresses a question the operator has already answered would match
  nothing. Found because the test asserting it was itself flaky, twice in five
  runs; the same family as the audit chain's `rowid` ordering.

- **A memory too long to be shown whole is never folded.** The arbiter's answer
  *becomes* the surviving text, so it can only write what it was shown — and
  judging a longer memory on a prefix would fold its tail away into a merged
  note derived from that prefix, approved by an operator who was shown the same
  prefix. The excerpt is now the reflexion pass's own content ceiling, and
  anything above it is excluded from grouping outright: those are the long-form
  notes an operator wrote by hand, which are exactly the ones not to merge
  automatically.

- **The arbiter is told the notes are data.** They are model-authored text from
  earlier runs, and one of them can carry an instruction addressed to this
  call. Said in the same words the recall block uses when it hands memories to
  a run — the blast radius was only ever a misleading proposal a person still
  had to accept, but the sentence costs nothing.

- **A consolidation proposal is filed under the workspace it is about.**
  `listInsights` filters `workspace_id IS ?` exactly, with no union with the
  globals — unlike the memory list — so a group of one workspace's rows whose
  survivor happened to be a global memory was filed under NULL and invisible
  from the only screen an operator would look for it on.

- **The brief counts what is still waiting on a person.** `newInsights` was a
  plain `COUNT(*)` over the window, so it included insights already triaged —
  and would have announced a dozen new ones after a consolidation sweep whose
  "these are distinct" answers are filed pre-rejected and shown nowhere.

- **The dashboard's "Recently learned" stays about what was learned.** A
  consolidation proposal shares the review queue and is a request to delete
  rows, not something remembered; left in, one sweep's worth filled a panel
  capped at five and pushed the lessons out. It also gave that proposal a
  lesson's colour, because the Dashboard spelled the tone as a ternary chain
  while the Memory page spelled it as an exhaustive record — one table now,
  where a new kind fails the build rather than picking up a default.

- **Folding two memories no longer rewrites a finished run's history.**
  `memory_usages.memory_id` cascades on delete, and that table is what
  `recalledFor` reads to show a run's genesis. A naive merge would have made a
  completed run silently lose a memory it was demonstrably given. The usage rows
  are repointed first, with the primary-key collision — a run that saw both —
  resolved by keeping the larger score, so the attribution `reinforce` derives
  from it survives. Evidence sums, confidence takes the maximum, and a pin
  survives whichever row carried it.

- **A reconciliation re-takes its decision inside the transaction.** The rows
  are read to build the embedding text and embedding is awaited, so a memory
  deleted on that await would have had its use counts folded in from a row that
  no longer existed, and one *edited* on it would have had the edit overwritten
  by the copy read beforehand — including when the caller only meant to rename
  it. Both refuse now rather than proceeding on a stale snapshot.

- **`composeSystemAppend` is gone.** Exported, tested, and with no caller since
  the kernel started composing the appendix inline — the same shape as
  `resolvePermissionMode`, which had drifted out of sight the same way. The
  recall block's header also stopped claiming every note came from this
  workspace, which was about to become false the moment the global tier had
  anything in it.

### Notes

- No migration. `insights.kind` is a plain `TEXT` column, so a consolidation
  proposal is an ordinary row in a table that already exists — with the status
  it already has doing the work of remembering what the operator answered. A
  "these are distinct" verdict is filed pre-triaged for exactly that reason: it
  is the common answer, it costs a model call, and without a record of it the
  same question is paid for on every sweep for as long as both memories exist.

- Two proposals can still share a memory when a cluster is larger than one
  group. Applying either makes the other stale, and the apply route answers 409
  naming the row that moved and what to do about it — which is the honest
  handling of a plan drawn up against a corpus that has since changed, and the
  reason every proposal carries a fingerprint of the text it was drawn against.


## [0.42.0] — 2026-08-30

### Added

- **The doctor counts the days a credential has left.** Found by looking at a
  live server rather than at the code: no token in the vault, none in the
  environment, every run working — because the CLI's own account sign-in sat in
  the home volume. A supported mode, correctly reported as `ok`, and twenty-four
  days from a fixed expiry that nothing anywhere counted down.

  The date that matters is the refresh token's, not the access token's, and
  that distinction was measured rather than assumed: two nightly backups a day
  apart showed the access token's expiry move from 06:02 to 07:07 while the
  refresh token's stayed at exactly the same instant. It is a wall, not a
  rolling window — using the deployment does not push it back. The check now
  warns fourteen days out naming the days left, fails once it has passed, and
  says nothing at all when the end is unknown, because a pasted setup token
  carries no such field and inventing a warning for "unknown" is how alarms
  become furniture. The Claude card carries the same date, urgent on the same
  threshold, where somebody can act on it.

### Fixed

- **An MCP server that answered every test still showed `unknown`, for ever.**
  Reported from a deployment with seven of them, all tested by hand, all still
  unknown — and it was worse than a persistence bug: **nothing in the codebase
  ever wrote `connected`**. The value was unreachable, so the column could only
  hold `unknown` or `failed`. A successful test records the verdict now. A
  failed one still does not, and that asymmetry is deliberate — the route's own
  reasoning holds, that a description which cannot be fetched may be a slow
  server or a credential this process cannot see. So the badge answers "did it
  answer us the last time we asked", and the live catalogue goes on answering
  "is it up right now".

- **The boot warning about credentials had been crying wolf for weeks.** It read
  the two environment variables and nothing else, so a deployment paired from
  the interface (token in the vault) or signed in with `claude auth login`
  (token in the CLI's own store) was told at every single boot that it had no
  credentials — while the doctor, correctly, reported `auth: subscription`. The
  boot log agreed with it, printing `authMode: "none"` on a server that worked.

  Two lines agreeing on something false is how a true one comes to be ignored,
  which is exactly the warning you want working on the day a credential really
  is missing. The entrypoint now consults the CLI's own store as well — testing
  the refresh token rather than the file, because a logout blanks the value and
  leaves the file — and says the vault may hold one it cannot see, rather than
  claiming there is none. The boot log reports the credential as *resolved*,
  after the context exists, alongside the run ceilings it already reported that
  way. Two assertions in `check.sh` keep the entrypoint honest.

## [0.41.1] — 2026-08-29

### Fixed

- **"The run exceeded its 45 minutes time limit" is not a sentence.** English
  wants the singular in front of a noun — *a 45-minute limit* — so the helper
  that correctly writes "reported nothing for 10 minutes" wrote nonsense the
  moment the figure moved ahead of it. 0.41.0 shipped that, having replaced a
  version that was right by accident. The amount now comes *after* the noun,
  which dodges the inflection entirely and lets a ceiling name itself in the
  unit it was chosen in: "its time limit of 4 hours", not "of 240 minutes".

- **A backspace character had got into a test file**, from an escape mangled on
  the way in. Caught by the control-byte ratchet added in 0.40.0, on its first
  real occasion — which is the only kind of evidence a guard like that can
  offer for itself.

## [0.41.0] — 2026-08-29

### Added

- **A run may now work for as long as it needs to.** The ceiling was 45 minutes
  of *elapsed time*, which is the wrong question: it punishes a run for
  working, and a loop, an overnight refactor and a two-hour automation are
  indistinguishable from a wedged subprocess to a clock that only counts. The
  ceiling that normally fires is an **idle** one — no message from the CLI for
  ten minutes — and the wall clock stays as a backstop, now measured in hours.

  Silence is usable as a signal because it was measured rather than assumed:
  during a tool call that ran for 100 seconds the CLI emitted `tool_progress`
  every 30 seconds, plus `task_started` and a rate-limit event. Ten minutes of
  nothing therefore carries a factor of twenty over the heartbeat, and nothing
  has to special-case a tool being in flight. `0` switches either off — and
  means *no timer*, never a timer of zero, because a zero-delay abort fires
  before the CLI is spawned and an already-aborted signal reaches no listener:
  the run would end as a success having been stopped.

- **Settings → Configuration**, owner only: the operational settings this
  server runs on, changed without a restart. The two ceilings, runs at once,
  the quota guard, run retention and the log level. A value saved there applies
  to the next run — consumers read through a getter at the point of use, so
  there is no notification graph to keep in step — and the log level, which
  lives on the logger rather than in anything that will look it up again, is
  replayed at boot.

  A stored value outranks the environment, and that order is forced rather than
  chosen: `compose.yml` names every one of these with a default of its own, so
  an environment-wins design would be inert in every real deployment. The price
  is a second source of truth, paid by reporting provenance on every row — what
  is in force, what it would fall back to, who wrote it — and one action to
  hand the setting back.

  What is **not** there is the point of the design. Bypass mode, allowed
  origins, proxy trust, the master key and the bootstrap credentials stay in
  the environment, because what protects them is being unreachable from a
  signed-in browser; the server refuses any key not on its own list, so a
  hand-made request gets a 404 rather than a stored row. The data directories
  and the embedder are absent for a different reason — switching the embedder
  would leave every stored vector a different width, and `cosine` answers 0
  when the dimensions disagree, so retrieval would die in silence.

### Fixed

- **A cut-short automation looked perfectly healthy, for ever.** Anything other
  than `failed` reset the consecutive-failure streak, so a firing stopped at a
  ceiling read as a good one: `consecutiveFailures: 0`, never disabled, and
  invisible to both the doctor and the brief, which only look at automations
  the guard has already switched off. It could also launder a real streak back
  to nothing by being interrupted once. A stopped firing now leaves the streak
  where it was — it is evidence of neither health nor failure.

- **The delegation wait was a constant that had stopped outlasting the run.**
  Fifty minutes, with a comment claiming it outlasted the run timeout — true
  against the 45-minute default of the day, false the moment anyone raised it,
  and false in the shipped configuration once the backstop became four hours.
  The waiter giving up first turns "the delegated run hit its limit" into "the
  delegation timed out", which sends the operator to the wrong place. It is
  derived from the ceiling now, and a run with no ceiling still gets a bounded
  wait.

- **The wall clock had never had a test.** Not one, in the module that decides
  what a stopped run reports — because the fake `query` used to end its stream
  on abort while the real SDK throws, so the case was unreachable. Four now,
  each proven by sabotage.

## [0.40.0] — 2026-08-29

### Added

- **A workspace can pre-approve tools, which is what finally lets an unattended
  run reach the web.** The setting existed in the schema, reached the CLI, and
  had no control anywhere in the app — so "Don't ask", the mode every
  automation and every MCP gateway call lands in, refused `WebSearch`, `Write`
  and every mutating command with no way to widen it. The guide and the token
  form both described a configuration nobody could make. **Workspace settings →
  Pre-approved tools** offers exactly the tools that can raise a prompt, says
  what ticking one removes, and the run's timeline carries a line whenever one
  is used.

  Where the decision is taken is the interesting half. A pre-approval the CLI
  knows about skips the permission broker in *every* mode — measured: in "Ask",
  `allowedTools: ['WebFetch']` fetched a page with no approval card at all — so
  the CLI is told only under "Don't ask", where it answers before the broker can
  be reached. Everywhere else the broker decides, which keeps the trace. "Plan"
  pre-approves nothing.

  And not through the field that looked right: `allowedTools` let `WebFetch`
  through and left `WebSearch` refused, because a search executes upstream and
  only a permission rule covers it. Four probe runs read as passes before an
  end-to-end run asked for the search by name — the model, offered both tools,
  had picked the other one every time.

- **The doctor says whether anything can leave the container.** With no egress
  nothing the product does works — no runs, no clones, no HTTP MCP server — and
  the stack has come up healthy in exactly that state. It is a `fail`, not a
  warning, and it separates "this box has no network" from "the model was
  refused" without a guess.

- **A run says what it was refused.** `permission_denials` is the CLI's own
  record of the calls it turned down on its own, and nothing read it: the only
  trace was whatever the agent chose to put in its closing paragraph, which for
  an automation nobody reads. One line at the end, naming them.

### Fixed

- **Toggling an automation off erased its description.** `z.object({…})
  .partial()` reads as "absent means untouched" and is not: it still fires each
  field's `.default()`. The automations list toggles a row with
  `PATCH { enabled }`, so the route received `description: ''`,
  `continuous: false` and `maxConsecutiveFailures: 3` alongside it and merged
  each one in — wiping the description, ending a continuous loop and resetting
  a custom failure ceiling, silently, on the control an operator touches most.
  The same trap sat on every workspace setting. `patchSchema` replaces
  `.partial()` at all four sites, and a ratchet holds the count at zero.

- **Two settings the workspace screen showed in English on a French page.** The
  permission mode — on the workspace card *and* in its own picker — plus the
  answer-language table declared in that same file. Their French was in the
  catalogue all along: the three i18n measures ask whether the catalogue
  carries a string, never whether the render site translates it. A fourth
  measure closes that shape, and it names both sites when it is put back.

- **Seven files carried a raw control byte** where the escape was meant — among
  them the audit chain's field separator, the policy learner's cache key, and,
  in `docs/SECURITY.md`, an example *of* a control character written as one.
  Every one behaved correctly, and every one made its file binary: `grep`
  answers "Binary file matches" instead of showing the line, `file` says
  `data`, git renders the diff as `Bin … bytes`, and a reviewer sees nothing. A
  ratchet holds the count at zero, and it covers Markdown too — `docs/guide/`
  is bundled into the in-app Help screen, so prose ships. The URL sanitiser in
  `markdown.ts` had raw DEL and U+009F in its character class as well; it is
  written in escapes now, proven equivalent over the whole range it covers.

- **The README's own development quick-start could not start.** It set
  `METACLAUDE_WORKSPACES_DIR` to a directory *inside* `METACLAUDE_DATA_DIR`,
  and `loadConfig` refuses that layout outright — it would put every workspace
  one `..` from `master.key`. The two roots are siblings now, and both were
  already in `.gitignore`.

- **`additionalDirectories` was reviewed when a workspace was updated and not
  when one was created**, so a workspace could be born naming a directory every
  run then dropped in silence. Both guards are shared now and run on both
  routes, next to the permission-mode check that was written for the same
  asymmetry.

- **The pre-approval guard compared the request against itself.** A patch
  naming one tool list is merged with the other, so a tool could arrive
  pre-approved on a workspace that already forbade it. Found reviewing the
  guard rather than running it; it compares the merged state now.

### Changed

- **The guide said "Don't ask" means the opposite of what it does.** It read
  "everything proceeds except what the deployment forbids"; it is "nothing
  prompts, and nothing that would have prompted runs". An operator following
  that sentence picked it for an automation and got an agent that could not
  write a file. The MCP chapter's "a gateway run never prompts" was false for
  its widest ceiling, which can still stall on a command nobody answers. Both
  chapters now say which mode to reach for, and why.

- **The guide says there is no browser, and why.** No Chromium, none of its
  libraries, a read-only filesystem and an unprivileged user with every
  capability dropped — so nothing can install one, and a browser downloaded
  into the home volume would not start. Deliberate: a large network-facing
  surface beside a process that already runs model-authored commands, on a
  machine with 2 GB to spare. Fetching a page covers nearly every reason people
  ask, and a hosted browser reached over MCP covers the rest.

- **A tool name is split in one place now.** `/^mcp__[^_]+__/` was copied into
  six, and it stops at the first underscore — so a server an operator named
  `my_server` was never stripped and the risk badge, the transcript card and
  the grant key all fell through to their default branch on every one of its
  tools.

- **The two live checks run on Windows.** `scripts/harness.mjs` imported the
  built server by filesystem path, which Node's ESM loader reads as a URL with
  the scheme `d:` and refuses — so `check:e2e` and `check:browser` could not
  start at all on this platform, which is why neither had ever been run on one.
  They pass here now: 49 and 26 assertions, no failures. The browser check also
  pinned its pages to English: it asserts `aria-label="Send"`, the app follows
  `navigator.language`, and on a French machine it failed while the composer
  worked perfectly.

## [0.39.1] — 2026-08-29

### Fixed

- **Two new kernel tests closed the database under a run still finishing.**
  They start a gateway run without awaiting it — which is the behaviour under
  test — and then closed the in-memory database in their `finally`, while the
  tail of the schedule chain was still reading from it. `TypeError: The
  database connection is not open`, twice, as unhandled errors. Exactly the
  trap the delegation-leak test documents a few lines above, and CI caught it
  the same way it caught that one. Both now wait for the runs to land first.

## [0.39.0] — 2026-08-29

### Added

- **`run_status`, the half `start_run` was missing.** An asynchronous call
  handed back a run id that no tool could redeem: a finished run's answer lives
  in the transcript, not on the run row, and nothing read it. It reads the last
  assistant block — everything before it is the agent thinking aloud on the way
  — and a run id is not a capability: the run's workspace goes through the same
  scope check as every other tool, answering identically for "not yours" and
  "does not exist".

### Fixed

- **`ask_workspace` dressed every failed wait up as work in progress.** A bare
  `catch` reported "still running" for a kernel shutting down or a discarded
  stash as readily as for a timeout, sending the caller to poll a run that would
  never answer. Only a timeout means still running now.

- **A gateway session grew without end.** One standing session per token per
  workspace is the point — an integration's asks build on each other — but a
  token used every minute for a year has no natural end, and nobody watches the
  context, or the bill. Past a bounded amount of transcript the next call opens
  a fresh session under the same name.

- **The per-token rate budget was calibrated against the wrong unit.** It counts
  HTTP requests; one complete exchange costs **five** of them, because a client
  negotiates the protocol before it can ask anything. The original numbers read
  as generous while allowing six exchanges. Measured now, pinned by a test so a
  transport upgrade that changes the figure fails loudly, and resized to a dozen
  exchanges of burst and twelve a minute sustained.

### Changed

- **Two guards against shipping half a feature**, both written from the two
  defects that reached production this week.

  `api.test.ts` now checks that **every path the client calls is a route the API
  registers** — a renamed route, a method that diverges, a typo that only shows
  up as a 404 on the one screen nobody opened by hand. Structural rather than a
  live round trip: importing the server into the web app's tests would couple
  two packages that are separate on purpose.

  A new ratchet counts **API client methods no screen calls**. `updateApiToken`
  shipped that way — a route, a client method and a service test, with nothing
  in the interface reaching it. It found eight more the day it was written:
  `me`, `users`, `createUser`, `tasks`, `run`, `deleteFile`, `createDirectory`
  and `previewPolicy`. They are recorded as a ceiling rather than deleted —
  removing methods across four unrelated domains is a decision to take
  deliberately, not in passing — so the debt is frozen and cannot grow.

## [0.38.5] — 2026-08-29

### Fixed

- **`check.sh` does run on a Windows checkout, and it had been lying.** The
  previous release said it could not run here and leaned on CI for it. It runs:
  64 of its checks pass, and the 27 that fail all want `docker`, `flock` or
  PyYAML. Three failures were the script's own portability, not the
  environment's, and all three reported something alarming and false:

  - **Windows Python writes CRLF on stdout.** Three checks feed a heredoc
    script's output through `while read`, so every extracted pattern carried a
    trailing carriage return and matched nothing. That is how a local run
    claimed the guide sends readers to four Settings screens that do not exist,
    and that a documented log line had vanished from the code. Piped through
    `tr -d`, which is inert on Linux.
  - **`deploy/.heredoc-check.py` opened files in the locale's encoding.** On a
    Windows checkout the default is cp1252, these scripts carry em-dashes, and
    the read raised `UnicodeDecodeError` — reported as "prose inside a heredoc
    will be executed by the shell", a security finding about a file it never
    managed to read. Explicit `encoding="utf-8"`.
  - **A `.gitattributes`, which the repository had never had.** Without one, a
    Windows checkout converts all twelve shell scripts and `docker/entrypoint.sh`
    to CRLF. The image was never affected because CI builds it on Linux, but a
    build from a Windows working copy would have shipped a container that
    cannot start: a shebang ending in a carriage return is not a shebang, and
    the kernel reports "no such file or directory" about a file that is plainly
    there.

- **Two flaky component tests, named at last.** `HelpPage` and the composer's
  permission control each failed once in a full run and never in an isolated
  one — the signature of a timeout, not of a defect. Both wait on a dynamic
  `import()` rather than on a state update: eleven guide chapters through
  `import.meta.glob`, and the French catalogue's own lazy chunk. RTL's default
  patience is one second, which is enough on an idle machine and sometimes not
  when three suites run at once. `asyncUtilTimeout` is now set once in the test
  setup, where a new file gets it by existing. Only patience widened; a
  genuinely broken screen still fails, five seconds later.

- **A NUL byte in `permissions.ts` made git treat it as binary.** `grantKey`
  deliberately prefixes an unparseable command's key with NUL so no real verb
  can collide with it — correct, and worth keeping — but it was written as a
  raw byte rather than the escape. Same string once compiled; the difference is
  that the file had no readable diff and no usable blame for releases, in the
  module that decides what the agent is allowed to run.

## [0.38.4] — 2026-08-29

### Changed

- **Documentation caught up with three days of code.** The MCP gateway had
  shipped, been reviewed adversarially and been fixed twice without the README
  mentioning that Metaclaude exposes an MCP server at all — the one document
  most people read first. It now carries the feature and a row in the security
  table; `docs/ARCHITECTURE.md` gains the gateway beside delegation (it is the
  same primitive with the caller outside the process) and `api_tokens` in the
  data model; the roadmap records 0.36.0 and 0.38.0 as shipped; the guide's
  settings chapter describes minting a token and the troubleshooting chapter
  answers "my MCP token is refused" — including the two failures that look like
  a bad token and are not, a `403` from an `Origin` header and a client
  reporting a broken server over the wrong URL.

- **Three claims that had gone stale.** `CLAUDE.md` and the README both
  advertised "1733 tests, ~30s" for a suite that is now 2440 and takes about a
  minute. `.env.example` and `docs/DEPLOYMENT.md` said `METACLAUDE_PUBLIC_URL`
  was "needed by exactly one thing" — true until the gateway screen started
  using it to show the endpoint. And the roadmap still listed a docs-drift
  guard as unbuilt that `check.sh` has been running for a while: every
  environment variable the guide names must exist in `.env.example` or
  `compose.yml`.

  What remains there was rewritten honestly rather than deleted: the guards
  check *references*, not *claims*. "A run started by a token is marked in the
  history" was true of the database and false of the screen for a release, and
  no check in this repository could have said so.

- **Six traps added to `CLAUDE.md`**, each one paid for this week: `request()`
  serialising the body itself, a test that replaces `window.location` without
  restoring it (and so passes for the wrong reason), jsdom not implementing
  `<details>` hiding, a Streamable HTTP client treating every status but `405`
  as an error, the kernel stashing a final text nobody will collect, and why
  the i18n ratchets require a capital first letter.

## [0.38.3] — 2026-08-29

### Changed

- **The Google connection folds away.** It was a tall card carrying a four-line
  explanation and a three-step setup, sitting open forever for something you
  configure once. It now shows one line — its name and whether it is connected
  — and opens on a click. New `CollapsibleCard`, built on `<details>` rather
  than on conditional rendering for a reason that is the whole design: a folded
  body stays **mounted**, so the effect that reads the OAuth outcome out of the
  query string and raises the toast still runs. A fold that unmounted it would
  have swallowed the result of a consent the operator had just given.

  It opens itself when you come back from Google's consent screen — driven by
  that effect rather than by a check at mount, because a mount-time read races
  the same effect's clearing of the query string and loses it outright under
  `StrictMode`, whose deliberate remount reads a query that is already gone.
  That was written the wrong way first and caught before it shipped.

### Fixed

- **A test that had been passing for the wrong reason.** One case replaces
  `window.location` to intercept the navigation to Google — jsdom cannot
  navigate — and never put it back, so every case after it ran against a frozen
  object whose `search` was permanently `''`. The callback test asserts that the
  query string gets *cleared*; on a stub that starts cleared, it passed without
  the effect ever running. The location is restored in `afterEach` now, and the
  test establishes that the query exists before asserting it goes away. Same
  trap as the uninstall rehearsal in CLAUDE.md: a check that cannot tell "the
  guard held" from "the code never ran" proves nothing.

## [0.38.2] — 2026-08-29

### Fixed

- **Creating a token from the interface was broken on arrival.** `request`
  serialises the body itself, and `createApiToken` handed it a string it had
  already stringified — so the API received a JSON *string* where its schema
  wanted an object and answered "expected object, received string". Every
  end-to-end test of the gateway was green because they all call `fetch`
  directly; the only caller that went through the client was the only screen
  that mints a token. Two tests now stand where none could: one reads the
  source for the mistake in any caller, present or future, and one drives the
  client and parses what actually reaches the wire.

- **A run started from outside was invisible as such.** `docs/SECURITY.md` and
  the guide both promised that a gateway run "never reads as one somebody
  typed" — true of the database and false of the screen, because `triggeredBy`
  was rendered nowhere at all. The genesis strip now names any non-human
  origin: an API call, a delegation, an automation, a loop, the system. `user`
  stays silent, because a strip that labels every run "started by you" stops
  being read.

- **The route that edited a token's reach is gone.** It had no interface, no
  edge test, and no good behaviour: widening extends a secret that has been in
  circulation for months into somewhere it was never issued for, and narrowing
  changes what a holder can do without telling them. A token whose reach must
  change is a new token and a revocation — which has the property that matters,
  the secret changing hands at the moment the trust does.

- **`search_notes` said "scoped to a workspace" and returned the global shelf
  too.** That is the knowledge store's contract for a named workspace and the
  right behaviour — it returns exactly what a run there would read — but the
  tool description, the code comment and a test all implied otherwise. A token
  granted `read` on one project can reach anything filed globally, and an
  operator should learn that from the tool, not from a surprise.

- **Nothing tested that the gateway's input schemas are enforced.** They are —
  by the agent SDK, which refuses an oversized prompt before a handler runs —
  but that is a dependency's decision, and the handler tests call the handlers
  directly where a schema that stopped validating would break nothing. Proven
  now over a real protocol round trip, including that no run is started.

### Changed

- **A new i18n ratchet: copy tables the catalogue carries only part of.** The
  three existing measures all rest on a first-letter-capital heuristic, which
  is not fussiness — relaxing it surfaces 76 candidates here and about seventy
  are Tailwind class strings. So lowercase copy escaped, and it was real copy:
  `QUESTION_NAMES` had been interpolating "models, slash commands" into a
  French sentence for releases, and five run-origin phrases went through a
  review untranslated. The new measure has no false positives by construction —
  a module-level table whose string values are *already* in the catalogue is a
  copy table by demonstration, and every one of its values must be. It found
  two more omissions the day it was written.

- `MAX_API_TOKEN_DAYS` moved to `constants.ts`. The form that mints a token
  needs the value at runtime, and importing it from `api-contracts.ts` would
  have pulled every API-only Zod schema into the web app's runtime graph —
  the bundle trap CLAUDE.md documents, walked into and backed out of.

## [0.38.1] — 2026-08-29

### Fixed

- **Four defects found by re-reading 0.38.0, not by its tests.** Two of them
  were mine and shipped green.

  **A run nobody waits on used to be kept forever.** The kernel stashes a
  finished run's final text for whoever asked, because it exists nowhere else
  — and 0.38.0 decided who to stash for from the *kind* of run. That reading
  broke the moment the gateway added `start_run`, which starts a run and walks
  away on purpose: the stash held a whole run and its text, nobody ever came
  back for it, and an automation polling every minute grew the map all day.
  The same family as the timed-out delegation the code already had a set for.
  The predicate is now the caller's *declared* intent at submission
  (`SubmitOptions.awaited`), because only the caller knows.

  **A run cancelled while queued left its caller hanging for the full
  timeout.** It never reaches the supervisor, so nothing downstream ever
  settled it: fifty minutes for a delegation, ten for an HTTP caller holding a
  request open, on a run that had been dead since the moment it was cancelled.
  Pre-existing, and invisible until the gateway made someone wait on the other
  end. The answer exists immediately and is now handed over immediately.

  **`GET` on the gateway answered 404 where the protocol wants 405.** A
  Streamable HTTP client opens a `GET` looking for a server-initiated stream;
  the specification lets a server answer `405` to say it has none, and the
  reference client treats exactly that status as "carry on" — *every other
  status becomes an error it raises*. The comment in the route claimed 405
  while the unregistered method answered 404 from the not-found handler, so a
  conforming client would have reported a broken server while every request
  worked. Registered now, inside the guard, rather than asserted in a comment.

  **A failure after `reply.hijack()` left the socket open.** Past the hijack
  Fastify's error handler cannot answer, so a request that failed instantly
  hung until the proxy's 30-minute read timeout. It now answers on the raw
  socket, or at least closes it.

## [0.38.0] — 2026-08-29

### Added

- **Metaclaude is now an MCP server, and other applications can hold a token to
  reach it.** One endpoint — `POST /api/gateway/mcp` — offering `ask_workspace`
  (run a prompt in a workspace with its own memory, skills and conventions, and
  wait for the answer), `start_run` for work too long to hold a request open,
  `list_workspaces`, `search_notes` and `list_tasks`. Connecting is one line of
  `claude mcp add --transport http`, and the same for anything else that speaks
  MCP over HTTP.

  The interesting half is what bounds it, because a token that may start runs
  can make this deployment execute things with nobody in the room. A token is
  not a second user: the expiry is never null, the workspace list is never a
  wildcard — there is deliberately no "all workspaces", or a token minted for
  one integration would follow the deployment into every workspace created
  afterwards — and it carries a *ceiling* on what a run it starts may do. Only
  the SHA-256 of the value is stored and it is shown once; minting is
  owner-only, an `operator` may change nearly everything else here and still
  not issue one.

  Three refusals in the guard are the ones that matter. The path is **not** in
  `PUBLIC_PATHS`, because public means unauthenticated and a tool-executing
  endpoint must never be: it has its own bearer set, checked in the same global
  hook. The **session cookie is ignored there however valid it is** — this route
  carries no CSRF token, so honouring ambient cookie authority would hand any
  page on the internet a tool call in a signed-in operator's name. And **any
  `Origin` header is refused**, because a real MCP client is a server or a CLI
  and sends none, which also closes the DNS rebinding the MCP specification
  singles out for HTTP servers.

  A gateway run never prompts: a permission request nobody answers expires
  after ten minutes and fails, which is a worse answer than a refusal. Every
  interactive mode is replaced by the token's ceiling (`plan`, `dontAsk` or
  `acceptEdits`), and a workspace already narrower stays narrower — the ceiling
  is a maximum, never a grant. Scope is checked on every path and answers
  identically for "not yours" and "does not exist", since confirming the
  difference leaks the deployment's map; delegation is withheld from these runs
  outright, because it reaches other workspaces by design and would put the
  whole scope one prompt away. The gateway is stateless — a fresh server and
  transport per request, so nothing carries between two tokens. Runs are marked
  `api` in the history and audited under `token:<name>`, and each token records
  when it was last used, which is what makes a forgotten integration visible.

  `docs/SECURITY.md` gains a fourth threat: an authenticated but credulous
  caller — an application that holds a token and reads something hostile.

## [0.37.0] — 2026-08-29

### Added

- **What a test learns about an MCP server is kept, and dated.** Asking a server
  what it exposes costs a connection, so it happens when an operator presses
  **Test** and never on a page load — which meant everything it learned vanished
  on the next render. You tested a server, read its tools, navigated away, came
  back to an empty card, and nothing on that card could tell "never asked" from
  "exposes nothing". The description and the tool list now live on the row
  (migration 19), refreshed by every test and stamped with when: the fold reads
  *last test: 5m ago*, because a stored answer that cannot be dated is
  indistinguishable from a claim about now. Two rules keep the two sources from
  being silently mixed — where **From Claude** has a live catalogue reading it
  wins outright, and a tool it no longer lists is never resurrected from
  storage; and a probe that fails leaves the stored answer alone, since a
  momentary blip must not be recorded as a server that exposes nothing. Driven
  through the edge by a test that stands up a real MCP server on loopback,
  because storing-and-listing is a decision that lives in the route and in the
  listing, where neither the probe's tests nor the registry's could see it.

## [0.36.3] — 2026-08-29

### Fixed

- **"Not signed in." was our own guard refusing the OAuth callback.** A redirect
  back from a provider's consent screen is a cross-site top-level navigation, so
  it carries no `SameSite=Strict` cookie and cannot be authenticated the usual
  way — its `state` is the credential instead. The handler said exactly that in
  its own comment and the path was never added to `PUBLIC_PATHS`, so the guard
  answered 401 before the handler ever ran and the flow died on its last step.
  The Google callback had been carrying that same reasoning, written out, for
  releases — and it did not stop the second one shipping guarded.
- **So the test reads the routes rather than naming the paths.** It finds every
  `/api/…/callback` the route files register and asserts each is public,
  including a count check so it cannot quietly pass by finding none. Naming the
  two paths would have had the same weakness the comment did.

### Changed

- **A server's own description folds, like its tools.** It can run to
  paragraphs, and a card that unrolls one pushes every other server off the
  screen. The summary says it is there; opening it is a decision.

## [0.36.2] — 2026-08-29

### Fixed

- **"Still connecting", however many times you pressed Test.** MCP startup is
  non-blocking by design — a run must not wait on a slow server before its
  first turn — so `mcpServerStatus()` asked immediately answers `pending` for
  anything that has not finished, and the probe took that snapshot and reported
  it. Every press asked just as early as the last, so the answer never changed.
  Measured against a server that takes four seconds: the probe returned in
  1.2 s with `pending` and zero tools; it now waits and returns `connected`
  with its tools in 5.2 s.
- **Polled, not `alwaysLoad`.** The SDK flag also blocks startup until a server
  is connected, and it does it by putting every one of that server's tools into
  every prompt — a real cost on the *run* path, paid to fix a reporting problem
  on the probe path. The deadline is what makes waiting safe: a server that
  never connects leaves the loop still `pending`, which is the truth about it,
  and 0.35.1 already gave that its own sentence.

## [0.36.1] — 2026-08-28

### Fixed

- **`METACLAUDE_PUBLIC_URL` was commented out in `.env.example`.** The pairing
  with `compose.yml` is checked in both directions and I had verified one:
  every variable the *guide* names must exist, which it did. The other says
  every variable *compose reads* must be a real line in the example — because
  `install-app.sh` warns a deployed `.env` about keys the example has grown,
  and it cannot warn about a comment. Uncommented and left empty, which is the
  honest value: empty is the unset state the code reads, and an example address
  would look configured while being wrong.

## [0.36.0] — 2026-08-28

### Added

- **OAuth for remote MCP servers.** A server that answers `needs-auth` now has
  a button. Press it and Metaclaude discovers the authorization server,
  registers itself, sends you to sign in, keeps the tokens sealed in the vault
  and puts `Authorization: Bearer …` on every mount from then on. Verified end
  to end against a real provider: `mcp.plaud.ai` issued a client id through
  dynamic registration with nothing configured by hand, and the browser landed
  on its own sign-in page carrying our client name.
- **Metaclaude runs the flow because the CLI cannot.** Checked against the
  shipped `sdk.d.ts`: the agent SDK's HTTP and SSE server configs accept
  `headers` and have no OAuth field at all. The one consequence worth stating
  is that a token has to be *fresh at mount* — there is no 401 anyone would
  see — so it is renewed before a run rather than in response to a failure.
- **What the specification asks for, in full.** RFC 9728 for the protected
  resource's own metadata, RFC 8414 for the authorization server's, RFC 7636
  PKCE with S256 (a server offering only `plain` is refused, not downgraded),
  RFC 7591 dynamic registration, RFC 8707 `resource` so a token minted for one
  MCP server cannot be replayed against another, and RFC 9207: the `iss` on the
  callback is checked against the issuer the flow started with **before** the
  authorization code is redeemed anywhere.
- **The discovery order is the reverse of the obvious one.** The
  `resource_metadata` URL a 401 names is authoritative; the well-known path is
  a guess. Measured: `mcp.plaud.ai` names the path-scoped
  `/.well-known/oauth-protected-resource/mcp`, and the unsuffixed guess answers
  the same document only because that origin hosts one resource. An origin with
  several would have described the wrong one.
- **An outbound guard, which did not exist.** The flow takes URLs from a third
  party and then sends an authorization code to them, so every one is resolved
  and its *addresses* judged — loopback, RFC 1918, carrier NAT, link-local
  (169.254.169.254 above all), unique-local IPv6 — immediately before each use
  rather than once at registration, because DNS moves. A name answering with
  one public and one private address is refused on the second: "the first one
  is public" is not the question. Its two limits are stated in the file rather
  than papered over.
- **Nothing a third party wrote reaches the logs.** An authorization server
  controls its own response bodies: an `error_description` can carry a token,
  personal data or a CRLF-injected line, and no generic redaction can be
  trusted to catch that. Only an error *code* from the RFC 6749 §5.2 allowlist
  is logged; anything else is recorded as `unrecognised`.
- **`METACLAUDE_PUBLIC_URL`**, needed by this and nothing else. A redirect URI
  is the one value in OAuth that must never come from the client, so it cannot
  be read off a `Host` header. Unset, the Authorise button refuses and names
  the setting; everything else runs untouched.

## [0.35.1] — 2026-08-28

### Fixed

- **"0 tools" was the report for a server that never answered.** The contract
  carries six statuses; the report knew two. Anything that was not `failed` was
  called a success, and a success sentence carries a tool count — so a server
  answering `needs-auth`, `pending` or `disabled` was reported as having
  *answered*, with the zero tools it naturally has. `needs-auth` is the case
  that matters: it is what a remote server demanding OAuth replies, the badge
  on the card said so, and the toast contradicted it. Each status now has its
  own sentence, the switch is exhaustive, and a `never` makes the compiler
  refuse a seventh status arriving from the SDK rather than letting it be
  absorbed into a success — the trap CLAUDE.md already records about `default:`
  over an SDK union.
- **The summary hid the same thing.** With no failure it said "every server
  answered", including when several were waiting to be authorised. Servers
  needing authorisation are now named ahead of the success case, because that
  is the one line with something to do about it. A single server reports its
  own outcome rather than a count of one.

### Changed

- **Measured, not assumed: the CLI does report a connected server's tools.**
  The suspicion was that tool loading is deferred behind tool search and that
  the probe would have to ask for `alwaysLoad`. Checked against a real stdio
  MCP server with two named tools: the probe returns both, immediately. What it
  drops is their *descriptions*, which is the gap the direct probe already
  fills. No change was needed, and the change that looked obvious would have
  put every server's whole tool list into every prompt for nothing.

## [0.35.0] — 2026-08-28

### Added

- **A test button on each enabled MCP server**, which is where the question is
  actually asked: an operator wonders whether *this* server works, not whether
  the set does. It runs the same CLI probe — that probe mounts everything a run
  would mount, which is the whole reason its answer can be trusted, so a
  per-server button cannot connect to one server in isolation without answering
  a different question. What changes is the report: the row you pressed, with
  the reason the probe gave, or the number of tools it exposed. The header
  button still tests the set.
- **Only enabled servers get one.** A disabled server is never mounted, so a
  button offering to connect it would be answering about a run that will never
  include it.

## [0.34.3] — 2026-08-28

### Fixed

- **Sixteen browser-session snapshots were committed with 0.34.2.** The
  Playwright MCP writes an accessibility snapshot per navigation into
  `.playwright-mcp/`, and `git add -A` swept them in — 140 kB of throwaway YAML
  describing a local dev page. Removed, and the directory is in `.gitignore`
  now, which is the part that stops it happening again: a tool that writes into
  the working tree during a debugging session will keep doing so.

## [0.34.2] — 2026-08-28

### Fixed

- **"Test connections" was a dead button on the scope the page opens in.** It
  is disabled without a workspace, because connecting is a per-workspace act
  and a probe with none named mounts nothing — the first version asked anyway
  and reported "every server answered" over zero servers. Disabling it was
  honest and still wrong: Global is the *default* scope, so the ordinary path
  was a greyed-out button explained by a tooltip no touch device can read, and
  it was reported as not working, which is what it was. A global server is
  mounted in every workspace, so "which one" has a real answer: the button asks
  it and tests there. It refuses only when there is no workspace at all.
- **The permission modes were in English on a French screen.** Six labels and
  six descriptions — `Ask`, `Accept edits`, `Bypass` and the sentence under
  each — declared in `packages/shared` and rendered straight into the composer,
  the control an operator touches on every run. Every i18n measure scans
  `apps/web/src`, so no check had ever looked at them. The English stays in the
  contracts package as data (it cannot depend on the web's catalogue, and the
  API imports it too); the render sites translate it, and a new ratchet asks
  the only remaining question — does the catalogue carry it?
- **Three i18n ratchets read zero because they asked with `includes`.**
  `catalogue.includes(key)` is a substring test over the whole file. For a
  sentence it is accurate by accident; for a short label it answers the wrong
  question entirely — `'Ask'` is a substring of `'Ask the advisor'`, so every
  one-word label on the permission control read as translated while not one of
  them was a key. The catalogue's keys are parsed into a set and matched
  exactly now, which immediately surfaced **thirty** more: `Delete`, `Sessions`,
  `Runs`, `Cost`, `Effort`, `Filter`, `Clear`, `New`, `Open`, `Commit` and the
  rest. Where the French genuinely is the English — `Board`, `Global`,
  `Plugins` — the entry exists anyway: without it the check cannot tell
  "translated, same word" from "never looked at".
- **A test whose truth depended on its neighbours.** `AgentsPage.test.tsx` had
  no `beforeEach`, so call history and `mockResolvedValue` overrides leaked
  between cases: "the probe was never asked" passed or failed on the order the
  tests happened to run in.

## [0.34.1] — 2026-08-28

### Fixed

- **Two shellcheck warnings failed the release that 0.34.0 shipped in.** Both
  are unused variables in the image purge and its test: the second `read` loop
  named a creation date nothing reads — `sort -r` has already done everything
  that field is there for — and the harness sets `ALLOWED_IMAGE_PREFIX` and
  `IMAGE_KEEP` for a function it sources, which shellcheck cannot follow into a
  file it is told not to read. Neither changes behaviour, and both stopped a
  green build from becoming a tag.
- **The shellcheck section is the one `deploy/check.sh` skips most quietly.**
  It is guarded by `command -v shellcheck`, so a machine without it prints
  `skip` among eighty passes and reads as a clean run — which is exactly what
  happened: 80 passed and 9 skipped locally against 105 passed and 2 failed on
  CI, where the tool exists. The skip is right (the check cannot run), but
  "check.sh is green here" is not the same claim as "check.sh is green", and
  only the second one gates a release. Install shellcheck before believing a
  local run: it needs no root, and the difference is twenty-five assertions.

## [0.34.0] — 2026-08-28

### Added

- **The dashboard says what the machine is doing.** Three meters — CPU, RAM,
  disk — polled every ten seconds, beside the work they explain. The figures
  are the *container's*, from its cgroup, because the ceiling that gets a
  process killed is its cgroup's and not the host's; the host's load average
  and total memory ride along as context. Settings → System renders the same
  component from the same payload, replacing two lonely numbers: two separate
  answers to "how full is the disk" would eventually disagree, and nobody
  would be looking at the wrong one.
- **Every reading may be absent, and says so.** Production is Linux with
  cgroup v2; development is bare macOS or Windows, where none of those files
  exist. An unmeasured figure travels as null all the way to a dash and a
  dimmed track, never as a zero — a confident empty gauge on a machine that is
  working hard is worse than no gauge. CPU usage is a rate, so the first poll
  after a restart reports nothing rather than idle, and it distinguishes "not
  yet" from "not here": on a host that can measure it says so and resolves ten
  seconds later; on one that cannot it says that instead of waiting forever.
- **A workspace can pin the language its agent answers in.** `auto` stays the
  default and adds nothing to the prompt — the model follows the language it
  is written to, which is right most of the time. What it does not follow is a
  *subagent's* prompt, and all twenty-three in the library are English: work
  delegated out of a French conversation came back in English, with nothing
  anywhere in the run stack having an opinion about it. One line settles the
  whole run, delegations included, and exempts code, identifiers, paths and
  command output.
- **Finished runs and their transcripts now have a retention window.**
  `transcript_events` holds every message, tool call and streamed delta of
  every run, and it was the one table with no ceiling at all while the audit
  log and the distilled insights both had a one-year window. Six months by
  default (`METACLAUDE_RUN_RETENTION_DAYS`), and deliberately generous: this is
  the only background sweep that destroys something the operator wrote. A run
  has to be past *both* conditions — the window **and** the per-workspace floor
  of the newest 50 (`METACLAUDE_RUN_KEEP_PER_WORKSPACE`) — because age alone
  would empty a workspace nobody has opened in a year, and losing the only
  three runs someone has is a far worse outcome than a few megabytes. Runs
  still in flight are never touched, and sessions are never deleted: a session
  carries the CLI session id that resumes a conversation, long after its
  transcript stops being interesting.
- **The retention sweep deletes the files, not only the rows.**
  `attachments.run_id` is `ON DELETE CASCADE`, so a plain `DELETE FROM runs`
  takes the attachment rows and leaves their bytes on the volume forever — the
  unlink is application code that no foreign key reaches. Written the obvious
  way, this feature would have fixed a leak of rows by creating a leak of
  files. Attachments go through their own service, and a file two runs share
  survives until the last of them goes.
- **Enable, disable or delete a whole listing at once.** Skills and subagents
  both, from the screen that lists them. The per-row toggle went through the
  upsert route, which needs the entire record — so switching 34 skills off
  meant 34 requests carrying up to 200 000 characters of body each, 34 audit
  entries, and no atomicity: a failure on the twelfth left a half-applied
  intention. One statement, one transaction, one audit entry carrying the
  count.
- **The bulk routes act on ids, never on a scope they expand themselves.** A
  workspace's listing deliberately includes the global entries, because a run
  there mounts both — so a server-side "everything in this scope" would let a
  workspace screen delete the shared library. The ids are the rows the
  operator was shown, and the scope is checked again underneath so a caller
  cannot widen its own reach by naming rows outside it. The confirmation says
  how many, says that a workspace listing carries the global entries too, and
  says that anything from the Library comes back.
- **An MCP server's tool descriptions, asked for directly.** Measured against a
  real server that sends them: the CLI's status reports every tool description
  as empty while the annotations arrive intact — so the list the operator was
  shown was a row of bare identifiers. Testing a workspace's servers now also
  asks each connected one for its own text, over the same configuration a run
  mounts, and shows the `instructions` string the protocol has for "what this
  server is for". The two sources stay separate on purpose: the catalogue
  decides what exists and whether it connects, the direct probe only fills in
  words. A tool the probe sees and the catalogue does not is a tool no run
  would have, and it is not shown.
- **Nothing needed injecting into the system prompt for the agent's sake.**
  The question this started from — does an agent need a description per MCP
  server to choose between them — has a checkable answer: it chooses on each
  *tool's* description, which reaches it from the server, and a server's
  `instructions` reach it as an MCP instructions block. Both were already
  arriving. What was missing was the operator's view of them.
- **The MCP tab says whether each server actually connected, where the servers
  are configured.** The answer already existed — the catalogue probe mounts
  exactly what a run mounts and reports connection status and tools — but it
  lived on the Claude tab, so an operator configured a server on one screen and
  found out whether it worked on another. A **Test connections** button asks
  the probe directly, and the status badge and errors on each card now come
  from it, falling back to what the last run recorded.
- **Testing is offered only where it can answer.** A server is connected for a
  run and a run happens in a workspace, so with the scope set to Global the
  probe mounts nothing and returns an empty list. The first version of the
  button asked anyway and reported "every server answered" while testing none
  of them; it is now disabled there, and says why.
- **Dates and times follow the language, not the browser.** `formatRelative`
  is called from about thirty places, most of them inside a `.map()` where a
  hook cannot go, so every session row said "2h ago" under a French heading and
  `toLocaleDateString(undefined, …)` answered to the browser rather than to the
  choice made in Settings. The provider publishes the language to a
  dependency-free module the formatters read; it is set before the state
  update, so the render a switch triggers already shows "il y a 2 h".
- **The dashboard headline is composed by the reader, not by the server.** It is
  "the one sentence to read when nothing else gets read", and it was English
  prose the API assembled from counts — untranslatable by construction, since
  there is no catalogue on that side. Every number it needs is already in the
  payload, so the same sentence is now built from the same figures in whichever
  language is on screen. `brief.headline` stays on the contract for anything
  that is not a browser.
- **Counted sentences are translated whole, in both forms.** `plural(n, '{n}
  run', '{n} runs')` picks a key rather than gluing an `s` onto a word, and it
  knows that English pluralises at zero and French does not — "0 échec
  consécutif", not "0 échecs". That difference is the entire reason it is not
  an `n === 1` ternary at each call site: the ternary is written in English and
  silently stays English once the sentence around it is translated. Fifteen
  counters moved onto it; the interim `failure(s)` spelling, which reads as a
  form to fill in, is gone.
- **The catalogue check reads both arms of a plural.** Neither passes through
  `t()`, so a check that only knew about `t()` reported a complete catalogue
  while every counted sentence in the app was English.
- **A ratchet for copy held as a module constant.** Nav entries, preset lists
  and risk tables keep their English as *data* and are translated at render —
  a constant evaluated at import time must never bake a language in — which is
  correct and invisible to every other check: no `t('…')` names the string and
  it is not JSX text. `DoctorReportView`'s three verdicts and `SessionPage`'s
  three starter prompts sat in English that way. This one asks the catalogue
  rather than the syntax, so the pattern stays legal and the gap does not.
- **`node deploy/ratchets.mjs --list` prints what the i18n ratchets found.** A
  ceiling that says "21" and nothing else is a number nobody can act on; the
  first thing anyone does is re-implement the measurement in a throwaway script
  to see the twenty-one. That script now lives beside the rule it reports on,
  so the two cannot disagree.
- **The embedder's fallback is pinned by tests.** `METACLAUDE_EMBEDDINGS=local`
  needs an optional package that is in no manifest and not in the shipped
  image, so on every deployment that asks for it the branch that actually
  executes is the *fallback* — and nothing exercised it. A factory that threw
  instead of falling back would have taken the service down at boot with the
  suite still green. No mocking involved: the optional import fails in the
  test run for exactly the reason it fails in production.

### Changed

- **The initial JS ceiling moves from 185 kB to 187, one kilobyte at a time.**
  `ResourceMeters` is imported by two lazily-loaded pages — the dashboard and
  Settings → System — so Rollup hoists it into the entry chunk, where it costs
  about a kilobyte gzipped downloaded before either screen is visited; the
  alternative was two renderings of the same three meters, which would have
  cost more and eventually disagreed. The second kilobyte is the translation
  sweep: the English string *is* the key, so every newly wrapped call carries
  its own text, and the entry-reachable components gained a few hundred of
  them. The French dictionary itself stays out of it — 37 kB gzipped in its own
  chunk, fetched only when someone switches. Both recorded rather than
  absorbed: the point of the ceiling is that a kilobyte has to be argued for.
- **The whole interface speaks French.** Every screen, and the parts of a
  screen that are not text: the toasts, the confirmations, the `aria-label`s,
  the status badges, the tooltips. About six hundred strings, ending at zero
  hard-coded English by a measure that can see all four of the ways a string
  used to escape.
- **The hard-coded-English ratchet was measuring a tenth of what it claimed,
  then a third.** It filtered on whether a file imports `useT` — right for the
  checks asking "does this component translate correctly?", wrong for the one
  asking "is anything left in English?"; 28 of the 52 text-bearing components
  had never adopted i18n and were invisible to all three at once, which is how
  `MemoryPage` came to render entirely in English beside a French dashboard
  while every measurement agreed i18n was essentially finished. Widening it to
  every component took the honest count from 31 to 314. Then the *same* ratchet
  at 0 still had two blind spots of its own, and between them they held about
  three hundred strings: it required a capital letter, so every lowercase
  `<Badge>paused</Badge>` in the app was invisible, and it only looked at JSX
  text, so no toast, no `cond ? 'Archive' : 'Restore'` and no
  `` aria-label={`Actions for ${name}`} `` was ever a candidate. It is a
  parser now rather than four regexes, and it counts the string literals too.
- **A tool call's label is a table rather than a switch.** Ten entries mapping
  a tool name to its label and the one input worth the line, with the English
  kept as data and translated at render — which is what makes it translatable
  at all, since a plain function cannot call a hook. The MCP fallback is the
  one branch left, and it is the honest one: an unknown tool has only its own
  name to offer.

### Fixed

- **Forty-five hooks were called where React would refuse to run them.** The
  translation sweep placed `const t = useT()` in the *innermost* enclosing
  function, which for a toast inside `onSuccess: () => {…}` or a row inside
  `rows.map(row => …)` is a plain callback, not a component. Nothing in this
  repository could see it: TypeScript is happy, the component renders in every
  test that does not reach that branch, and there is no ESLint here to carry
  `react-hooks/rules-of-hooks`. They are back where they belong, and a ratchet
  now counts any `useSomething()` whose enclosing function is not a component
  or a hook — which is the check the missing linter would have done, for the
  one rule whose violation is a runtime crash rather than a style opinion.
- **Two operators pressing Apply at the same instant both won.** The update
  request was claimed with an exclusive lock file and then `rename`d into
  place — but `rename` overwrites, and the lock only excludes writers whose
  attempts *overlap*. A contender that claimed the name after the winner had
  already moved it away published a second request over the first: both were
  told they had won, and the version that deployed was the later one. It
  publishes through `link` now, which refuses an existing destination, so the
  ordering stops mattering. A request file nobody can act on is still swept
  rather than left to brick the button.
- **A board column only explained itself while it was empty.** The hint sat in
  a `title` on the header — text that exists only for a mouse, on the screen
  most likely to be read on a phone — plus a copy in the body that disappeared
  as soon as a card arrived. It is a *full* column that raises the question.
  The hint is rendered under the column's name, always; the empty body now
  says what it is instead, which is somewhere a card can land.
- **A plugin's skills were names with no explanation.** Each skill's
  description was a `title`, so on a phone a plugin's contribution was a list
  of bare identifiers. Rendered beside the name now, truncated by the row
  rather than hidden by it.
- **Fourteen of the library's subagents never said when to use them.** An
  agent's description is what the *main* agent reads when deciding whether to
  delegate, and the file's own header says so — but only the four engineering
  agents written first carried a trigger clause. The ten personal-life agents
  added later described what they do and never when to reach for them, which
  is a convention that survived exactly one batch of new entries. All fourteen
  now carry one, and a test enforces it.
- **An MCP server's tools were listed as chips whose descriptions lived in a
  `title` attribute** — text that does not exist on a phone, where there is no
  hover and a decorative `<span>` never takes focus. One shared component now
  renders them, folded by default with the count on the summary, so the fold
  never hides *whether* there is anything to see. It serves the catalogue panel
  and the MCP tab, which asked the same question in two places.
- **The deploy's image purge had never removed a single image.** It filtered on
  `until=168h`, and at several releases a day nothing ever reaches seven days.
  Found on a real host at 97% full: 23 images and 19 GB, beside 15 GB of build
  cache on a box whose whole premise is that it never builds. Retention is by
  count now — the newest `IMAGE_KEEP` (three by default), plus whatever
  `releases/current` and `releases/previous` resolve to, spared whatever their
  age. Resolved to image *ids* first, because `current` records a digest while
  the same image usually also wears a version tag, and sparing the literal
  string would have deleted it under its other name — leaving the rollback
  button with no target, discovered during an incident. Removal is by
  reference, since an image keeps its layers until its last tag goes.
- **A backup could buy an outage and hand back a truncated archive.** The room
  was never checked: the app stopped, `tar` filled the volume, the partial was
  removed, and the outage bought nothing. The check now happens while the app
  is still serving, and refuses with the three knobs that fix it. It will not
  prune below the retention ceiling to make room — trading an archive that is
  known good for one not yet written can leave an operator with strictly less
  than they had.
- **Lowering the retention ceiling took effect one archive too late.** Pruning
  ran only after the new archive was written, so a host whose volume was
  already full needed one more archive's worth of space before a lower ceiling
  could help it. Retention is applied before the write as well.
- **A filling backup volume was invisible.** The recommended layout puts the
  archives on a separate volume, which the container does not mount and the
  app therefore cannot measure. Each marker now records the space left where
  the archives are kept, and the doctor escalates on it — before the volume is
  full rather than after. A marker written before the field existed, or on a
  host where `df` declined to answer, still reads as healthy: absent means not
  measured, never zero.

## [0.33.0] — 2026-08-28

### Changed

- **A directory listing is a window now, and says when it is one.** Measured
  on 20 000 files: 1 450 ms and 2.3 MB of JSON, spent on a `stat` per entry
  awaited in sequence — with every other request in a single-process API
  waiting behind it, and the browser then rendering twenty thousand rows.
  Listings cap at a thousand entries and carry a `truncated` flag the panel
  states plainly, pointing at the name filter that reaches the rest. Same
  directory afterwards: 121 ms and 118 kB. The rows use the transcript's
  `content-visibility` lazy rendering, so the ones below the fold cost no
  layout or paint.

### Fixed

- **A capped listing kept an arbitrary thousand entries, not the first
  thousand.** The cap has to come before the `stat` per entry or only the
  payload improves — but it also came before the *sort*, and `readdir` returns
  a hashed directory in no order at all. A large folder showed a thousand
  arbitrary names, dropped its subdirectories outright, and showed a
  *different* thousand once any file was created. Ordering is decided from the
  dirents, which already carry the name and the kind, so it costs nothing and
  now happens first.
- **The listing comparator contradicted itself around symlinks.** `if (a.type
  !== b.type) return a.type === 'directory' ? -1 : 1` answers +1 both ways
  round for a symlink against a file; `sort` does not reject an inconsistent
  comparator, it simply lands wherever its merges take it, so the alphabet
  broke silently wherever a link sat. It ranks first and compares names within
  the rank, with an antisymmetry test over every pair of kinds.

## [0.32.15] — 2026-08-28

### Fixed

- **The push test reported "unexpected response code" and nothing else.**
  That sentence is the *entire* message `web-push` throws: the status and the
  relay's own reason live in `statusCode` and `body`, and only the message was
  being recorded — so the one control whose job is to diagnose push produced
  an unactionable string. Failures now name the relay, the status and the
  relay's words, and translate the two an operator can act on: Apple's 403
  (the device subscribed under a different VAPID key — turn notifications off
  and on again on it) and 400 (a malformed token, usually the subject).
- **The VAPID subject used a domain reserved never to resolve.** It was
  `mailto:owner@metaclaude.invalid`; `.invalid` is RFC 2606's guaranteed-dead
  TLD, and relays validate this claim even though none deliver to it. It is
  now `METACLAUDE_PUSH_SUBJECT`, defaulting to an `https:` URL, and the config
  refuses a shape no relay accepts rather than letting it fail hours later at
  send time.

### Changed

- **The push test's fake now behaves like the library it stands for.** It
  fabricated an error whose message contained the status, so every assertion
  on the recorded error passed while the deployed code recorded a sentence
  with no diagnosis in it. A fake more helpful than the real thing cannot
  reveal that the real thing is unhelpful.


## [0.32.14] — 2026-08-28

### Added

- **Every React component now has a test, and the ratchet is locked at zero.**
  The count was 25 when the ratchet was introduced eight releases ago —
  8,062 lines including every major page. Analytics and Memory close it:
  Analytics pins `granularityFor`, which switches a ninety-day period to a
  weekly series because ninety daily points is noise on a phone; Memory pins
  the distinction between *filtering* the loaded list and *recalling* by
  meaning through the search endpoint, two boxes that sit side by side and
  answer different questions.


## [0.32.13] — 2026-08-28

### Added

- **Automations and the workspace landing screen are tested**, leaving two.
  A *disabled* automation no longer being able to advertise a next run it will
  never take is now pinned, as is the consecutive-failure count — an
  automation quietly failing every night is the worst thing that screen can
  allow. On the workspace side, the effect that opens a first session for an
  empty workspace is held to creating exactly one, however many times the page
  re-renders before the refetch lands.


## [0.32.12] — 2026-08-28

### Added

- **The session screen and the plugins screen are tested**, leaving four
  components untested. The invariant worth the most here is that a failed run
  submission **keeps its attachments** — the user picked those files and
  nothing in the interface can put them back, so only a message that actually
  left may consume them. The plugin toggle is pinned to send the *opposite* of
  the state it is in, and an install reports what arrived (how many skills,
  how many MCP servers) rather than merely that something did.


## [0.32.11] — 2026-08-28

### Added

- **Source control and the file browser are tested**, leaving six components
  untested. Two guards here protect what the interface cannot undo. A
  *truncated* file is not savable — writing the visible half back would
  silently discard the rest, with nothing on screen to reveal it — and the
  name filter waits for a pause before spending a recursive server-side walk,
  which is the difference between a filter and a denial of service against
  your own machine. Committing needs a message *and* something staged; either
  half alone is a git error the operator has to go and read.


## [0.32.10] — 2026-08-28

### Added

- **The workspaces index and the dashboard are tested**, leaving eight
  components untested. The assertion that earns its keep here guards the only
  control in the product that erases a directory: the delete dialog's "also
  delete the files on disk" checkbox defaults to off, changes what the confirm
  button says, and **resets between workspaces** — ticking it for one project
  must not arrive pre-armed on the next. Sabotaged to confirm it bites.


## [0.32.9] — 2026-08-28

### Added

- **The socket frame router is tested** — the most load-bearing switch in the
  web app, and until now entirely unguarded. Several of its branches exist
  only to stop a screen sitting on stale figures: a run reaching a terminal
  state refreshes Analytics, Memory, Insights and Approvals, none of which
  receives a frame of its own, while a run merely *running* refreshes nothing
  (a refetch per streamed frame would be a request storm for numbers that
  cannot have moved). An approval notifies once, from the system topic only,
  because the request arrives on two. Ten components remain untested.


## [0.32.8] — 2026-08-28

### Added

- **The transcript row is tested, with the assertion that matters most in the
  whole web app**: assistant output reaches the DOM through
  `dangerouslySetInnerHTML`, and `lib/markdown.test.ts` proves the sanitiser
  works — but not that it is *in the path*. A refactor passing the raw text
  straight through would leave every one of those tests green while handing
  agent output to the browser as markup. Sabotaged to confirm it bites.
- **Two files are now excluded from the untested-component ratchet on
  purpose**, rather than given hollow tests: `test/render.tsx` is the harness
  every other test renders through, and `main.tsx` is `createRoot` plus a
  production-only service-worker registration. The count is 11 real
  components, down from 25 when the ratchet was introduced.


## [0.32.7] — 2026-08-28

### Added

- **The transcript container and the session list are tested**, taking the
  ratchet from 16 untested components to 14. Both had load-bearing behaviour
  that only a test can hold still: the transcript follows new output *only*
  while the reader is at the bottom, and the session list renders in the order
  the server gave it — the header comment promised the latter so a pin would
  not make rows jump before the refetch, and nothing checked it.


## [0.32.6] — 2026-08-28

### Added

- **Two more components tested**, taking the ratchet from 18 untested to 16.

### Fixed

- **A notification's level was carried by colour alone.** The dot beside each
  entry is `aria-hidden`, and nothing else said whether a run had succeeded or
  failed — so the place a failure is *found* announced a rollback and a
  finished backup identically. Each entry now states its level in text for
  the readers a hue cannot reach.
- **An empty patch drew a bordered table around a blank row.** `parseDiff('')`
  returns one empty context line, deliberately and pinned by its own test, so
  the guard belongs in the viewer rather than in the parser.


## [0.32.5] — 2026-08-28

### Added

- **Five more components tested — and five defects they had been hiding.**
  `Modal`, `TaskCard` and `CommandPalette` were paid down last release;
  `ConnectionBadge`, `Menu`, `UserMenu` and `CopyableCode` follow, taking the
  ratchet from 22 untested components to 18. Two new ratchets guard the i18n
  leaks this found.

### Fixed

- **A menu never told assistive technology which item was selected.** The tick
  beside the active theme, model or tool is `aria-hidden`, and nothing else
  carried the state — a screen-reader user heard a list of identical items.
  `MenuItem` now declares `role="menuitemcheckbox"` and `aria-checked`
  whenever selection is a concept, and stays an ordinary command when it is
  not: announcing "Delete" as an unchecked box would be worse than silence.
- **The connection badge imported the translator and never called it.** All
  four of its states rendered English while `fr.ts` carried their French,
  unreachable — the same for six strings in the account menu (`Light`,
  `Transcript`, `Sign out`…), whose translations were also already there.
- **The account menu closed after the first preference.** A comment beside it
  promised the menu stays open so several can be set at once; the `keepOpen`
  prop that would have made that true was missing, so the comment described
  behaviour the code did not have.
- **`ConnectionBadge` mounted with a stale state.** It read the socket's
  current state, which is right, but nothing pinned it — a badge that showed
  green after mounting on a dropped socket would have waited for a transition
  that may never come.


## [0.32.4] — 2026-08-28

### Fixed

- **Memory tags existed twice, and repeats evicted the real ones.** Three
  writers reach memory — the web form, the reflexion pass, the edit route —
  and none agreed on what a tag looks like: the form lowercased what it
  parsed, reflexion handed over whatever case the model produced, the edit
  route normalised nothing. `new Set` over strings is case-sensitive, so
  merging a repeated observation kept `Bail` *and* `bail`, and every repeat
  added another variant until the 24-tag cap began evicting genuine ones —
  measured at 20 distinct tags filling all 24 slots with case pairs. There is
  now one rule, in `packages/shared`, applied by every writer; the web's
  `parseTags` splits the comma-separated field and defers to it, so the user
  sees exactly what will be stored.


## [0.32.3] — 2026-08-28

### Added

- **A ratchet for React components with no test at all, and the first three
  paid down.** The API is tested at 0.86 lines of test per line of source; the
  web app was at 0.27, and both suites were green, so the gap was invisible.
  Measured: 25 of 65 components had no test whatsoever — including every major
  page, `MemoryPage.tsx` among them, a thousand lines of the screen two
  consecutive lots had just modified. `Modal`, `TaskCard` and `CommandPalette`
  now have one; the ratchet holds the rest from growing back.

### Fixed

- **A failed confirmation escaped as an unhandled promise rejection.** Every
  destructive action in the product goes through `ConfirmDialog`, whose click
  handler discards the promise it starts — so when the confirmed action threw,
  the rejection reached the window: a console error in the browser, and here a
  test run that failed while all 404 assertions passed. It stays open on
  failure as it always did, and now absorbs the rejection; reporting remains
  the caller's job.
- **A board card claimed `role="button"` but answered only Enter.** Space is
  the other half of that contract, and the key that scrolls the page when
  nothing handles it — so a keyboard user pressing it did not open the card
  and watched the board jump instead.
- **A run with an empty prompt showed as a blank row in the command palette.**
  `split('\n')[0]` yields `''`, which is not nullish, so the `?? 'Untitled
  run'` fallback never fired.

## [0.32.2] — 2026-08-28

### Added

- **A ratchet for untranslated interface strings, held at zero.** The app
  ships in two languages and `t()` falls back to its English key when a
  translation is missing, so a gap is invisible to every test, every
  typecheck and every English-language review — it surfaces only as one
  English button in the middle of a French screen, to the person using it.
  Swept once by hand: 411 keys, one gap (`Saved “{name}”`, from the knowledge
  library). Translated, and the sweep is now a ratchet so each new feature
  cannot re-open it. Template literals and computed keys are a stated blind
  spot rather than a guess.

## [0.32.1] — 2026-08-28

### Changed

- **The no-reranker decision now rests on a much stronger measurement.** The
  cold review asked the obvious adversarial question — is the wall the
  embedder, or is it my own relevance gates? Stripping every gate, the fusion
  and the limit, and letting the embedder rank the whole corpus by raw cosine,
  the right passage comes back **34th to 76th of 113**, scored like noise
  (−0.009 to 0.089) while the best-ranked wrong chunk sits at 0.098–0.204;
  the same measurement on in-vocabulary questions returns rank 1. That bounds
  *every* reranker rather than one pool size, and rules out the gates as the
  cause. Pinned as a test that goes red the day an embedder gains semantics.
- **The rephrased questions live in one place.** The regression test carried
  four of them and the bench script six — the exact drift `eval-corpus.ts`
  exists to prevent for the corpus, reproduced for the queries. They are now
  a single exported set both consume, guarded by a test asserting they really
  do share no content word with the passage that answers them.

### Fixed

- **The semantic-wall test pinned a bound instead of the measurement.** It
  allowed a quarter of those questions to start working while the docs went
  on claiming zero, and its own comment said the failure would be the good
  news — which a bound tolerating improvement prevents. It now asserts
  exactly zero.
- **The re-index control uses the app's tooltip rather than a `title`
  attribute**, which is unstyled, outside the charter, and never appears on
  touch — where this screen is used as much as on a desktop. It also counts
  in the singular, as memory maintenance already did.

## [0.32.0] — 2026-08-28

### Added

- **A retrieval evaluation harness — and the two measurements that changed
  the plan.** `learning/eval.ts` computes recall@k, MRR and nDCG@k over a
  labelled corpus; `scripts/eval-retrieval.mjs` re-runs it after any change
  to the embedder, the chunker, the relevance gates or the fusion. It exists
  because retrieval improvements are the kind that feel obviously right and
  are not — and it immediately proved that twice.
- **The doctor now names the embedder that actually answered.** Requesting
  `local` embeddings falls back to the built-in hashing one whenever the
  optional model package or its download is unavailable, and until now the
  only trace was one boot log line. Since that provider is the difference
  between a library that understands a rephrased question and one that only
  matches words, Settings → System → Doctor reports it, warns when the
  configured provider is not the one running, and says which regime the
  deployment is in.
- **Re-index the knowledge library from the interface**, the twin of memory
  maintenance and needed for the same reason: after an embedding-provider
  change, vectors from two spaces are incomparable, the dense arm silently
  stops contributing, and the exact-word arm keeps answering — a degradation
  quiet enough to need a button.

### Changed

- **No reranking stage, and that is now a measured decision rather than an
  omission.** Asked whether reranking would help, the harness answered from
  both ends. On questions phrased in the corpus' own words, retrieval is
  already perfect — recall@5, MRR and nDCG all 100%, holding at three hundred
  chunks and across three leases that differ only by the address in their
  title. On questions sharing no content word with their answer it scores
  zero — and zero *at the candidate pool*, not merely below the cut. A
  reranker reorders candidates; there are none to reorder, so reranking is
  not a weak improvement here but an arithmetically impossible one. The lever
  is the embedding provider, and the tests now record that conclusion so a
  future contributor meets the evidence rather than the intuition.
- **The guide says what the library finds and what it does not.** The shape
  is sharp rather than gradual — exact in the document's own words, blind
  outside them — so the memory chapter states it, with the habit that follows
  (phrase the question with a word the document contains, and rehearse the
  retrieval) and the upgrade path that removes the limit. `.env.example`
  stops implying `METACLAUDE_EMBEDDINGS=local` works out of the box: it needs
  a ~350 MB dependency in the image and a model download.

### Fixed

- **The instrument no longer contradicts itself.** `evaluate` scored
  recall and nDCG over the top `k` but MRR over the *whole* returned list, so
  a pipeline handing back fifty candidates with a hit at rank twenty would
  report "recall@5 0%, MRR 5%" — a passage no run would ever receive,
  credited as if it had been read, and precisely the shape a reranker's
  arrival would produce. Every figure in a report now answers for the same
  window.
- **Re-indexing the knowledge library asks the embedder for bounded
  batches**, as memory's maintenance already did, instead of for every
  passage in the library in a single call. Invisible under the hashing
  embedder that ships and live the day someone installs the model the doctor
  recommends. Batched by *document*, because staleness is recorded on the
  document while vectors live on its chunks: marking one halfway would strand
  its remaining passages under a document later runs no longer look at. A
  provider returning fewer vectors than it was asked for is now refused
  outright rather than half-applied.
- **The re-index control speaks French**, like the rest of the library
  screen it sits on.

## [0.31.0] — 2026-08-28

### Added

- **The knowledge library: a document RAG, global and per workspace.** The
  system always retrieved what it *learned* (memories); it can now retrieve
  what you *hand it to read*. At the bottom of the Memory page, paste
  reference documents — a lease, a spec, a runbook — onto the global shelf
  (every workspace) or a workspace's own; a sibling workspace can never see
  them. Each document is split into passages (markdown headings become the
  sections passages are cited under, seams overlap so a straddling sentence
  is findable from both sides) and indexed twice, by meaning and by exact
  words. Runs retrieve the relevant passages automatically and receive them
  as quotations with their source, which the agent is told to cite; the run's
  genesis shows **Passages consulted**. Documents never decay — unlike
  memories, reference material that quietly faded would be the worst possible
  failure — and a switch pauses one without deleting it.
- **Retrieval you can rehearse.** The library card answers "what would the
  agent see?" by running the exact pipeline a run uses — same hybrid search
  (dense ∪ BM25, reciprocal-rank fusion), same measured relevance gates, same
  diversity cap — and showing the passages, sources and scores. When it says
  a run would receive nothing, that is the same nothing the run would get:
  the library refuses to pad the context, because eight wrong quotations are
  worse than none.
- **Three retrieval guards, each from a measurement, two shared with memory.**
  A dense-only match now needs to clear a floor (0.18) measured against
  French stopword queries, whose character n-grams soak a French corpus into
  a flat band the relative gate admits (stopwords ≤ 0.102, genuine queries
  ≥ 0.446 on chunk-scale text). The lexical arm abstains outright on queries
  of nothing but function words — on a small corpus "un" present in one chunk
  of two carries real IDF straight through the BM25 clamp gate, measured at
  −0.0325 — and this fix lands in the shared `toFtsQuery`, so memory search
  inherits it. And at most two passages of any one document reach a result
  list, so the strongest document cannot silence the second-best.
- **`knowledgeEnabled`, per workspace.** Beside the memory toggle in the
  workspace drawer, separately: what the system learned and what it was
  handed to read are different trusts. No migration — text settings column,
  Zod default, the `advisorAuto` pattern.

### Changed

- The retrieval internals memory and knowledge share — the measured relevance
  floors, the FTS query builder, reciprocal-rank fusion — moved to
  `learning/retrieval.ts` with their derivations, re-exported so nothing
  breaks: two stores, one set of measurements.

## [0.30.1] — 2026-08-28

### Fixed

- **The setup screen could never show the redirect URI it exists to show.**
  The status route read the browser's `Origin` header — which browsers only
  send on POSTs and CORS requests, never on a same-origin GET. Measured
  against a live Fastify instance during the cold review, then fixed: the
  deployment's origin now falls back to protocol + the `Host` header — the
  *header*, not Fastify 5's `request.hostname`, which splits the port into
  its own field and would have stranded a `:8443` deployment at the wrong
  address after the consent (the callback's redirect had exactly that bug,
  fixed by the same helper). The screenshot bench now captures the screen
  against the real server, where the URI visibly renders.
- **Coming back from Google landed on a tab that could not hear the news.**
  The callback redirects to `/settings?google=…`, but the page opened on
  Security and Radix unmounts inactive tab content — so the connection
  card's effect never ran: no toast, no refresh, the parameter left in the
  URL. The parameter that carries the outcome now also picks the tab that
  can read it.
- **`calendar.write` alone plans blind, and now says so.** The grant maps to
  Google's `calendar.events`, but without `calendar.read` the listing tool is
  deliberately not registered — an agent asked to add an event cannot check
  for conflicts first. The checkbox hint warns to grant reading alongside
  writing. Caught by driving the *built* server over real stdio JSON-RPC —
  which also proved the dist entry, the handshake and the granted-set gating
  end to end.
- Removed two pieces of dead surface the review turned up: an unused
  `replyTo` header path in the mail builder and an unconsumed grants-reading
  helper.

## [0.30.0] — 2026-08-28

### Added

- **Gmail, Calendar and Drive, natively — Settings → Connections.** The
  claude.ai connectors cannot be imported (a run has no browser to give OAuth
  consent in), so the consent now happens *here*, once: register your own
  OAuth application in the Google Cloud console — the screen shows the exact
  redirect URI to paste, because `redirect_uri_mismatch` is how this setup
  usually fails — tick what the agent may do, and approve in your own browser.
  Metaclaude seals the refresh token and client secret in the vault and ships
  its own Google MCP server **inside the image**: no third party between the
  agent and your mailbox, versioned and reviewed like everything else.
- **Grants, not access.** Reading mail, sending mail, the calendar and Drive
  are separate checkboxes, each one Google scope, always the narrow one —
  `drive.file` reaches only what Metaclaude itself creates, `calendar.events`
  cannot touch calendar settings. The granted set decides which tools the
  server registers, so an ungranted capability is not refused at run time —
  its tool never exists and the agent cannot try it. The server itself lands
  under Agents & skills **disabled**, and the card names the account it
  actually bound (via the `openid email` identity scopes), so authorising the
  wrong Google account is visible instead of silent.
- **The seven-day trap, warned about before it is sprung.** Gmail and
  Drive *read* scopes are ones Google classes restricted: while a Cloud
  project's consent screen is still in "Testing", its refresh tokens expire
  after seven days and the connection dies next week for no visible reason.
  The screen warns when a restricted grant is ticked and says what to do —
  publish the app as Internal on a Workspace account, or keep to the
  unrestricted grants. Disconnect says plainly that it is local, and links
  the Google page where the grant is actually revoked.
- **An OAuth callback that respects the app's own cookie policy.** The
  session cookie is `SameSite=Strict`, so Google's redirect back arrives with
  no cookie at all — and rather than loosening that, the callback is
  authenticated by its `state` alone: 256 bits minted for one signed-in
  owner, ten-minute life, spent by the same SQL statement that validates it.
  The token exchange happens server to server (`prompt=consent` +
  `access_type=offline`, so a reconnection always yields a fresh refresh
  token), the client secret never appears in any URL, and an exchange that
  comes back without a refresh token is refused outright — storing it would
  look like success and die within the hour.
- **A Gmail that survives real mail.** The MCP server walks the MIME tree
  (plain text preferred, HTML stripped as fallback, attachments never
  mistaken for the body — a `.txt` attachment included), sends with RFC 2047
  encoded headers so «Réunion budget» arrives intact, expands recurring
  calendar events, keeps all-day events as dates rather than shifting them a
  timezone, and exports Google Docs and Sheets as text and CSV. Access tokens
  renew sixty seconds early through a cache that collapses concurrent
  refreshes, and a mid-life 401 is retried once with a fresh token. 134 new
  tests, every load-bearing behaviour proved able to fail by sabotage.

## [0.29.0] — 2026-08-28

### Added

- **A connector directory, under Agents & skills → MCP servers.** Eleven MCP
  servers whose documentation this repository has read — GitHub, Sentry,
  Context7, Exa, Apify, Hugging Face, Notion, Stripe, Google Maps, Wolfram and
  Anthropic's sequential-thinking scratchpad — each with its exact endpoint and
  the exact name of the credential it wants. Paste the credential, press Add,
  and the server is written globally and **disabled**, the secret sealed in the
  vault; switch it on and *From Claude* tells you whether it really connected.
  The shelf is narrower than a list of famous servers would be, and that is the
  point: every entry authenticates with something you can paste, because a run
  has no browser to complete an OAuth consent in. Two entries pay for the whole
  directory — Sentry wants `Sentry-Bearer` rather than `Bearer` (it reserves
  `Bearer` for MCP's own OAuth) and Google Maps wants `X-Goog-Api-Key` with no
  scheme word at all. Guess either and the failure reads exactly like a bad
  token. Each card states what it needs (`needs Authorization`) without showing
  a field: the first press asks for the credential, the second installs — the
  first draft mounted eleven password inputs at once and read as a form rather
  than a shelf, which the screenshot bench made obvious.
- **One allowlist, two features.** The directory is held to the advisor's own
  publisher allowlist: a test runs every entry through the same `checkMcpTrust`
  that refuses an untrusted MCP proposal, so a connector cannot exist for a
  publisher this repository has not vouched for, and the directory cannot
  become a second, laxer trust surface — the one an operator clicks rather than
  reviews.

### Changed

- **"Where are my claude.ai connectors?" now ends with what to do instead.**
  The guide already explained why Gmail, Calendar and Drive cannot be imported
  (the setup token is scoped to inference; each connector's consent needs a
  browser). It now gives the two routes that do work unattended — an automation
  hub issuing a static server token, or your own Google Cloud OAuth app with a
  local server holding the refresh token — and names the shape they share: a
  browser step that happened once, outside the agent, reduced to a credential a
  run can carry.

## [0.28.0] — 2026-08-27

### Added

- **The everyday half of the library gains its experts.** Sixteen more
  entries, aimed at the moments that actually cost money and sleep rather
  than at the daily routine: a tax preparer, a housing navigator covering a
  tenancy from the inventory to the deposit, a career coach, a caregiver
  organiser for an ageing parent, a negotiator that fixes the walk-away
  number before the conversation starts, and a gardener that plans by season
  — with procedures beside them for a house move, an insurance claim, vehicle
  paperwork, a CV and cover letter, interview preparation, health
  administration, energy savings, school orientation, a sleep reset and a
  digital-hygiene sweep. Fifty-six entries now.
- **`career` joins the vocabulary**, between travel and general: a job search
  is neither a domain of work nor a chore of the house, and filing it under
  either made the chips lie. Thirteen categories, all covered — existing rows
  are untouched, since the column is text with a `general` default and the
  enum is the validator.
- **A declared jurisdiction, enforced.** Administration is the one domain
  where a good procedure stops being portable: a notice period, a tax ceiling
  or an application calendar is a fact about one country, and a vague entry
  would be useless where a concrete one is wrong. Entries that lean on a
  national system open with a `Jurisdiction: France` line naming the portal
  to confirm against — service-public.fr, impots.gouv.fr, ameli.fr,
  ants.gouv.fr, Parcoursup — and instruct the agent to say what still holds
  elsewhere. A catalogue test refuses any entry citing one of those services
  without declaring the assumption, so the shelf cannot quietly become
  France-only; proved by stripping one marker and watching it go red.

## [0.27.0] — 2026-08-27

### Added

- **The library grows a second half: everyday life.** Nothing in this system
  was ever specific to code — the memory, the learned policy and the board
  serve a house move exactly as they serve a refactor — so the shelf now
  holds eight subagents and twelve skills for the rest of a week. A meal
  planner that starts from what the kitchen already holds and ends with the
  shopping list; a trip planner that puts travel time in the plan and names
  the one booking that ruins the week; an administrative navigator that finds
  the form, the evidence and the deadline and drafts what to send; a budget
  coach; a tutor; a home-project planner; a fitness coach; a week planner.
  Beside them, procedures for shopping lists, cooking from the cupboard,
  formal letters, packing, decluttering, hosting, auditing subscriptions,
  deciding a big purchase, revising for an exam, practising a language,
  preparing a medical appointment, and the household inventory an insurance
  claim needs. Five new categories shelve them — **home, health, money,
  learning, travel** — placed between the work domains and the general
  drawer. Where a domain belongs to a professional the entry says so in its
  own working rules (the fitness plan and the budget are explicitly not
  medical or financial advice, and prepare you for that appointment instead),
  and a test enforces it so the rule cannot quietly lapse.

## [0.26.2] — 2026-08-27

### Fixed

- **"Ask Metaclaude about itself" answered from a frozen guide.** The help
  workspace was seeded with the guide exactly once, when it was first
  created — so every chapter written or corrected afterwards never reached
  it, and the assistant went on answering, confidently, about a product that
  had moved on. (On a deployment that had asked one question before 0.21.0,
  that meant no library, no advisor, and two chapters' worth of corrections
  it had never seen.) The guide is now re-seeded whenever it has changed,
  detected by a fingerprint file written *after* the last chapter, so an
  interrupted seed is retried rather than remembered as complete. Steady
  state costs one read.

## [0.26.1] — 2026-08-27

### Fixed

- **Two chapters of the guide sent you to the wrong screen.** The advisor
  chapter said its daily opt-in lived in Settings when it lives in the
  workspace's own settings drawer, and the MCP chapter named a
  "Settings → MCP" screen that has never existed — MCP servers are configured
  under Agents & skills. Both are now right, and `check.sh` grew the guard
  that would have caught them the day they were written: every
  `Settings → …` path the guide or the README cites must resolve to something
  that exists in the settings screen, or the deploy checks fail.

### Changed

- **The documentation caught up with the product.** The roadmap had stopped
  five versions back — it still listed the advisor as future work — and is now
  a map of what shipped, version by version, with an honestly short list of
  what remains. The architecture document gained the built-in library, the
  run-genesis endpoint and the rules behind the visual layer; the learning
  document now shows what each loop *looks like* (the constellation is the
  forgetting curve, the posterior's width is the doubt); the workspace chapter
  documents the settings drawer including both autonomy opt-ins; and CLAUDE.md
  records four traps this cycle taught — the border-box safe-area collision
  that shipped broken twice, jsdom silently dropping `env()` values from the
  CSSOM, Radix activating on pointer events rather than clicks, and SVG ids
  colliding without `useId`.

## [0.26.0] — 2026-08-27

### Changed

- **An aesthetic pass, checked by eye.** A screenshot bench now boots the
  real server, seeds a lived-in deployment and captures every key screen in
  both themes — the pass was made against those images, not against
  imagination. What changed: the interface gains light — two faint radial
  glows fall from the top of every page, cards cast a soft shadow and, in
  the dark theme, catch a one-pixel light along their top edge; the primary
  button trades its flat paint for a lit sheen. The constellation becomes a
  sky: a deep radial ground, a shared halo glowing around every star, and
  rings that now sit at real durations — a day, a week, a month — so the
  chart can be read as dates. The pulse's heartbeat bars take a vertical
  gradient, and the pulse itself moves to the very top of the Dashboard,
  where an opening line belongs. Posterior curves gain a gradient fill,
  quartile ticks and a marked mean. Every change rides the existing theme
  tokens, stays still under reduced motion, and costs the entry bundle
  nothing.

## [0.25.0] — 2026-08-27

### Added

- **The dashboard opens on the system's pulse.** One line answers "what is
  my agent OS doing right now?" — runs in flight, the queue, decisions
  waiting — beside a 24-hour heartbeat: one bar per hour, green for what
  succeeded, red capping what failed, quiet hours drawn as ticks because an
  empty hour is information too. The current hour breathes while runs are
  in flight, and the whole thing holds still under reduced motion.

## [0.24.0] — 2026-08-27

### Added

- **The memory has a sky.** The Memory page now opens on a constellation:
  each kind of memory owns a sector, a star's size is its confidence, its
  distance from the centre is how long since a run last recalled it — so a
  star drifting toward the rim *is* the forgetting curve — and one recalled
  in the last day breathes gently (stilled under reduced motion). Pinned
  memories wear a ring, visibly exempt from decay. Tap a star to land on
  its card. Positions are deterministic — the sky holds still between
  visits, and only genuine reinforcement or decay moves a star; past ~240
  the faintest stars stay undrawn and the legend says how many.

## [0.23.0] — 2026-08-27

### Added

- **The loop, made visible.** Every exchange in a transcript now carries a
  small strip between your message and the answer: the category the
  classifier assigned, the model and effort the policy chose, and who chose
  them — the learner, the workspace default, or you. On the run working
  right now the segments cascade in one after another (and hold still for
  anyone who prefers reduced motion); open the strip and the evidence
  unfolds: the memories actually injected with their retrieval strength,
  the Beta posterior of the exact arm the choice stood on, and the
  learner's own sentence. A run that recalled nothing says so plainly. The
  transcript pays nothing for history — the detail is fetched only when
  opened.
- **Posteriors drawn as curves.** Analytics now draws each policy arm's
  Beta distribution instead of a bar: a narrow spike is a settled belief, a
  broad hump is doubt — and that width is why a trailing arm still gets
  occasional trials. Two arms with the same mean finally look as different
  as they are.

## [0.22.2] — 2026-08-27

### Fixed

- **The installed app's tab bar: no more black bands, no more miniature
  icons.** One CSS trap explained all three symptoms on a gesture-nav
  phone: the bar carried a fixed height *and* the home-indicator padding on
  the same border-box element, leaving ~22px for its content — flexbox
  crushed the icons into it (fine in a browser tab, where the inset is 0) —
  while the page's global padding *also* reserved the inset, so the three
  stacked reservations showed as a bare band above the bar and a hollow one
  below it. The bar now owns the bottom inset alone and paints the
  home-indicator zone with its own surface, its content row keeps its full
  height, the icons refuse to shrink, and the page chrome pads only the
  notch and the sides. Two tests now pin the separation, so neither half of
  the trap can come back quietly.

## [0.22.1] — 2026-08-27

### Changed

- **The security and architecture documents now cover the advisor.**
  docs/SECURITY.md's prompt-injection section explains why its autonomy is
  graduated by consequence and how the trusted-publisher allowlist bounds
  what web research can bring in; docs/ARCHITECTURE.md describes the
  service, the per-run proposal tools and the daily sweep.

## [0.22.0] — 2026-08-27

### Added

- **The advisor.** Metaclaude can now study itself and propose. Ask it from
  the Dashboard (or opt a workspace into a daily analysis under Settings →
  Autonomy): a run titled *Advisor* reads recent runs and their failures,
  the board, the automations and the registry, then acts with graduated
  autonomy — tickets go straight to Backlog with the reasoning as a card
  comment, automations are created **disabled** with the rationale beside
  the switch, and anything that would act the moment it existed (skills,
  subagents, MCP servers, plugins) lands in a Dashboard **inbox** where
  accepting is one click and still creates the record disabled. MCP
  proposals face a trusted-publisher allowlist enforced server-side —
  Anthropic, GitHub, Linear, Notion, Sentry, Stripe, Cloudflare, Hugging
  Face — because the advisor researches the open web, and a page saying
  "add this MCP server" is exactly what prompt injection looks like. The
  proposal tools are mounted into every run, so any agent that notices a
  repeated chore can propose the automation on the spot; each advisor run
  is pinned to the Auto permission mode and keeps one session per
  workspace, so analyses accumulate context.

## [0.21.0] — 2026-08-27

### Added

- **A built-in library.** Agents & skills grows a **Library** tab: a starter
  shelf of eight subagents (code reviewer, test writer, debugger, security
  auditor, tech writer, data analyst, researcher, ticket splitter) and twelve
  skills (conventional commits, PR descriptions, migrations, changelog
  entries, ADRs, SQL review, Dockerfile review, CI diagnosis, option
  comparison, user stories, meeting notes, postmortems). Everything on the
  shelf is curated and versioned in the repository itself — never fetched
  from a store — and installing copies an entry into the global registry
  **disabled**, where it becomes yours to edit, rename or delete; the
  library keeps the original for reinstallation.
- **Categories.** Skills and subagents are now filed under engineering,
  writing, data, ops, research, product or general. The library filters by
  category chips, list entries wear their category as a badge, both editors
  offer the choice, and the French translation covers all of it.

## [0.20.0] — 2026-08-27

### Added

- **The interface speaks French.** A language switch in Settings →
  Appearance (each language named in itself, so the way back is always
  readable), the choice persisted per browser, and a browser already set to
  French starts in French. The translation covers the everyday surface:
  navigation, sign-in, dashboard, the whole board, sessions' chrome
  (approval prompts included), settings with all their security cards,
  notifications and passkeys, the command palette and the onboarding
  checklist. Honest edges, stated in the switch itself: the guide and the
  changelog stay in English for now, as does text the server or the CLI
  produces. Under the hood the English string is the key — a missing
  translation falls back to English, never to a blank — and the French
  dictionary loads as its own lazy chunk, so the English product pays
  nothing; the entry grew 1 kB for the translation *machinery*, and the
  bundle ratchet moves 182 → 184 deliberately for it.

## [0.19.1] — 2026-08-27

### Fixed

- **The phone tab bar was miniature in the installed app.** An installed
  PWA renders raw CSS metrics: unlike a browser tab, no accessibility text
  scaling rescues undersized icons, so the 19px icons and 10px labels that
  looked fine in Chrome read as miniatures on the Home-Screen app. The bar
  now carries the platform floor itself — 24px icons, 11px labels — and the
  content area finally accounts for the safe-area inset the bar grows by on
  gesture-nav phones, so the last lines of a screen are no longer hidden
  behind it in the installed app.
- **"Send a test" no longer claims no device is subscribed when one is.**
  Two bugs wearing one message. The browser's push subscription and the
  server's record can drift apart — a restored database, a registration
  that failed after the permission was granted — and the card then said
  "subscribed" from the browser's half alone; it now re-registers the
  device on every visit (an idempotent upsert, no permission prompt), so
  the two halves converge. And the test button reported *every delivery
  failed* with the same words as *nobody is subscribed*; the server now
  answers with devices, deliveries and the last error, and the button says
  which of the three actually happened.

## [0.19.0] — 2026-08-27

### Added

- **Review changes hands explicitly, in both directions.** Whatever enters
  the Review column is now assigned to *you* — the agent finishing a card,
  the agent moving one with its own board tools, your own drag, every path
  converges on the same rule, because what sits in review is yours to
  judge. (Reordering inside the column changes nothing: tidying is not
  judging.) And the one way a review card can be agent-assigned is the new
  hand-back: **assign the agent to a card in review and the agent picks it
  up** — ahead of the To do queue, with or without the autopilot opt-in,
  past the quota guard (you asked for exactly this card), and never two
  runs at once; the run-finished chain and the periodic sweep start it the
  moment the workspace is free. The hand-back prompt tells the agent the
  card came back from review — verify, don't redo — and carries the card's
  discussion, so comment your feedback first. On success the card returns
  to review, assigned to you again: the loop closes where it started. The
  assignee menu says all of this before you click it.

## [0.18.0] — 2026-08-27

### Added

- **Passkeys.** Sign in with the device's own unlock — Face ID, a
  fingerprint, a security key — instead of the password. Enrolment lives in
  Settings → Security beside two-factor: adding a passkey costs your
  password (so does removing one), the password and authenticator app keep
  working underneath, and once any device is enrolled the sign-in screen
  offers **Sign in with a passkey** — only where pressing it could work.
  WebAuthn scopes a credential to a *domain*, so a deployment reached by IP
  address is refused enrolment with the fix in the message (give the server
  a hostname) rather than offered a ceremony that fails opaquely. A passkey
  sign-in deliberately ignores the password lockout — an assertion is not
  guessable, and it is the way back in while someone hammers the password
  form; the ceremony endpoints share the password login's rate limit, and
  challenges are single-use with a five-minute life. Verification is
  `@simplewebauthn/server`; the test suite drives a real software
  authenticator — genuine P-256 signatures, CBOR attestation — through the
  unmodified service, and flips one byte to watch it refuse.

## [0.17.1] — 2026-08-27

### Fixed

- **Uninstalling saved the secrets again.** The closing-summary lookup of the
  backup directory read `deploy.conf` through a pipeline; on a host without
  that file, `set -e` killed uninstall.sh at that line — after removing the
  systemd units, *before* saving `.env` (the master key) to `/root` and
  before removing the application tree. Caught by CI's uninstall rehearsal
  minutes after v0.17.0 was pushed, released as the fix here; the read is now
  guarded, and the trap (an assignment from a failing command substitution
  exits the script) is recorded in CLAUDE.md.

## [0.17.0] — 2026-08-27

### Added

- **Backups that take themselves — and say so when they stop.** The
  installer now leaves a nightly systemd timer running
  `metaclaude-backup`: it stops the app for the seconds a consistent copy
  needs (the proxy stays up), archives all four volumes — database and
  sealed vault, workspaces, the CLI's own transcripts, Caddy's certificate
  authority — into one timestamped archive under `/var/backups/metaclaude`,
  restarts, and keeps the newest 14. The archive deliberately excludes
  `.env`: a master key that travels with the ciphertext it opens is a
  formality, not a key. `restore <archive> --yes` puts every byte back
  (and refuses without the `--yes`); `list` and `prune` do what they say.
  After each completed archive the tool writes a marker into the data
  volume, and the **doctor** grew a check that reads it: no backup ever, or
  none for more than a day, is a warning in Settings → System — so a timer
  that quietly stops firing becomes visible news instead of a discovery
  made the day the disk dies. The whole tool is rehearsed by CI against a
  stubbed daemon: stop-copy-start ordering, archive completeness, the
  marker, retention, and both restore guards.

## [0.16.1] — 2026-08-27

### Changed

- **The entry bundle sheds the API's paperwork.** Twenty-eight
  request/response schemas only the API validates moved out of the module
  the web's socket validation keeps alive, into
  `packages/shared/src/api-contracts.ts` — a module nothing in the entry's
  runtime graph imports, so the bundler drops it whole. The entry shrinks
  by 1.2 kB gzipped *after* three feature lots landed the same day, the
  bundle ratchet tightens for the first time (184 → 182), and every future
  API-only contract is free. The rule now lives in CLAUDE.md.
- **Long transcripts render lazily.** Each exchange carries
  `content-visibility: auto`: sections far off screen skip layout and
  paint entirely, which keeps a hundred-run session scrollable on a
  phone — chosen over list virtualisation deliberately, since it cannot
  interfere with scroll anchoring, find-in-page, or the DOM that tests
  and tools see.
- **Fixing an MCP server shows up without the wait.** Saving or deleting
  an MCP server or a custom agent now drops the catalogue cache, so the
  From Claude panel's next read reflects the change immediately instead
  of up to a minute later — exactly the window an operator refreshes in
  after fixing a server's command.

## [0.16.0] — 2026-08-27

### Added

- **A Getting set up checklist on the dashboard.** A fresh deployment has
  half a dozen one-time steps spread across four screens, and each was
  historically discovered by hitting the wall it guards. The owner's
  dashboard now lists them — pair Claude, create a workspace, run the
  agent once, two-factor, notifications, the host updater — each a link
  to its screen, struck through as done, gone when everything is, and
  dismissible for good.
- **Slash commands where you type.** `/` on an empty message offers the
  CLI's own commands, narrowed as you type — arrows choose, Enter or Tab
  completes, Escape writes a literal slash. Read from the catalogue, so a
  command a plugin adds appears without a release; a `/` mid-sentence (a
  path, a fraction) never interrupts.

### Changed

- **The ⌘K palette reaches everywhere.** Board, Plugins and Help joined
  its navigation list — the three sections it could not jump to.

## [0.15.0] — 2026-08-27

### Added

- **The board works itself.** Switch *Work the board by itself* on in a
  workspace's settings and each finished card run pulls the top unblocked
  To do card automatically — one card at a time (a backlog is a queue,
  not a fan-out), in the order you arranged, success landing in Review
  and failures blocking the card with their reason, exactly as a pressed
  "Send to the agent" would. A **quota guard**
  (`METACLAUDE_QUOTA_GUARD_PCT`, 85% by default) pauses automatic starts
  when the plan's worst window nears its ceiling — per-model buckets are
  ignored so one saturated model cannot stall the rest — and a periodic
  sweep resumes the queue when the window breathes, or when cards were
  added while the board sat idle. The guard never refuses a human: the
  new **Work the board** button in the board header starts the top card
  on demand, opted in or not, and the board history signs automatic
  starts as `autopilot` so who queued what stays answerable.

## [0.14.0] — 2026-08-27

### Added

- **Push notifications, self-hosted end to end.** The phone finally hears
  about the one moment everything is blocked on you: a run waiting on an
  approval pushes to every subscribed device (high urgency, a lifetime
  matching the approval's own ten minutes), and a run **you** started
  pushes its outcome when it ends. Automations, loops and delegated runs
  never push, by design — they work while you sleep. The VAPID identity
  is generated on the server and sealed in the vault, payloads are
  encrypted end-to-end (RFC 8291, via the `web-push` library) so the
  browser vendor's relay reads nothing, and they carry only a title, a
  short line and a link — never prompt text or tool input. Enable per
  device from Settings → Notifications, with a **Send a test** button
  that proves the path to the lock screen; a relay answering "gone"
  prunes the subscription by itself. The installed app's icon also
  **badges** with the number of waiting approvals, cleared the moment
  the last one is decided.

## [0.13.1] — 2026-08-27

### Changed

- **The mirror's real-world status is documented.** Tested on a live
  deployment with a full-scope sign-in: server sessions do not appear on
  claude.ai today. The upload belongs to the CLI's Remote Control bridge —
  a background worker headless runs never start — and is feature-gated per
  account on Anthropic's side besides. The guide now says so where the
  toggle is explained: the setting is passed faithfully, costs nothing
  while ignored, and starts working without a Metaclaude release the day
  Anthropic opens the gate.

## [0.13.0] — 2026-08-27

### Added

- **Mirror a workspace's sessions to claude.ai.** With the CLI's account
  sign-in as the live credential (v0.12.0), each workspace can now opt in
  to publishing view-only copies of its sessions to the account — the
  toggle lives in the workspace's settings, rides the same flag-tier
  settings payload as ultracode and plugins, and is sent only when on, so
  every run that never asked stays byte-identical. Off by default: it
  puts transcripts on claude.ai, and it is inert under a token
  credential, which Anthropic scopes to inference only.

## [0.12.1] — 2026-08-27

### Fixed

- **Pressing Check re-served last hour's answer.** The server caches the
  update check for an hour — right for passive readers, wrong for the
  button: the card never sent `refresh=true`, so a deliberate press
  minutes after a release still answered "no update" from the
  pre-release cache. Found live, minutes after v0.12.0 was published.
  The Check button now always forces a fresh read; it is the only thing
  that runs that query, so the cache still shields everything else.

## [0.12.0] — 2026-08-27

### Added

- **The CLI's own account sign-in is a first-class credential.** claude.ai
  session sync — mirroring, Remote Control, `--teleport` — needs a full
  account sign-in, and Anthropic limits long-lived tokens to inference
  only, server-side; an injected token moreover *overrides* a sign-in. All
  three facts now live in the product instead of in the dark: with nothing
  paired and nothing in `.env`, runs fall through to the sign-in `claude
  auth login` leaves in the container (persisted by the home volume, kept
  fresh by the CLI itself), the status reports `cli-login` as its source,
  and the credentials card says when runs use the sign-in — and when a
  paired token is shadowing a full-scope sign-in, with the remedy. The
  guide's sessions chapter documents the whole bridge, including the
  teleport-then-adopt path that brings a claude.ai/code session into a
  workspace.

## [0.11.0] — 2026-08-27

### Added

- **Pair with Claude from the app — no shell, no restart.** Settings →
  System now runs the `claude setup-token` flow itself: Start pairing hands
  you the claude.ai sign-in link (open it here, or copy it to any device),
  and pasting back the code Claude displays finishes the exchange
  server-side — PKCE-bound, the token sealed straight into the vault and
  live on the very next run. A mistyped code is retriable, an expired or
  replaced attempt says so, and the token never passes through the browser.
  The OAuth constants are read from the CLI binary the image ships, and the
  manual token paste stays as the fallback.

### Changed

- **The From Claude panel now reports the world runs actually see.** The
  catalogue probe used to open a bare CLI session: no registry servers, no
  custom agents, none of the run posture — so "whether each configured
  server actually connected" was a promise about servers it never mounted.
  It now mounts the workspace's resolved MCP servers and agents under the
  same policy locks and strict MCP posture as a run, so connection status
  is finally live truth. The panel and guide also now say plainly why
  claude.ai account connectors cannot appear on a headless server — a
  setup token is scoped to inference only — and that the MCP registry is
  the way to connect external services.

## [0.10.1] — 2026-08-27

### Fixed

- **The version-tagged image was never published — found by a real deploy.**
  `deploy ghcr.io/…:v0.10.0` answered "not found": the CI entries that tag
  images by semver only fire on a *tag* event, and the version tag is pushed
  with `GITHUB_TOKEN`, whose pushes deliberately trigger no workflows — so
  only `latest` and `sha-…` ever existed. The container job now reads
  `APP_VERSION` out of the checkout and tags `v<version>` on every green
  main push — the exact reference the in-app Apply button composes, which
  would otherwise never have worked. `check.sh` asserts the wiring.
- **install-app.sh died on a real host at `install -o 10001`.** The
  container uid exists only inside the image, and `install` refuses an
  owner `/etc/passwd` cannot name — aborting the script before the updater
  units were installed. The ownership is now a numeric `chown`, which takes
  the raw id; asserted by `check.sh` so the shape cannot return.

## [0.10.0] — 2026-08-27

### Added

- **Drag cards with a finger.** The board's drag and drop only ever spoke
  mouse — the native HTML5 drag API does not fire on touch, which left
  phones with the ⋮ menu alone. Press and hold a card and it lifts (a quick
  swipe still scrolls, as it must), a ghost follows the finger, the column
  under it lights up, the columns edge-scroll when you carry a card past
  the screen, and letting go drops it — after the card under your finger,
  or at the end of an open column, exactly like the mouse. Pointer-events
  only, no library; the mouse keeps the native path untouched.

### Fixed

- **Fable could vanish from the model picker.** The composer showed exactly
  what the CLI chose to *enumerate* — but that list is not everything the
  CLI accepts, and a catalogue answer without `fable` silently hid the
  flagship the subscription pays for. The stable aliases (Fable, Opus,
  Sonnet, Haiku, Opus plan) now stay on offer even when the CLI enumerates
  without them; the CLI's own names and hints still win when it does name
  them, and an alias the subscription lacks fails at run time with the
  CLI's own visible message rather than being pre-censored on a guess.
- **Ultracode looked missing under Auto.** It is withheld there on purpose —
  the learner may pick a model that cannot orchestrate — but silently, so
  it read as absent. The toggle now shows inert under Auto with the reason
  and the fix in its tooltip: pick a model (Fable, Opus…) to enable it.

## [0.9.1] — 2026-08-27

### Fixed

- **The apply request is race-proof now, and the reload rule is pinned.**
  An adversarial pass over v0.9.0's handshake closed two seams. Requesting
  an update was read-then-decide-then-write — every concurrent press could
  pass the "already pending" check before any had written (the same family
  as the login race this project was bitten by) — so the write is now the
  check: an exclusive lock-file creation admits exactly one of any number
  of simultaneous requests, with a stale lock left by a crash swept after a
  minute rather than bricking the button. And the page-reload decision
  ("only on a success this page watched happen") moved into a pure,
  directly-tested function — a stale success from last week can provably
  never refresh anyone's screen. The whole loop is now simulated with both
  real processes: the HTTP server on one side, the actual updater script on
  the other, including the app's own restart in the middle and two
  simultaneous presses admitting exactly one request.

## [0.9.0] — 2026-08-27

### Added

- **Apply the update from the app.** The Updates card grows the button the
  check always implied: on a server whose installer set up the updater,
  **Apply vX.Y.Z** runs the real deploy — pull, switch, health gate, and an
  automatic rollback if the new version does not serve. The app itself is
  handed no power over the host: it writes a bare version into an exchange
  directory, and a host-side systemd path unit composes the image from the
  server's own pinned repository and drives `metaclaude-deploy`, the same
  executor CI uses. Even a fully compromised app could only pick which
  published version of the allowed repository runs. The page rides out its
  own restart and reloads on the new version; a failed attempt stays
  visible on the card with the updater's reason. Owner-only, audited,
  confirmed in a dialog, and one request at a time — a second press while a
  deploy is in flight is refused. `deploy/check.sh` rehearses the updater
  against a stub deploy and proves a malformed request never reaches
  Docker; without the host updater the card stays informational and says
  how to add it.

## [0.8.3] — 2026-08-27

### Fixed

- **v0.8.2 never became a release — its CI was red on the bundle ratchet.**
  The phone-navigation fix below is worth its weight: the More sheet and the
  account menu pushed the entry bundle from 180 to 181 kB gzipped, exactly
  one kilobyte over the ceiling. The ceiling moves to 181 — deliberately,
  by hand, for tap-reachable navigation that belongs in the entry chunk.
  The structural way to win the headroom back stays on record in CLAUDE.md:
  the API-only Zod contracts still ship in the entry and could move to a
  module the web's runtime graph never imports.

## [0.8.2] — 2026-08-27

### Fixed

- **The board was outside the shell.** The one screen in the app that never
  wrapped itself in the application shell: no icon rail on desktop, and on a
  phone no tab bar at all — the browser's Back button was the only way out
  of `/board`. It now renders inside the shell like every other page, and a
  test pins the rail and tab bar to the page so it cannot ship without them
  again.
- **Five sections had no touch entry point.** On a phone the icon rail is
  hidden and the tab bar only holds the five primary sections, which left
  Memory, Agents & skills, Plugins, Analytics and Help reachable only by
  URL or the command palette. The tab bar gains a **More** tab opening a
  bottom sheet with the rest — one tap, closes on navigation, tinted when
  you are standing on one of its sections. The account menu (theme, sign
  out) joins the phone header too; it only ever lived in the hidden rail.

## [0.8.1] — 2026-08-27

### Fixed

- **The update check no longer answers "404 Not Found".** It asks GitHub for
  the latest *release* — but the pipeline only ever pushed *tags*, and a
  repository with tags and no formal release answers 404 on that endpoint
  forever, which the Settings screen then displayed raw. Two-sided fix: CI
  now publishes a real GitHub release for every version tag, with that
  version's changelog section as the notes (asserted by `check.sh`, and the
  extraction is proven against the real changelog on every run); and the
  checker itself falls back to the newest version *tag* — semver maximum,
  never API order — when the release endpoint answers 404, so servers
  running ahead of the first published release still get a real answer.
  A 404 on both now reads as the sentence it means ("nothing published
  there yet, or the repository is private to this server") instead of a
  status code, and a non-404 failure (GitHub down, rate-limited) is
  reported as such rather than misread as "no releases".

## [0.8.0] — 2026-08-27

### Added

- **Notes, the Obsidian way — without installing Obsidian.** Markdown files
  in a workspace now open *reading*: rendered, with `[[wikilinks]]` live —
  click one and the linked note opens in the panel, `[[Note|alias]]` shows
  its alias, a name no note answers to shows muted, and links inside code
  stay prose. Under every note, its local graph (what links here, what it
  links to, every node a click) drawn in plain SVG, and its backlinks with
  the exact line that made each link. Resolution matches Obsidian's habits —
  bare names case-insensitively, the note's own folder first, then the
  shortest path — and the *same* resolver module is shared by the server's
  index and the click handler, so the note a click opens is always the note
  the graph drew. Served straight off the workspace's files: a synced vault
  works as-is, nothing is stored, scans are bounded (a huge vault gets a
  truncation flag, never a hung request), and traversal paths are refused at
  the jail like every other file route. The Edit toggle keeps the plain
  editor one keystroke away.

## [0.7.0] — 2026-08-27

### Added

- **The agents on the board.** The board's other half. Open a card and
  **Send to the agent**: its title, description, discussion and sub-tasks
  become the prompt of a run in a session named after the card, the card
  slides to *In progress* under agent hands with a live pulsing marker, and
  the drawer links straight to the session. When the run ends the loop
  closes on the card itself — success moves it to **Review** with a comment
  (never to Done: done is the operator's word), failure or interruption
  blocks the card with the reason where the board can read it, and a card
  the agent already moved holds its place, on failure as on success.
  **Send back to the agent** resumes the same session, context intact, after
  review feedback; a card already being worked refuses a second press.
- **Board tools in every run.** An in-process `metaclaude_board` MCP server
  rides along on every run — card runs, chat, automations, even delegated
  runs: `board_list`, `board_get`, `board_create`, `board_update`,
  `board_move`, `board_comment`, `board_decompose`. Strictly scoped to the
  run's own workspace — a foreign card gets the same "no such task" as a
  missing one — and everything an agent does lands in the card history under
  its run's name. Like the delegation server, it cannot be excluded from the
  composer's Tools picker: kernel machinery, not a workspace server.
- **The board in the morning brief.** One line with the counts that need
  eyes — in review, blocked, being worked, due soon — linking to the board,
  and review cards now break the "quiet day" headline.
- **Filters and counts on the board.** All / Yours / Agent chips narrow the
  columns to one pair of hands; the header states the board's own numbers
  (cards, being worked, in review, blocked) unfiltered.

### Fixed

- **Deleting a decomposed card left ghosts on open boards.** The rows died
  by `ON DELETE CASCADE`, but only the root's removal was published; every
  descendant now gets its own removal frame through the board gateway — the
  one mutation surface the routes, the agent tools and the run-outcome hook
  all share, so a forgotten publication can no longer regress per call site.

## [0.6.0] — 2026-08-27

### Added

- **The board.** One kanban per workspace, shared by you and the agents:
  Backlog → To do → In progress → Review → Done, with priorities, an
  assignee (you or the workspace's agent), due dates, blocked markers whose
  reason travels with them, comments, sub-tasks three levels deep, and an
  append-only history on every card — a board worked by several hands must
  stay explicable after the fact. Drag on desktop, the card's ⋮ menu on a
  phone (swipe between columns), everything live over the socket: a card
  moved anywhere slides across every open board. Ordering is fractional —
  the server assigns each move a key between its neighbours, so concurrent
  edits cannot corrupt positions and there is never a renumbering sweep.
  Archiving keeps the column a card died in and restores exactly there;
  deletion is deliberately two-step. The agent's half — picking cards up,
  decomposing, reporting back — arrives with the delegation lot.

## [0.5.1] — 2026-08-27

### Changed

- **Claude CLI 2.1.247, Agent SDK 0.3.247.** The paired pin moves up one
  patch. The SDK's message union gained nothing new to narrate — the
  union-completeness test that exists for exactly this moment stayed green —
  and the full suite passed unchanged.

## [0.5.0] — 2026-08-27

### Added

- **Steer the tools, when judgement is not enough.** Normally the agent
  knows its skills and MCP servers and picks well; the composer's new Tools
  picker is for the other times. Require a skill and only the required ones
  load — with the requirement written into the run's instructions; switch
  an MCP server off and it is simply not mounted for that message; mark one
  preferred and the agent is asked to reach for it first. Per-message by
  design, like Ultracode: nothing stays quietly forced. A directive naming
  a skill or server that does not exist fails loudly at submission, the
  result carries a "tools steered" chip with the detail on hover, and none
  of it widens a permission — the approval rules apply unchanged, and the
  kernel's own delegation machinery cannot be cut from the picker.

## [0.4.1] — 2026-08-27

### Fixed

- **The attachments review, applied.** v0.4.0 never became a release — its CI
  was red, which blocks both the tag and the deployable image — and the deep
  review that followed found four things worth fixing before one exists:
  attachment rows now cascade with their session, run and workspace (the
  first draft's enforced foreign keys made any session that ever carried an
  attachment undeletable); a janitor sweep reaps uploads nobody ever sent
  after a day's grace; files picked in one session no longer follow a
  navigation into another; and the attachment contract became a type instead
  of a schema — nothing ever parses one at an edge, and the needless z.object
  was exactly the kilobyte that pushed the entry bundle over its ratchet and
  turned CI red.

### Added

- **Messages carry files now.** The paperclip, drag & drop onto the composer,
  a pasted screenshot, or the phone's camera — up to 8 files, 20 MB each, on
  any message. Every attachment lands in the workspace itself under
  `attachments/`, where the agent reads it with its own tools (images and
  PDFs natively) and the Files browser shows it; small images and PDFs also
  ride the message inline so the model sees them without a tool round-trip.
  The transcript renders images as thumbnails and everything else as chips,
  both serving the stored bytes through an authenticated route — uploaded
  HTML deliberately downloads instead of rendering, because serving it inline
  on this origin would execute its scripts with the app's cookies. Uploads
  deduplicate by content hash, bind to exactly one run however submissions
  race, and are audited like every other mutation.

## [0.3.0] — 2026-08-26

### Added

- **What actually ran, on every result.** Each run's footer now shows the
  model, effort, permission mode and provenance (learner, workspace default,
  or your choice), plus an ultracode marker. The model shown is the one the
  CLI itself reported serving, captured off its init message and persisted —
  because under Auto the policy can say literally `default`, and nothing
  else answers "which model was that?". Hover for the requested-vs-served
  detail.
- **The society of sessions.** The agent can delegate: from a session in one
  workspace, ask another workspace to work on something and get its answer
  back. The target runs with its own memory, skills, conventions and
  permission mode — a project consulted through its own agent answers better
  than its files read cold. Every delegation passes a permission prompt
  naming the target and the exact ask, is a real recorded run in the
  target's history and usage, and accumulates in a standing Delegations
  session there. Depth is one by construction — a delegated run never sees
  the tool and the kernel refuses it besides — so chains cannot loop and
  every delegation traces back to a run a human started.

### Changed

- **Every push now carries a version.** `node deploy/bump.mjs patch|minor`
  moves the five version declarations and the changelog together, CI's
  version-guard job refuses a push to main whose version did not increase,
  and every green push tags its version (`v<version>`) — the release points
  the update check compares against. Deploying stays an explicit act; set
  the repository variable `METACLAUDE_AUTO_DEPLOY=true` to have each green
  push dispatch the health-gated deploy as well.
- **Auto can now reach Fable.** The learner's exploration frontier gains the
  Claude 5 flagship at high and very-high effort — a frontier frozen at the
  previous generation made the newest model structurally unreachable under
  Auto, whatever the runs scored. The reward already prices cost in, so the
  expensive arms win only on evidence; existing deployments grow the new
  arms on their next selection. The composer's fallback model list offers
  Fable too, for when the CLI cannot enumerate models.

### Fixed

- **The deployed Help screen was empty.** The user guide and this changelog
  are bundled from outside `apps/web` (`docs/guide/*.md` and the root
  `CHANGELOG.md`), and the image's build stage copied neither — a glob over
  absent files matches nothing rather than failing, so production shipped
  Help sections with no content while every check stayed green. The build
  stage now copies both, and `vite.config.ts` refuses to build a tree where
  the corpus is missing, so forgetting it fails the image build instead of
  the reader.

## [0.2.0] — 2026-08-26

The system starts to know itself: what its subscription is spending, whether
its own machinery is healthy, what happened while you were away — and it
begins converting what it learns into capability, always through a human's
review.

### Added

- **Skill synthesis.** Reflexion learns one run at a time; "Distil a skill"
  reads across runs — the workspace's accumulated procedural memories,
  highest-confidence first, handed to one cheap tool-less model call that
  either drafts a coherent skill or answers that the procedures do not
  cohere. Refusal is a first-class answer, reported as such. A draft lands
  in the same review queue as every per-run proposal and installs only
  through the same explicit action: synthesis never touches the registry.
- **The brief.** The dashboard opens (for the owner) with one card
  answering "what happened, what needs me": a headline sentence, the last
  24 hours' activity, each failure linked into its session with the error
  in sight, approvals waiting, the automations the failure guard switched
  off — named, since nothing else says so loudly — the doctor's verdict,
  insight growth, and the quota window closest to its ceiling. Composed
  deterministically from the server's own records: no model in the loop,
  so it is always available and always current; a source that cannot
  answer (usually the quota) costs its section, never the page.
- **A guarded update check.** Settings → System → Updates compares the
  running version against the latest published release and answers with one
  of three honest states: an update exists, up to date, or "cannot tell"
  when the latest tag is not a version — because "no update" and "I don't
  know" are different answers. Informational by design; applying an update
  stays the tag-driven, health-gated, self-rolling-back deploy pipeline.
  `METACLAUDE_UPDATE_REPO` points it elsewhere or, set empty, disables it.
- **The doctor.** One button under Settings → System runs every self-check
  the system knows how to make — database integrity, the audit chain, the
  secrets vault, disk space on both volumes, the Claude CLI and its
  credential, and any automation the failure guard has switched off — each
  answering with a verdict and its evidence. Read-only by design: guarded
  autonomy starts with self-knowledge that changes nothing, and acting on a
  finding stays a human decision. A probe that itself breaks fails its own
  check rather than the examination.
- **The quota, on screen.** Analytics now shows the subscription's own
  windows as the CLI reports them — the five-hour session window, the weekly
  windows, per-model buckets — each with utilisation, tone escalating toward
  the ceiling, and its reset time; plus the CLI's attribution of what has
  been consuming them, carrying its own caveat (this machine's transcripts
  only). A plan without windows says "does not apply" in words rather than
  rendering nothing.
- **Plugin marketplaces.** The CLI-native plugin store, inside the product:
  add a marketplace by GitHub repo or marketplace.json URL, browse its
  catalogue as the marketplace itself describes it, and enable plugins per
  workspace. The CLI does the fetching and installing itself — the sources
  ride each run's settings at the flag tier, which a cloned repository's own
  settings.json cannot override, and headless installs are narrated in the
  transcript. Disabling a marketplace severs its plugins everywhere at once;
  a plugin orphaned by a removed source stays visible in workspace settings,
  marked, so it can be switched off. Owner-only to add or remove — a
  marketplace is a trust decision about a publisher.
- **Adopt the CLI's own sessions.** The workspace page can now list every
  conversation the Claude CLI holds for that directory — terminal sessions
  included — and adopt one into Metaclaude, after which resuming, steering
  and accounting work as for a native session. Adoption trusts only the CLI's
  own listing: an id the CLI does not name for that directory is refused, so
  a request cannot bind a session from some other directory; and a session
  already adopted is offered as *Open*, never adopted twice.
- **Help, inside the product.** A Help screen fed from the repository rather
  than from strings in the code: the user guide (`docs/guide/`, nine chapters,
  bundled per-chapter as lazy chunks), this changelog, and search that treats
  a two-word query as one question. "Ask Metaclaude about itself" opens a
  plan-mode session in a workspace seeded with the same guide — the assistant
  answers from the pages you are reading, with citations, and can execute
  nothing.
- **Documentation that cannot drift.** The deploy checks now fail when the
  running version has no changelog entry, when the guide names a setting that
  does not exist, or when any documented log line stops existing in the code.

## [0.1.0] — 2026-08-26

The first version deployed to a real server, reachable at a real domain with a
publicly trusted certificate, and driven to green through a full reinstall
rehearsed end to end.

### Added

- **The agentic core.** Sessions with streaming transcripts, tool-call cards,
  permission prompts showing the literal command, plan checklists, inline
  diffs, and per-run cost accounting. Runs are steerable mid-flight: the SDK
  `Query` handle is held, so follow-ups, model switches and clean interrupts
  reach a live run.
- **Ultracode.** Per-message multi-agent orchestration — one toggle in the
  composer fans the message out across sub-agents at maximum effort. Offered
  only when the chosen model reports `xhigh`; never a stored default, never
  chosen by the learner: orchestration multiplies token spend, so only a
  per-message human choice may switch it on.
- **Learning.** Three-kind memory (episodic, semantic, procedural) with hybrid
  retrieval — dense vectors plus BM25 under an absolute relevance floor, fused
  by reciprocal rank. A Thompson-sampling bandit picks model and effort per
  task category; reflexion extracts durable lessons; everything inspectable
  and resettable from Analytics.
- **Rewind.** Any finished run can be undone through the CLI's own file
  checkpointing, with a dry-run preview of exactly which files would change.
- **Agent Plugins 1.0.0.** A conformant loader for the vendor-neutral plugin
  format: skills, agents, MCP servers, per-component isolation, and the
  `.data` reservation honoured.
- **Security.** Argon-free scrypt password hashing, single-use TOTP with QR
  enrolment and recovery codes, race-free second-factor consumption (the
  write is the check), an AES-256-GCM vault for MCP secrets, an append-only
  hash-chained audit log, path jailing with realpath resolution, and a
  workspaces root that may not contain — or be contained by — the data
  directory holding the master key.
- **Deployment.** One-command bootstrap on a hardened host (accounts, sshd,
  ufw with the Docker bypass closed on v4 *and* v6, fail2ban, dead man's
  switch against lockouts). Five TLS modes including a Let's Encrypt staging
  rehearsal so iterating cannot burn the five-per-week quota. CI builds and
  attests the image; deploys are tag-driven, health-gated, and roll back on
  their own. An uninstaller that keeps your data unless told twice not to.
- **Self-checks.** 1,240 tests; 72 deploy assertions that rehearse the
  uninstaller against a real daemon, validate every TLS mode with Caddy
  itself, and verify that every log line the documentation says to grep for
  is one the code still writes.

### Fixed

- A run never ended: streaming input left the SDK generator waiting for a
  close that only arrived at the 45-minute timeout. The test double had been
  ending the stream on its own — more helpful than the SDK it doubled — which
  is how 47 green tests certified a supervisor that hung on every run.
- The proxy leaked one task per healthcheck probe (no reaper as PID 1) and
  read `unhealthy` forever after ~5 hours while serving perfectly. Found on
  the live deployment at 3,643 tasks of a 3,647 ceiling; `init: true`, plus a
  deploy assertion that no probed service ships without a reaper.
- Moving the workspaces root stranded every workspace row at its old path,
  which read as data loss while the files sat untouched. Rows whose directory
  is named after their slug are re-pointed at boot; the rest are reported.
- Two authentication races (concurrent logins sharing one TOTP code or one
  recovery code), a symlink escape past the directory grants, and a lexical
  retrieval gate that admitted the whole corpus when every score was noise.

[0.2.0]: https://github.com/jgouviergmail/Metaclaude/releases/tag/v0.2.0
[0.1.0]: https://github.com/jgouviergmail/Metaclaude/releases/tag/v0.1.0
