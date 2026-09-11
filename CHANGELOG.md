# Changelog

All notable changes to Metaclaude. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). Each entry links the commit that carries the full
story — the commit messages in this repository are written to be read.

This file is part of the product surface: the in-app changelog renders from it,
and Metaclaude maintains it as part of shipping a change (see docs/ROADMAP.md,
"The system that documents itself").

## [Unreleased]

## [0.93.1] — 2026-09-11

### Fixed

- **The browser-check job's ceiling, raised from 20 to 30 minutes.** The
  responsive guard walks every route across viewports, passes and a dialog
  sweep, and it grows with the app: measured on the CI runner, 14m04 at
  0.90.1, 15m37 at 0.92.0 and 18m31 at 0.93.0 — where every step passed and
  the job was cancelled at 20m01, so 0.93.0 was never tagged. A cancelled job
  whose steps are all green and whose duration equals its ceiling is the
  ceiling, not a hand on the button; it now has room for the app it measures.


## [0.93.0] — 2026-09-10

### Fixed

- **The skills a run was given were written on three of the eight paths that
  start one.** `materialiseSkills` writes the workspace's enabled skills to
  `.claude/skills/`, which is the only place the CLI looks for them, and it was
  called from the session route, the board route and the board autopilot. The
  five without it were the scheduler, the steward, the advisor, delegation and
  the MCP gateway — which is to say every run nobody is watching. Those ran
  against whatever the last interactive message had left on disk: a skill
  created in the morning was invisible to that night's automation, and one
  switched off went on being offered to it. A workspace driven only by
  automations never had its skills written at all.

  Nothing reported it, because the run succeeded either way — and
  `run_extension_usages` recorded the skill as *offered and never opened* from
  the database list, which is the sentence the weekly instruction review reads
  and acts on. It would have proposed rewriting a description that was never
  the problem.

  It now happens in `ContextProvider.prepare`, which `execute` calls before
  `resolve` on every run, so a submission path added later cannot forget. Three
  things follow from being on every run rather than on a typed message, and
  each is under test: nothing is written when nothing has moved (a continuous
  automation firing every minute would otherwise delete and rebuild the tree,
  plugin copies included); the fingerprint is not trusted alone, because the
  agent has `Bash` and its own workspace and can remove what it was given; and
  the new tree is built beside the old one and renamed in, since two runs of
  one workspace overlap in ordinary operation and the old shape emptied the
  directory while a CLI was spawning into it.

### Added

- **System → CLI tools: what Claude Code brings, and what this deployment keeps
  of it.** Metaclaude mounted the CLI's whole tool set, and the CLI is written
  for a person at a terminal signed in to claude.ai. Most of it merely costs
  tokens — measured against CLI 2.1.267, the built-ins occupy 23,543 in-window
  tokens on the cached prefix of every run — and three of them reach past the
  deployment entirely: `CronCreate` and its pair schedule recurring work in the
  CLI's own scheduler, outside the Automations screen and outside its quota
  guard, and `Artifact` publishes a web page to claude.ai from inside a run. No
  screen said either was possible.

  Nine are switched off out of the box. Measured: that takes the in-window
  figure to 13,388 and the deferred half from 15,378 to 8,047 — about ten
  thousand tokens off every run, and three doors closed. The screen reports
  whether it is showing that default or a choice, and hands the default back.

  The list is **measured, not written down**: it comes from the CLI's own
  opening frame, because the set is platform-dependent (`PowerShell` on
  Windows against `Bash` elsewhere) and moves with every bump — a screen built
  on a hard-coded list lies the day the CLI changes, with nothing to notice.
  `initializationResult()` reads like the place to ask and carries `commands`,
  `agents` and `models` with no tools on it; the `system/init` frame is the
  only place the CLI says.

  One tool cannot be switched off, and the reason is a measurement rather than
  a policy. `ToolSearch` is how the CLI keeps every other tool's schema — its
  own and every MCP server's — *out* of the prompt until something needs one.
  Refusing it takes the in-window system-tool figure from 23,543 tokens to
  39,045 and loads every MCP schema besides, on every run, announced by
  nothing. It is refused at the form, at the deployment's list, at a
  workspace's own deny list, and again when the stored row is read.

- **The CLI's own skills, governed the way yours are.** The same screen's
  second section lists the seventeen skills the CLI ships inside itself, a
  box each, off unless chosen — the shape the operator asked for once it was
  clear these were not theirs and never had a switch. Nothing is copied: a
  skill you switch on stays the CLI's, with its real body, current with every
  version. Each row shows roughly what carrying it would add to a prompt.

  The measurement forced the shape underneath. `disableBundledSkills` is a
  floor nothing climbs back over: the same session with `skillOverrides:
  { 'code-review': 'on' }` beside it still carried *zero* built-in skills. So
  a deployment that has chosen nothing keeps the one flag — which is the only
  form that also covers a skill a future CLI ships — and a deployment that
  has chosen something switches to naming every known skill one by one. That
  list is written down each time the screen reads the CLI, because a run
  cannot spawn a probe of its own. And `managedSettings` does nothing for
  this key either, exactly as for the flag: measured, both times.

  Measured and not taken, for the record: `user-invocable-only` hides a skill
  from the model while keeping `/name` typable, at zero prompt cost. It works.
  It was left out because a box that means "on" should mean what it means
  for your own skills.

- **A doctor check for the one thing nothing else could see.** The CLI turns
  tool deferral off by itself when `ANTHROPIC_BASE_URL` names a host it does
  not recognise, when the served model is on its unsupported list, or when the
  tool is disallowed — and the only symptom is the bill. `cli-tools` warns when
  `ToolSearch` is no longer among the tools the CLI offers, and says what it
  costs. An empty tool list is reported as "could not be measured" rather than
  as a finding: no CLI offers no tools.

### Changed

- **A workspace offers the skills you gave it, and nothing else.** Claude Code
  ships seventeen skills of its own — `design`, `dataviz`, `update-config`,
  `keybindings-help`, `loop`, `schedule` and the rest — written for a terminal
  and for claude.ai. They were listed in every Metaclaude run's prompt and were
  openable by the agent, describing capabilities this deployment does not have:
  an operator who had switched every one of their own skills off still had
  seventeen, none of them theirs, on a screen that said none. Measured, one
  turn per cell: the skills section falls from 19 skills / 2,040 tokens to 2 /
  32, and the slash-command list from 19 entries to 2.

  The tier was measured too, and the obvious reading of the SDK's own
  documentation is wrong. `disableBundledSkills` is declared on `Settings`, and
  `managedSettings` is where every other policy here rides — where it does
  **nothing at all**, byte for byte the same as sending nothing. Only the flag
  tier bites. Shipped on the documentation rather than the measurement, this
  whole change would have been dead on arrival and looked delivered.

  The catalogue probe carries the same payload, so the composer's slash menu
  cannot outrun the CLI: without it the probe answered 56 commands against a
  run's 38, and the menu offered eighteen the CLI would no longer honour.

- **`scripts/sdk-probe.mjs` records what reaches the prompt.** Four claims the
  above now rests on, none visible from any test: a skill contributes its
  frontmatter and not its body (a 24 kB body measures 3 tokens), a subagent its
  description and not its prompt (an 8 kB prompt measures 28), tool schemas are
  deferred, and `disableBundledSkills` bites in the flag tier and not in the
  managed one. A bump that moves any of them now shows up in the diff instead
  of in the bill.


## [0.92.0] — 2026-09-10

### Added

- **The model and effort of every learning pass, on the Configuration screen.**
  Six rows, one per background pass, each with a model and an effort, and
  independent of every workspace: a workspace's model is what an operator chose
  for the *work*, and these are the machines that read that work afterwards. Up
  to here the model was a constant in the source — `haiku` for the five
  structured passes, the workspace's own for the advisor — which was the right
  default and the wrong arrangement: wanting better judgement on the weekly
  instruction review, or cheaper reflexion on a chatty deployment, was not
  something an operator could say.

  Four decisions in it are worth keeping, because each is a way the obvious
  version is wrong.

  **The sentinel is `auto`, not `default`.** `default` is the CLI's own alias
  and means "whatever the CLI would pick", which on a subscription is Opus.
  Choosing it for the reflexion pass expecting "leave it alone" would move every
  post-run call from Haiku to Opus at roughly thirty times the price, with
  nothing on screen saying so. `auto` is the word the `language` setting already
  uses, and every row states in plain words what it resolves to rather than
  leaving an operator to infer it from two pickers both reading `auto`. The
  picker does not offer `default` at all: two words that read alike and differ
  by thirty times the price is not a choice anyone is well served by making.

  **Absence is not `null`.** A pin is spread into the request; an unpinned value
  is *omitted*, because an absent model lets the call take its own default and
  an absent effort lets the CLI choose for the model it is serving. One helper,
  `pinnedFields`, knows that; five call sites spread it.

  **Every pass reads its setting at the moment of the call.** The call contexts
  are built once at boot, so a captured model would need a restart. The test
  that proves it builds each call once and fires it twice with the setting moved
  in between — and the first version of that test, which rebuilt the factory
  between firings, passed against a deliberately captured policy. A sabotage
  that changes nothing is a test to fix before it is a result to believe.

  **An effort means nothing on a model without the knob.** Haiku has none and a
  level pinned there is silently downgraded — measured — so the screen says to
  change the model first rather than letting an operator believe a control did
  something.

  Two of the five passes had no factory at all: the consolidation and synthesis
  calls were written inline at the wiring site, where nothing could drive them
  without booting a server. They now sit beside their own prompt and schema, as
  the other three do.

- **The instruction review's budget is a setting.** What that weekly pass may
  spend on the texts it reads is money, and the right number depends on how
  many skills a deployment carries — so it belongs on the Configuration screen
  beside the models, not in the source where needing it changed means waiting
  for a release. Read per pass, so a change applies to the next one with no
  restart. Zero is meaningful rather than off: a workspace's own standing
  instructions are kept whatever the budget says, so zero reviews those alone.

- **`fable` wherever a model is chosen.** It was in the bandit's arms and in no
  picker, so the learner could serve a model an operator could not select. A
  test derived from `DEFAULT_ARMS` now refuses that.

### Fixed

- **A review row could name the model that did not judge it.** `revision_reviews`
  records which model read a window, and the value was a constant — so a window
  judged on a pinned model would have been recorded as `haiku`. Read per review
  now, from the same setting the call reads. A column that is wrong reads as an
  answer, which is worse than one that is absent.

- **The structured passes forbade a tool the CLI has never sent.** Their
  belt-and-braces deny list named `Task`; the delegation tool is `Agent` —
  measured, and the fourth place in the repository where that four-release-old
  naming defect was still standing. Harmless here, since these calls offer no
  tools at all, and now correct.

### Security

- **A workspace could propose — and on accept, apply — a rewrite of another
  workspace's instructions.** `advisor_propose_revision` is mounted into
  ordinary runs and takes a target **id** straight from a model's arguments,
  while the surface that resolves ids looks records up by id alone. Nothing
  tied the two together, so a run in one workspace could name another's skill,
  or another's standing prompt, file the card under itself, and rewrite it the
  moment an operator pressed Apply. Revisions are the one proposal kind that
  takes effect on accept, which is what made this the worst reachable defect in
  the feature.

  `mayRevise` is the boundary, and where it asks its question was measured
  rather than assumed: reach lives in `is_global` and a join table, while
  `skills.workspace_id` records only who created the row and an operator may
  widen a skill's reach later. A rule comparing that column — the obvious one,
  and the one written first — would have refused a skill they had deliberately
  shared. So the question is asked of the *same listing a run of that workspace
  is given*, which cannot drift from what the workspace actually runs under
  because it is that query. A target outside it is answered as not found.

### Fixed (found in review)

- **The card warned that every skill revision reaches every workspace.** The
  payload's `target.workspaceId` drives that warning and was taken from the
  caller, which passed a constant `null` — so the warning was on for every
  skill, subagent and automation revision ever proposed, including ones
  confined to one workspace. Read from the record's own reach now, the way the
  target's *name* already was. A warning that is always on is a warning nobody
  reads.

- **The arbiter's prompt had no budget for the instruction texts.** Each text
  was capped; the number of them was not. A deployment with forty skills would
  have sent about a hundred thousand tokens on top of the window, every week,
  per workspace — and past the model's context, a pass that fails for good with
  nothing on screen but a row saying the call died. `TARGETS_MAX_CHARS` bounds
  the section, the workspace's own instructions are never what is dropped, and
  the prompt says how many texts it is not showing. The budget is applied where
  the list is born rather than where the prompt is built, because that same
  list is what a revision's index is resolved against.

- **A second, coarser lock on the review route refused every other workspace.**
  The reviewer already holds one per workspace and says in its own source that
  the guard lives there because the route is only one of two doors; the route
  kept a global boolean beside it, so a review of one workspace answered 409
  for all the others for the length of a model call, protecting nothing — two
  workspaces read disjoint runs and propose against disjoint texts. The route
  asks the reviewer now.

- **Two field definitions had drifted into an unrelated checklist** in the
  arbiter's system prompt, where they read as further conditions to satisfy
  before proposing an edit to an unused extension. Moved back beside the other
  two. Character-neutral, and the bench is unchanged at 2/2 caught and no
  over-reactions.

- **The dashboard's revision cards were three buttons all called "Apply".**
  The generic proposal rows beside them name theirs after the proposal for
  exactly that reason. Named now, with the visible label inside the accessible
  name rather than replaced by it.

- **A large diff rendered as the word "truncated" and nothing else.** The line
  budget was checked *before* a hunk was emitted, so a hunk bigger than the
  whole budget was skipped entire — and the operator's card, whose entire
  premise is that they approve the text rather than a description of it, showed
  them the description. It even said "open the target to read the rest", where
  the target holds the text being replaced. Oversized hunks are cut now, the
  header counts only the lines actually shown, and the notice no longer sends
  anyone to the wrong text.

- **A wholesale replacement could be filed through the tool.** The review pass
  has refused one since the first day — an edit, not a rewrite, above six lines
  and two fifths of the larger side. `advisor_propose_revision`, mounted into
  ordinary runs, was told the same thing in prose and held to it by nothing,
  and prose is not a rule: what it produced was a card whose diff is a wall of
  green nobody can read, which is the outcome the rule exists to prevent. The
  rule moved to `learning/revision.ts` beside the read and the write, and both
  doors now enforce the one definition.

- **A payload guard asked `in` where it meant `hasOwn`.** `kind in
  TARGET_LABELS` walks the prototype chain, so `constructor` and `toString`
  answer true and the label the card would then render is a function, which
  React throws on. Unreachable through the server, which validates the payload
  on write — and a guard's whole job is to be the last line.


## [0.91.0] — 2026-09-10

### Added

- **The instructions review themselves — a fourth learning loop.** Memory
  changes what a run is told, the bandit what serves it, reflexion what is
  remembered. None of the three ever touched the *instructions*: a workspace's
  standing prompt, a skill's description, a subagent's prompt, an automation's
  script, all written once and then left alone however often the runs showed one
  of them to be wrong.

  What forced it was a measurement on this deployment: sixty-three runs in eight
  days, **no failures at all**, two rated by the operator — and five skills and
  five subagents enabled with **zero invocations between them** in a hundred and
  seventy-three tool calls. "What is not working" was not in any status column,
  and the largest defect on the deployment was that ten extensions were carried
  into every run, paid for in every prompt, and never used.

  Nothing could see it either. `skills.use_count` was rendered on two screens and
  incremented by no code path in the repository, so it read zero whether a skill
  was working perfectly or had never been opened — the `rewindPoint` family of
  defect, a surface with no source.

  So: `run_extension_usages` records what each run was offered and what it
  reached for, at the end of every run and outside every workspace switch,
  because whether a skill was opened is a fact rather than an opinion. Once a
  week per workspace (opt-in, off by default) a pass reads the runs since the
  last one, **counts the recurrences in code** — three runs on two distinct days,
  twelve for an unused extension — and puts the counted facts to one cheap
  tool-less model call, which proposes at most three *edits*. Every proposal
  lands in the advisor's existing inbox with its diff and the runs behind it as
  links; nothing is applied until an operator presses Apply, and every applied
  revision keeps an undo. At the next pass the same measurement is repeated over
  the runs that followed, and the card says whether the problem came back.

  Four things about it are worth stating because each was a decision:

  - **The bar is arithmetic, and it is in code.** Asking a model to notice that
    something happened three times is asking it to count. The memory gate
    measured that four rules had to sit *after* the model; these are the same
    four in another key — cite a finding whose runs this window actually holds
    and which names at least three of them, not one already refused, not a text
    shown in part, not the text that is already there, and not a rewrite.
  - **A revision is the one proposal Metaclaude may not accept.** Every other
    kind lands *disabled*, so accepting is nearly free; a revision is in force on
    the very next run, including runs nobody is watching. The steward may dismiss
    one and say what it thinks, and that is all.
  - **The unused-extension bar is a blunt count on purpose.** The obvious
    refinement — score relevance by cosine between description and prompt — was
    written and rejected: every floor in `retrieval.ts` is a measurement *of
    retrieval*, and one reused for an unmeasured question would mean two
    different things on two deployments, since the hashing family carries no
    meaning at all.
  - **Every pass leaves a row**, proposed or not, with what the rules refused and
    why. Without it, "nothing needed changing", "the window was not ready" and
    "the call died" are the same empty screen — which is exactly what
    `runs.reflected_at` was added to fix, at the cost of a day of lost memory.

  `scripts/eval-instruction-review.mjs` replays ten labelled windows, eight of
  which should produce nothing at all, and refuses a prompt change whose worst
  pass over-reacts more than once. It is also a lesson in its own right: at
  three passes two materially different prompts were indistinguishable and a
  sabotage moved nothing, and only at five did the difference appear — five
  over-reactions and a miss against one and none. A measure that reads the same
  under sabotage is a measure to strengthen before it is a result to believe.

### Fixed

- **The delegation tool is called `Agent`, and this repository said `Task` in
  three places for four releases.** Measured against Claude Code twice — once
  from a harness and once with every `CLAUDE_CODE_*` variable stripped, because
  one observation identifies a difference and never its cause — and the name was
  `Agent` both times, with `{description, subagent_type, prompt}`. The SDK
  agrees: its union declares `AgentInput` and has never had a `TaskInput`.

  Nothing failed, which is why it survived: the permission card fell through to
  its generic branch and printed `Agent{"description":…}` where it meant to say
  "Delegate to a subagent", the transcript showed a raw tool name where it meant
  to say "Subagent", and every delegation ever made went uncounted. A skill call
  had the same problem for the opposite reason — the SDK declares no input type
  for `Skill` at all, so its one field had to be measured: `{skill: "<name>"}`.
  Both names now live in `packages/shared` with the date and the method beside
  them, both are labelled on the card and in the transcript, and
  `scripts/sdk-probe.mjs` records them so an SDK bump cannot move them quietly.

- **`skills.use_count` is a real number.** It was shown on the skills list and in
  the steward's library projection, and written by nothing at all.

### Changed

- `deploy/ratchets.json` raises `initialJsGzipKb` from 196 to 197, deliberately.
  The Dashboard gained a second query, a revert mutation and a folded section of
  applied revisions, and that is the kilobyte. What is *not* in it is the diff
  renderer and the revision card itself: written statically they cost five, and
  they now load on demand behind an `import()` boundary — most dashboards have
  no revision to draw, and a phone should not fetch a diff viewer to reach one.
  The schemas travelled the same road: parsed in the browser they pulled the
  whole of `api-contracts.ts` into the entry graph, so the card reads the
  payload through a two-line guard instead, and the server keeps the two
  validations it already had.

## [0.90.1] — 2026-09-10

### Fixed

