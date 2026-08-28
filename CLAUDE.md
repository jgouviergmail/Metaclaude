# Metaclaude

A private, self-hosted agentic OS built on the Claude CLI. Node/Fastify API
supervising Claude CLI subprocesses, plus a React PWA.

## Commands

```bash
pnpm install
pnpm --filter @metaclaude/shared build   # run first — the others depend on it
pnpm build                               # shared → api → web
pnpm typecheck
pnpm test:run                            # 1733 tests, ~30s
./deploy/check.sh                        # the deploy scripts, off-box
node deploy/ratchets.mjs                 # the quality ratchets (also run by check.sh)
```

There is deliberately no `pnpm lint`. ESLint is not installed and no config
exists, so the script that used to be here failed with
`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` — a command that lies about the toolchain is
worse than an absent one. What enforces quality is the four above: `typecheck`
(which covers the tests, see the tsconfig split), `test:run`, `check.sh` and the
ratchets. The ten `eslint-disable-next-line` comments in `apps/web` stay: each
marks a deliberately narrow `useEffect` dependency list beside the comment that
explains it, which is worth keeping whether or not a linter ever reads it.

`deploy/ratchets.json` holds numbers that may only move the improving way.
`--update` records improvements but **refuses to loosen a ceiling** — loosening
one is a hand edit, and the commit must say why.

**Write the changelog entry *into* the empty `[Unreleased]` section, never
above it.** `bump.mjs` leaves a fresh empty `## [Unreleased]` at the top of the
file after each release; inserting a second one above the previous version's
heading produces two, and the script reads the first — finds it empty — and
refuses with "carries no entry". The refusal is correct and the fix is to
merge them, but it costs a cycle every time, and it bit three releases in a
row. Related: `node deploy/bump.mjs … | tail -n` swallows the refusal's exit
code, so a `&&` chain after a *pipeline* continues as if the bump had
succeeded and commits an unbumped version that CI then rejects.

**Every push to main bumps the version.** `node deploy/bump.mjs patch|minor`
moves APP_VERSION, the four package.json files and CHANGELOG.md together, and
refuses while `[Unreleased]` is empty — write the changelog entry first. CI's
version-guard job rejects a main push whose version did not increase, and
tags `v<version>` once the push is green.

Run one package: `pnpm --filter @metaclaude/api <script>`.

Local dev needs the API and web on separate ports; Vite proxies `/api` to
`127.0.0.1:8787`. See the Development section of README.md for the env vars.

## Conventions

**ESM with NodeNext resolution.** Relative imports in `apps/api` and
`packages/shared` MUST end in `.js`, even when the source is `.ts`. The web app
uses the bundler resolver and the `@/` alias instead.

**Contracts live in `packages/shared`.** Every entity is a Zod schema with its
TypeScript type inferred from it. The API validates at the edge with those
schemas; the web app imports the inferred types. Add a field there first, or the
two sides drift.

**Tailwind semantic tokens only.** `bg-surface`, `text-ink`, `text-muted`,
`border-line`, `text-accent`, `bg-accent-soft`, and the state colours with their
`-soft` variants. Never raw palette classes (`bg-gray-800`, `text-blue-500`) —
they break the light theme. Tokens are defined in `apps/web/src/styles/index.css`.

**Migrations are append-only.** Add a new entry to `MIGRATIONS` in
`apps/api/src/db/schema.sql.ts`; never edit a shipped one.

**Comments explain why, not what.** Match the surrounding density. A comment that
restates the code is noise; one that records a decision or a trap is not.

## Things that have bitten before

- **`\b` is ASCII-only.** There is no word boundary between a space and `é`, so
  `\b(évalue)\b` never matches. `apps/api/src/learning/classifier.ts` uses
  `(?<![\p{L}\p{N}_])` lookarounds with the `u` flag. Any new cue must too.
- **The audit chain is ordered by `rowid`, not by timestamp.** Ids carry a random
  suffix and several entries land in the same millisecond; ordering by `(at, id)`
  chains onto the wrong predecessor and reports tampering on an intact log.
- **`Omit` does not distribute over a union.** `apps/api/src/kernel/repositories.ts`
  defines `DistributiveOmit` for transcript events; use it rather than `Omit`.
