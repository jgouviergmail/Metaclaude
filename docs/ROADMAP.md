# Roadmap

Where Metaclaude has got to, and what is genuinely left. This file is a
contract, not a wish list: everything under **Shipped** exists in the product
at the version named, and everything under **What remains** is grounded in a
surface the installed Claude Agent SDK actually declares. Every lot ships
under the regime of CLAUDE.md — TDD with each new test proved able to fail,
the ratchets, an adversarial review, and the documentation updated in the
same commit.

## The thesis: a meta-harness

Claude Code is a superb engine. Metaclaude's job is to be the *harness that
multiplies it*: memory the CLI does not keep, policy the CLI does not learn,
schedules the CLI does not hold, and — increasingly — a system that knows
itself, maintains itself, and puts the owner's whole toolchain behind one
intelligent surface.

Three laws bound everything below. They are not aspirations; the codebase
enforces all three today:

1. **Inspectable.** A self-modifying system you cannot read is not one you
   should trust. Every learned weight, every memory, every decision has a
   screen, and a Reset — and since 0.23.0 the loop that shapes each run is
   drawn *in the transcript where it ran*.
2. **Self-modification is gated.** The agent never mutates its own host
   directly. Changes to Metaclaude travel the same road as a human's: a
   commit, a green CI, a health-gated deploy, an automatic rollback. The
   sandbox exists precisely to make the shortcut impossible. The advisor
   (0.22.0) extends the same principle to proposals: what would *act* the
   moment it existed waits in an inbox for a person.
3. **Documented as shipped.** Docs, help and changelog are product surfaces,
   regenerated with the change that invalidates them — and `check.sh` fails
   when a documented log line stops existing in the code, or when the guide
   sends a reader to a screen that does not.

---

## Shipped

Grouped by what it does for the owner, with the version that delivered it.
The changelog carries the detail; this is the map.

### The system explains itself
- **In-app guide, changelog and search**, rendered from this repository's own
  `docs/` — plus *Ask Metaclaude about itself*, a plan-mode session seeded
  with the guide that answers with citations and executes nothing. *(0.1.0,
  0.2.0)*
- **The loop, made visible.** Every exchange carries a strip naming the
  category the classifier assigned, the model and effort the policy chose and
  who chose them; opening it shows the memories actually injected, the Beta
  posterior of the arm the choice stood on, and the learner's own sentence.
  *(0.23.0)*
- **The memory as a sky.** A constellation where a star's size is its
  confidence and its drift toward the rim *is* the forgetting curve. *(0.24.0,
  refined 0.26.0)*
- **The system's pulse.** The Dashboard opens on what the OS is doing right
  now beside a 24-hour heartbeat. *(0.25.0, moved to the top in 0.26.0)*
- **Posteriors as curves**, not bars: width is doubt, and doubt is why a
  trailing arm still gets trials. *(0.23.0, refined 0.26.0)*

### The ecosystem
- **Plugins (Agent Plugins 1.0.0) and marketplaces**, installed by the CLI
  itself, enabled per workspace. *(0.2.0)*
- **What Claude offers, asked rather than assumed** — models, commands,
  subagents and live MCP connection status, read from the CLI. *(0.2.0)*
- **Session convergence**: adopt a CLI session started in a terminal;
  optionally mirror sessions to claude.ai. *(0.2.0, 0.13.0)*
- **A built-in library** of eight subagents and twelve skills, curated and
  versioned in this repository, installed disabled in one click — with
  **categories** across the whole registry. *(0.21.0)*

### Autonomy, gated
- **The doctor**: every self-check in one read-only pass, including the age of
  the last completed backup. *(0.2.0, backup check 0.17.0)*
- **Self-update through the pipeline**: the app writes a version into an
  exchange directory; a host unit runs the same health-gated, auto-rolling-back
  deploy CI uses. *(0.9.0)*
- **A board that works itself**: fill To do, switch the autopilot on, cards get
  worked one at a time into Review, with a quota guard near the plan's ceiling
  — and Review changes hands explicitly in both directions. *(0.15.0, 0.19.0)*
- **The advisor**: on request or daily per workspace, a run studies recent
  activity, the board and the registry, then creates backlog tickets and
  *disabled* automations directly and files anything that would act into an
  inbox. MCP proposals face a trusted-publisher allowlist enforced
  server-side. *(0.22.0)*

### The multiplier
- **Skill synthesis** from recurring procedural lessons, reviewed before it
  ships. *(0.2.0)*
- **A society of sessions**: depth-one delegation with the transcript showing
  the society. *(0.2.0)*
- **The morning brief**, composed from runs, board, doctor and quota. *(0.2.0)*
- **Ultracode** per message: the CLI's standing multi-agent orchestration,
  offered only where the chosen model can do it. *(0.3.0)*

### The machine around it
- **Backups that take themselves**, with the doctor watching for silence.
  *(0.17.0)*
- **Passkeys** beside password + TOTP, honest about the domain-name limit.
  *(0.18.0)*
- **Self-hosted push notifications** and an icon badge for waiting approvals.
  *(0.14.0)*
- **French**, with the English string as the key and the dictionary in its own
  lazy chunk. *(0.20.0)*

---

## What remains

Deliberately short. Each item names the surface it would stand on.

- **Budget-aware orchestration.** The CLI reports its rate-limit windows and
  per-tier utilisation, and the board autopilot already consults them before
  an automatic start (0.15.0). The step not taken: teaching the *scheduler*
  to spend the windows — heavy ultracode work landing when the weekly window
  resets, routine automations degrading to cheaper arms as a ceiling
  approaches, with the plan shown before it spends. The learner knows which
  arm is *good*; this would teach it when an arm is *affordable*.
- **The advisor in the composer.** The advisor ships as an analysis run whose
  proposals land on the board or in an inbox. The SDK also exposes an
  advisor-model hook and prompt suggestions: the system that has watched every
  run could suggest the *next* one, in the composer, including "this is a job
  for ultracode" and "I have a skill for this — want me to use it?".
- **French, all the way down.** The everyday surface is translated (0.20.0);
  the composer's deeper controls, the workspace settings drawer and the
  secondary pages still answer in English, as does anything the server or the
  CLI produces.
- **A wider docs-drift guard.** Two thirds of this exists: `check.sh` fails
  when a documented log line vanishes from the code (0.2.0), and — since
  0.26.1 — when the guide sends a reader to a Settings screen that is not
  there. Both were written after a real drift: the second after an audit
  found *two* chapters naming screens that had moved or never existed. What
  remains is the rest of the family — every documented environment variable
  existing in `.env.example`, every screen name in the guide resolving to a
  route — so prose and code cannot disagree quietly anywhere, not just where
  someone has already been bitten.
- **Metaclaude as a resident workspace.** *Ask Metaclaude about itself*
  answers from the guide. The fuller version — this repository as a workspace
  with the doctor's read-only surface as context, so the system can cite its
  own traps and draft its own fixes as branches CI judges — is the natural end
  of law 2, and is not built.

---

*Ordering has been deliberate throughout: documentation before ecosystem
(growth without a manual multiplies support, not capability), ecosystem before
autonomy (the doctor needs surfaces to read), autonomy before the multiplier
(a system that proposes its own upgrades must first be one that knows itself),
and — since 0.23.0 — making the intelligence legible before making it wider.
Within a lot, the TDD/ratchet/review regime of CLAUDE.md applies unchanged.*