- **The settings chapter described a layout two moves out of date.** Asked
  whether the documentation was aligned, it was not, and `check.sh` could not
  have said so: it verifies "Settings → X" citations against the screens that
  exist, and every one of those was correct. What had drifted was the prose
  *around* them — the part that says where a thing lives and why.

  Six claims, all in the settings chapter. The Server screen was "the first of
  the System section, not a settings group" (it has led Settings for three
  releases) and shown as carrying "the Claude CLI's state" (that moved to
  Connections). Connections "started with Google" (it starts with Claude).
  Analytics was described nowhere as a settings screen at all, though it moved
  there two releases ago. And the doctor's countdown was explained as the CLI
  sign-in's, when it follows whichever credential is in force — a paired token
  standing in front of a sign-in is the case an owner is most likely to be in,
  and the chapter did not mention it.

  A citation check catches a dangling link; nothing catches a paragraph that
  describes the app it used to be. The remedy is to read the chapter after
  moving a screen, and this entry is the reminder that it has to happen in the
  same session — the alternative is exactly what happened here, three moves
  landing before anyone re-read the page describing them.


## [0.90.0] — 2026-09-10

### Changed

- **The Agent SDK moves to 0.3.267, which brings Claude CLI 2.1.267.** Shipped
  alone, as `docs/SDK-UPGRADE.md` requires, and measured rather than assumed.
  The static guards said nothing: the typecheck passed, the narrator's
  message-union guard passed, and 4,152 tests passed. The probe found three
  behavioural changes, all of them the same one seen from three angles.

  **The `snapshot` default inverted.** Before, passing an `append` turned
  recording off and the text was applied fresh on every launch. Now, omitting
  `snapshot` records the prompt on the conversation's first request and every
  later request and `resume` replays that record — "a different `append` passed
  on a later launch of the same session is ignored until compaction or a new
  session", in the SDK's own words. Metaclaude's append carries the language
  directive, the workspace conventions and the standing memory shelf, so the
  silent version of this bump is an operator changing one of those and watching
  an open session go on ignoring it. Nothing would have failed; the feature
  would simply have stopped working.

  The decisions, one per measured change:

  | measured | decision |
  |---|---|
  | `resumeAppend.reappliedOnResume` true → false | neutralised — `supervisor.ts` now states `snapshot: false` |
  | `resumeAppend.accumulates` false → true | same cause, same fix |
  | `appendCacheCost.prefixRewrittenOnChange` true → false | same cause; the prefix cost it saves is already avoided by keeping per-message context in `contextPreamble` |

  Re-measured with the setting stated: `reappliedOnResume` true,
  `accumulates` false — exactly the previous version's behaviour. The probe
  gained `resumeAppendUnsnapshotted` so the two are tracked apart from now on;
  measuring only the default would let a future bump answer for a setting
  nobody passes.

  Two probes could not run: the quota refusal and the CLI's own fallback need a
  genuinely spent model. Unknown, not unchanged.


## [0.89.2] — 2026-09-09

### Fixed

- **The image carried two Claude CLIs, and reported the one that ran nothing.**
  Measured in production: 2.1.247 on the PATH, 2.1.263 under the Agent SDK, in
  the same container. The SDK vendors a binary per platform and spawns *that*
  unless `pathToClaudeCodeExecutable` says otherwise — nothing sets it — so
  every run went through the second while the Dockerfile installed the first
  globally at its own pinned version. Everything that reads a CLI version read
  the wrong one: the credentials card, the doctor's line, and the update badge,
  which was comparing a binary nobody used against the registry and announcing
  a release that would not have changed anything.

  Nothing could see it. Both numbers are real versions of the same product, and
  no test can spawn a subprocess to find out which one answered.

  `/usr/local/bin/claude` is now a link to the binary the SDK spawns, resolved
  at build time and refused if there is not exactly one candidate — a `head -1`
  over two would pick by directory order and hide the ambiguity this removes.
  One version by construction, `docker compose exec app claude setup-token`
  reaching the same CLI the agent does, and about 240 MB of image back. Two
  assertions in `check.sh` stop the second install returning.


## [0.89.1] — 2026-09-09

### Fixed

- **Two module headers described the app of two releases ago.** The System
  strip's own comment still announced five screens and claimed the machine led
  it — the machine left for Settings three releases back, and Analytics has now
  followed. Nobody sees these but the next person to read the code, which is
  exactly who a wrong explanation costs the most: the prose was the only place
  saying *why* a screen belongs to a section, and it was arguing for a layout
  that no longer exists.

- **Two stale screen references outside the guide.** The deployment notes sent
  a reader to "System → Server → Doctor" and the SDK upgrade notes to
  "Settings → System", both for screens that had moved. `check.sh` covers the
  guide and the README and stops there, on purpose — four of the seven
  citations in the wider docs are a *phone's* settings app, and a check that
  indicts "Settings → General" is the grep-cannot-tell-code-from-prose trap.
  Widening it was measured and rejected; the reasoning now sits beside the
  check so the next person knows the scope is a decision rather than an
  oversight.


## [0.89.0] — 2026-09-09

### Changed

- **Analytics moved from System to Settings, second, behind the machine.** The
  System strip is what the deployment *does* — automations, agents, plugins —
  and consumption is not a capability. It belongs beside the box that ran the
  work and the bill it ran up, both of which are read deliberately rather than
  passed through. The URL is untouched, so every bookmark and link still lands;
  what follows the move is which rail entry lights up when they do, and a test
  derives that from the shared list rather than restating today's answer.

- **The Claude CLI reading and its credential moved to Settings → Connections,
  above Google.** They sat three sections apart on the Server screen, under a
  heading about the machine — and neither describes the machine. They describe
  the connection without which nothing else on that screen matters, so they
  lead the group that holds everything this deployment authenticates against:
  the reading first, the control that changes it under it, then the rest.

  Everything that pointed at them followed, which is the part that fails
  silently: the onboarding checklist's first step, the dashboard's
  unauthenticated banner, the quota panel's explanation, the boot warning, the
  guide and the README. The checklist and the banner now derive their
  destination from one place and are pinned by tests, because that banner has
  named the wrong screen twice already.

  One consequence worth stating plainly: the Connections group is owner-only,
  so an operator no longer sees the CLI version or which credential is in
  force. They could not change either — every route behind those cards already
  required an owner — but they could read them, and now they cannot.


## [0.88.2] — 2026-09-09

### Fixed

- **The doctor raised the alarm about a credential nobody was using.** Its
  credential check read the CLI store's sign-in date whatever was actually in
  force, so an owner running on a paired token — with an old account sign-in
  sitting expired behind it — was told "every run will fail to authenticate"
  while every run worked. The same untruth as the countdown fixed two releases
  ago, from the other side: one reassured about the wrong credential, this one
  alarmed about it.

  The check now takes the end of whatever applies, which is the field that
  exists for exactly this and which the credential service already computes.
  A shadowed sign-in still expires, and the credentials card says so on the
  line that is about it; that is information, not a fault, and the doctor
  reports faults.

- **The boot log said "credential in force" over a date that was not.** Same
  confusion, one layer down: the line logged the CLI store's sign-in end
  whatever was actually resolved. It now logs both, each named for what it is.

- **The quota panel told an owner to do something the app now does.** Its
  explanation for a paired token ended "sign the container in to the account",
  which was the only way when it was written and is a button today. Same sweep,
  same shape: prose describing a world one release out of date.

- **The boot warning sent an owner to a screen that had moved.** "Pair one from
  Settings → System" — the machine left that section three releases ago, and
  nothing checks the destinations inside log messages the way `check.sh` checks
  the ones in the guide. It now names Settings → Server, and mentions signing
  in as well as pairing, which is the point of this release.


## [0.88.1] — 2026-09-09

### Fixed

- **Every countdown in the app read "just now".** `formatRelative` answers "how
  long since", and says so in its own code: a timestamp in the future is a
  clock disagreement, not a prediction, so its first branch catches every
  negative delta. Four call sites were asking the opposite question. The
  credential countdown shipped the day before read "just now" whether the token
  had four days or a year left — the feature was dead on arrival — and the
  automations list said the next run was "just now" for every schedule on it,
  which it had been doing for far longer. Nothing could see it: both are
  perfectly plausible sentences, and no test asserted the *value*.

  `formatUntil` is the other direction, same scale, same fall back to an
  absolute date. Its test pins the defect as well as the fix, so the two
  functions cannot quietly swap again.

- **A shadowed sign-in expired with nothing on screen about it.** The countdown
  follows the credential in force, which is the fix this area came from — but
  an account sign-in standing behind a paired token still runs out on its own
  fixed date, and the owner would have found out on the day they dropped the
  token and discovered nothing behind it. The line that is *about* that other
  credential now carries its end date. Absent stays absent: a store with no
  such field says nothing rather than inventing one.


## [0.88.0] — 2026-09-09

### Added

- **The Claude account sign-in can be renewed from the application.** It was
  the one credential that still needed a shell. An account sign-in is
  fixed-term — measured on this deployment, thirty days, and the date does not
  move with use — so every few weeks the only way to keep plan quota, claude.ai
  session sync and account MCP servers was `docker compose exec app claude auth
  login` over SSH, on a system whose whole point is being operated from a
  phone. The owner's answer to that was to pair a setup token instead, which
  runs work perfectly and silently gives up all three.

  Settings → Claude credentials now offers both, fuller one first. **Sign in to
  a Claude account** runs the same OAuth flow `claude auth login` runs — same
  public client, same manual paste-back redirect, same six scopes, all read out
  of the CLI binary the image ships rather than guessed — and installs the
  result in the CLI's own credentials store, where the CLI refreshes it by
  itself. The manual redirect is not a lesser path: the CLI builds both links
  on every sign-in and offers whichever fits, and this server can never be the
  localhost a browser reaches.

  What is written is never invented. A grant that comes back without
  `user:sessions:claude_code` is refused rather than installed — it is an
  inference token, and writing it would *end* the sign-in it was meant to renew
  — every key in the file this code does not recognise is left untouched, and
  the write is read back afterwards to confirm the CLI did not rewrite the file
  in the same instant. Losing that race says so; it does not report success.

- **A one-tap way out of the shadowing.** A token Metaclaude injects overrides
  the account sign-in, so renewing while a token is paired changes nothing an
  owner can see. The card already said that and left them to work out that the
  ominous **Remove** button below was, in this case, the upgrade. It now offers
  **Use the account sign-in** beside the sentence, and the confirmation for
  removing a credential stops warning about runs failing when there is a
  sign-in waiting to take over.

### Fixed

- **`CLAUDE_CONFIG_DIR` reached the reader and not the CLI.** The status screen
  honoured it; the CLI child was never told, so on a machine that sets it the
  interface described one file while runs authenticated from another. Harmless
  while the file was only read, and not harmless at all once a renewal writes
  — a sign-in installed where nothing looks for it, under a message saying it
  worked. It is now forwarded. Forwarded rather than computed: imposing a
  value was written first and measured, and the end-to-end gateway check went
  red on the first run because the child then inherited a different settings
  directory. No deployment sets the variable, so in the container all three
  read the same path either way.


## [0.87.1] — 2026-09-09

### Fixed

- **The quota screen told an owner they were on an API key when they were
  not.** Reported from use, and measured on the deployment: a Claude
  subscription had just been paired, the panel said "this credential is an API
  key or a third-party provider", and the credential screen two clicks away
  said the opposite. One sentence was asserting one cause for a state that has
  three — and it was the wrong one for the case that actually happens.

  A token from `claude setup-token` asks for `user:inference` and nothing else.
  It can run work and cannot read consumption, so the CLI reports no plan
  windows for it. That is a *scope*, not a billing arrangement; the
  subscription is billed exactly as before. The panel now takes the credential
  in force and names it — the paired token, the API key — and when it does not
  know, it says what was observed and names the possibilities rather than
  picking one.

- **The countdown belonged to a credential that was no longer being used.**
  The card read the CLI sign-in's end whether or not the sign-in applied, so
  pairing a token left an owner watching a date about the credential their
  pairing had just shadowed — while the token they were actually running on,
  which expires in a year, was tracked by nothing at all. Reassurance about the
  wrong thing is worse than no date.

  `ClaudeCredentialStatus.expiresAt` is now the end of whatever is in force,
  and the sentence follows the source: a sign-in is renewed by signing in
  again, a paired token by pairing again. The date comes from the token
  response that minted it rather than from the lifetime that was requested —
  a grant is the grantor's to shorten, and putting the ask on screen would be
  a countdown the credential does not honour.

## [0.87.0] — 2026-09-09

### Changed

- **The Server screen leads Settings.** It has been in three places: a tab
  inside Settings, then a screen of its own in the System strip on the
  reasoning that nothing there is a preference, and now back into Settings as
  its first entry. What an operator opens Settings *for* is "how is this
  deployment set up", and the machine it runs on is the first thing that
  answers; the System strip beside it lists what the deployment can *do*.

  **The path did not change**, and that is what keeps the move cheap: the
  onboarding cards, the command palette, the Dashboard's pairing link and the
  push notifications all build `/server` from the shared contract, so every
  one of them still lands where it meant to. What moved is which strip the
  screen carries, which rail entry lights up, and where each rail entry sends
  you — System now opens on Automations, Settings on Server.

  `SETTINGS_SECTION_PATHS` is new and is why the rail can still tell: two of
  the section's three paths are not under `/settings`, so the prefix test that
  used to answer this would have said no while the operator stood on the
  screen. Its twin has existed for the System section since that strip was
  built.

### Added

- **The review queue is on the Dashboard, under the digest.** "Recently
  learned" said what the reflexion pass had proposed and offered no way to
  answer it: every decision cost a trip to the Memory page, which is how a
  proposal to fold three memories together sits unanswered for weeks. The
  queue now sits below it with its verbs attached — accept, reject, and a
  consolidation's own merge — capped at three so the Dashboard stays a
  digest, with a link to the rest.

  It shares one card with the Memory page rather than growing a second copy:
  the insight card was two hundred lines of JSX inside that page, and this
  repository has watched two copies of a component diverge by the one class
  that mattered. `InsightCard` is now the single one, and `readDecisions`
  moved to the shared library so neither page imports from the other.

  The two sections deliberately overlap: both read what is awaiting review,
  one as a fact to glance at and one as a question to answer — so a pending
  lesson appears twice, while a consolidation appears only in the queue,
  which the digest filters out. A test pins that so it stays a decision rather
  than something nobody noticed.

  It costs 3 kB gzipped on the first load — the Dashboard is the entry chunk,
  so the two cards move into it. Measured: 1 kB of that is the consolidation
  card, which is not enough to be worth a lazy boundary and its flicker on the
  screen the operator opens first.

## [0.86.0] — 2026-09-09

### Changed

- **A call arriving by MCP is now answered the way the interface answers.** A
  token says which workspace an application may knock at; behind that door the
  agent works under that workspace's own settings, with the same tools a run
  you started there would get. Two rules withheld those tools from gateway
  runs, each on the reasoning that a token's scope must not be one prompt away
  from being bypassed — and what that produced, measured in production, was an
  agent unable to answer a question this deployment held the answer to. Asked
  for a fact recorded as a pinned note in the next workspace, it called **no
  tool at all**, because it had none to call, and reported that Metaclaude did
  not know. It also claimed to have consulted `system_overview`, which was
  never mounted for it: a briefing naming tools that are not there does not
  produce a refusal, it produces a fluent account of a search that never
  happened.

  What still bounds such a run is its **ceiling**, and it bounded only the
  first hop. A token capped at *Run what is already allowed* could have reached
  a workspace set to *Run and edit files* by asking one agent to consult
  another. The ceiling is now recorded on the run and re-applied against the
  target's own mode every time a run starts another — which is also what stops
  a target left on *Ask* opening an approval card with nobody in the room.

### Added

- **Searching a neighbour, before making it work.** Delegation was the only way
  to reach another workspace and it costs a full run there — measured at $0.34
  and several minutes — while the question was usually a fact that workspace
  had already written down. `search_workspaces` reads the notes and reference
  documents of the workspaces this one may consult, executes nothing, calls no
  model, and answers at once. It needs no tick: like the workspace's own memory
  search it is pre-approved with its own mount, because under *Don't ask*
  anything unticked is refused without ever reaching a person — which is how an
  automation ends up carrying a lookup tool it can never use while still
  landing as a success. *Delegate* stays a tick: it spends another workspace's
  quota.

- **`search_notes` reads the agent's notes too, and no longer asks where to
  look.** The gateway's read tool covered the document library alone, so the
  fact behind the whole release was unreachable through it whatever the grant.
  It now returns both, each result saying which it is — a passage is a
  quotation you can attribute to a page, a note is something an agent concluded
  and may be out of date — and naming a workspace became optional: omit it and
  the search covers everything the token reaches. A calling program has no way
  of knowing where you filed a fact, and should not need one.

- **The steward can search the knowledge library** (`system_knowledge_search`).
  It could read every memory in the deployment and no document at all, while
  the interface has offered a library search since the library shipped.

- **`check:e2e` asks a gateway run for a fact only another workspace holds.**
  No unit test can answer the question that matters here — whether the model
  *reaches for* the tool — so the check drives a real run through the Claude
  CLI and then reads the transcript for the call. Measured on a live run: it
  answered in nine seconds and got there through `search_workspaces`, the free
  one, rather than by spending a delegation.

### Fixed

- **The peer directory kept the operator's budget by three characters per
  entry.** The separator between a slug and its description was counted
  nowhere: 3063 characters against a budget of 3000 at twenty-seven
  workspaces. The test that watched the budget used a case where descriptions
  are dropped, so the separator was never written and the bound it proved was
  one that did not hold.

- **A passage was labelled with the workspace a document was first filed in.**
  A memory belongs to exactly one tier, so naming its workspace is a fact; a
  document can reach several at once, and the field that looked like it
  answered is the record of where it was *first* filed — which a later change
  of reach leaves behind. A passage now names its document, its section and its
  page, which is what attribution needs, and carries no workspace at all.

- **The `Delegations` session never rotated.** The gateway's standing session
  and the steward's both open a fresh one past an event ceiling, because a
  session nobody closes grows its context every day; delegation had a third
  copy of that rule which only checked whether a run was in flight — so the one
  session that accumulates a *second* workspace's context on every question was
  the only one that never rotated. The three are one rule now.

## [0.85.0] — 2026-09-09

### Added

- **A run can read the other sessions of its own workspace.** Three read-only
  tools — `session_list`, `session_read`, `run_result` — so "use the data from
  the session about the API" or "what did we conclude last week" is something
  you can simply ask for, and an automation can be written to work from a
  session you point it at. `session_list` matches titles ignoring case and
  accents, because *Évaluation* has to be findable typed `evaluation`;
  `session_read` takes a window, so "the last seven days" is one argument
  rather than everything.

  Measured end to end on a live server: a run in one session was asked for a
  figure that existed only in another, called `session_list` then
  `session_read`, and answered with it — under `dontAsk`, which is what proves
  the pre-approval. Without it the CLI refuses anything not pre-approved
  without ever reaching the broker, and these would have been mounted and
  unusable in exactly the runs they are for.

  Pull, not push, deliberately. Injecting other sessions into every run would
  cost tens of thousands of tokens a turn for content that mostly does not
  concern the question — one session here holds 36 kB of dialogue and one busy
  day 120 kB of events — and anything per-message in the system prompt rewrites
  the cached prefix, measured at a factor of seventy on tokens written to
  cache. What should cross sessions unasked already does: memory distils it
  after each run. These carry the verbatim record, for what the caller names.

- **A chained automation is told what the one before it answered.** The
  preamble carried the outcome and not a word of the content, so "deploy what
  the tests approved" was a chain in name only. It now opens with the upstream's
  final answer, bounded to 2 000 characters — ten of the twelve most recent runs
  here answered in under 1.5 kB — with the run and session ids beside it, so a
  longer answer stays one `run_result` away rather than being silently reduced
  to the part that fit. Verified on a live server: the downstream quoted the
  upstream's figure without calling a tool, because the answer was already
  there.

### Security

- **The sessions tools are fenced to the workspace.** Every id resolves inside
  the run's own workspace, and a session belonging to another answers exactly
  as one that does not exist — a distinct refusal would let one workspace's
  agent enumerate another's ids one guess at a time.

  **A token that names a workspace now grants reading what was said in it.**
  That follows the standing rule for the gateway — the token says which door an
  application may knock at, and behind that door Metaclaude behaves as it does
  from the interface — so an application granted a workspace can read its
  sessions within the token's ceiling. Issue a token for the workspace whose
  conversations the application may see.

  A **delegated** run is the exclusion: it is another workspace's agent and its
  answer travels back there, so a question phrased to extract would come home
  with the verbatim record attached. Being consultable is not being readable.
  See docs/SECURITY.md, *Reading other sessions*.