- **A test that starts below the edge schema cannot see an edge-schema bug.**
  `auth.test.ts` proved recovery codes worked — single use, case-insensitive,
  the lot — by calling `auth.login()` directly. The route rejected them at
  `LoginRequest.safeParse` long before that, so the feature was dead while its
  tests were green. When a contract in `packages/shared` decides what may be
  submitted, test the *contract* too; `packages/shared/src/domain.test.ts` is
  where.
- **`git config --local --list` is not what git obeys.** For a *specific* scope
  git defaults `--includes` to off, so an `include.path` directive hides keys
  from the listing that every other invocation honours — and `$GIT_DIR/config.worktree`
  (via `extensions.worktreeConfig`) is the `--worktree` scope, not `--local`.
  `assertNoExecutableConfig` in `services/git.ts` therefore lists *without* a
  scope, relying on `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null` to
  bound it. It must also pass `pinConfig: false`: `GIT_SAFE_CONFIG`'s `-c`
  overrides land in git's `command` scope, and an unscoped listing that includes
  them hands the guard five keys off its own deny list, refusing every
  repository including empty ones.
- **MCP secrets are merged, not replaced.** The API never returns secret values,
  so an edit form cannot round-trip them. Replacing the set means renaming a
  server destroys its credentials.
- **CSP is `script-src 'self'`.** No inline scripts in `index.html`; put them in
  `apps/web/public/` and reference by path.
- **A `default:` branch over an SDK union silently absorbs whatever ships next.**
  Five of the SDK's ~40 message types were translated and the rest vanished,
  including every message that explains a run's behaviour. `sdk-narrator.ts`
  now requires each one to be narrated or named in `IGNORED_SDK_MESSAGES`, and
  a test reads the union out of the installed `.d.ts` to enforce it. When the
  SDK is upgraded, expect that test to name what is new.
- **`aria-describedby` does not take text *out* of the accessible name.** The
  name of a labelled control is its `<label>`'s text content, so a hint nested
  inside the label is announced as part of the name however it is described.
  Move it out of the label — `components/ui/controls.tsx` does.
- **A Zod schema declared in `domain.ts` ships in the web app's entry chunk.**
  `parseWireFrame` validates socket frames, so `TranscriptEvent`, `Run`,
  `Session`, `ApprovalRequest` and everything they reference are genuinely
  reachable and *should* be there — and because `z.object(...)` is a call
  Rollup cannot prove side-effect-free, *everything else in the same module*
  rides along: `sideEffects: false` only lets it drop a whole unused module,
  never a declaration inside a used one. That is why
  `packages/shared/src/api-contracts.ts` exists: the request/response schemas
  only the API validates live there, nothing in the entry's runtime graph
  imports it, and the whole module vanishes from the bundle (measured: −1.2 kB
  gzip the day it was split). **A new API-only schema goes in `api-contracts.ts`,
  not `domain.ts`** — and nothing the web runs at runtime (`protocol.ts` above
  all) may ever import from it; type imports are fine everywhere.
- **Naming a Vite manual chunk pulls it into the entry's graph.** `index.html`
  then emits `<link rel="modulepreload">` for it, which is the opposite of
  deferring it. Let the dynamic `import()` boundaries derive the chunks; see the
  comment in `apps/web/vite.config.ts`.
- **Caddy reads `{$VAR}` from its own process environment, not from `.env`.**
  Compose reads `.env` to interpolate `${VAR}` *in the compose file*; a variable
  documented in `.env.example`, written by `bootstrap.sh` and named in the
  Caddyfile is still unset as far as Caddy is concerned unless the proxy's
  `environment:` block forwards it — and it then silently takes the
  `{$VAR:default}` written inline. That cost a red CI and a proxy that never
  went healthy. `deploy/check.sh` now asserts the forwarding generically, so a
  new variable fails the day it is added.
- **`default_sni`/`fallback_sni` must name a site that exists.** They choose
  among the *configured* certificates; pointing them at a third address leaves
  nothing to fall back to and the handshake dies with `tlsv1 alert internal
  error` before a log line. `METACLAUDE_SNI_DEFAULT` therefore defaults to
  `METACLAUDE_SITE` rather than to a constant.
