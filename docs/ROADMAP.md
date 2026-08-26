# Roadmap

What Metaclaude is becoming, and in what order. This file is a contract, not a
wish list: every capability named here is grounded in a surface the installed
Claude Agent SDK actually declares — the file cites them — and every lot ships
under the same regime as the code that exists: TDD, the ratchets, an
adversarial review, and documentation updated in the same commit.

## The thesis: a meta-harness

Claude Code is a superb engine. Metaclaude's job is to be the *harness that
multiplies it*: memory the CLI does not keep, policy the CLI does not learn,
schedules the CLI does not hold, and — increasingly — a system that knows
itself, maintains itself, and puts the owner's whole toolchain behind one
intelligent surface.

Three laws bound everything below. They are not aspirations; the codebase
already enforces the first two and the third is this file's reason to exist:

1. **Inspectable.** A self-modifying system you cannot read is not one you
   should trust. Every learned weight, every memory, every decision has a
   screen, and a Reset.
2. **Self-modification is gated.** The agent never mutates its own host
   directly. Changes to Metaclaude travel the same road as a human's: a
   commit, a green CI, a health-gated deploy, an automatic rollback. The
   sandbox exists precisely to make the shortcut impossible.
3. **Documented as shipped.** Docs, help and changelog are product surfaces,
   regenerated with the change that invalidates them — and `check.sh` already
   fails when a documented log line stops existing in the code.

---

## v0.2 — The system that documents itself

*The owner asked for online help, user documentation and a changelog, kept
current by Metaclaude itself. This lot makes documentation a build output.*

- **In-app user guide.** A Help surface rendered from `docs/` and a new
  `docs/guide/` written for users rather than operators — served by the API,
  searchable with the retrieval stack that already exists (hybrid BM25 +
  vectors is running; pointing it at the docs corpus is configuration, not
  invention).
- **Intelligent help.** "Ask Metaclaude about Metaclaude": a help agent whose
  workspace is the product's own documentation and source, answering with
  citations into the guide. Runs under `plan`-style read-only permissions; the
  help agent can never mutate the host it explains.
- **Changelog in the product.** `CHANGELOG.md` rendered in-app; a release is
  not done until its entry exists. Enforced the way this repo enforces
  everything: a check that fails when a tag lacks an entry, not a convention.
- **Self-maintenance.** The docs-drift guard generalises: every UI screen name
  cited in the guide must exist in the routes; every documented setting must
  exist in `.env.example`. Metaclaude's own release automation regenerates the
  derived pages and refuses to ship when prose and code disagree.

## v0.3 — The ecosystem

*Everything Claude ships, reachable from the interface; everything the owner
already has, importable into it.*

- **Plugin marketplaces.** The SDK takes marketplace declarations and plugin
  installs through the same `Options.settings` channel ultracode opened
  (`extraKnownMarketplaces`, `plugins:[...]`, SHA-256 digests, a headless
  install-progress message to narrate). UI: browse a GitHub `owner/repo`
  marketplace, inspect, install with digest verification, uninstall. The
  Agent Plugins 1.0.0 loader already handles what arrives.
- **Sessions everywhere.** The SDK exports `listSessions()` /
  `getSessionInfo()` — every session in the container's home, enumerable with
  metadata — and carries the cloud-session client underneath (default
  environment ids, `session_`/`ses_` envelope ids, `/teleport` handoffs). In
  order: (1) a browser for the CLI's own sessions with one-click resume into
  a Metaclaude session; (2) import of transcripts carried from another
  machine; (3) linking the owner's claude.ai cloud sessions as first-class
  residents. The owner was right that remote access exists; this makes
  Metaclaude the place it all converges.
- **Visualisation, done properly.** The current charts are inventory, not
  insight. v2 renders the learning system visibly: the bandit's posterior per
  arm over time, retrieval heatmaps (which memories fire, which decay),
  token-flow by workspace against the subscription's own windows — the CLI
  reports its rate-limit buckets per model tier, so the chart shows *the
  actual ceiling*, not a guess. One visual system, both themes, built on the
  product's tokens.

## v0.4 — Guarded autonomy

*Self-knowing, self-healing — with the third law doing the steering.*

- **The doctor.** A diagnostic agent with a read-only surface over what the
  operator already greps by hand: the boot self-checks, the audit chain, the
  health endpoints, container state. "Why is the proxy unhealthy?" becomes a
  question the product answers itself — with the evidence, in the UI. The
  uninstall rehearsal's lesson applies: the doctor must distinguish "the
  guard held" from "the thing never ran".
- **Self-update, through the gate.** Metaclaude watches its own upstream,
  reads the changelog it maintains, and *proposes* updates: a staged deploy
  the owner approves from the phone, executed by the existing tag → CI →
  health-gate → rollback pipeline. The agent drives the pipeline; only the
  pipeline touches the host.
- **Self-knowledge.** Metaclaude's own repository as a resident workspace,
  with the doctor's read-only surface as context: the system can explain its
  own architecture, cite its own traps (CLAUDE.md is written for exactly
  this), and draft its own fixes as branches CI will judge.

## v0.5 — The multiplier

*The visionary lot — each item grounded in a surface that already exists.*

- **Skill synthesis.** Reflexion already extracts durable lessons from runs.
  The step nobody ships: promote a recurring procedural lesson into a *drafted
  skill* — written to the workspace's `.claude/skills/`, flagged for the
  owner's review, measured afterwards by the same reward loop that judges
  models. The system does not just remember how it solved something; it
  packages the method, and the bandit tells you whether the package works.
- **A society of sessions.** The protocol carries inter-session message
  envelopes with linkable session ids. Metaclaude sessions that delegate to
  each other — a research session feeding an implementation session feeding a
  review session — with the transcript showing the society, not just the
  soloist. Ultracode fans out inside one run; this composes *across* runs.
- **The IT-director's morning.** Automations already run on cron with
  accumulated context. Compose them into briefs: overnight CI across watched
  repos, dependency advisories against the fleet's lockfiles, the capacity
  picture from the usage buckets — delivered as one morning session the owner
  interrogates, not a dashboard they decode.
- **Budget-aware orchestration.** The CLI reports its rate-limit windows and
  per-tier utilisation. The scheduler learns to spend them: heavy ultracode
  work lands when the weekly window resets; routine automations degrade to
  cheaper arms as a ceiling approaches; the owner sees the plan before it
  spends. The learner already knows which arm is *good* — this teaches it
  when an arm is *affordable*.
- **The advisor.** The SDK exposes an advisor-model hook and prompt
  suggestions. Wired into the composer, the system that has watched every run
  starts suggesting the next one — including "this is a job for ultracode"
  and, someday, "I have a skill for this; want me to use it?".

---

*Ordering is deliberate: documentation before ecosystem (growth without a
manual multiplies support, not capability), ecosystem before autonomy (the
doctor needs surfaces to read), autonomy before the multiplier (a system that
proposes its own upgrades must first be one that knows itself). Within a lot,
the TDD/ratchet/review regime of CLAUDE.md applies unchanged.*