### Changed

- **`TranscriptRepo.bySession` takes a time window, applied in SQL.** Filtering
  after the 2 000-event cap would answer "the last seven days" with whatever
  survived a cap that knew nothing about days — on a long session, silently the
  wrong answer rather than a slow one. Same family as capping a directory
  before sorting it.

- **The MCP prefix is stripped by the shared parser, in all seven places that
  were still doing it by hand.** `splitToolName` was written against exactly
  this — its own comment says the predecessor `/^mcp__[^_]+__/` stops at the
  first underscore — and was then applied nowhere: seven copies of that regex
  remained, in the approval card's risk assessment, its one-line summary, the
  grant key and the transcript card. Every in-process server Metaclaude mounts
  is named with an underscore (`metaclaude_memory`, `metaclaude_board`, and now
  `metaclaude_sessions`), so all of them fell through: the transcript showed
  the raw `mcp__metaclaude_memory__memory_search` where it meant a sentence,
  and a read-only tool from a server an operator called `my_server` was rated
  *medium* instead of *low*. Measured before fixing, not assumed. A primitive
  written against a defect and not applied leaves the defect *and* the
  impression of having fixed it.

- **A run with nothing watching it no longer has its transcript read.** Every
  finished run reaches the scheduler's event hook and most have no watcher, so
  composing the answer before checking loaded and parsed a whole run's events
  for a sentence nobody received.

- **Reading a transcript back as prose is one definition, not three.**
  `kernel/transcript-view.ts` holds what the steward's `system_run` had inline:
  the final answer (the last *completed* block — a streaming one is half a
  sentence that reads as finished), the tools called, and the dialogue with a
  character budget that keeps the end and *says* it truncated. The sessions
  tools and the chained preamble ask the same questions of the same events;
  written a second time they would have diverged, and an agent handed a
  silently cut conversation reasons about a conversation that did not happen.

## [0.84.0] — 2026-09-09

### Added

- **An automation can now wait for another one to finish.** An event trigger
  chooses between two populations of runs: the ones a person, a token or a
  delegation started — the only thing it could watch until now — or the end of
  automations you tick by name. That makes a chain expressible for the first
  time (tests, then deploy, then the report), and the form offers the
  workspace's automations rather than asking for ids.

  What stood in the way was a deliberate guard: `onRunFinished` refused every
  run an automation produced, because two watchers of failures whose firings
  can fail feed each other forever. The refusal moves to where the edges are
  now declared — a trigger that would close a loop is rejected at create and at
  update, with the path it found, and the form does not offer the tick at all.
  Structural rather than conditional: a paused link is still an edge, since
  resuming it revalidates nothing.

  Which automation a run *belongs to* is its session, which is what
  `recordOutcome` has always read — so **Run now** on a source triggers what
  waits on it, exactly as its schedule would. One rule, no exception: the
  button stays on every row, including watchers, and now says what it will do.
  A watcher fired by hand is told there is no triggering run to react to,
  rather than left to invent one.

  The two modes are exclusive, filter included: a firing's prompt is the
  automation's own, so a filter over it would either always match or silently
  never — a watcher that looks configured and is dead.

- **The filter field says what can go in it.** It is matched against a run's
  category or prompt, and the categories are English identifiers the classifier
  assigns; a French screen asking for one unnamed is asking for a filter that
  matches nothing. `TASK_CATEGORIES` moved to `packages/shared` — it is what
  `Run.category` holds, so both sides are entitled to it — and the form lists
  the thirteen.

### Fixed

- **A list of ids in JSON is a foreign key nothing enforces.** Deleting or
  moving an automation now removes it from every trigger that named it, in the
  same transaction. The watcher is left with an empty list and *says* so —
  "watches nothing since its source went away" on the list, a refused save in
  the editor until a source is ticked or the mode is changed — where falling
  back to the absent-list meaning would silently turn a chain link into a
  watcher of everybody's runs. Same family as the gateway token that went on
  naming a deleted workspace.

- **`update` validated the trigger only when the patch named it**, which was
  enough while a trigger meant a cron expression, and wrong for one that names
  automations: sources are resolved inside a workspace, so a move carrying them
  would leave a watcher enabled and permanently mute. A move revalidates
  against the destination, and the family propagation drops such a trigger
  instead of failing the copy — the operator's own save lands, the copies keep
  theirs.

- **A clock on everything that was not continuous.** The trigger icon was a
  ternary over one field, so a manual runbook and — once watchers could name
  their sources — a row whose own summary reads *after Tests de nuit succeeds*
  both showed a schedule's clock, the picture contradicting the sentence under
  it. One icon per kind, from an exhaustive `Record` that fails the build when
  a kind is added, the way `INSIGHT_TONE` does on the Memory screen.

- **Three confirmation titles and one chart label were English on a French
  screen.** `` title={`Delete "${name}"?`} `` is a template literal, and all
  three i18n measures look for a translated *call* — so the automations dialog,
  the workspaces dialog and the posterior curve's accessible name had never
  been translated and nothing could see it. Found by reading the rendered
  dialog rather than the source. The new `templateCopyProps` ratchet closes the
  shape: it read **1** on its first run, naming a site nobody knew about, and
  it does not indict a template that carries no prose.

- **The trigger picker's buttons were 32px under a thumb.** Raised to 44 on a
  coarse pointer by the box rather than by an inset pseudo-element: these sit a
  `gap-1.5` apart, and opposing vertical hit areas would have overlapped by
  exactly that gap, the lower button quietly taking presses meant for the one
  above. The event block is also set off by a rule down its left — it asks two
  further questions, and flush left they read as six choices at one level
  rather than two.

## [0.83.3] — 2026-09-08

### Fixed

- **Four titled blocks were still drawn by hand, so they alone had no
  frame.** `Section` encloses every titled block since the aesthetic pass —
  the tinted band, the border, the radius — and *Insights awaiting review*,
  *Knowledge library* and both groups on Plugins were written as a bare
  `<section>` with an `<h2>` above it, from before the primitive existed. On
  the Memory screen the difference sits one block below *Stored memories*,
  which is enclosed: the eye reads the unframed pair as unfinished, and an
  operator reported exactly that. The `boxedSections` ratchet could not see
  it — it counts a titled group boxed in a `Card`, and these were in neither.

## [0.83.2] — 2026-09-08

### Fixed

- **The only way into the library without a mouse was too small to press.** In
  the drop zone, *choose them* is a link inside a sentence, so it is as tall as
  its line and no more: measured in a real browser at 16px of hit area against
  a floor of 32, in both languages. Anyone who cannot drag a file — which is
  everyone on a phone — had a 16px target for the one control that opens the
  file picker.

## [0.83.1] — 2026-09-08

### Fixed

- **The loser of an upload race deleted the winner's file.** Two uploads of one
  document both pass the duplicate check — it is a read, not a lock — and the
  unique index refuses the second row, correctly, with the 409 it already had.
  Its cleanup then removed the file *by hash*: the original the surviving
  document had just been given. Measured end to end, the survivor's download
  answered 404. Two tabs, or one impatient double click.

- **Writing the same original twice at once failed with ENOENT.** Both writes
  shared one `.part` name, so the first rename moved it out from under the
  others — two failures in six concurrent writes, measured. Each write gets a
  name of its own, and a file already at its content-addressed name is left
  alone rather than rewritten.

- **A second file dropped while one was uploading started its own queue.** The
  drop zone sequenced the files of a single drop and nothing else, so a second
  drop opened a loop beside the first and whichever finished declared the queue
  idle — putting *Clear the list* under a row still in flight, where clearing it
  dropped a request nobody had cancelled.

- **A spreadsheet with a blank tab renumbered every sheet after it.** An empty
  sheet was skipped rather than counted, so the third sheet was cited as sheet 2
  and whoever opened sheet 2 to check found a blank page.

- **"A document needs content" was the answer to a file whose text is on
  screen.** A document that is only headings — a stub note, an outline, an
  export whose header row has nothing under it — makes no passage, and got the
  same sentence as a genuinely empty file. It now says which emptiness it means,
  and a header-only CSV is refused where the reason is known.

- **An unclosed `<script>` or `<style>` was indexed as prose.** Its body reached
  the retrieval corpus and could be quoted back as a passage. Those two are
  HTML's raw-text elements: with no closing tag the rest of the file *is* the
  script, which is what a browser makes of it.

- **A slide was named twice, in two languages, inside one prompt.** The citation
  read `slide 3` and the heading directly beneath it read `Diapositive 3`, with
  nothing to say they were the same slide.

### Changed

- **A long document opens without laying out the part nobody is looking at.**
  Measured in Chromium on 8 500 lines — a 512 KiB document, the largest the
  store accepts — layout falls from 86 ms to 16 ms, and the jump to the cited
  line still lands it exactly centred.

- **The cited line is marked, not merely tinted.** It carried a background
  colour and nothing else, in the one screen whose whole job is to point at a
  line.

## [0.83.0] — 2026-09-08

### Added

- **Drop files into the knowledge library, and let them reach several
  workspaces.** The library accepted pasted text and one shelf per document.
  It now takes `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.txt`, `.md`, `.csv`,
  `.html` and `.json` — dropped on the Memory page, up to 20 MB each — and a
  document reaches every workspace, or the two or three that need it, or none
  at all, with the same picker and the same badges the registry screens use.

  Files are read for *structure*, not only for words: a Word heading becomes
  the section its passages are cited under, a spreadsheet's header row travels
  with every row of that sheet, a slide keeps its title and its speaker notes,
  a PDF keeps its pages. The original is kept, downloadable, and re-readable —
  which is what lets a document already in the library benefit from a better
  extractor later without being dropped a second time.

- **A retrieved passage says where it came from — document, section, page and
  lines.** The block injected into a run carries it and the agent is asked to
  cite it; the genesis strip turns each consulted passage into a link that
  opens the document at the quoted line, so a claim can be checked rather than
  trusted; `search_notes` carries it to programs on the MCP gateway. A passage
  whose document has changed since is marked *Replaced since* rather than
  quietly dropped — re-extracting a document used to erase the citations of
  every run that had quoted it.

- **poppler reads PDFs, and the image installs it.** Measured against the
  built-in JavaScript fallback over two real two-column papers and a LaTeX
  document, inside the image this product ships: poppler rejoins a word its
  typesetter split across a line, the fallback leaves 10 to 165 of them
  broken per document, and one probe phrase was findable with one engine and
  not the other. The fallback remains for a host without poppler, *named* on
  every document it reads and reported by the doctor, so a deployment
  retrieving less always says so.

- **The doctor answers two new questions**: whether every uploaded original is
  still on disk — a document whose file is gone still answers every search, so
  nothing else would ever mention it — and which engine reads a PDF.

### Changed

- **The library's filter row gains a search by name**, accent- and
  case-insensitive, over both the title and the file's name. The workspace
  filter stays the page's: one question, one control, both halves of the
  screen.
- **Pausing a document is a `PATCH`.** It used to read the whole document and
  save it back to flip one boolean, which cannot work at all for a document
  whose text the store now refuses on the way in.
- **The Memory page reads its own URL.** `routes.memory(workspaceId)` has been
  built by the kernel for every notification since the library existed and
  nothing read it: the link resolved to the page showing every workspace.

- **No reranker, and now the numbers say why under a real embedder too.** The
  old argument — that nothing was in the candidate pool to reorder — was true
  of the hashing embedder and stopped applying when bge-m3 shipped. Re-measured
  on the same corpus and metrics: `bge-reranker-base` takes rephrased recall@5
  from 83.3% to 50.0%, `bge-reranker-v2-m3` to 66.7%, both losing the same two
  French questions the dense arm had at rank 1 — and the second model does not
  fit beside the embedder inside the container's memory limit.
  `scripts/eval-retrieval.mjs --rerank <model>` re-opens the question if the
  host ever changes shape.

### Fixed

- **A quota-refusal test expired at a wall-clock instant.** Its fixture named
  2026-09-08 16:00 UTC as the moment the block lifted, and `ModelAvailability`
  drops a hold whose reset has passed — so the suite went red that afternoon
  on a subsystem nobody had touched, and would have stayed red.


## [0.82.0] — 2026-09-08

### Added

- **Copies of an automation stay linked, and an edit asks whether to travel.**
  Duplicating gave two independent rows that drifted the moment one was edited —
  the cost named in the previous release, now made into a decision instead of an
  accident. The two rows share a *family*, and saving an edit to one asks whether
  to carry it to the others, listing them by workspace with each one tickable.

  It asks rather than syncing, and that is the design: a copy whose prompt
  deliberately names its own project has to be able to refuse, once, per save,
  per sibling. Ticked by default, because opening the dialog is already the
  answer. **Detach from its copies** says so permanently, which a copy that has
  gone its own way needs — being asked for ever is a chore, saying so once is an
  answer.

  What travels is the definition you just changed. What never travels is what
  belongs to one copy's life in one workspace: its schedule, its history, its
  failure counter, and **whether it is paused** — carrying `enabled` would let
  saving the original wake a copy somebody had deliberately stopped. The dialog
  appears only when there is something to ask, so the ordinary save is unchanged
  and nobody learns to dismiss a box.

  The propagation ids are checked against the family server-side: a form may not
  become a way to patch an automation the operator was never shown.


## [0.81.0] — 2026-09-08

### Added

- **Duplicate an automation into another workspace**, from its own menu. An
  automation that suits one project often suits the next, and until now the only
  way to have it in two places was to type it twice from memory.

  It is a copy and not a second attachment, and that is the schema speaking
  rather than a shortcut taken. A skill attaches to any number of workspaces
  because what gets mounted is identical everywhere; an automation carries seven
  fields of *execution* state — its continuous session, its failure count, its
  next firing, whether it is paused, its history — and every one of them is per
  workspace. One row reaching two workspaces would have to answer "does failing
  three times here pause it there too", which is a child table and a different
  subsystem. Worth doing the day these copies start to hurt; not worth doing
  before.

  So the copy starts its own life: nothing travels but the definition. It lands
  **paused**, because an automation fires unattended and one arriving already
  armed in a workspace it was not written for — with that project's files and
  permissions — is precisely the surprise this screen's guard rails exist to
  prevent. The workspace it already lives in is not offered as a target.


## [0.80.1] — 2026-09-08

### Fixed

- **"Forget" on a note in *Insights awaiting review* changed nothing on screen.**
  Reported: `Keep` worked, `Forget` looked inert. It was not — the memory was
  deleted every single time — but the note went on recording `kept` and the id
  of a memory that no longer existed, so the row kept offering `Forget` and the
  screen could not say what had happened. Two layers, and fixing either alone
  would have left the other:

  The note's `memoryId` is a foreign key nothing enforces — the same shape as a
  gateway token's `workspace_ids`, and the same lesson. A memory leaves by two
  doors and neither knew about this one: the operator's own button, and decay
  reaping it. So the repair is on *read*, not at each deletion site: it covers
  every door at once, including the one nobody presses, and it writes the
  correction back so a damaged row costs one repair and never again.

  `GateOutcome` gains `forgotten`, and it is not cosmetic. Reusing `skipped`
  would have been a row claiming the gate skipped a note the operator deleted —
  and the exhaustive `Record` that maps outcomes to tones refused to compile
  until the new state was named, which is exactly why that table is a record and
  not a ternary chain.

  The client half: `deleteMemory` did not invalidate the insights query while
  `keepNote` did. That asymmetry is what made the button look broken rather than
  merely stale.


## [0.80.0] — 2026-09-08

### Added

- **An automation can be moved to another workspace.** Its workspace could be
  chosen at creation and never again — the editor hid the control once the
  automation existed, the route stripped `workspaceId` from the patch schema and
  the scheduler's own type omitted it. So an automation was neither visibly
  attached anywhere nor movable, while a skill, a subagent and an MCP server all
  show their reach in their editor and let it be changed.

  The refusal was protecting something real rather than being lazy: a
  **continuous** automation keeps writing into one session so context
  accumulates, and that session lives in its workspace — carrying it across
  would have the automation writing into a project it no longer belongs to, with
  that project's files and permissions. The fix is to handle that in the move
  rather than to forbid the move. A move ends the thread and the next firing
  opens a fresh session on the other side; the editor says so before the save,
  and only for the automations it applies to. A move to a workspace that does
  not exist is still refused, and the audit line names both ends of it.

  The form sends `workspaceId` only when it actually changed. A patch that names
  it on every save is a patch that writes "moved" into the audit log every time
  somebody fixes a typo.


## [0.79.0] — 2026-09-08

### Added

- **A listing that shows the library whole, and says where each thing lives.**
  The registry screens offered "Global" as their widest scope, meaning only the
  definitions attached to no workspace in particular — so a skill attached to
  one workspace was invisible from every other scope, and there was no view that
  listed everything. The API has served `?scope=all` since the reach became a
  many-to-many, with a comment saying exactly why it exists; nothing ever asked
  for it. **All workspaces** is now the default on Agents & skills.

  That view is only useful if a row says where it lives, so every row carries a
  reach badge: **Global**, the workspace's own colour and name, a count with the
  names on hover when there are several, or **no workspace** when it is attached
  to none — a real state, reachable by unticking the last box, that an empty
  badge would have read as "global". One component across skills, subagents, MCP
  servers *and* automations, where it degenerates to the single workspace an
  automation belongs to by schema. That last one was already on screen as prose
  in the sentence under the name; as a badge it reads as a column.

### Changed

- **The workspace scope sits with the other filters now, on every screen.** It
  lived in the page header beside the title on Agents & skills, Memory and
  Analytics, while each screen's own filters sat in a row above the list — so
  the one control that changes a listing most was the one that did not look like
  a filter. One component, one label, one place. Analytics keeps two answers
  rather than three: it ranks runs, a run belongs to a workspace, and a "global"
  option there would return an empty list forever.

  The scope control also stays visible when a listing is empty. Hiding it with
  the rest of the filter row is how an operator ends up stuck inside a workspace
  that has nothing in it.


## [0.78.0] — 2026-09-08

### Changed

- **Auto now opens on the cheapest arm the learner ranks, instead of the CLI's
  own default.** `select` refuses to act below eight trials — rightly, since one
  data point is worse than none — but the fallback behind that refusal was the
  most expensive model available. Measured in production: a research run whose
  session, workspace default *and* automation all said Auto, on a category with
  a single trial, was served `claude-opus-5[1m]` and cost $1.33 for 610,618
  tokens, while the learner's own ranking for that very workspace put haiku
  first and fable last. It knew, and had no way to say so.

  The floor uses `list` — the posterior mean, an opening rather than a decision
  — which the cost-aware prior makes meaningful from the first run. It applies
  only when nobody chose: a workspace naming a real model still wins outright.

  Escalation is not left to hope, and the numbers are worth stating. Against an
  ordinary success at 0.810, a thumbs-down scores **0.234** and a failure
  **0.270** — either one drops haiku below every sonnet arm and opus/medium in a
  single run, so the next run starts higher. Hitting a turn ceiling (0.630) and
  failed tool calls (0.666) push more gently; latency barely moves it. What
  nothing detects is a run that succeeds and answers *badly* — that scores 0.8
  like any success — so on a young workspace the operator's rating is the only
  signal that says "this model was too weak for this". Five or six ratings place
  a category; after that the loop carries itself.


## [0.77.2] — 2026-09-08

### Fixed

- **The Claude catalogue showed the CLI's effort levels in English.**
  `ClaudeCataloguePanel` rendered `supportedEffortLevels` raw, so `low` and
  `xhigh` appeared as badges inside a French page. Latent since the panel was
  written, and only visible when the CLI happens to report those levels — which
  is why the browser check caught it on one release and not the one before, at
  identical code and an identical SDK. The panel now names them through the
  same catalogue the composer uses, and an unrecognised level still shows
  rather than vanishing.

  The gap worth recording is not the missing translation, it is that the unit
  test *already supplied* `['low','high']` to this component and asserted
  nothing about what was drawn from them. A browser check on a live CLI is a
  slow and non-deterministic way to learn something a fixture had in hand all
  along.


## [0.77.1] — 2026-09-08

### Corrected