- **`dataDir` and `workspacesDir` may not contain one another, and `loadConfig`
  refuses to start if they do.** The image used to ship
  `METACLAUDE_WORKSPACES_DIR` *inside* `METACLAUDE_DATA_DIR`, so every workspace
  sat one `..` from `master.key` and any check phrased as "is this inside the
  data directory?" was true for every legitimate workspace path — which is how
  `additionalDirectories` came to reject everything in production while every
  test used a sibling layout. They are now `/var/lib/metaclaude` and
  `/srv/metaclaude/workspaces`. Any new containment rule still needs a case in
  `security/directories.test.ts` under the layout that actually ships.
- **A derived value that is *stored* stops being derived the moment its input
  changes.** `workspaces.path` is `resolve(workspacesRoot, slug)` at creation
  and nothing updates it, so moving the root left every row naming an address
  the volume no longer mounts — with no crash, because each guard just answers
  "outside the root" and refuses. The failure reads as data loss while the files
  sit untouched in the volume. `relocateWorkspaces` runs at boot and re-points
  rows whose directory is named after their slug; anything else it reports and
  leaves alone, because there is nothing to derive the new location from.
- **A `docker exec` healthcheck needs something to reap it.** Docker runs a
  healthcheck through `docker exec`; a `CMD-SHELL` probe forks, and whatever
  outlives its shell is reparented to PID 1 *inside* the container. Caddy is the
  proxy image's PID 1 and does not reap — no reason it should, it never forks —
  so every probe leaked one task. Nothing shows until the cgroup's pids ceiling
  is hit, about five hours at a 5s interval; then `runc exec` cannot fork into a
  full cgroup, fails with `procReady not received`, and the healthcheck can
  never pass again. The container reads `unhealthy` forever *while serving
  perfectly*, which is what makes it hard to see, and both `up --wait` and the
  deploy health gate fail on a working site. Found in production at 3643 tasks
  of a 3647 ceiling with one live process. `init: true` on the proxy; the app
  image already ships tini. `check.sh` asserts every service with a healthcheck
  has one or the other.
- **Under `set -e`, an assignment from a failing command substitution exits the
  script.** `VAR="$(sed … file | tail -1)"` with pipefail dies when the file is
  absent — and uninstall.sh died exactly there, after removing the systemd
  units and *before* saving `.env` or deleting the tree. CI's uninstall
  rehearsal caught it; local runs skip that section without root, so a change
  to uninstall.sh is only really tested where docker and root exist. Guard the
  read (`[ -f ] || default`), never bolt `2>/dev/null` onto a pipeline and
  call it handled.
- **A check that cannot tell "the guard held" from "the script never ran" proves
  nothing.** The uninstall rehearsal asserted three promises; on CI the script
  refused at its own root check, and two assertions *passed on the inert
  outcome* — the volume survived because nothing touched it. Same family as the
  edge-schema trap: the test must first establish that the thing under test
  actually executed. The rehearsal now escalates via sudo or emits an explicit
  skip naming what was missing.
- **A ratchet that greps text cannot tell code from prose.** Writing
  `bg-gray-800` inside a *comment* explaining the raw-palette rule trips the
  raw-palette ratchet. Say `bg-gray-<n>`.
- **`import.meta.glob` over absent files matches nothing rather than failing.**
  The web bundle reaches *outside* `apps/web` — `docs/guide/*.md` and the root
  `CHANGELOG.md` via `src/lib/help.ts` — and the Docker build stage copied only
  `packages/` and `apps/`, so production served a Help screen whose sections
  rendered empty while build, tests and every check stayed green. The
  Dockerfile now copies both, and `apps/web/vite.config.ts` refuses to build a
  tree missing the corpus. Anything new the bundle pulls from outside `apps/`
  needs a line in both places.
- **A read-then-decide-then-write on the user row is a race, not a check.**
  `login()` verifies the password with scrypt — ~100 ms — and everything after
  it decides against the row snapshot taken *before* that. Two concurrent
  logins with one TOTP code both got sessions, and two with one recovery code
  both got sessions while consuming a single code; "strictly single-use" was a
  property of the sequential case only. `consumeSecondFactor` now makes the
  write *be* the check, with the condition in the `WHERE` and `changes === 0`
  meaning someone else got there first.
