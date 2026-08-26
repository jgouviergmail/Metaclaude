# Changelog

All notable changes to Metaclaude. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). Each entry links the commit that carries the full
story — the commit messages in this repository are written to be read.

This file is part of the product surface: the in-app changelog renders from it,
and Metaclaude maintains it as part of shipping a change (see docs/ROADMAP.md,
"The system that documents itself").

## [Unreleased]

### Added

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
