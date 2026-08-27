# Changelog

All notable changes to Metaclaude. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). Each entry links the commit that carries the full
story — the commit messages in this repository are written to be read.

This file is part of the product surface: the in-app changelog renders from it,
and Metaclaude maintains it as part of shipping a change (see docs/ROADMAP.md,
"The system that documents itself").

## [Unreleased]

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