- **A relevance gate relative to the best hit fails when everything is noise.**
  fts5 clamps a term's IDF at 1e-6, so a query of nothing but stopwords scores
  every row at ~0 — and `best * fraction` is ~0 too, admitting the whole corpus.
  It also drops genuine matches for being *long* rather than irrelevant, and the
  cut moves when unrelated rows shift the average document length. The lexical
  arm uses an absolute floor (`MIN_ABSOLUTE_BM25`); the four-orders-of-magnitude
  gap it relies on is the clamp, not the corpus.
- **Undoing an EMA step algebraically assumes nothing happened in between.**
  `(c' - lr·rp)/(1 - lr)` is the exact inverse only if the memory has not moved
  since; six other reinforcements later it over-corrects, and `clamp01` on that
  intermediate value erases the history outright. `reinforce` moves by the
  *change in reward* instead, which agrees with the inverse wherever nothing
  clamps and is bounded by `lr` everywhere else.
- **A path check is a check on a name.** `reviewAdditionalDirectories` compared
  lexical paths, so a symlink named like a workspace granted the agent the
  directory it pointed at — the master key included. Both roots and the
  candidate go through `safeRealpath` now. What no path check can bound is a
  link the agent creates *inside* a directory it was already granted; that is a
  property of directory grants, `security/directories.test.ts` asserts it as a
  limit rather than pretending otherwise, and docs/SECURITY.md says so.
- **The web app's `maxPayload` is the frame-size control, not the app check.**
  `server.ts` sets ws's own limit, so an oversized frame closes with the
  standard 1009 and the `raw.length > 64 * 1024` branch in `ws.ts` is a backstop
  that only becomes reachable if the two figures diverge. Keep them in step.
- **A fixed height and a safe-area padding on the same element fight, and the
  padding wins.** With border-box sizing, `h-14` *plus*
  `padding-bottom: env(safe-area-inset-bottom)` leaves 56 − ~34 = 22px of
  content on a gesture-nav iPhone, and flexbox crushes the icons into it —
  while every browser tab and every Android install (inset 0) looks perfect,
  which is what made this ship broken twice. One layer per inset, never two:
  the phone tab bar owns the bottom inset alone and paints the home-indicator
  zone with its own surface, its inner row owns the height, `<main>` reserves
  the total, and `body` pads only the notch and the sides. `AppShell.test.tsx`
  pins both halves. A symptom that appears only in the installed app is nearly
  always an inset that is 0 everywhere you tested.