- **0.77.0 claimed the SDK upgrade made `rate_limits` carry `model_scoped`. It
  does not.** The key appeared in one measurement — taken on Windows — and in
  neither of the two taken on Linux, before or after the bump. It is not
  attributable to the version, and what it does depend on is unknown. The
  upgrade's honest result is therefore *one* change, not two:
  `messaging_socket_path` joins the init frame, and Metaclaude reads none of it.

  This is the third time today a single observation was read as a version or a
  code fact without controlling for the environment it was taken in, so the
  lesson is now in `CLAUDE.md` rather than in a commit message: **one
  observation identifies a difference, never its cause.** The probe already
  records `process.platform` and warns on a mismatch — that warning fired, and
  the claim was made anyway.

### Fixed

- **The upgrade's phase 4 ran, and reports clean.** Re-measured against
  production on the platform that serves it, the SDK 0.3.247 → 0.3.263 diff is a
  single new init-frame key. `unifiedWindows` still arrives on every rejection,
  the CLI's own `fallbackModel` still does not cover quota, a changed
  system-prompt append still rewrites the cached prefix, and the init frame
  still carries no `effort`. Four shipped features rest on those four facts and
  all four hold.


## [0.77.0] — 2026-09-08

### Changed

- **The Claude Agent SDK moves to 0.3.263** (the CLI's 2.1.263), from 0.3.247 —
  sixteen patch releases — and it ships alone, which is the first rule of
  `docs/SDK-UPGRADE.md`.

  Phase 1, reading the declarations before installing them, found the delta
  quiet in everything Metaclaude depends on: `SDKRateLimitInfo`, the
  `rate_limits` declaration, the `SDKMessage` union, the init frame's `effort`
  and `fallbackModel`'s documentation are byte-identical. The three new
  `type:`/`subtype:` strings are control requests, not messages, which is why
  the narrator test stayed green — it was predicted to, and did.

  What is new and worth knowing: two hook events, `PreModelSwitch` and
  `PostModelSwitch`, reporting `source: 'auto'` for an automatic fallback along
  with `prompt_cache_warm`, `estimated_cache_write_usd` and `cache_ttl`. That
  last one confirms the CLI models a one-hour cache TTL — and it appears only on
  hook *inputs*, so it is reported, never chosen. There is still no knob.

  Phase 3 re-measured and found no behavioural regression. One real change: the
  declared object shape of `rate_limits` now carries `model_scoped`, which was
  `undefined` before. `readRateLimitWindows` reads the array first so nothing
  moves, and the object branch it keeps is now the complete one it was written
  to be.

### Fixed

- **The SDK probe reported three changes that were not changes.** Its first
  real use diffed raw cache-write token counts — 11,455 against 15,556 for
  behaviour that had not moved — because those figures follow the prompt and the
  mounted tools, not the version. It now diffs the conclusion (does changing the
  append still rewrite the prefix?) and keeps the magnitudes under `raw` for the
  record. It also records `process.platform` and warns when a baseline and a
  measurement come from different ones: `powershell_path` in the init frame is a
  Windows fact, not a version fact, and it was reported as one.


## [0.76.3] — 2026-09-08

### Fixed

- **The quota model switch would never have fired.** `classifyQuotaRejection`
  inferred a utilisation scale from the value — `u > 1 ? u / 100 : u` — which is
  unambiguous for 97 and catastrophic for 1. Measured on this deployment,
  `rate_limits.five_hour` reports `{ utilization: 1 }` meaning **one percent**;
  the rule read it as a spent global window, and a spent global window is
  precisely the case where no switch is attempted. Every model-scoped refusal
  would have been classified global and 0.76.0's whole feature would have shipped
  dead. The scale now comes from the source — the event speaks a fraction, the
  usage payload a percentage — because the value cannot say which it is on.
  Found by the SDK baseline probe below, not by a test: no test can see what the
  CLI actually sends.

### Added

- **A methodology for moving the Claude Agent SDK, and the probe it needs.**
  `docs/SDK-UPGRADE.md` and `apps/api/scripts/sdk-probe.mjs`. The static guards
  are good — the narrator test reads the message union out of the installed
  `.d.ts` and names what is new, and typecheck catches every field that moved —
  but four shipped features rest on behaviours the types omit or contradict, and
  nothing could see those. The probe measures them against a live CLI, saves a
  baseline before the bump, and diffs after; it reports an explicit *skip* for
  the two that need a genuinely exhausted model, because "unknown" and
  "unchanged" must not look alike. The rule the document opens with: an SDK bump
  ships alone, or a regression three days later cannot be attributed.

  `deploy/sdk-baseline.json` is the frozen reference for 0.3.247, captured
  against production with **all seven probes measured** — the two opportunistic
  ones included, because a model happened to be genuinely spent that hour. The
  next bump has a complete answer to compare against rather than a partial one.

### Corrected

- **0.76.1 claimed the quota screen had been blank in production. It had not.**
  The first inspection read the payload through a 2000-character truncation, saw
  only the `limits` array, and concluded the declared object keys were absent.
  They are there: `five_hour` and `seven_day` were read and displayed correctly
  all along. What was genuinely missing is the **per-model** buckets — the Fable
  one at 100% — because `model_scoped` is `undefined` on this payload and the
  model rows live only in `limits[]`. The fix in 0.76.1 is right and still
  needed; the reason given for it was wrong.


## [0.76.2] — 2026-09-08

### Fixed

- **`ModelAvailability.release` read the wall clock while its callers reasoned
  at a given instant.** It was the one method here that took no `now`, so an
  entry the wall clock considered expired made it return without writing —
  leaving the row in the database for a caller that had just been told it was
  gone. It surfaced as a test green on one machine and red on CI three minutes
  later, which is exactly why this project drives time with an explicit
  argument. The write is unconditional now, so expired entries are swept rather
  than accumulating.


## [0.76.1] — 2026-09-08

### Fixed

- **Two aggregates on the Analytics screen disagreed about what a token is.**
  The summary counted all four counters after 0.75.0; the per-workspace ranking
  beneath it still counted input and output only — about 6% of the bill —
  so the chart meant to say which workspace is spending the ceiling was drawn
  from the smallest part of it, next to a total that was drawn from the whole.
  Both count the same four now.
- **The documentation had drifted six releases behind, and three passages had
  become false.** `docs/LEARNING.md` listed the bandit's arms as "deliberately
  five" and named five — the fable pair has been there since Auto learned to
  reach it, and `sonnet/medium` arrived in 0.75.0, making eight. It also said
  retrieved memories are appended to the system prompt, which stopped being true
  in 0.75.0 when they moved to the user message to keep the cached prefix
  stable. And its rule for when the learner is consulted turned on `undefined`,
  which is right for a caller that can omit the field and unavailable to a
  picker that must send something.

  That last one is worth naming plainly: the section already recorded this exact
  defect in its scheduler form, and drew the general lesson — and the composer
  went on committing it, one screen away, for every message a person typed. A
  written lesson is not an applied one.

### Added

- **Documentation for six shipped features that had none**: the quota model
  switch and what to do when a limit is reached (troubleshooting), where each
  bandit arm opens and why (learning), the token count on a run's footer and
  what makes one turn cost five times another (sessions), a workspace's colour
  and icon (workspaces), filtering automations and switching many at once
  (automations), and attaching one skill, subagent or MCP server to any number
  of workspaces (extensibility).


## [0.76.0] — 2026-09-08

### Added

- **A run refused for quota now changes model instead of dying.** Measured
  against the real CLI on a genuinely exhausted Fable bucket: the run stopped
  with `You've reached your Fable 5 limit` as its error — a hard stop for a
  condition another model could serve, since Sonnet answered the same prompt
  seconds later. The refusal is now classified, and when the exhausted window
  belongs to one model the run resumes the same CLI session on the learner's
  next-best arm, with a warning naming the spent model, when it resets and what
  took over. Three switches, so four attempts, then the error stands. A global
  window is never retried: every model draws on it, so switching would buy
  three more refusals and a transcript claiming to have tried something it
  could not. The refused model is remembered until its window resets, so the
  next run does not pay the same discovery again, and the arm credited to the
  learner is the one that actually ran — a quota refusal says nothing about a
  model's quality.

  Two discriminators were written and refuted by measurement before this one,
  and both looked right. Switching on `rateLimitType === 'seven_day_<model>'`
  reads well against the SDK's enum and would never have fired: the rejected
  event carried `seven_day_overage_included`, which names no model. Passing the
  CLI's own `fallbackModel`, documented for a primary model that is "overloaded
  or unavailable", produced a result byte for byte identical to no fallback at
  all — it does not cover quota. What does discriminate is the rejected event's
  view of the *global* windows: `seven_day` at 0.97 and serving while Fable was
  refused.

### Fixed

- **The quota screen was blank in production.** The SDK declares `rate_limits`
  as an object keyed by window name; the CLI answers with a `limits` array of
  `{ kind, percent, scope }` rows. Every named lookup was therefore `undefined`
  and the screen rendered nothing on a subscription whose weekly window sat at
  97% and whose Fable bucket was at 100%. Both shapes are read now, from a
  captured payload rather than from the declared type — and an unrecognised
  third shape says so instead of showing an empty list, which is the difference
  between "nothing to report" and "we could not read the answer".


## [0.75.1] — 2026-09-08

### Fixed

- **Auto with no evidence still routed to the CLI's own default.** The
  cold-start fallback read `session.model || settings.defaultModel`, and `||`
  treats Auto as a choice because `'default'` is a non-empty string — so a
  session left on Auto never reached the workspace default at all. It resolved
  to `'default'`, which reaches the CLI as "pass no `--model`" and lands on
  `claude-opus-5[1m]`, measured. That path is taken until a (workspace,
  category) pair has eight trials, so it is the ordinary one in a young
  deployment: the learner's *absence* was being routed to the dearest model
  available. It now falls back to the workspace's own default.


## [0.75.0] — 2026-09-08

### Fixed

- **Choosing "Auto" for the model switched the learner off and pinned the most
  expensive model.** The composer offers Auto as the value `default` and sends
  its pickers on every message, so `overrides.model` was defined for every
  message a person ever typed; the kernel gated the bandit on
  `!overrides.model`, which is false for the string `default`. So the learner
  was never consulted from the composer, the run was stamped `explicit` as
  though somebody had chosen it, and `default` reaches the CLI as "pass no
  `--model`" — which lands on the CLI's own default. Measured in production
  over 54 runs: 46 stamped `explicit` against 7 `learned`, and all 42 runs
  submitted as Auto were served by `claude-opus-5`, three of them by the 1M
  variant at roughly three times the price. Auto did the exact opposite of what
  it said. The guard now asks "did the operator pin one?" rather than "is the
  field present?" — the same shape as the workspace-settings guard that used to
  refuse the form that round-tripped it.
- **A run's token count showed about 6% of what it used.** The footer added
  input and output, which in an agentic loop are the two small halves: 650k and
  172k against 12.04M read from cache and 1.41M written to it, over the same 54
  runs. A turn that had moved 109,000 tokens read `716 tokens`. Session totals
  had the same hole and stored only the two — a session that carried 4.53M
  tokens for $7.88 displayed 45.7k. Both now count all four, with the breakdown
  still one hover away, and the two new session columns are backfilled from the
  runs, which had carried the full usage all along.

### Changed

- **Per-message context left the cached system prompt.** Retrieved memory and
  knowledge are selected by similarity to *this* prompt, so the block differed
  on nearly every run — and it was appended to the system prompt, which is the
  cached prefix. Measured against the real CLI, three runs in one resumed
  session: the append is re-applied on resume and replaces what was there, so a
  changed one rewrote the whole prefix. The run whose append had changed wrote
  11,498 tokens to cache; the next, whose append was identical, wrote 163. A
  factor of seventy, from nothing but the append moving. In production the
  prefix is ~34k tokens with the MCP catalogues, and every run paid it. Recall,
  knowledge and the per-message tool steering now travel in the user message;
  what is stable for the session — the language directive, the workspace's
  conventions, the standing shelf — stays in the prefix. The git status leaves
  it too, via the SDK's `excludeDynamicSections`: an agent that edits files
  changes its own git status between runs, which invalidated the prefix on
  exactly the workload Metaclaude exists for.
- **The bandit starts low instead of in the middle of an expensive range.**
  Every arm was seeded Beta(1,1) — the uniform prior, which says a $2.10 arm is
  as plausible as a $0.07 one — and four of the frontier's arms are opus or
  fable, so a near-uniform Thompson draw put most early decisions on the dear
  end. The frontier stays complete, because omission is not evidence; what
  changed is where each arm opens. `armPrior` asks the reward function itself
  what an ordinary success on that arm would score, given what it costs and how
  long it takes — the only two things that can honestly separate arms nobody
  has run, since every success scores alike on quality. It is worth four
  pseudo-trials, so two or three real runs overturn it. `sonnet medium` was
  added: the gap between low and high was where the operator's own workspace
  default sat with no arm beside it.


## [0.74.0] — 2026-09-07

### Added

- **A skill, a subagent or an MCP server can now be attached to any number of
  workspaces.** The reach used to be a single nullable column: one workspace,
  or all of them. So an extension useful to three projects out of eight had to
  be made global — visible to five workspaces with no business seeing it — or
  written out three times, after which the three copies drifted. Each editor
  now carries the same control: *every workspace, including any created
  later*, or a list ticked one by one. The three questions are one component,
  because three copies of a reach picker is how one of them ends up unable to
  express the third answer.
- **Attached to nothing is now a state it can hold.** An extension reaching no
  workspace stays in the library and is mounted nowhere — the old column could
  not say it, since every row reached at least one. It is also a state an
  operator can arrive at by accident, so the control says so in words rather
  than showing an empty tick list and leaving them to work it out.

### Changed

- **The reach lives in a table with two foreign keys, not in a list of ids.**
  A token's `workspace_ids` is such a list; it went on naming a workspace that
  had been deleted, and the gateway filtering by exactly those ids told its
  operator this Metaclaude had no workspaces at all. The fix then was a prune
  somebody has to remember to call. `ON DELETE CASCADE` on both sides makes
  the same bug inexpressible: delete a workspace, or delete the extension, and
  the rows that named it go with it.
- **A save that does not mention the reach leaves it alone.** The field is
  optional at the edge and absent means untouched — the `.partial()` lesson in
  another costume, where a form saving a name silently resets everything it
  never showed.

### Fixed

- **`CheckboxField` no longer describes itself with an empty hint.** A row
  whose label already says everything — a workspace's name beside its avatar —
  passed `aria-describedby` at a blank span, which makes a screen reader
  announce nothing after the name. The hint is optional now, and absent rather
  than empty.

## [0.73.0] — 2026-09-07

### Added

- **A workspace's colour can be changed, and it can wear an icon.** The colour
  was choosable at creation and never again; the icon was worse — a field the
  schema stored, the PATCH route accepted, no control ever set and no screen
  ever showed, which is the "a schema field nothing forwards" shape this
  repository keeps finding. Both are in the settings dialog and the creation
  dialog now, from one pair of controls rather than two copies. Removing an
  icon is a choice of its own, first in the row: without it an operator who
  picked one could never go back to the plain square.
- **One avatar component, where there were eight hand-written squares.** The
  coloured marker was spelled out in the workspaces list, the dashboard, the
  command palette, a session's header, a workspace's header and the workspace
  columns of Agents, Analytics and Memory — so adding the icon to one would
  have left the other seven showing a bare square for a workspace that has
  one. The icon appears only at the two sizes that can hold one: four of those
  eight render a 12px marker, where a glyph is not small but illegible, and
  they render exactly what they rendered before. The system workspace's `bot`,
  stored since it first shipped and never once displayed, now shows.
- **The Claude CLI says which version it is, and whether a newer one is
  published.** A reading, deliberately, and not a button. The CLI is pinned
  into the image — `npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`
  — and the container refuses to change it three ways over: the process runs
  as uid 10001, the directory is root-owned, and the filesystem is mounted
  read-only. All three are on purpose. So the honest thing to offer is the
  knowledge, which nothing carried: the installed version appeared only inside
  a diagnostics check and the published one nowhere at all, so an operator had
  no way to know a release was worth asking for. The line says where the
  update comes from rather than pretending to be one. Unknown reads as
  unknown: when the registry cannot be reached the badge stays away instead of
  claiming the CLI is current.

## [0.72.0] — 2026-09-07

### Added

- **The automations screen filters, and switches many at once.** By workspace,
  by all/active/inactive with a count on each chip, and *Enable all* / *Disable
  all* over the rows on screen. The three other extension listings — skills,
  subagents, MCP servers — have had `AvailabilityFilter` and `BulkActions`
  since they shipped; automations were the one type left out, on the screen
  where switching a whole workspace's schedules off is most often what an
  operator wants. Both components are the existing ones, one kind wider.
- A filtered list that comes back empty says **which** emptiness it is, and how
  many rows the filters are hiding. "Nothing here" cannot tell "there are none"
  from "none match", and the operator picks the wrong one — the gateway told
  an operator their deployment had no workspaces for exactly this reason.

### Fixed

- **A bulk switch that only wrote `enabled` would have left automations
  enabled and never firing.** Enabling one is three coupled writes, not one:
  `enabled` is the visible half, `next_run_at` is what the sweep actually
  selects on — `enabled = 1 AND next_run_at IS NOT NULL` — and re-enabling
  clears `consecutive_failures`, or an automation the failure ceiling switched
  off switches itself off again on its very next failure. So the bulk verb is
  the single verb, once per row in one transaction, rather than the registry's
  one `UPDATE … WHERE id IN (…)`: the two cannot drift because there is only
  one. The cost is N statements where the registry pays one, which is the
  registry's own trade in reverse — a skill's row carries up to 200 000
  characters and an automation's carries a cron expression. Verified end to
  end on a live server: nine disabled and rescheduled, nine `next_run_at`
  present afterwards.
- `POST /api/automations/bulk` takes no `delete`, deliberately, and no
  three-way `null` scope: a cron expression somebody thought about is a bigger
  loss than a listing row, and an automation belongs to exactly one workspace
  by schema, so "global only" would name an empty set.

## [0.71.0] — 2026-09-07

### Added

- **A workspace can pre-approve the tools its MCP servers offer.** Under
  *Don't ask* — where automations and the gateway land — the CLI answers
  "denied, nothing is pre-approved" itself, so only names on the workspace's
  list ever run. The interface could tick exactly seven built-ins, and nothing
  else: an operator with a working MCP server had no way to use it unattended,
  and the screen gave no reason. Reported from a live deployment, where mail
  retrieval worked under *Ask* and stopped dead under *Don't ask*. The
  pre-approval group now lists each of the workspace's enabled servers as a
  fold — the tool's own name, its description, and a count on the summary so
  folding never hides whether a server decides anything — with *Tick all* and
  *Untick all* per server. The mechanism never needed changing: the system
  workspace has pre-approved forty-six `mcp__…` names since it shipped. It was
  only the screen that could not name one.
- **A server nobody has asked yet says so, and offers to ask.** Its tools are
  stored from the last describe, so a server never tested has none — which
  would otherwise render as a server that offers nothing, and read as broken.
- `GET /api/workspaces/:id/mcp-tools` answers which servers reach a workspace
  and what each offers, computed with `RegistryService.listMcpServers` — the
  same call the runtime makes when it mounts them. The rule is not restated in
  the browser, deliberately: it is about to gain a per-workspace attachment,
  and a second spelling of it would be free to disagree.
- `mcpToolName(server, tool)` in `packages/shared`, beside the parser that
  takes such a name apart and pinned to it by a round-trip test. The
  `mcp__<server>__<tool>` prefix was spelled by hand in six places once, and
  every one of them was wrong about a server named `my_server`.
- **The delegation tool is tickable too.** It is mounted by Metaclaude rather
  than registered by the operator, so the registry knew nothing about it and
  the picker could not offer it — which meant a workspace in *Don't ask* could
  not consult another one at all, and the screen said nothing about why. Listed
  as a built-in server, badged as such, and offered only where there is
  somebody to consult. Deliberately a tick rather than a grant: delegating
  spends another workspace's quota and starts a full run there with nobody
  watching, which is the operator's call to make once.
- `mcpToolName` is now the only place the `mcp__server__tool` prefix is built.
  It was spelled by hand in nine, across the five tool servers and the
  container.

### Fixed

- **An automation could not report on its own board.** Under *Don't ask* a run
  receives its ticked built-ins plus the two memory tools and nothing else, so
  the board and proposal tools — mounted, described, and never pre-approved —
  were refused outright. A scheduled run could not file the card it had just
  decided to file, nor propose the automation it had concluded was needed;
  every night, silently, with the run still landing as a success. Found on a
  live deployment while diagnosing something else. They now sit in the tier
  memory already occupied: every write in them is reversible and local to the
  workspace — a card lands on a board the operator reads, a proposal lands in
  an inbox, an automation a proposal creates arrives *disabled* — so they run
  without a card in every mode and say so in the transcript instead. The tests
  are derived from the tool catalogues, so a tool added to either server
  tomorrow is covered the day it is added.

## [0.70.0] — 2026-09-07

### Added

- **An agent can see which other workspaces it may consult.** `delegate` has
  shipped since the delegation lot describing its argument as "the target
  workspace's slug, exactly as listed" — and nothing listed anything. Measured
  on the build before this one: with delegation wired, the SDK options carry
  the `metaclaude` server and a system-prompt append of the empty string. The
  tool therefore only ever worked in the one case where the agent needed no
  help, a human having already typed the slug in the message. Every run that
  may delegate now carries a short directory of the other workspaces — slug,
  description, and the name only when a rename has moved it away from the slug
  — so a **workspace's description stops being decoration**: it is what another
  project's agent reads to decide whether the question belongs to you. Read
  against a real deployment the block costs about 220 tokens for three peers.
  The mount and the briefing come from one answer, so a tool nobody is told
  about and a briefing for a tool that is not mounted are both inexpressible;
  the supervisor's dependency carries the roster and the verb together for the
  same reason. Withheld from a run started through the gateway (a token names
  the workspaces it may reach, and the directory is a map of the rest), from a
  delegated run (depth is one), and from `dontAsk`, where the tool would be
  refused rather than asked about and the words would be waste on every
  scheduled run for ever.
- **Any workspace can decline to be consulted.** *Settings → Other workspaces →
  Let other workspaces consult this one*, on by default and stored as
  `delegable`. On by default is the whole of the decision, not a preference:
  settings are reparsed through their schema on every read, so every row
  written before the field existed takes the default — measured on a live
  deployment whose stored settings carried twenty keys against the schema's
  twenty-one — and `false` would have made every existing workspace silently
  unreachable at the next boot. It governs other projects' agents, never the
  steward, which reaches every workspace through its own verbs.
- **The size of that block is an operator's setting.** *Settings →
  Configuration → Peer directory budget*, 3000 characters by default. Measured
  with descriptions of the length an operator actually writes: twenty peers all
  keep theirs, past roughly twenty-seven the descriptions go together and the
  names remain, past about eighty the block says how many names it could not
  fit. Membership never degrades, because capping a list sorted by slug would
  make the same tail invisible on every run for ever. `0` switches delegation
  between workspaces off across the deployment — the tool included, since a
  ceiling whose zero means "off" that still creates the thing is the trap this
  repository already has a note about.
- **`list_workspaces` says what a workspace is for.** The gateway answered id,
  slug and name, which is what a workspace is *called*; a program routing
  between them had exactly the problem the agent had.

### Fixed

- **A checkbox wired to a literal showed the operator the opposite of what was
  stored, and nothing could see it.** Each of the workspace dialog's ten
  boolean settings was covered, if at all, by the test for the feature that
  introduced it; a control reading its neighbour's field renders, saves and
  looks perfect. The new test turns one field on at a time and requires exactly
  one box checked, which is what tells a swap from a literal — the first
  version turned them all on together, and a control reading its neighbour
  passed it.

## [0.69.0] — 2026-09-07

### Added

- **A filter on the three extension tabs.** Skills, subagents and MCP servers
  now carry `All statuses · Active · Inactive`, each chip with its own count,
  so "is anything switched off here?" is answered without a click. One
  component for the three, for the reason `BulkActions` is one component: a
  segmented row copied per tab is a row that loses `[&>*]:shrink-0` in one of
  the copies and squeezes its chips on a phone. The bulk buttons take the
  *filtered* list — they promise to act on the rows on screen, and that
  promise is what "delete all" rests on.
- **An `Applied` view for insights, and the way to what an installed proposal
  produced.** Installing a proposed skill sets the insight to `applied`, which
  no filter offered — so the card left every view on the click and a toast was
  the only evidence anything had happened. The reasoning that omitted it held
  for consolidations, whose effect is in the memory list above; a skill's
  effect is on another screen. The applied card now links to it, and no longer
  offers `Install` a second time, which could only hit the registry's
  unique-name conflict.

### Changed

- **A section is enclosed again.** `Section` was deliberately a band separated
  by a rule rather than a box, to stop 138 bordered blocks carrying identical
  weight. The reasoning was sound and the result was not, because the boxes
  never all went: the dashboard kept `MetaclaudeCard` and `AdvisorCard` boxed
  while the brief and the run list beside them were bands, and what the eye
  read there was not "object versus group" but "finished versus unfinished" —
  reported as a missing border, twice, on two different screens. The header
  band stays, bled to the enclosure's edges.
- **The memory tiers start folded.** This page is opened with two questions —
  how much is there, and under which project — and the headings answer both;
  a wall of cards answers neither. A keyword, kind or shelf filter unfolds
  them, because a narrowed list folded shut hides exactly what was narrowed
  to.
- **`Recently learned` moved above `Recent runs`**, and out of the rail into
  the main column: what the system learned is read before what it ran, and in
  the rail it sat below the fold on every screen.
- **An insight card names the workspace it was learned in.** The list unions
  the tiers exactly as the memory list does, and a lesson is a proposal about
  somewhere; the consolidation card has carried this from the start.

### Fixed

- **A proposed skill whose name a model spelled with underscores could be
  approved and never installed.** `upsertSkill` takes lowercase letters,
  digits and dashes — right for a name an operator typed into the form, wrong
  for one a model wrote — and the refusal landed at *install*, after the
  proposal had been drafted, shown, named on screen and approved, on the one
  screen offering no way to correct it. `toSkillName` now normalises at both
  ends: when a proposal is drafted, so the name shown is the name that will
  exist, and when one is accepted, so proposals already in the queue can still
  be installed.

## [0.68.0] — 2026-09-07

### Added

- **The agent can write to its own workspace's memory.** It could read it and
  not write it: recall arrives as an unattributed block with an instruction
  never to mention it, and the only write path was the pass that runs *after*
  the conversation. So an agent told something worth keeping did the one thing
  it could and wrote Markdown files — a second memory that nothing lists,
  decays, consolidates or searches, and that diverges from the store on the
  next run. `memory_search`, `memory_write` and `memory_forget`, pinned to the
  run's own workspace: another workspace's memory, and the global tier this
  one merely recalls, answer exactly like a memory that does not exist. Not
  mounted in the system workspace, whose steward already has more. These
  writes skip the memory gate deliberately — the gate exists to stop the
  automatic pass flooding the corpus, and a note written because the operator
  just said something is not that.
- **Catch up on runs that were never reflected on.** `Memory → maintenance →
  Catch up` replays the pass over finished runs that never completed one,
  scoped to the workspace in view. It runs in the background and reports what
  it recovered, because one model call per run cannot fit in a request.
- **The Doctor reports runs that never went through the pass.** The failure
  this whole release is about was invisible for a day; this is the check that
  would have spoken after the first one.
- `scripts/eval-memory-tool.mjs`, which measures what the agent actually
  writes: a real server, the real CLI, and a scripted conversation half of
  whose turns carry something durable and half of which carry nothing. What it
  reports is discrimination, not volume. Measured over five passes: the agent
  never once called `memory_write` on a turn carrying nothing, wrote on every
  turn carrying a durable fact bar one, and on a borderline turn twice
  *corrected* an existing memory rather than adding a second — which is what
  its instructions ask for.

### Changed

- **A workspace that has memory pre-approves reading and writing it.** Measured
  on the deployment this was built for: the workspace ran in `default` mode
  with `Write`, `Edit` and `Bash` pre-approved and nothing else, so writing a
  Markdown file was silent while writing a memory would have raised an approval
  card every single time. That incoherence is what produced the second memory
  in the first place — the system made the wrong thing frictionless. A memory
  write is strictly less consequential than the `Write` beside it: confined to
  the workspace's own tier, unable to touch a file, another workspace or the
  global shelf, listed on a screen built to review it, and reversible.
  `memory_forget` still asks, being the only one that takes something out of
  recall. `memoryEnabled` remains the switch for the whole arrangement.

### Fixed

- **The reflexion pass had been dying silently.** `structuredCall` allowed one
  turn, and the SDK returns a schema-constrained answer through a hidden tool
  call — so a model that spends that turn writing prose first ends as "Reached
  maximum number of turns (1)" with no answer at all. The memory gate measured
  this and raised its own call to three; nothing raised the reflector's, which
  has the longest prompt of the lot. Measured in production: **ten consecutive
  failures**, a workspace with eighteen successful runs and not one memory,
  each failure logged at warn and dropped by design. The default is three for
  every caller now: a ceiling is not a target, so a call that answers on its
  first turn costs exactly what it did before.
- **A run whose notes were all refused left no trace.** An insight was recorded
  only when a memory was *kept*, which made a refusal indistinguishable from a
  crash and from a pass that never ran — three very different things, one blank
  screen. It is recorded whenever the gate returned a verdict, and the `Keep`
  button added last release makes those refusals reversible.
- The insight list ordered by timestamp alone, which is not a total order: one
  run records its reflexion insight and its skill proposal in the same
  millisecond, so which one read as newest changed between runs.
- **The catch-up had no grace period, and the Doctor did.** Both read
  `reflected_at`; only one left a freshly finished run alone. A catch-up
  started while the live pass was still working on a run would have reflected
  it a second time and written its lessons twice. One shared constant now.
- The catch-up's notification reported how many runs it managed without saying
  how many it was given, so a partial success read as a success.

## [0.67.0] — 2026-09-07

### Added

- **A tinted band behind every section heading.** The rule alone separates a
  section from the one above it; it does not say where a section *starts*,
  which is the question on a settings screen carrying eight of them. Hue 250
  rather than the accent's 275, deliberately: the accent is a blue-violet, and
  a heading in it reads as "this section is selected" — the signal the current
  nav chip already uses. Opaque, never an alpha over the surface: a translucent
  band changes colour with whatever it sits on, and a heading that shifts hue
  down the page is worse than no tint at all. Both themes, one token each.
- **A workspace's settings, from inside a session of it.** A session runs
  *under* those settings — the model, the permission mode, whether files are
  checkpointed — and reaching them meant leaving the session for the workspace
  screen and coming back. The dialog was a local function of that screen, so it
  could not be offered anywhere else; it is a component now, with two callers.
- **An automation chooses its effort, beside its model.** Same shape as the
  model last release: `AutomationPolicy.effort` has been in the schema since
  the feature shipped, the scheduler has always forwarded it, and no form ever
  set it. It offers what the chosen model supports — under `Auto` the learner
  picks the model at submit time, so nothing can be ruled out — and drops a
  level the newly chosen model does not offer, rather than keeping a value
  nobody can see they chose.

### Fixed

- **The memory gate could only be disagreed with in one direction.** A refused
  note could be kept; a kept one could not be undone — and the note that
  matters most is a wrong *keep*, already in the corpus and already being
  recalled. `Forget` deletes the memory the keep created, and the row then
  offers `Keep` again, so the decision is reversible either way.
- **A decision, once made, left the screen for good.** The insight list asked
  the server for `new` only, so what the system learned and what it was refused
  — the two things the review exists for — could never be looked at again, and
  "did I already reject this?" had no answer here. Three filters now, and the
  heading follows: `Insights awaiting review` over a list of rejected ones is a
  lie the eye reads before the chips.
- **A failed language write was swallowed**, under a comment claiming the
  interface changing had already reported it. Backwards: the interface changes
  whatever happens, so a failure left the app in French and the deployment
  still writing English with nothing on screen to say the two had come apart.
  Reported from use — twenty-two memories in English under a French interface.
  It says so now, and names the setting to fix.
- The workspace settings dialog **crashed on a partial settings object**. It
  read `settings.defaultPermissionMode` straight into a lookup table, which is
  safe only while every caller hands over a complete one — true of its single
  caller, false the moment a second appeared. It parses through the contract
  now, so it survives any caller, which is what a shared component has to do.
- Both automation pickers defaulted to the label `Auto`, so neither could be
  named — by a screen reader, by voice control, or by a test. Each carries its
  own name: `Model: Auto`, `Effort: Auto`.

## [0.66.0] — 2026-09-07

### Changed

- **Settings is a section, not a screen.** Its groups were Radix tabs sharing
  one URL: nothing could be linked to, the back button walked out of Settings
  rather than back a group, and the section read as a different kind of thing
  from the System strip beside it. Each group is a route now — appearance,
  connections, security, configuration, audit log — listed by chips exactly as
  the System screens are. `/settings` is kept and still carries its query,
  because `integrations.ts` returns from Google's consent there and an operator
  has bookmarks; it forwards to the group that can read what it carries.
- **The machine gets a screen of its own, at the head of System.** Version,
  uptime, resources, the Claude CLI, the doctor and the updater were a tab
  inside Settings, which was wrong twice: none of it is a preference, and
  "System" then named both that tab and the rail section beside it. It leads
  the System strip now, because "is the box healthy" comes before "what is it
  doing".
- **Help moves to Settings, after the audit log.** It was the one entry in the
  System strip that did not describe something the deployment *does* — it is
  the manual, and it sits with the settings it explains. Its URL is untouched.
- **An automation chooses its model.** `AutomationPolicy.model` shipped with
  the feature, the scheduler has always forwarded it, and no form ever set it —
  so every automation ran on whatever `default` resolves to, including the
  nightly briefs where the choice matters most. The picker reads the workspace's
  own catalogue, and shows the stored value rather than `Auto` when the
  catalogue does not list it: falling back there would show a choice nobody
  made while posting a different one.
- **Messages carry the time they were written.** A session read back a day
  later said when nothing happened: the run footer carries a duration, which
  answers "how long", never "when". Both sides now, as a `<time>` with the full
  instant behind a short `14:32`.

### Fixed

- **Every text field uses the width it is given.** A control passed to `Label`
  sits inside the `<label>` — that is what associates the two — and the label
  was a flex item, which shrinks to its content: each field took `w-full` of
  its own *label text*. Three password fields on one screen came out 311, 292
  and 344 pixels wide. Measured across the app, thirteen of seventeen visible
  fields were under 80% of their room; it is zero now, and
  `scripts/measure-inputs.mjs` is the ruler.
- **Eight page titles were truncated on a phone**, in both languages —
  `Automations` reduced to `Aut…`, `Board` to 24 of the 41 pixels it wants. The
  title is the flexible item in a row whose buttons are not, and it is the only
  thing on screen saying which page you are on; `truncate` was doing exactly
  what it is for, so nothing reported it. Four measured changes brought it to
  zero: the action labels fold to their icon below `sm`, the title's decorative
  icon folds away with them, the board's workspace picker is bounded, and the
  header's gap tightens on a phone. `scripts/measure-titles.mjs` is the ruler,
  and the code's own note asked for exactly this — "the crowding is real and
  unfixed; it belongs to the final pass, with a measurement rather than a
  guess".
- **A panel button with no panel behind it**, on Board, Help and Plugins:
  `ContentHeader`'s default was `true` and the two components live in different
  files. The shell knows whether it was given a panel and the header asks it,
  so the defect cannot come back.
- Four things went on pointing at the machine's old address after it moved: the
  guide, three onboarding steps whose cards had gone with it, the dashboard's
  pairing link, and the command palette, which had no entry for the new screen
  at all. Each still *resolved*, to a page with none of what it promised.
  `check.sh` caught the first and now checks both sections; `onboarding.test.ts`
  pins the rest.

### Added

- `SectionTabs`, one component for both section strips. They were the same
  forty lines twice and had already diverged by exactly one class —
  `[&>*]:shrink-0`, which is what makes a chip row scroll rather than squeeze.
  `OWNER_ONLY_SETTINGS` and `SYSTEM_SECTION_PATHS` join it in the shared
  contract: the owner-only rule had three readers and two spellings, and the
  System paths two.
- `deadImports`, a ratchet counting names imported and never used. `tsc` does
  not report them, no test can see them, and splitting Settings in two left
  eleven — each still pulling its module into the chunk. Ceiling zero; three of
  the eleven predated this work.
- `scripts/measure-inputs.mjs`, and the `lib/sections.ts` split that keeps the
  entry chunk at 191 kB: `AppShell` needs the two section predicates, and
  importing them from the strips dragged six lucide icons in behind them.

### Fixed

- **Rewind works. It never had.** The Rewind button is gated on a run's
  `rewindPoint`, the uuid of the user message a turn opened with, and the code
  waited for the CLI to volunteer it on a replay acknowledgement. Instrumented
  against Claude Code 2.1.218 over a real run: the CLI sends **no** `type:
  'user'` message at all in streaming-input mode, so the acknowledgement never
  came, the field was null for every run ever recorded, and the button could
  not appear. Four unit tests covered it and stayed green throughout, because
  the fake `query` emitted the message the real CLI does not. `SDKUserMessage`
  carries a *client* uuid we may assign ourselves; the CLI stamps it back as
  `user_message_uuid` and — measured — accepts it as the `rewindFiles` target.
  The anchor now exists the instant the prompt is queued, and only where
  checkpointing is on, so a run that could not be restored still offers no
  button. `check:e2e` proves it end to end with a live agent.
- The live check that should have caught it asserted `typeof
  preview.body.canRewind === 'boolean'` — which `false` satisfies. It asserts
  `=== true` now: the CLI has to agree the anchor is restorable.
- The board's filter bar wrapped to three rows in French at 390px and sits
  *above* the scroller, so it pushed the first card to 237px — 28% of the
  screen, the worst of the ten routes and reported by nothing, because no
  control was clipped, covered or overflowing. It scrolls now, like the section
  strip that had already solved this and whose rule was never carried across.
- Two of the eleven flagged upstream advisories reached code we load: `sharp`
  (four libvips CVEs) rides `@huggingface/transformers` in the local-embeddings
  configuration production runs. Overrides take `sharp` to 0.35.4, `adm-zip` to
  0.6.0 and `qs` to 6.16.0; measured, `adm-zip` and `qs` are never loaded at
  all, and `transformers` imports and resolves sharp 0.35.4 without complaint.

### Changed

- The Settings tab called **System** is now **Server**, which is what it shows:
  version, uptime, timezone, CPU/RAM/disk, the Claude CLI, the kernel. "System"
  named two different things one tap apart — that tab and the rail section
  holding Automations, Agents, Plugins, Analytics and Help. The `?tab=system`
  value is untouched, so bookmarks and the guide's links still land.
- The setup checklist stops listing what is already done. Six rows filled 343px
  at the top of the dashboard and half of them were struck through; the count
  and a bar carry the only thing those rows said. Ninety-four pixels back on
  the first screen.

### Added

- `FILTER_ROW`, the class a filter bar takes so it scrolls rather than wraps.
  `flex-nowrap` alone is not enough: a flex child shrinks before it overflows,
  so the chips squeezed into three-line pills and the bar got *taller* than the
  wrapping version. It carries `[&>*]:shrink-0`.
- `scripts/measure-tabbar.mjs` and `scripts/measure-chrome.mjs` — two rulers
  for what no guard can see. The first found 2px between `Dashboard` and
  `Workspaces` on a six-section tab bar (16px in French, which already says
  `Accueil` and `Espaces`); the second refuted the assumption that the System
  screens' two navigation bars were the problem — they cost 101px, 12% of a
  phone — and found the board instead.
- The bench photographs the comfortable density on a desk, not only on a phone,
  where one column hides most of what the setting does. And its memories carry
  a body that is not their own title repeated: every card showed its sentence
  twice, which made a well-judged screen look bloated and nearly got it cut
  down.

## [0.65.0] — 2026-09-07

### Changed

- **Settings leaves the System group and becomes its own section.** It was the
  group's landing screen, so the rail pointed at `/settings` while the strip
  listed it sixth — the screen an operator reaches for most deliberately sat
  one tap deeper than the four beside it, and "System" named both the group
  *and* a tab inside Settings. Six sections now, the same six in the rail and
  in the phone tab bar, and the System entry lands on Automations. No URL
  moved.
- **The dashboard reads in two columns.** Eleven full-width bands stacked down
  a 1100px column put the workspaces, the figures and the history two screens
  below the fold, and every row of the run list carried 900px of empty space in
  its middle. What is happening reads on the left; what the system *is* — its
  figures, its machine, its projects, what it has learnt — sits beside it. The
  four stat tiles become a list, because the point of that screen is what needs
  a person, not the numbers.
- **A run's status is a dot, not a pill.** Twelve rows carried twelve
  `succeeded` badges — twelve repetitions of the one thing every row has in
  common, drawn louder than the prompt that distinguishes them, so the single
  red failure was the quietest thing on the list. Colour carries it now and the
  word stays in the accessible name. Rows go from 45px to 35px.
- **Twenty-one titled groups stop being boxes.** `Section` was written during
  the redesign against exactly this — 138 bordered blocks, none leading the eye
  — and then applied nine times out of ninety-seven, never on Settings, never
  on Analytics. Settings' eight groups, its six cards' worth of components,
  Analytics' five and a workspace's two are sections now: a heading, a rule,
  the content. What kept a card is what a card is for — an object you act on, a
  chart, an empty state, a tool.
- **One size for a page title.** `ContentHeader` set its `h1` at 13.5px, the
  same as the section headings under it; `PageHeader` — the other header in
  this app, naming the same thing — set 18px. One role cannot have two sizes.
  Both are the `title` role now, and the literal-size ratchet drops to 9.

### Fixed

- The resource meters were laid three across in a 304px column and every
  reading was truncated to `Not mea…` and `350 GB f…`. `sm:grid-cols-3` asks
  how wide the *window* is, which knows nothing about the column the block sits
  in; a container query asks the block. Settings, where it spans the page, is
  unchanged.

### Added

- `boxedSections`, a ratchet that counts a `<CardHeader>` sitting directly
  inside a `<Card>` — the shape `Section` replaces. Its ceiling is one, and the
  one is deliberate: the setup checklist is dismissible, which makes it an
  object rather than a group.
- `StatList` beside `Stat`, for figures read down a column rather than across
  four tiles, and `FLUSH_TABLE`, which pulls a table's outer cells flush with
  the heading that names it — a card's padding used to justify that indent and
  there is no card any more.
- The screenshot bench takes `SHOTS_ONLY` and `SHOTS_PASSES`. A ten-minute run
  is an instrument you look at once at the end; seconds make it one you design
  with, which is the difference between catching a defect and shipping it.

## [0.64.1] — 2026-09-07

### Fixed

- The sweep reported a toast's close button as covered by the dialog that had
  just opened over it. The menu phase presses items that announce something,
  and it was written without the dismissal the button phase already does — one
  copy in two places, and the one that was forgotten is the one that broke. The
  dismissal is shared now.
- And the check no longer depends on how fast the machine is. Dismissing a
  toast before each press narrows the race; it does not close it — this sweep
  was green locally at the moment CI was red on exactly that. A toast is
  transient chrome whose geometry belongs to sonner and which disappears on its
  own, so the audit excludes it the way it already excludes what a modal marks
  `aria-hidden`. A check that answers differently on two machines teaches you
  to read past red.

## [0.64.0] — 2026-09-07

### Changed

- The responsive guard presses menu items too, so a dialog that opens from a
  row's overflow is audited like any other: an automation's edit form and two
  confirmations, which nothing had ever looked at. Nineteen dialogues now,
  1707 checks.
- The sweep signs back in when a menu item ends the session. `Sign out` is one
  of the items it presses, and without this the first route logged itself out
  and the remaining eleven audited the login page — reporting a confident zero
  dialogues. Naming that item in a deny list would rot the day another one ends
  a session; noticing the login screen does not.

## [0.63.1] — 2026-09-07

### Fixed

- Every command in the palette rendered at 10.5 pixels. The pass that gave the
  eyebrow its role saw `uppercase` in a class list and put the size on the
  *container*, where the heading's own styling lives in
  `[&_[cmdk-group-heading]]:` variants aimed at a descendant — so the container
  set a font size the whole list inherited, and the heading kept its old one.
  Nothing failed: a class list is not a place a test looks, and no guard
  reaches a dialog opened by a keyboard shortcut. Found by reading the diff.
- A notification's timestamp was styled as an eyebrow. The same pass mapped
  10.5 pixels onto the new role, and the role carries the 600 weight and wide
  tracking that belong to a capital label above a group, not to `3 min ago`.

## [0.63.0] — 2026-09-07

### Fixed

- The comfortable density was never actually photographed, and its first
  picture showed a compact screen with more air. The bench wrote
  `metaclaude.density` — the standalone key the pre-paint script reads to stamp
  the attribute — and not `metaclaude.ui`, the store the disclosure reads. So
  the spacing moved and the help stayed folded. Both keys now, and the setting
  keeps its promise in both directions: five settings visible compact, two with
  their full explanation comfortable.

### Changed

- A seventh type role, `text-eyebrow`, for the small capital label above a
  group — `RECENT COMMITS`, `PERMISSION MODE`, `SESSIONS`. Twenty-two of them
  across fourteen files, in three sizes and two weights, for a role the app
  used constantly and had no name for. The test that derives the theme
  namespaces from the stylesheet caught that `cn` would delete it before it
  reached a single screen.
- Literal text sizes end at **10**, from 360 when this began. Those ten are a
  floor rather than a remainder: a notification badge sized to its 15-pixel
  circle, the page `h1` at 18 where the scale steps 16 then 24, and two TOTP
  codes spaced so six digits can be read off one phone and typed into another.
- The design bench photographs the comfortable density and French. It captured
  three combinations of a possible sixteen and none of them was the density
  setting's own subject; these two answer what the other thirteen would repeat.
  The French pass skips the tabbed screens, whose selectors are English —
  `scripts/responsive.mjs` covers their geometry in French at three widths.

## [0.62.1] — 2026-09-07

### Fixed

- The bench seeded a transcript event under a name the schema does not have —
  `assistant_thinking` where `domain.ts` says `thinking`. The row was written
  and the screen ignored it, which looked exactly like the preference for
  showing reasoning being off, and I said so. With the right name the block
  renders, and the session screenshot finally shows what a run actually looks
  like.

## [0.62.0] — 2026-09-07

### Changed

- The session header fits a phone. It carried four icon actions plus the
  connection badge, the bell and the avatar, and the title — the only thing
  saying which session you are in — was truncated to `Workin…`. Nothing was
  clipped or covered, so no guard reported it: `truncate` was doing exactly
  what it is for. The two panel toggles take the whole screen at that width
  anyway and deleting a session is not something you reach for in a hurry, so
  on a phone they move into a menu and only `+` stays. The four are declared
  once and rendered twice, because a second copy is how the two forms come to
  disagree — and the menu announces a toggle as a toggle.
- Fifty-six literal text sizes across the transcript, the composer, the
  approval card and the diff view become scale roles. None of the 121 tests
  covering them moved, which is what a mechanical change should look like.
- The design bench opens a session, with a transcript. It created runs but
  never any events, so that screen was always the empty state — judging the
  transcript, the tool cards and the composer by eye was impossible, which is
  how a whole lot's worth of density went unlooked-at.

## [0.61.1] — 2026-09-07

### Changed

- The claim that encoding an id changes nothing is now derived from the
  generator rather than from a sample. It holds because the alphabet is
  Crockford base32 and a prefix; an alphabet that ever gained a `/` would move
  every link the API has already sent, and the test says so.

## [0.61.0] — 2026-09-07

### Changed

- **Every path in the interface comes from one contract.** The web app owns the
  router and the API sends people into it — a push notification points at a
  session, Google's consent returns to a settings tab, an insight links a
  workspace's memories — and those strings were written by hand on both sides,
  in files that never meet. A rename in the router would have left the
  notifications on the 404 screen, silently, on a phone.
  `packages/shared/src/routes.ts` is now the one place, both apps build from
  it, and a ratchet refuses a path written by hand. No URL changed: an operator
  has bookmarks and a notification sent last week still has to open the right
  session, so every string that ships is pinned by a test.
- Ids are encoded into a path rather than pasted into it. Nothing changes today
  — ids come from a safe alphabet — which is when to do it: an unencoded
  segment is a way out of the path it belongs to.
- Seventy-six literal text sizes across the workspaces screens and their panels
  become scale roles.
- The design bench visits `/workspaces` and a workspace, which it never did —
  the two screens this release changes most.
- A workspace's path is hidden on a phone rather than truncated to `C`.

## [0.60.1] — 2026-09-06

### Fixed

- The ratchet added yesterday could not see the defect it was written for. It
  read the string literal the help class sat in, so `cn('help-comfortable',
  'block')` — the two classes in two *arguments*, which is the defect exactly —
  read zero. It now excuses only the fix's own shape, the two on opposite arms
  of one choice, and counts everything else. Three arrangements sabotaged: two
  arguments, one string, and the fix itself.

## [0.60.0] — 2026-09-06

### Fixed

- `help-comfortable` did nothing wherever a display utility sat beside it. The
  class hides prose the compact density does not show; Tailwind emits its
  utilities in a *later cascade layer*, and a later layer beats any
  specificity — so `block help-comfortable` showed the prose in every density.
  Silently, and immune to the obvious fix: raising the selector's specificity
  changed nothing on screen. A ratchet now refuses the pairing, sabotaged with
  the exact shape that failed.

### Changed

- The dashboard's checklist explains the step you are on. Six steps carrying
  two lines each filled four hundred and forty pixels of a phone, in front of
  everything the dashboard exists to show; the detail of a step you have not
  reached is not urgent. The composer below it now opens above the fold. The
  disclosure used everywhere else cannot go here — the row is a link, and a
  button inside a link is invalid and unreachable by keyboard.
- Thirty-eight literal text sizes on the dashboard, the board and their cards
  become scale roles.

## [0.59.1] — 2026-09-06

### Changed

- The disclosure beside a setting is *described* by its label rather than named
  by it. Eight settings called `Explain` is a poor list of buttons, and naming
  each by its subject is what made every row answer twice to a search for its
  own words. `aria-describedby` is the third answer and the one it exists for:
  the name stays short, the description says what is being explained, and a
  search for the setting still finds one control.
- `Label` sets the id its own description points at *after* the caller's props,
  so a caller passing one cannot leave that description pointing at nothing.
  None does today.

## [0.59.0] — 2026-09-06

### Fixed

- The automation card leaked the next line of its prompt. `line-clamp` limits
  the *content* to two lines but `overflow: hidden` clips at the **padding**
  box, so the six pixels below the second line were a window onto the third —
  cut through the glyphs, outside the tinted background it belonged to. One
  layer per concern: the box carries the padding, the paragraph carries the
  clamp. A ratchet now refuses the pairing, and reads the whole `className`
  value rather than only a plain string, because the sabotage that was meant to
  prove it could fail found nothing until it did.

### Changed

- The configuration screen folds its explanations. Eight settings, three lines
  each, is twenty-four lines of prose in front of the values you came to
  change; on a phone it showed two settings, and now shows five. `Label` grew
  an `explanation` — the essay, which follows the density — beside the `hint`
  it already had, which never folds: a hint is the constraint you need *while*
  filling the control, and hiding that in the density most people run is not
  the trade the setting offers.
- The whole System section moves onto the type scale: 129 literal sizes across
  Automations, Plugins, Analytics, Settings, Help and their cards, in six
  spellings, become three roles.
- Tailwind's own named sizes count as literals now. The measure read
  `text-[13px]` and walked past `text-sm`, which is the same decision spelled
  the other way — forty-eight had survived five lots of burning the first
  spelling down. Forty-two are converted; the ceiling counts what remains.

## [0.58.1] — 2026-09-06

### Fixed

- A teardown failure could take the whole report with it. The throwaway data
  directory would not delete on Windows — the database file is held for a
  moment after close — so a run whose every check had passed exited non-zero
  and printed no tally at all. That is the exact failure the guard exists to
  prevent, in the guard: a check that reports nothing is indistinguishable from
  a check that passed. It retries, then says on stderr what it could not remove.
- The dialog pass ran inside the sweep, in the fourth of six combinations, so
  two of them audited a deployment it had modified — a run it started, a token
  it issued. One real defect surfaced that way and a phantom could have. It has
  its own pass now, after everything, and nothing follows it.
- Two dead fallbacks on the run-status tables. `lastStatus` is narrowed to
  `RunStatus` inside the guard that renders it, so `?? 'warning'` was
  unreachable — and worse than noise: it invites the next reader to loosen the
  exhaustive table instead of adding the case that failed the build.

### Changed

- The five invariants live in one `inspector(page)` rather than in a closure
  the dialog pass would have had to copy.
- The i18n rule covers `cond && 'Text'` as well as `cond ? 'A' : 'B'`. There
  are none of the first shape today; a rule that waits for one arrives after it
  ships.

## [0.58.0] — 2026-09-06

### Fixed

- Seven button labels that were never translated. `{automation ? 'Save' :
  'Create'}` and six like it — the shape `CLAUDE.md` names as the one that
  escapes every i18n measure, because the rule requires two words and a button
  says one. They shipped in dialogs and on the transcript, in French.
- A run's status was rendered raw, so a French screen said "succeeded". Its
  colour was a ternary chain too, which silently gives a new case somebody
  else's colour; both are exhaustive tables now, and the build fails the day
  `RunStatus` gains a member.
- A checkbox was a 16-pixel target. A pseudo-element does not render on a
  replaced element, so the box itself cannot carry a hit area at all — the
  label can, and pressing it toggles the box, which makes the row the target it
  already looked like.
- Rendered markdown links had none either: four failed at once on the
  changelog, at 19 pixels.

### Changed

- The responsive guard visits every tab panel, opens menus on every route, and
  finds dialogs instead of being told about them. It audited 1065 things and
  now audits 1629: nineteen tab panels where it saw three, sixteen dialogs
  where five were named, forty-five menus where it opened them on five routes
  of twelve. Every defect above came out of that sweep, on panels and dialogs
  nothing had ever looked at.
- Animations are off during the sweep. A geometry probe measures the layout at
  rest, and a control covered only mid-animation is not a defect an operator
  meets — it was reporting a different subset at each width, which is a flaky
  check, which is worse than no check.
- The guard knows a closed `<details>` hides its contents, and asks the
  platform rather than three hand-picked properties. It was measuring a Copy
  button nobody could reach, inside a folded card, and reporting it covered.
- Tool names render as code. `Write` and `Edit` are what the CLI calls them;
  they are identifiers an operator matches, not words to translate — and the
  sweep is right to report an untranslated word, so the markup has to say which
  it is.

## [0.57.3] — 2026-09-06

### Fixed

- The typecheck error that took CI red. A new test destructured a regex capture
  without guarding it; `vitest` strips types and never checks them, so the
  suite was green here and `tsc` was red there. The repository already
  documents that trap — the fix below is the one that makes it impossible
  rather than remembered.
- Fourteen tests that failed on Windows, permanently. They assert POSIX
  absolute paths verbatim — `/srv/metaclaude/workspaces/a` — and they do it on
  purpose, because what ships is a Linux container; `resolve()` turns those
  into `D:\srv\…` and the assertion compares two different worlds. They now
  declare themselves skipped and say why, so they still run in CI on the
  platform they describe. A suite with a standing red block teaches you to read
  past red, which is exactly how a real failure hides.
- The test-count floor punished that fix: `it.skipIf(…)` did not match, so the
  number fell by fourteen the day those cases stopped failing. A conditional
  skip is still a test and still runs in CI; `it.skip(` stays excluded, since
  that one runs nowhere.

### Changed

- `pnpm verify` runs typecheck, tests, build and the ratchets in the order CI
  does. Remembering four commands is not a strategy, and until the fix above it
  could not have passed on the maintainer's own machine.

## [0.57.2] — 2026-09-06

### Fixed

- Two rows were drawn with no background at all. `bg-canvas/40` names a colour
  the palette does not have, so Tailwind generated no rule and the class did
  nothing — on a knowledge search hit and on an MCP credential block. Nothing
  could see it: not the app, not the tests, not either browser guard, because a
  missing background looks exactly like an intended one.
- A ratchet that passed on a broken build. `initialJsGzipKb` skipped a
  referenced asset that was not on disk, so an incomplete build measured
  **zero** and passed under any ceiling. Found by deleting `dist/assets` to
  check that the new measure beside it reported "not measurable", and watching
  this one report 0 instead. It now reports rather than passes.

### Changed

- A ratchet for classes the stylesheet never defines — the third way a class
  can fail to take effect, after tailwind-merge deleting it and a custom theme
  namespace it did not recognise. It reads the built stylesheet and treats a
  string as a class list only when at least two of its tokens are classes that
  genuinely exist and they are at least half of it: 1470 lists recognised here,
  one token reported, and that token was real.
- A test that derives the custom theme namespaces from `styles/index.css` and
  fails on any it has no assertion for. It found `ease-*`, which tailwind-merge
  did not know either — harmless today, since those tokens are only read from
  CSS, and declared anyway so the rule holds without an exception list.

## [0.57.1] — 2026-09-06

### Changed

- The two filter groups on the memory screen were the same forty lines twice —
  the state, the options and how a label is read differed, and nothing else,
  the comment included. The duplication had already cost something: the hit
  area they were missing had to be added to each. One local component, and
  three tests that had to pass before and after it.
- The ratchet that catches a tab trigger re-declaring its appearance reads the
  tag by brace depth *and* by quote, so a `>` inside `icon={<Icon />}` or
  inside `title="a > b"` no longer ends the tag early. Both were sabotaged and
  caught before being trusted; the first version read a comfortable zero.

## [0.57.0] — 2026-09-06

### Fixed

- **The type scale was never applied.** The six roles live in an `@theme`
  block, and tailwind-merge — which knows nothing of that block — classified
  `text-caption` as a text *colour* and deleted it as conflicting with the
  `text-muted` beside it. Every role in the app was being dropped before it
  reached the DOM wherever a colour followed it in one class list, which is
  nearly everywhere since prose is muted. Nothing could see it: the ratchet
  counts roles in the *source* and had been reporting a steadily improving
  number while none of them applied, no test asserted a size and a colour on
  one element, and a paragraph that silently inherits its size still looks like
  a paragraph. Now that it applies, the memory filters fit one row per group on
  a phone instead of two.
- Tabs sit above the panel they label. The agents screen draws a sticky strip,
  which cannot live inside the scrolling body — so it was full-bleed while its
  panel was centred, and the triggers began a hundred and eighty pixels to the
  left of the content they named. It read as a band of chrome.

### Changed

- The agents screen stops opting out of the shared tab strip. It used the
  component while overriding its stickiness, its margin, its gutter and the
  entire appearance of a trigger — so its tabs had a different height, type
  size and active colour from every other tab in the app, while the wrapper's
  own comment claimed the duplication was over. Two props replace the four
  overrides, an `icon` slot replaces the two spellings of a tab icon, and the
  ratchet now counts a trigger that re-declares the appearance rather than only
  a screen that imports Radix directly.
- The directory of connectors is a section like any other, so its five
  sentences of explanation fold away in the compact density instead of filling
  a phone's screen — and its heading no longer skips a level under the page's.
- A `Select` primitive, which the app had rewritten by hand eight times across
  three files beside the `Input` that already said exactly it. The whole form
  family — input, textarea, select — moves off `text-sm` onto the scale, so a
  compact interface finally has compact forms.
- Sixty-one literal text sizes on the agents screen and its panels became scale
  roles: six spellings for what the scale expresses in three.

## [0.56.20] — 2026-09-06

### Fixed

- Nine more controls too small to press, and the reason the last release
  missed them. The sweep that found sixteen searched for one spelling of a
  quiet link; there were four. Searching by *structure* instead — every link
  and button whose classes say "small text" and which carries no hit area —
  found the rest: the card drawer's two menu triggers, the library's category
  chips, two external "Docs" links, an archived session's row, the release
  notes link, and the dashboard's link out to the settings screen.
- A quiet link inside a sentence is 16 pixels tall, and the hit area written
  for a 32-pixel button left it at 28 — under the floor. Lines of text now grow
  further than boxes do. Measured, not guessed: this is the one the browser
  check failed on.

### Changed

- The responsive guard no longer depends on the machine it runs on. It read the
  host's Claude credentials, so on a signed-in developer machine the dashboard's
  "not authenticated" panel never rendered and everything inside it went
  unaudited — which is exactly where the link above was hiding. It passed
  locally with 1065 checks and CI failed on that panel. Both now audit the same
  screen.

## [0.56.19] — 2026-09-06

### Fixed

- Sixteen controls that were too small to press. The disclosure added in
  0.56.18 shipped at 16×16 with no hit area, which the browser check caught on
  the settings screen — and looking for its siblings found fifteen more, none
  of them new: the composer's model, effort, permission and tool pills, the
  board's filters and its quick-add buttons, the cron presets, the task kinds
  and priorities, a workspace's colour swatches, and every quiet "View all" or
  "Review" link out of a card. All between 19 and 29 pixels tall under a thumb,
  and all of them perfect on a desktop, which is why they lasted. They now
  carry the app's own hit area — invisible, applied only to a coarse pointer,
  so the desktop keeps its dense rows unchanged.

### Changed

- The responsive guard measures hit areas. It visits twelve routes at three
  widths in two languages and opens the dialogs and menus, and had no such rule
  at all; the browser check, which has had one from the start, sees six routes
  at one width. Two guards, one blind spot each — and the blind spot is where
  those sixteen controls lived. It measures what a control *offers* rather than
  what it wins when pressed, because adjacent hit areas overlap by design and a
  probe cannot tell a missing area from one a neighbour took.
- Five spellings of a "quiet link", five of a toggle chip and seven of the
  composer's pill became one each. That is what made the fix above a handful of
  lines rather than sixteen, and it moved twenty literal text sizes onto the
  scale on the way.

## [0.56.18] — 2026-09-06

### Fixed

- The explanations on the memory screen are readable again in the compact
  density. Making them follow the density was right; hiding them with a CSS
  rule keyed on *comfortable* was not, because compact is the default — so in
  the density everybody actually runs, the sentences that say what the filter
  box does and what the recall box does were gone, with no control to bring
  them back. Side by side those two boxes are otherwise indistinguishable, and
  the sentence under each is the entire distinction. A description is now
  disclosed rather than dropped: shown outright when there is room, offered
  behind a small control when there is not. `Section` and `CardHeader` already
  owned a description, so they carry the behaviour and no screen had to change.

### Changed

- The disclosure control names what it explains. Two of them sit side by side
  on the memory screen, and named alike they were one entry twice in any list
  of the screen's controls — the heading above each separates them on screen
  and by arrow navigation, and not there.

## [0.56.17] — 2026-09-06

### Changed

- The memory screen shows its memories first. The constellation sat above the
  shelves, so the answer to "what do I remember" was a picture and the memories
  themselves began below the fold — several screens below it on a phone. It is
  a good picture and it is not what the screen is for; it is revealed on
  request now, and the default is the list.
- Four statistic tiles became one line. On a 390px phone they filled the whole
  screen — two hundred and sixty pixels for four numbers. `Stat` is right where
  a figure *is* the point, which is the dashboard and the analytics; here the
  counts are context and the shelves are the subject.
- Every literal text size on that screen — twenty-seven of them — now names a
  role from the scale. The ratchet moves from 469 to 442.

### Added

- The comfortable density finally keeps its own promise. Its copy says "plus
  d'air, et l'aide toujours affichée", and until now it changed a font size and
  a padding while the help was permanently on in both. A `.help-comfortable`
  rule shows explanatory prose in comfortable and hides it in compact — a
  class rather than a prop, so no component has to know the density. Measured
  on the memory screen: nothing shown in compact, five paragraphs in
  comfortable, and the list starts 173px lower for it.

## [0.56.16] — 2026-09-06

### Changed

- The `primary` flag on a navigation entry is gone. With ten sections it said
  which ones the phone could afford; with five every entry carried it and the
  filter it fed was a no-op — a distinction without a difference, which reads
  as a choice long after it stopped being one. One list, rendered twice, and a
  test now holds the rail and the tab bar to the same sections in the same
  order.
- The section chips carry the coarse-pointer hit area the small buttons already
  use: 36px painted, ~48px of screen under a thumb, vertical only because the
  chips sit 6px apart and a sideways area would let one steal presses meant for
  its neighbour. Reused rather than reinvented — `TOUCH_TARGET_Y` is exported
  now instead of copied.
- `ContentHeader` names its title and subtitle by role rather than by pixel
  count, and its section strip has a test: one rule under the header, never
  two, and the strip outside the header row rather than inside it.

## [0.56.15] — 2026-09-06

### Changed

- Ten top-level sections became five, and the phone's "More" sheet is gone.
  Automations, agents, plugins, analytics, settings and help are one section —
  System — because none of them is something an operator *works in*: they are
  how the deployment is configured and inspected. Ten entries never fitted a
  tab bar, so four lived behind a sheet, and which four was decided by the
  available space rather than by meaning. The rail and the tab bar now hold the
  same five, in the same order, and nothing is one tap further away than
  anything else.
- **No URL moved.** The API builds links to `/settings` for the Google OAuth
  return and to `/automations` for a scheduler notification, push notifications
  carry their own paths, and an operator has bookmarks. The grouping is
  navigational; every path is exactly what it was.
- The section's own strip is drawn as chips, deliberately: Settings carries six
  tabs of its own, and drawn in the same register the two stacked into
  identical scrolling rows — ninety pixels of a phone's height, with nothing
  saying which moved between screens and which moved within one.

### Fixed

- The section strip scrolls its current entry into view. Six French labels are
  wider than a phone, so it scrolls from the left, which put the current chip
  off-screen on every System screen at 390px — a strip that does not show your
  position is a row of links, not navigation.
- The untranslated-copy check now reads accessible names too. This very lot
  shipped a `aria-label` in English and the check said nothing, because it only
  walked text nodes: a name nobody sees is still copy, and it is what a screen
  reader announces and what voice control listens for.

## [0.56.14] — 2026-09-06

### Added

- The responsive check now opens the menus and two more dialogs. It covered
  three dialogs out of forty-two and no menu at all, which is a large blind
  spot for a check whose subject is what a control looks like once it is on
  screen — the trigger defect that cost a release in 0.56.4 was inside a
  dialog. Menus are found generically by `aria-haspopup="menu"`, so nothing
  drifts as menus are added and nothing is mutated by opening one. The sweep
  went from 432 assertions to 873.

### Fixed

- A memory's action menu came out 430px wide on a 390px phone: Radix sizes a
  menu to its widest child, and several items carry an explanatory sentence
  under the label, so every sentence ran off the right edge — on the one screen
  where that menu is the only way to act on a memory. The menu's width is
  bounded by the viewport now, and the items' existing `min-w-0` lets the
  sentences wrap.

## [0.56.13] — 2026-09-06

### Added

- The responsive check now also asks each French screen whether anything is
  still showing in English. The rule admits no false positive by construction:
  a run of text is a defect only when it is *exactly* a catalogue key whose
  French value differs — a proper noun, a workspace name, a number or a
  sentence assembled from fragments cannot match one. Rendered markdown, code
  and the help corpus are excluded, because those stay English by design.

### Fixed

- Three enum values reached French screens in English and no static measure
  could see them: a memory's kind (« episodic », « semantic ») on the memory
  list, a run's status (« succeeded ») on the dashboard, and the analytics
  period (« 30 days »). All three are lowercase, and the three i18n ratchets
  rest on a capital first letter — a limit this repository already documents.
  The browser check found them the first time it ran.
- The measure that reads copy tables followed a `.map` callback but stopped at
  a call, so `PERIODS.find((p) => …)?.label` was invisible to it. It walks
  through calls now — and gained two exclusions it needed to stay honest: a
  property read as a *condition* is not a render, and `t(a ?? b)` translates
  `a`. A `return` hands a key to the caller, which this repository documents as
  the correct pattern; that hole is covered from the other side by the browser
  check.

## [0.56.12] — 2026-09-06

### Fixed

- The two transcript preferences reintroduced the exact accessibility defect
  `CheckboxField` was factored out to fix: a local `PreferenceToggle` nested its
  hint inside the `<label>`, so a reader announced "Show the model's reasoning
  Collapsible blocks showing how the agent worked through the problem, checkbox,
  checked" on every focus, and voice control had no short phrase to target. They
  use the primitive now, and a test holds the name to the label alone.
- Seventeen lists wrote `divide-[var(--mc-border)]` where `divide-line` says the
  same thing, and one swatch reached past `ring-accent` the same way. An
  arbitrary value pointing at a token is the token reached through the back
  door: it works, and it is what stops a future change from being one line. A
  `tokenBypass` ratchet keeps the count at zero.
- Two different components were both called `Row`, in two files — the trap this
  repository already records under another name. They say what they are:
  `DefinitionRow` and `CatalogueRow`.

### Changed

- `DataList` was dropped from the redesign's plan rather than built. The
  duplication behind it is a class string, not a structure, and wrapping a
  `<ul>` in a component for one class adds indirection without removing a
  decision. Normalising the class was the actual fix.

## [0.56.11] — 2026-09-06

### Changed

- `Section` and `Grid` had no call site at all — components with tests and no
  users, which is the same defect as the dead density tokens removed two
  versions ago, made by the same hand. Both are now used where they belong: the
  dashboard's grid, which carried a hand-written `min-w-0` patch since the
  first lot, and the two list sections on Memory and Analytics that already
  wrote a `<section>` with a heading and a count by hand.
- `Grid` fixed the breakpoint per column count, and not one of the ten
  hand-written grids in the app matched it: two charts want `xl`, two cards
  want `sm`, the dashboard wants `lg`. How many columns is the layout's
  business; the width at which they are worth having is the content's, and only
  the caller knows it. It takes a `from` now.
- The Claude catalogue declared its own `Section` — icon, title, subtitle,
  count, four call sites — a duplicate of the primitive with one thing that is
  genuinely local: a shelf reporting nothing says so. It delegates its header
  and keeps its rule, and `Section` gained the icon slot it was missing.

### Fixed

- The bundle ceiling moves from 189 to 190 kB gzipped, by hand and for a
  reason: the dashboard is deliberately eager, so the layout primitives it uses
  land in the entry chunk. Declaring `sideEffects` on the web package was tried
  first and measured no gain, so it was not kept — a change with no measured
  benefit is not worth its risk.

## [0.56.10] — 2026-09-06

### Added

- One tab strip, replacing three. `TAB_CLASS` was declared byte-for-byte
  identically in the settings and help screens, with a third variant inline in
  agents — three places to change when the active underline moves. The wrapper
  also owns the gap below the rule, which the three copies each carried
  differently, and an `adHocTabs` ratchet keeps the count at zero.

### Changed

- `StatTile` and `Field` were dropped from the redesign's plan rather than
  built: `Stat` already exists with 25 call sites, and `Label` already wraps a
  control and carries a hint. Adding either would have put a duplicate in the
  lot whose purpose is removing duplicates.

## [0.56.9] — 2026-09-06

### Added

- The layout primitives — `Page`, `PageBody`, `Section` and `Grid`. Ten screens
  carried ten independent choices before them: four maximum widths, three
  paddings and four vertical rhythms for one repeated shape. `Page` owns the
  width, named by intent rather than by a Tailwind step, and no screen names
  its own any more. `Grid` carries `min-width: 0` on its children, which is the
  defect that clipped the dashboard on a phone. `Section` separates with a rule
  instead of enclosing in a box, and owns its heading level.
- A `pageWidths` ratchet, so a screen cannot go back to naming its own width.
  Two remain, both in the session view, which lot 8 rewrites.

### Fixed

- The memory kind filters and the board's assignee filters rendered in English
  on a French screen — « All / Episodic / Semantic / Procedural » and « All /
  Yours / Agent » — with every translation already sitting in the catalogue.
- The ratchet that exists to catch exactly that saw only a direct index,
  `TABLE[i].label`, and no copy table in this app is read that way: they are
  all rendered through `TABLE.map((entry) => … entry.label)`, where the
  property access is rooted at the parameter. It now follows the row into the
  callback, scoped to it, and found both defects above the moment it could see
  them.

## [0.56.8] — 2026-09-06

### Added

- `SegmentedControl`, replacing three hand-rolled button rows that sat in one
  card — language, theme and density. Two of them were bare `flex` rows whose
  items could not shrink below their own text, which is the shape that put a
  trigger button off a 390px screen in 0.56.4. It is a grid, it owns its own
  label so the visible text and the group's accessible name cannot drift, and
  an odd last option takes the whole row rather than sitting alone in a
  half-width box.

### Fixed

- `font-variant-numeric: tabular-nums` was applied to the whole document. The
  convention here is targeted — ten call sites put it exactly where columns of
  figures line up, `Stat` among them — and applying it globally also reached
  the assistant's prose, where fixed-width digits are simply wrong.
- Three of the five density tokens were declared and consumed by nothing, and
  the test passed on them. Only the two the app reads are left; row height and
  section rhythm arrive with the primitives that need them. The gutter is now
  live in `CardHeader`, `PageHeader` and `Stat`, so comfortable widens the
  padding of every card in the app rather than only enlarging text.
- The embedded font was served network-first by the service worker. It is
  immutable and its name is stable, so it is cache-first like a hashed asset.

### Changed

- The density setting is covered where it actually happens: the attribute on
  the document and the standalone key `density-init.js` reads before React
  mounts. A test on the button alone would have passed while the setting did
  nothing on the next load.

## [0.56.7] — 2026-09-06

### Added

- A type scale with six roles — `text-display`, `text-title`, `text-heading`,
  `text-body`, `text-label`, `text-caption` — replacing seventeen distinct
  sizes named in fourteen different ways with no rule saying which belonged
  where. A component now chooses a role, not a size.
- A density setting, compact by default, comfortable on request, in
  Settings → Appearance. It lives entirely in CSS custom properties switched on
  `data-density`: no component branches on it, which is what keeps its cost
  near zero. What a screen actually gains depends on that screen consuming the
  tokens rather than naming its own sizes, and the new `literalTextSizes`
  ratchet is the honest measure of that — 494 when it was introduced, 485 now.
- Inter, served from this deployment. The `latin` subset alone, 47 kB measured:
  `latin-ext` costs 83 kB more and French needs none of it, `Œ`/`œ` sitting at
  U+0152-0153 inside the range shipped. Chosen for what this interface is — a
  console full of counters and small labels — and paired with `tabular-nums`,
  so a column of live figures stops shivering as it updates. Self-hosted
  because the CSP is `font-src 'self'`, and because it is one fewer party who
  learns when someone opens the app.

### Changed

- `CLAUDE.md` said the web tests run under jsdom. They run under happy-dom, and
  have for a long time — five documented traps named the wrong engine. They are
  corrected, and three measurements taken against 20.11.6 are recorded beside
  them: no layout at all (`getBoundingClientRect` is 0×0), Tailwind v4's output
  is unparseable here, the computed-style cache is invalidated by a DOM
  mutation rather than by a resize, and `window.innerWidth` widens with the
  overflow under mobile emulation.

## [0.56.6] — 2026-09-06

### Added

- A permanent responsive check (`check:responsive`), wired into CI: twelve
  routes, three widths, two languages, dialogs open, against a deployment
  seeded with adversarial content — long French, unbreakable tokens, a URL.
  Every route injects a positive control, without which "zero defects" would be
  indistinguishable from a broken probe. The check the app already had could
  not see the two phone defects that shipped this month: this app's clipper is
  the AppShell's `overflow-hidden` div, which stops the overflow from ever
  reaching the document, and under mobile emulation `window.innerWidth` widens
  with the overflowing content, so the worse a defect is the better it hides.

### Fixed

- The dashboard clipped three controls on a phone. A grid item's `min-width` is
  `auto`, so it refuses to shrink below its content: the workspaces card blew
  out to 542px — 697 in French — inside a 358px column, and since the grid is
  `overflow-x: visible`, nothing scrolled. The links were simply out of reach.
- The account menu fell off the workspaces header in French, where the labels
  run half again as long as in English. The header's buttons now fold to their
  icon below `sm`, each keeping an explicit accessible name.
- A memory whose title is a URL or an identifier now wraps instead of being cut
  off with no ellipsis to say so.
- A card renders a level-2 heading rather than a level-3 one. `PageHeader`
  renders the page's `h1`, so every screen skipped a level — 24 skips measured
  across both languages and all three widths, which makes the heading outline
  wrong for anyone navigating by it.
- The workspace and session screens mark Workspaces as the current section;
  neither marked any. `NavLink` derives `aria-current` from its own path and
  overwrites what it is handed, so the two screens an operator spends the most
  time in announced no active section at all.

## [0.56.5] — 2026-09-06

### Fixed

- **The board's header fits a phone.** The workspace picker plus two
  full-width buttons overflowed a 390px header, and what fell off the right
  edge was the primary action — **New task** was unreachable on the screen
  where the board is most used. Both labels fold to their icon below `sm`,
  the way every other header in the app already did, each with the
  `aria-label` that a `display: none` label cannot provide.

### Changed

- **The design bench photographs the dialogs, and the automations page.** It
  captured nine screens on a phone since the day it was written and never a
  single dialog — which is where the settings an operator changes actually
  live, and where a row of controls has the least room. It cost the event
  trigger a release: `scripts/shots.mjs` now opens the automation, memory and
  task dialogs at 390px and 1440px, scrolling each to its end, because a
  dialog's overflowing half is usually below the fold.

## [0.56.4] — 2026-09-06

### Fixed

- **The event trigger can be chosen on a phone.** Four trigger buttons in one
  flex row cannot shrink below their own text, so the row overflowed the
  dialog with no wrap and no scroll: on a 360px screen in French — Planifié ·
  Intervalle · Manuel · Événement — the fourth was simply off-screen, and an
  event trigger could neither be seen nor chosen. Two by two on a phone, four
  across from `sm` up. The priority row on the board wraps for the same
  reason, and the Memory page's **Add memory** button carries its own
  `aria-label`: its text label is `display: none` below `sm`, which takes it
  out of the accessible name and left an unnamed button on the phone.

## [0.56.3] — 2026-09-06

### Fixed

- **Editing an automation no longer reverts what it did not show.** The form is
  filled when it opens and never re-seeds while somebody types — which is
  right — but it sent every field it holds, so a change made anywhere else in
  between was silently written over by an unrelated edit. Reported on
  `Alerte échec`: its trigger had become `event/run_failed`, the open form
  still held the cron it was created with, and changing the prompt would have
  put `0 9 * * *` back. The form now sends only the fields it actually
  changed, against the automation it was seeded from; the route merges the
  rest.
- **And it says when it is out of date.** A form whose automation moved since
  it opened carries a line saying so, with a button to load the new version —
  re-seeding on its own would discard what the operator is typing, and saying
  nothing is how an unrelated edit came to look like it reverted a trigger.

## [0.56.2] — 2026-09-05

### Fixed

- **Choosing a workspace for a token cannot be done from a stale list.** The
  picker is drawn from the workspace list the page loaded with, and a
  workspace deleted since produced `That workspace does not exist` on a name
  the operator had just clicked — a refusal about an id that was never on
  screen. The list is re-asked when the dialog opens, which is the only moment
  it decides anything, and the refusal now names the id and says the list is
  out of date rather than denying what the screen shows.

## [0.56.1] — 2026-09-05

### Fixed

- **The gateway card no longer says the address is unset while it is loading
  it.** Reported from use, on a deployment where `METACLAUDE_PUBLIC_URL` *is*
  set: `endpoint.data?.url` is falsy in three situations and the card treated
  them as one, so a claim about this deployment's configuration was made
  before the server had answered. Loading shows the shape of the field, a
  failed request says the address could not be read, and only a resolved
  `null` is the configuration itself. Same family as the gateway's empty list
  the same day: an unverified conclusion presented as a fact.

### Added

- **The doctor says whether this deployment knows its own address.** A warning,
  not a failure — everything that does not hand an address to somebody else
  runs untouched. What does not run is authorizing an MCP server (which needs
  a redirect URI) and showing the gateway endpoint, and both refuse with a
  sentence about a setting, which reads as a broken feature until you know
  which line of `.env` is missing.

### Changed

- **`bootstrap.sh` writes `METACLAUDE_PUBLIC_URL` from the site it just asked
  for.** The app still refuses to derive its address from a request — a `Host`
  header is attacker-controlled and a redirect URI is the one value that must
  never be — but the installer already knows the answer, and leaving the
  operator to state it a second time meant every fresh deployment started with
  both of those features unusable.

## [0.56.0] — 2026-09-05

### Fixed

- **A token no longer keeps a grant on a workspace that has been deleted.**
  Found from use: an external agent holding a gateway token reported that this
  Metaclaude had no workspaces at all. It had one — the token named a
  workspace deleted since, `workspace_ids` is a JSON list that no foreign key
  reaches into, and the gateway filters by exactly those ids. So
  `list_workspaces` answered `[]`, which the program on the other side read as
  an empty deployment. Deleting a workspace now prunes it from every token
  that named it, and says so in the audit line.
- **The gateway explains an empty answer instead of returning one.**
  `list_workspaces` now says whether the deployment has no workspaces or the
  token reaches none of the ones it has, with the count as proof — an empty
  list was a conclusion the caller had no way to check.

### Added

- **A token's reach can be repaired without issuing a new secret.**
  `PATCH /api/tokens/:id` changes the workspaces (and the name, scopes or
  ceiling) of a token that already exists; the store had the method and
  nothing exposed it, so the only fix for a pruned grant was to revoke and
  mint again — reconfiguring every client for a mistake none of them made. The
  MCP gateway card shows a token that reaches nothing, in the warning colour,
  with the repair beside it.

## [0.55.1] — 2026-09-05

### Fixed

- **The reply no longer jumps backwards mid-stream.** Reported from use: text
  appeared truncated while it streamed and became whole when the run ended.
  The socket's reconnect invalidates the session query, the answer re-hydrates
  the store, and `load` cleared every streaming buffer — so the screen fell
  back to the last block the transcript had persisted and the rest reappeared
  only with the authoritative event. Blocks still streaming into the same
  session now survive a re-hydration; the ones whose event has landed are
  dropped, as before.
- **Reopening a session shows the session.** `staleTime: Infinity` makes the
  cached answer eternally fresh, so React Query's refetch-when-stale never
  fired: the second visit rendered the transcript as it was when the screen
  was last closed, and an automation's run or work done from the phone was
  missing until a live frame happened to arrive. The screen asks the server on
  every mount now — the socket keeps an *open* session current, it cannot fill
  in what was missed while nobody watched.

## [0.55.0] — 2026-09-05

### Added

- **Cards have a kind: bug, task or improvement.** A board mixed three things
  that are read very differently — something is broken, something must be
  done, something could be better — and told them apart only by their titles.
  The kind is what a card *is*, separate from priority (how soon) and status
  (where): it shows as an icon on the card, changes from the drawer, filters
  the board above the columns, and is offered when a card is created. The
  agent has it too — `board_create` and `board_update` take it, `board_list`
  reports it. Everything written before this is a task, which is what
  migration 24 backfills.

  The schema-derived forwarding test earned its keep on the day: `board_create`
  declared `kind` before the handler passed it on, and
  `kernel/tool-forwarding.test.ts` failed with exactly that sentence.

## [0.54.0] — 2026-09-05

### Added

- **An archived session can be ended, not only put back.** The fold offered
  one way out — restore — which made it a drawer that only ever fills. Each
  row now carries both: restore it to the list, or delete it permanently
  through the same confirmation a live row gets, because it takes the
  transcript with it. Archiving still deletes nothing.

## [0.53.2] — 2026-09-05

### Fixed

- **A stored policy is parsed, not cast.** Verifying 0.53.1 in production
  showed the other half of the same bug: the one automation there had no
  `notify` key in its stored JSON at all, because the column holds whatever
  was written the day it was written. The API handed that object back as it
  was — an `Automation` whose policy was missing a field its own type
  declares, saved from breaking anything only by `undefined` being falsy.
  Every stored policy is now read through `AutomationPolicy`, so the fields
  that did not exist when a row was written come back at their declared
  defaults. A policy the schema refuses keeps the values an operator chose
  and gains only the missing ones: it is already unusable, and resetting it
  would be a second failure on top of the first.

## [0.53.1] — 2026-09-05

### Fixed

- **"Notify me when a firing ends" is saved.** It was not. `routes/registry.ts`
  carried a hand-written copy of the automation policy — the same five fields —
  and the copy never gained `notify`; Zod drops what it does not declare, so
  the checkbox was posted by the browser and thrown away at the edge without
  an error. The form went on showing it enabled until the page was reloaded,
  and the automation ran mute. Every automation created or edited from the
  interface since the flag shipped has it off; tick it again on the ones that
  should speak.

  The copy is gone: `AutomationPolicy` is exported from `packages/shared`, the
  route validates against it, and the scheduler's defaults are
  `AutomationPolicy.parse({})` rather than a third literal. The bound the
  route's copy carried alone — `agentName` at 64 characters — moved to the
  shared schema with it.

  `routes/automation-policy.test.ts` derives its sample from the schema and
  fails if a field is missing from it, so the next field added to the policy is
  covered on the day it is added. The web test asserting the form posts
  `policy.notify` had been green throughout: it proved the browser sends it,
  never that anything accepts it — the edge-schema trap from the other side,
  now in CLAUDE.md.

## [0.53.0] — 2026-09-05

### Added

- **Archived sessions can be found again.** Archiving was one-way from the
  interface: the row left the sidebar and nothing anywhere offered it back —
  the session was still there, and only the API or the steward could reach it.
  The sidebar now folds them at the bottom under a line saying how many there
  are; opening it loads them, and each one can be read or restored. The count
  rides the workspace payload so the label is honest before anything is
  fetched, and the rows themselves load only when someone goes looking:
  `GET /api/workspaces/:id/sessions?archived=1`.

## [0.52.0] — 2026-09-05

Three things the sidebar owed the operator, asked for together because they
are one thing: knowing, from anywhere, that something is waiting.

### Added

- **Rename a session.** The title is written by the first message and is often
  wrong for what the session became; until now the only way to change one was
  to start another, which loses the transcript it was about. **Rename** is in
  the row's menu — right-click works too — and changes nothing else.
- **An unread dot on a session.** A run that finishes while you are on another
  screen, or another device, used to leave the row reading exactly as it did
  before: the only signal was a toast that had already gone. A session whose
  activity is newer than your last look now carries a dot, and its title the
  weight for anyone who cannot pick out six pixels of accent. Opening the
  session clears it, and so does a run settling while you watch it — leaving
  mid-run leaves the dot behind, which is the point. It lives in the database,
  not the browser, so it is the same mark on the phone and on the desktop.
- **An unread dot on a workspace.** The index carries one on any workspace with
  at least one such session, so the projects that answered while you were away
  are visible without opening any of them. Archiving a session clears its dot
  for good: hiding it is a way of being done with it. The steward sees the same
  fact — `system_sessions` reports `unread` per session.

Migration 23 adds `sessions.last_read_at`, backfilled to each session's last
activity: shipping this does not mark every session in the deployment unread on
the morning it lands.

## [0.51.4] — 2026-09-05

### Fixed

- **The memory count says how many of how many under a shelf filter.** It
  compared the total against the unfiltered live rows, so filtering to one
  shelf showed "2 shown" with no denominator — the number that says what is
  being hidden. It compares against the cards actually rendered now.

### Changed

- **CLAUDE.md records the trap 0.51.2 fell into**: vitest strips types and
  never checks them, so a suite can be green here while `tsc` and the build
  are red on CI — and the release is then tagged by nothing. Same family as
  the `check.sh` entry beside it.

## [0.51.3] — 2026-09-05

### Fixed

- **0.51.2's own test fixture did not typecheck**, so the version was tagged
  by nothing and never shipped. `Partial<T>['usage']` is the *full* usage
  type, not a partial one — the parameter has to be `Partial<RunUsage>`.
  Vitest does not typecheck, so the suite was green while `pnpm typecheck`
  and the build were red: after touching TypeScript, run the typecheck, not
  only the tests.

## [0.51.2] — 2026-09-05

### Added

- **A run's footer names what it wrote to the cache, not only what it read.**
  The transcript's token tooltip showed "in · out · cached", and the half it
  left out is the one that decides the bill. Measured in production on one
  conversation: its first turn — a two-word greeting answered with a single
  tool call — wrote 36 430 tokens into the cache and cost $0.42, while its
  seventh ran three tools, read 170 807 tokens from the cache, wrote 7 153,
  and cost $0.19. The sessions guide now carries those figures.

  The measurement also settled the question 0.51.0 instrumented: the cache
  **holds** across the turns of a session. The system prompt carries the
  memories recalled for each request and therefore changes every turn, which
  should in principle break a prefix cache — it does not, in the numbers, and
  the idea of restructuring the prompt around it was dropped.

## [0.51.1] — 2026-09-05

### Changed

- **The guide says what 0.51.0 shipped.** The sessions guide explains the
  cache split under the period's cost — why a two-word turn can cost more
  than an investigation — and the Metaclaude guide lists editing among the
  automation gestures the steward makes on its own.

## [0.51.0] — 2026-09-05

Two things the steward asked for after a day of using its own tools, and it
was right about both.

### Added

- **The steward can edit an automation.** `system_automation_update` changes
  the name, description, prompt, trigger, notification or permission mode of
  an automation in place — only the fields named, so a new prompt leaves the
  description, the schedule and the failure ceiling alone. Until now its only
  way to change the prompt of `Morning review` was to create a twin and pause
  the original, which left a dead automation behind and lost its history.
  Pausing stays its own tool; the change is audited as
  `steward.automation.update` with the fields it touched.
- **Cache tokens, where the cost is decided.** A run reports four token
  counters and the tools showed one figure: the cost. The steward measured a
  two-word greeting costing twice a three-tool investigation and could not say
  why from `system_analytics`. `system_run` and `system_runs` now carry input,
  output, cache-read and cache-written tokens per run; the analytics summary
  totals the two cache halves over the period, and the Analytics page shows
  them under the cost — a context written again after the cache expired is
  most of a short turn's bill.

## [0.50.1] — 2026-09-05

The cold review of 0.50.0, the shelves and the gate read end to end a day
after they shipped. Nothing here changes what a memory is; each entry is a
seam where two of the new rules met and one of them lost.

### Fixed

- **Pinning a retired memory restores it.** The store refused to retire a
  pinned memory but let a retired one be pinned, and the janitor skips pinned
  rows — so that memory was neither recalled nor collected, in a state no
  screen showed and no gesture undid. Pinning now says what it means.
- **A memory cannot be superseded twice.** `supersede` on an already-retired
  loser returned success and changed nothing; it refuses now, the way it
  refuses a pinned or a durable one. The steward's retire and restore are
  idempotent without writing an audit line for a no-op.
- **The gate says when it folded a note into an existing memory.** `remember`
  merges a near-identical note rather than inserting it; the decision then
  reported "kept" with the existing memory's id and the shelf the gate had
  asked for, which was never applied. It now carries the memory's real shelf
  and says "folded into an existing memory".
- **A preference is detected in French as well as in English.** The rule that
  asks a preference to mention the operator used `\b`, which is ASCII-only:
  `opérateur`, `préfère` and `demandé` never matched (see the first trap in
  CLAUDE.md). Unicode lookarounds now.
- **A run that delegated to a subagent is reflected on.** `Task` was on the
  read-only list, and a subagent's own calls are not in the parent's events,
  so a steward run that changed something through one was skipped as
  "read-only".
- **Acting on an old insight no longer answers 404.** The keep, consolidate
  and install-skill routes looked the insight up in the newest five hundred;
  one reader by id serves all three.
- **The Memory page counts what it shows.** The constellation was drawn over
  the retired rows too; "shown" counted them while `total` did not, so the
  two disagreed by the size of the fold. The fold's own heading pluralises
  through `plural()`, and the count sentence is translated whole.
- **The steward can list what it can restore.** `system_memories` takes
  `includeRetired`; without it a retired memory was restorable only by an id
  the steward had to remember.

## [0.50.0] — 2026-09-05

Memory learns to say no. Measured on a day of production before this release:
the reflexion pass wrote twenty-seven notes, two of which deserved to outlive
the session; five of them said one fact at five moments; the steward marked
the old ones "[obsolete]" in their titles for want of a way to retire them; a
state fact stayed retrievable for two hundred and thirty idle days; and a
pinned convention was never recalled for a request that did not resemble it.

### Added

- **Three shelves.** Every memory now says how long it is meant to hold beside
  what it is. A **standing** memory — a convention or preference the operator
  stated — is injected whole into every run of its scope, whatever the request,
  and never fades; the search leaves it out so it never arrives twice. A
  **durable** memory is the default and behaves as before. A **volatile**
  memory is a fact that can stop being true: recalled the same way, forgotten
  three times faster, and the one shelf a machine may replace. Badge, filter
  and form on the Memory page; `shelf` on the API, the steward's tool and the
  operator's form; the doctor warns past ten conventions in one scope.

- **Retirement, a soft delete.** A retired memory leaves recall, injection,
  the duplicate check and consolidation at once, sits folded at the bottom of
  the Memory page for thirty days with a Restore button, and is collected
  after. A supersession is a retirement that names the newer memory, bounded
  by rule: only a volatile, unpinned loser in the same scope — the arbiter was
  measured wanting to replace the operator's pinned convention with a note
  derived from it. The steward gains `system_memory_retire` and `supersedes`
  on `system_memory_write`, and its instructions say what to remember, what
  never to, and that a fact that changed is replaced rather than annotated.

- **A gate on everything the machine writes.** The reflexion pass proposes;
  `learning/gatekeeper.ts` decides, with one cheap model call per run that
  produced candidates: each note's level — preference, lesson, fact, state,
  redundant, episodic — and whether it describes an existing memory at a
  later time. Only the first three levels are kept, a fact as volatile, and
  what the model is not trusted with is bounded outside the prompt: two per
  run, three on a failure, six per workspace per day; a supersession only
  onto a neighbour it was shown; on any failure nothing is written and
  nothing is lost. Every verdict rides the run's insight with its reason, and
  a refused note has a **Keep** button — the gate is wrong sometimes, and
  overturning it costs one press. The insight itself is only written when
  something was kept or the run failed; a run of the steward's workspace that
  only read is not reflected on at all.

- **A bench for the gate**, `apps/api/scripts/eval-memory-gate.mjs`, replaying
  the labelled production corpus through the real prompt on three passes.
  Measured at release: of the twenty-seven notes that were all kept before,
  the two worth keeping are kept on every pass and four or five of the
  twenty-two others slip through — the same handful each time, with haiku and
  sonnet alike — so the bench refuses a change whose worst pass misses a keep
  or keeps more than five. `reflect()` is tested for the first time, with the
  model call injected.

### Fixed

- **An advisor's own run no longer fires an event automation.** The
  anti-chain guard promised "a person, a token or a delegation" and let a
  `system` run through; the steward's first review noticed.


## [0.49.0] — 2026-09-05

Three observations Metaclaude made of its own scheduling, all verified, all
addressed: event triggers that never fired, a cron read on a clock nobody
named, and a brief nobody was told about.

### Fixed

- **Event triggers fire.** The schema has offered `run_failed`,
  `run_succeeded`, `session_idle` and `file_changed` since the first release
  and nothing emitted any of them: an automation on `run_failed` showed
  *enabled* and stayed silent forever, indistinguishable from a deployment
  where nothing failed. The kernel's finish hook now drives the scheduler:
  an enabled watcher of the same workspace fires when a run a person, a
  token or a delegation started ends that way — never one another
  automation produced, which would let two watchers feed each other — with
  the run, its outcome and the start of its prompt prepended to the firing.
  An optional filter matches a word in the run's category or prompt. The
  two events nothing emits are refused at creation, naming the two that
  work. The Automations form offers the trigger; it never had.

### Added

- **The server's timezone, wherever a schedule is typed.** Cron is read in
  the process's clock — `TZ` in the container, UTC unless set — and a
  schedule typed for eight fired at ten in Paris all summer with nothing on
  screen saying which clock. `/api/system` reports the zone; the cron field,
  Settings → System, the steward's overview and its SYSTEM-MAP name it;
  `.env.example` says what `TZ` does.

- **Notify me when a firing ends.** Automations stay silent by default, but a
  brief nobody hears about is a brief read ten hours late. Each automation
  can opt in; the push is announced under its name. The shipped *Morning
  review* opts in, and `system_automation_create` takes `notify` and
  `permissionMode`.


## [0.48.3] — 2026-09-05

### Changed

- **The README, the guide and the roadmap describe what Metaclaude has
  become.** The front page still introduced an interface with a memory and a
  schedule; it now tells the three moves — a system that learns, one that
  explains itself, one that stewards itself — and carries a section on the
  steward as it stands: sources in its workspace, rings, pre-approved
  surface, the permission mode as the operator's. The memory bullet says
  retrieval matches meaning on a model that runs on the server; the
  architecture diagram names the knowledge store, the board, the advisor, the
  steward and the gateway; the roadmap records retrieval (0.46.0) and the
  steward's evolution (0.47.0–0.48.2) among what shipped, and states what
  "drafting its own fixes" would and would not mean. The in-app Help renders
  the same files.


## [0.48.2] — 2026-09-05

### Added

- **A schema-derived test over every in-process tool.** The `pinned` defect
  of 0.48.1 was a field a tool accepted and never forwarded, and a per-tool
  test cannot prevent the next one: the field that is dropped is the field
  nobody thought to assert. `kernel/tool-forwarding.test.ts` now reads each
  tool's input schema, drives the tool with every field filled and then with
  each optional field removed in turn, against a facade that records what it
  is asked, and requires every value to arrive — across the system, board,
  proposal and gateway servers, 50 tools. Deliberate drops are listed with a
  reason and fail if they stop happening. Audited the same day: no other tool
  dropped a field; a heuristic pass over the 59 request-body schemas the REST
  routes parse found none either.


## [0.48.1] — 2026-09-05

### Fixed

- **`system_memory_write` now applies `confidence` and `pinned` on a
  creation.** The tool accepted both, the store takes both, and the two
  links between them forwarded four fields of six — so a memory the steward
  asked for as pinned at confidence 1 came back unpinned at 0.7, with no
  error. Reported by Metaclaude itself. An edit by id was never affected.


## [0.48.0] — 2026-09-05

### Changed

- **Metaclaude's permission mode is yours to set.** It was fixed to *Ask* for
  three releases beside the tool lists, which made the steward unable to be
  autonomous by anyone's choice: an operator's *Don't ask* was refused with a
  409 and, had it reached the row, re-set at the next boot. With the shell and
  the editors forbidden and its reach bounded to the pre-approved list, the
  mode decides how much you want to be asked, not what the agent can do — so
  the settings dialog now offers every mode but *Bypass*, the server keeps
  your choice across boots and refuses bypass alone, and the tool lists and
  extra directories stay locked. The steward itself is still refused the
  setting, on every workspace.

- **The shipped *Morning review* runs under *Don't ask*.** Nobody is there at
  eight to answer a card, and the whole reversible surface is pre-approved, so
  the review acts on what it may and is refused the rest instead of leaving a
  card to expire. A review seeded by an earlier release under *Ask* that has
  never fired is brought to the same policy once; one that has run, or that
  you moved, is left alone.


## [0.47.1] — 2026-09-05

### Fixed

- **A run waiting on one of your approval cards is no longer stopped for
  "reporting nothing".** While a card waits for a person the CLI is blocked
  inside the permission callback and emits no message, so the ten-minute idle
  ceiling read the operator's absence as the agent's silence. Found in
  production on the steward's board runs: a `Glob` outside its workspace and a
  `board_get` that 0.46.1 had not pre-approved each opened a card, nobody was
  there, and both runs were killed at ten minutes with the card still on the
  Dashboard — the card's own ten-minute timeout lost the race by two seconds.
  The supervisor now holds the idle clock for as long as a card of the run is
  pending and re-arms it once the card is answered or expires. The absolute
  ceiling is unchanged.


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
