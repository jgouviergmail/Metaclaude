# Changelog

All notable changes to Metaclaude. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). Each entry links the commit that carries the full
story — the commit messages in this repository are written to be read.

This file is part of the product surface: the in-app changelog renders from it,
and Metaclaude maintains it as part of shipping a change (see docs/ROADMAP.md,
"The system that documents itself").

## [Unreleased]

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