- **jsdom's CSSOM silently drops `env()`.** `style={{ paddingBottom:
  'env(safe-area-inset-bottom)' }}` renders correctly in a browser and reads
  back as `''` in a test, so the invariant cannot be asserted — which is how
  the trap above survived a test suite. Express such values as Tailwind
  classes (`pb-[env(safe-area-inset-bottom)]`), which are readable from
  `className`. Same family: `import('…?raw')` returns empty and
  `new URL(…, import.meta.url)` is an http URL under vitest — read a source
  file with `readFileSync('src/…')`, relative to the package root.
- **Radix activates on the pointer event, not on click.** Menus open on
  `pointerdown`, tabs switch on `mousedown`. `fireEvent.click` alone does
  nothing in jsdom; fire the pointer event first. Costs a red test that looks
  like a broken component every single time.
- **Capping a list before sorting it keeps an arbitrary subset, not the first
  one.** `FileService.list` caps a directory at `MAX_DIRECTORY_ENTRIES`, and the
  cap has to come before the `stat` per entry or the payload shrinks while the
  latency stays — but the first version also came before the *sort*, and
  `readdir` returns a hashed directory in no order at all. A capped folder
  therefore showed a thousand arbitrary names, dropped its subdirectories
  outright, and showed a *different* thousand after any file was created. Order
  by whatever the cheap source already carries — a dirent has both the name and
  the kind, so only size and mtime need the syscall — then cap, then pay.
- **A comparator that branches on "the types differ" contradicts itself as soon
  as there are three types.** `if (a.type !== b.type) return a.type ===
  'directory' ? -1 : 1` answers +1 both ways round for a symlink against a
  file. `sort` does not throw on that; it lands wherever its merges take it, so
  the alphabet silently breaks around a link. Rank, then compare within the
  rank — `compareForExplorer` in `services/files.ts`, with an antisymmetry test
  over every pair of kinds.
- **Two SVGs on one page share an id namespace.** A `<linearGradient
  id="fill">` in a component rendered twice makes the second instance
  reference the first's gradient — invisible until a page shows two arms or
  two curves. Every gradient, mask and filter id goes through React's
  `useId()`; the visual components do this already, so copy the pattern rather
  than a literal id.
- **The nearest enclosing function is not the component.** A codemod that
  inserts `const t = useT()` beside the call it introduced puts the hook inside
  `onSuccess: () => {…}` or `rows.map(row => …)` — a callback, where React
  throws on the first call, outside render. Forty-five of those shipped into one
  working tree: TypeScript is happy, the component renders in every test that
  does not reach the branch, and there is no ESLint here to carry
  `react-hooks/rules-of-hooks`. Walk up to a function *named* in PascalCase or
  `useSomething`; the `misplacedHooks` ratchet counts the rest.
- **A translation that is not a whole sentence is not translated.** Three
  shapes escape a check that only knows `t('…')`: both arms of `plural(n, one,
  other)`, copy held as a module constant and translated at render
  (`t(entry.label)` — the *correct* pattern, and invisible), and any literal
  that never reaches `t()` at all, which is every toast and every
  `cond ? 'Archive' : 'Restore'`. `deploy/ratchets.mjs` has one measure per
  shape; `--list` prints what each one found. And pluralise with `plural()`,
  never a ternary: `n === 1` is an English rule, French keeps the singular at
  zero, and the ternary silently stays English once the sentence is translated.
- **`attr=t('x')` is not JSX.** A codemod replacing a string literal has to know
  whether it sat in `attr="x"` (needs braces) or inside `attr={…}` (already has
  them). The parser reports the resulting error lines away from the edit, in a
  file that looks structurally broken.

## Testing

Vitest, colocated as `*.test.ts`. Use `openDatabase({ path: ':memory:' })` +
`migrate(db)` for anything touching the database. Drive time with explicit `now`
arguments or `vi.useFakeTimers` — never `sleep`. Pass a seeded PRNG to
`PolicyLearner` for determinism.

Note that `hashPassword` costs ~100 ms (scrypt N=2¹⁶); keep the call count low.

Tests must not spawn the Claude CLI or hit the network.

**Component tests** (`apps/web`, `*.test.tsx`) render through
`renderWithProviders` from `@/test/render`, never RTL's bare `render`: the app
wraps everything in React Query, the router and `TooltipProvider`, and a
component that reaches for one of them throws when rendered bare. Add a provider
to `main.tsx` and you add it there too. `src/test/setup.ts` registers RTL's
`cleanup` — without it a second `render` stacks in the same document and the
failure surfaces as "found multiple elements" on an unrelated query.

**The kernel** has a fixture in `kernel.test.ts`, deliberately half real: the
database, repositories and event bus are genuine against an in-memory SQLite,
because what is worth testing lives in the gaps between the kernel and its
storage. The learning collaborators are fakes. The supervisor fake can be *held
open* — `supervisor.hold()` then `finish()` — which is the only way queueing, the
reservation window and cancelling a not-yet-started run are observable at all.

**Prove a new test can fail.** Break the line it covers, watch it go red, then
put the line back. Three of the kernel tests were written against code that
already worked, and only a deliberate sabotage of each showed they were testing
the thing they claimed to.

`apps/api/scripts/shots.mjs` is the design bench, not a check: it boots the
real server, seeds a lived-in deployment (memories with a history, a day of
runs, policy arms with distinct posteriors, a full board) and screenshots
every key screen in both themes and on a phone. Nothing asserts — the output
is for eyes. Run `pnpm build`, then
`PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium node scripts/shots.mjs <dir>`
from `apps/api`. Any change to a visual is judged against those images before
and after; the aesthetic pass in 0.26.0 was made entirely that way, and the
first capture is what revealed the hero shipping below the fold.

The two checks that *do* need a live agent live in `apps/api/scripts/` and are
run by hand (`check:e2e`, `check:browser`). They boot the real server against a
throwaway data directory, so they exercise the deployed code path rather than a
test double — the guards, the migrations, the static handler and the CSP. Add to
them when a change is only observable end to end: a socket that reconnects, a
tap target, a CSP violation.
