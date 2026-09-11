# Metaclaude

A private, self-hosted agentic OS built on the Claude CLI. Node/Fastify API
supervising Claude CLI subprocesses, plus a React PWA.

## Commands

```bash
pnpm install
pnpm --filter @metaclaude/shared build   # run first — the others depend on it
pnpm build                               # shared → api → web
pnpm typecheck
pnpm test:run                            # 2440 tests, ~60s
pnpm verify                              # the four above, in the order CI runs them
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

`pnpm verify` exists because remembering the four is not a strategy: a green
`vitest` run is not a green typecheck, and a test file that CI rejected on
`tsc` had a green suite here — twice. It runs typecheck, tests, build and the
ratchets in the order CI does, so the first thing that fails is the first thing
CI would have failed on. The two browser guards stay separate: they need a
build and a browser, and take minutes.

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
- **A heredoc collapses \\ to \, so a JS regex written through one loses its
  word boundary.** `const RE = /\bfoo/` written from a `python - <<'PY'` block
  reaches the file as `/<0x08>foo/` — a *backspace*, invisible in every diff,
  in a regex that then matches nothing and a ratchet that reports a
  comfortable zero. It happened three times in one session while adding
  measures to `deploy/ratchets.mjs`, and once more inside the entry written to
  document it. A raw string does not save you: the collapse happens before
  Python sees the source. Build the sequence from character codes instead —
  `chr(92) + "b"`, or `bytes([92, 98])` — or edit the line with a tool that
  does not go through a shell. What catches it after the fact is
  `controlBytesInSource`, which is the second reason that ratchet earns its
  place; and never trust a new measure that reads zero on its first run —
  sabotage it and watch the number rise.
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
- **happy-dom's CSSOM silently drops `env()`.** `style={{ paddingBottom:
  'env(safe-area-inset-bottom)' }}` renders correctly in a browser and reads
  back as `''` in a test, so the invariant cannot be asserted — which is how
  the trap above survived a test suite. Express such values as Tailwind
  classes (`pb-[env(safe-area-inset-bottom)]`), which are readable from
  `className`. Same family: `import('…?raw')` returns empty and
  `new URL(…, import.meta.url)` is an http URL under vitest — read a source
  file with `readFileSync('src/…')`, relative to the package root.
- **Radix activates on the pointer event, not on click.** Menus open on
  `pointerdown`, tabs switch on `mousedown`. `fireEvent.click` alone does
  nothing in happy-dom; fire the pointer event first. Costs a red test that looks
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
- **`./deploy/check.sh` green on your machine is not `check.sh` green.** Its
  shellcheck section is guarded by `command -v shellcheck`, so a machine
  without the tool prints one `skip` among eighty passes and reads as a clean
  run. CI has it: 80 passed / 9 skipped locally was 105 passed / **2 failed**
  there, and the two were SC2034 warnings that cost a release its tag. The skip
  is correct — the check genuinely cannot run — but the local run is then
  answering a smaller question than the one that gates a push. Shellcheck needs
  no root: unpack the release tarball into `~/sc` and put it on `PATH`. Run it
  the way `check.sh` does, `-x --severity=warning`; the default severity adds
  `info` notes that CI does not fail on.
- **A backtick in a SQL comment ends the migration.** `MIGRATIONS[].sql` is a
  template literal, so `` -- compared with the callback's `iss` `` closes the
  string and the parser then reports "',' expected" somewhere below, in a file
  that looks structurally broken. Same family as the heredoc trap: write the
  identifier without backticks, or the whole schema stops compiling.
- **`attr=t('x')` is not JSX.** A codemod replacing a string literal has to know
  whether it sat in `attr="x"` (needs braces) or inside `attr={…}` (already has
  them). The parser reports the resulting error lines away from the edit, in a
  file that looks structurally broken.
- **`request()` in `apps/web/src/lib/api.ts` serialises the body itself.** A
  caller passing `body: JSON.stringify(x)` encodes it twice, the API parses a
  JSON *string* where its schema wants an object, and the error reads
  "expected object, received string" — from the edge, about a field that looks
  fine. It shipped in the token screen and made the whole feature unusable
  while fourteen end-to-end tests stayed green, because they all call `fetch`
  directly and never touch this file. `api.test.ts` now reads the source for a
  second `JSON.stringify` and drives one call to parse what reaches the wire.
- **A test that replaces `window.location` must put it back.** One case swaps
  it for a stub to intercept `assign` — happy-dom cannot navigate — and without an
  `afterEach` restore, every case after it runs against a frozen object. Worse
  than flaky: the callback test asserting the query string gets *cleared*
  passed on a stub whose `search` was already `''`, so it proved nothing for
  releases. Capture the descriptor at module level and restore it; and make a
  test establish the state exists before asserting it goes away.
- **happy-dom does not implement `<details>` hiding.** Children of a *closed*
  `<details>` are findable, visible and clickable in a test, so `toBeVisible()`
  passes just as happily on a card that never folds. Assert the element's own
  `open`. Same family as the `env()` trap below: assert what the DOM actually
  carries.
- **A Streamable HTTP client treats `405` as normal and everything else as an
  error.** It opens a `GET` looking for a server-initiated stream; the spec
  lets a server answer `405` to say it has none, and the reference client
  returns quietly on exactly that status — a `404` from an unregistered method
  becomes a thrown `StreamableHTTPError`, so a conforming client reports a
  broken server while every request works. Register the method and answer
  `405`; a comment claiming it is not the same thing, and was wrong here for a
  release.
- **The kernel keeps a finished run's final text only for a caller that said it
  would wait.** The text exists nowhere but memory when a run settles, so it is
  stashed — and the predicate used to be the run's *kind*, which broke the day
  `start_run` began starting runs and walking away. Nobody consumed the stash,
  and an automation polling every minute grew the map all day. `SubmitOptions.awaited`
  is declared by the caller, synchronously in `submit`, before anything can
  settle. Related: a run cancelled while *queued* never reaches the supervisor,
  so its waiter has to be settled from the cancellation path or it blocks for
  the full timeout on a run that is already dead.
- **`waitFor` over a negative assertion is satisfied on its first poll.**
  `await waitFor(() => expect(mock).not.toHaveBeenCalled())` returns
  immediately and proves nothing; so does asserting on the DOM right after
  waiting on a mock's call count, because the call lands before React has
  re-rendered. Two cases written that way passed against the very bugs they
  were written for. Wait on a *positive* signal the change would produce — a
  rendered value, a second fetch's result — or assert synchronously on
  something already true.
- **React Query shares structure: an identical refetch returns the *same*
  array.** An effect keyed on `query.data` therefore does **not** re-run when
  a background fetch answers with unchanged contents, and a "fix" keying it on
  a signature of the values is insurance against a bug that is not there. It
  was written here, could not be made to fail under any sabotage, and was
  removed. When a sabotage cannot turn a test red, suspect the premise before
  the test.
- **A zero-delay timer is not "no timer".** `setTimeout(fn, 0)` guarding a run
  fires before `query()` is called, and an already-aborted signal reaches no
  listener the SDK registers afterwards — so the abort is invisible to the CLI
  and the run finishes as a *success* having been stopped. Any ceiling whose
  `0` means "off" must skip creating the timer entirely.
- **The CLI is never silent for long while anything is happening.** Measured:
  during a tool call that ran for 100 seconds it emitted `tool_progress` every
  30 seconds, plus `task_started` and a rate-limit event. That is what makes an
  *idle* ceiling usable where a wall-clock one is not, and why nothing has to
  special-case a tool being in flight. **Except a tool waiting on a person**:
  while an approval card is pending the CLI is blocked inside `canUseTool` and
  emits nothing, so the idle ceiling stopped a production run "for reporting
  nothing for 10 minutes" with its card still on the Dashboard — and
  `APPROVAL_TIMEOUT_MS` is the same ten minutes, so the card's own denial lost
  the race by two seconds. `canUseTool` holds the idle clock (`LiveRun.holdIdle`)
  until the broker answers.
- **`MenuItem` with `selected` renders `menuitemcheckbox`, not `menuitem`** —
  deliberately, so a chosen entry is announced as chosen. A test querying
  `getByRole('menuitem')` on a picker finds nothing and reads as a menu that
  never opened. And there is no `jest-dom` here: `toBeDisabled` is not a
  matcher, assert `(el as HTMLButtonElement).disabled`.
- **`z.object({…}).partial()` still fires every field's `.default()`.** It reads
  as "absent means untouched" and it is not: a patch naming one field parses
  into an object carrying all the others at their defaults, and a repository
  that merges it over the stored row resets every one of them. Measured, on the
  control an operator touches most: the automations list toggles a row with
  `PATCH { enabled }`, `AutomationInput.partial()` delivered
  `description: ''`, `continuous: false` and `maxConsecutiveFailures: 3` with
  it, and turning an automation off wiped its description, ended its continuous
  loop and reset its failure ceiling. `patchSchema` in `api-contracts.ts` strips
  the default before making the field optional; the `defaultingPartials` ratchet
  is an AST measure (a text search would report this bullet) and its ceiling is
  zero, because there is no remaining case here where `.partial()` is right.
- **A server-side tool is not covered by `--allowedTools`.** Under `dontAsk`,
  the SDK's `allowedTools` let `WebFetch` through and left `WebSearch` refused:
  `WebSearch` executes upstream rather than in the CLI, and only a *permission
  rule* reaches it. Pre-approval therefore rides
  `managedSettings.permissions.allow`, which is also the one tier
  `allowManagedPermissionRulesOnly` still honours. Related, and the reason this
  took two attempts: a probe that offers the model **both** web tools measures
  whichever one it picks. It picked `WebFetch` every time, the run came back
  green, and the conclusion was wrong for four measurements running. Name the
  tool in the prompt, or offer only the one under test — and prefer an
  end-to-end run through `AgentSupervisor` over a bare SDK probe, because that
  is what caught it.
- **A bare tool name in a pre-approval skips the broker in *every* mode.** The
  SDK says so (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) and it is measured: in `Ask`
  mode, `allowedTools: ['WebFetch']` fetched a page with no approval card at
  all. So the CLI is told only in `dontAsk`, where it answers before
  `canUseTool` can be reached; every other mode goes through
  `PermissionBroker`, which is what keeps the decision and its transcript line
  inside Metaclaude. `plan` pre-approves nothing at all.
- **A row of `flex-1` buttons cannot shrink below its own text.** Four trigger
  buttons in one `flex` row overflowed the automation dialog on a 360px screen
  — no wrap, no scroll — so the fourth was off-screen and an event trigger
  could not be chosen *or seen* on a phone. It read as a missing feature, and
  was first diagnosed as stale data. French is where it shows:
  `Planifié · Intervalle · Manuel · Événement` is half again the English. A
  segmented row gets `grid grid-cols-2 … sm:grid-cols-N`, never a bare `flex`.
  happy-dom has no layout, so what a test can hold is the class contract on the
  row — the same reasoning as the `env()` trap. And the label inside such a
  button is `hidden sm:inline`, which is `display: none`: hidden text is out
  of the accessible name, so every one of those buttons needs its own
  `aria-label` or it is unnamed on the phone where the label is gone.

- **A JSON list of ids is a foreign key nothing enforces.** A gateway token's
  `workspace_ids` kept naming a workspace that had been deleted, so the
  gateway — which filters the workspace list by exactly those ids — answered
  an *empty list*, and the program holding the token told its operator this
  Metaclaude had no workspaces. Two rules came out of it: whatever holds ids
  in JSON needs an explicit prune where the referent is deleted
  (`ApiTokenService.forgetWorkspace`), and a filtered listing that comes back
  empty must say *which* emptiness it is — nothing there, or nothing you may
  see — because the caller cannot tell them apart and will pick the wrong one.
  Related: the repair has to exist. The store could edit a token's grants and
  no route exposed it, so a pruned grant could only be fixed by revoking the
  credential every client held.

- **A re-hydration mid-stream must not discard what is not persisted yet.**
  The session store's `load` cleared every streaming buffer, and the session
  query is invalidated whenever the socket reconnects — so a refetch during a
  run threw away the text streamed since the last persisted block. On screen
  the reply jumped *backwards* to what the transcript held and became whole
  again only when the run ended, which reads as the model retyping itself.
  `load` now keeps the buffers of the same session minus the blocks whose
  authoritative event has landed. Related, same screen: `staleTime: Infinity`
  makes data eternally fresh, so React Query's default refetch-when-stale
  never fires and reopening a session showed it as it was when last closed —
  the socket keeps an *open* session current, it cannot fill in what was
  missed while nobody watched. `refetchOnMount: 'always'` is what a
  never-stale query needs.

- **A route that re-declares a shared shape strips what its copy forgot.**
  `routes/registry.ts` carried its own `AutomationPolicy` — the same five
  fields, hand-written — and never gained the sixth, `notify`. Zod objects
  drop unknown keys silently, so the checkbox was posted by the browser,
  thrown away at the edge with no error, and the automation ran mute while
  the form went on showing it enabled until the page was reloaded. The web
  test asserting the form posts `policy.notify` passed the whole time, which
  is the edge-schema trap again from the other side: it proved the browser
  sends it, never that anything accepts it. Validate from the one definition
  — `AutomationPolicy` is exported from `packages/shared` and imported by the
  route and by the scheduler's defaults — and cover it with a test that
  *derives* its sample from the schema, so a new field fails on the day it is
  added: `routes/automation-policy.test.ts`.

- **A green vitest run is not a green typecheck.** Vitest strips types; it
  never checks them. A test fixture typed
  `Partial<TranscriptEvent & { kind: 'result' }>['usage']` — which is the
  *whole* usage type, `Partial` having been applied to the event, not to the
  field — ran perfectly and failed `tsc`, so the suite was green here and CI
  was red on both the typecheck and the build. The version it belonged to was
  therefore tagged by nothing and never shipped. `pnpm typecheck` is what
  covers the tests (see the tsconfig split); run it after touching any
  TypeScript, tests included. Same family as the `check.sh` entry above: the
  local run was answering a smaller question than the one that gates a push.

- **The i18n ratchets require a capital first letter, and that is deliberate.**
  Relaxing `SENTENCE` surfaces 76 candidates here, about seventy of them
  Tailwind class strings — `flex items-start gap-2` is indistinguishable from
  prose by any cheap rule. So lowercase copy escapes all three measures, and it
  is real copy: `QUESTION_NAMES` interpolated "models, slash commands" into a
  French sentence for releases. The `halfTranslatedTables` measure closes the
  case that regresses, with no false positives: a module-level table whose
  string values are *already* in the catalogue is copy by demonstration, and
  every one of its values must be.

- **A threshold that no test ever reaches is a feature that does not exist.**
  `remember` merges a near-duplicate above 0.92 cosine, is documented as the
  thing that stops the corpus degenerating, and has four passing tests. On the
  hashing embedder that ships by default, the *highest* similarity between any
  two memories of a real deployment was **0.51** — while a third of that corpus
  was semantically redundant. Every merge test used byte-identical text, so
  they proved the branch executes and never that the threshold is reachable.
  Same family as the edge-schema trap: when a constant decides whether code
  runs, one test has to approach it from where the real inputs actually sit.
  And no threshold fixes it — 0.15 catches every true pair and fifty-eight
  false ones out of seventy-seven, so `learning/consolidation.ts` shortlists
  with the cosine and *asks a model*.
- **"Somewhat similar" is transitive and meaning is not.** Union-find over the
  neighbour graph at 0.25 swallowed eight unrelated memories of that corpus
  into one component, and fifteen of twenty-two at 0.20. Group around a centre
  instead — a star cannot chain. But one star per member is not enough either:
  a cluster of four produces four *overlapping* stars, which is four model
  calls for one question and four competing proposals of which applying any one
  leaves the other three stale. Drop a group that shares more than half its
  members with one already kept. Both numbers were measured by replaying the
  production corpus through the real pass, and neither was visible from a unit
  fixture — a three-member cluster produces identical stars, so the overlap
  never appears until there are four.
- **`ORDER BY <timestamp> DESC` is not a total order.** Several memories written
  by one run share a millisecond, and in the consolidation pass the read order
  decides which memory anchors a cluster, hence its members, hence its key —
  so two sweeps over an unchanged corpus formed *different* groups and the key
  that suppresses an answered question matched nothing. It surfaced as a test
  failing two runs in five. Add `rowid` wherever the order is load-bearing;
  same family as the audit chain's ordering.
- **A fingerprint of a fresh read proves nothing about what was judged.** The
  consolidation arbiter is awaited, so a memory can be edited while the call is
  in flight. Fingerprinting the row *afterwards* records agreement with an edit
  the merged wording was never written against, and the apply route — whose
  entire job is to refuse a plan drawn against text that has since moved —
  waves it through and drops the edit silently. Fingerprint the snapshot the
  model was shown.
- **A model can only decide about what it was shown.** Its answer becomes the
  surviving text, so judging a longer memory on a prefix folds the tail away
  into a note derived from that prefix — approved by an operator shown the same
  prefix. `ARBITER_EXCERPT` bounds what is shown *and* excludes anything longer
  from being grouped at all.
- **`listInsights` filters `workspace_id IS ?` exactly.** No union with the
  globals, unlike the memory list — so a row filed under `NULL` is invisible
  from every workspace view. File a proposal under the project it is *about*,
  which is not necessarily its survivor's tier.
- **An exhaustive `Record` notices a new case; a ternary chain does not.**
  `INSIGHT_TONE` on the Memory page failed the build when `Insight['kind']`
  gained a member. The Dashboard spelled the same mapping as
  `kind === 'failure' ? … : …` and silently gave the new kind a lesson's
  colour. Two spellings of one table is the bug; `lib/insights.ts` is the fix.
- **The i18n copy-table measures only saw object literals.** An *array* of rows
  — the maintenance actions, the git panel's sections, the shell's navigation —
  was not scanned at all, so adding an untranslated row to a translated table
  was invisible. Generalising it needs care: a record puts identifiers in the
  keys and copy in the values, an array puts both in values, so judge one
  property at a time and require a capital first letter, or every route path and
  cron expression in the app is indicted.
- **A guard on "the field is present" refuses the form that round-trips
  it.** The workspace settings dialog sends the *whole* settings object
  back with one field changed, so the system workspace's guard, first
  written as "refuse a patch naming a safety setting", turned every save of
  its language into a 409. Refuse on a *different* value, never on
  presence — and write the test that sends the stored object back unchanged.
- **`content-type: application/json` over an empty body is a 400.** Fastify
  refuses it before the handler, so a test helper that always sets the
  header reports a `DELETE` guard as broken. Send the header only with a body.
- **"The most recent session" is not a total order.** Two sessions rotated
  in one millisecond share `last_activity_at`, and a card naming the newer
  one flipped between runs. Same family as the audit chain's `rowid`: pick
  by the semantics the caller needs — the one answering, else the one with
  room — not by recency alone. And a rotation test whose newest session is
  also the first in list order proves nothing about the ceiling; make both
  standing sessions unavailable so a third is the only right answer.
- **A tool that is mounted and not pre-approved is a card in `default` mode
  and a refusal under `dontAsk`.** The system workspace pre-approved its own
  `system_*` table and nothing else, while the supervisor mounted the board
  and proposal servers for its runs too — so the steward could not file a
  ticket on its own board without a person watching, and its scheduled
  review was refused the same tools outright. Whatever a workspace's runs
  are given, its pre-approval list has to name in full; each tool server now
  exports a catalogue, a test holds it to what the server registers, and
  `context.ts` pre-approves the union. Related: the steward's extra
  directories are bounded to the workspaces root like everyone's, so the
  code it reads is *copied* into its workspace (`SOURCE_TREES`), never
  granted — pointing it at `apps/api/dist` cost a card per file.
- **A tool schema that accepts a field its handler does not forward is a
  silent no-op.** `system_memory_write` declared `confidence` and `pinned`,
  the store took both, and the handler and the facade between them each
  forwarded a hand-picked subset — so a memory asked for as pinned at 1 came
  back unpinned at 0.7 with no error, and only the steward noticed. Same
  family as the edge-schema trap: when a schema names a field, one test has
  to follow that field to the row. `kernel/tool-forwarding.test.ts` now
  derives that test from the schemas: every in-process tool is driven with
  every field filled, then with each optional field removed in turn, against
  a recording facade, and every value must arrive. The "each optional
  removed" family is not optional — filling everything drives `id`-or-create
  tools down their edit branch only, and the first version of that test
  passed on the very bug it was written for.
- **A trigger the schema accepts and nothing emits is a promise on screen and
  silence underneath.** `AutomationTrigger` named four events since the
  first release; `computeNextRun` returned null for them and no code path
  ever fired one, so an automation on `run_failed` showed *enabled* and stayed
  mute — indistinguishable from a deployment where nothing failed. Same
  family as the unforwarded field: an enum member is a claim, and one test has
  to make the thing happen and watch it fire. `run_failed`/`run_succeeded`
  now have an emitter in `Scheduler.onRunFinished`; the other two are refused
  at creation, and `EMITTED_AUTOMATION_EVENTS` is the list a new emitter
  extends.
- **A pinned memory is not an injected one.** The search scores only what its
  two arms already found, so a pinned "propose defaults rather than ask" was
  never recalled for a request about deployments — the +0.35 prior ranks, it
  does not retrieve. A convention has to reach the run whether or not the
  prompt resembles it: `MemoryStore.standing()` and `selectStandingContext`
  inject the standing shelf whole, and the similarity search excludes it or
  the same rule arrives twice.
- **A gate test that fills every field drives one branch of every tool.** The
  first version of the memory gate's test passed on the exact defect it was
  written for, because `system_memory_write` with `id` set is an *edit* that
  spreads its arguments — the creation branch that hand-picked four fields of
  six was never reached. Same lesson in `tool-forwarding.test.ts`: every
  optional removed in turn, not only everything filled. And the same for the
  gate's own measurement: the per-note simulation kept three to five wrong
  notes, the real batched call kept up to nine — measure the call that ships,
  with the instructions it will actually be shown, never a stand-in. And when
  the rules stop moving the number, change the model before the prompt again:
  sonnet landed on the same four or five as haiku, which said the residue was
  in the notes, not the judge.
- **A class declared beside `vi.mock` is in its temporal dead zone when the
  factory runs.** The factories are hoisted above every top-level statement,
  so `ApiError` defined at module level and referenced from the factory
  throws "Cannot access before initialization". Declare it inside
  `vi.hoisted`, with the mocks.
- **A floor measured on one vector space is wrong on another by a factor of
  two.** Every retrieval gate was a measurement of the hashing embedder;
  under bge-m3 a stopword query scores 0.36 where hashing noise stopped at
  0.10, and the 0.25 consolidation floor would shortlist the whole corpus.
  Equal-weight fusion, right for two arms that both match words, demoted
  passages a real model had ranked first. `retrievalProfile(family)` in
  `learning/retrieval.ts` is the only place such a number may live, and
  `retrieval-profile.test.ts` pins each to the measured band, not to a value.
- **A lexical test needs three rows.** bm25's IDF is
  `log((N − n + 0.5) / (n + 0.5))`: zero for a term in one row of two, and
  clamped to nothing on a one-row corpus. A store test that seeds one
  memory and searches for its word finds nothing, and reads as a broken
  lexical arm. Seed two unrelated rows first.
- **A model that fails to load must keep its own id.** The old fallback
  to hashing re-embedded the whole corpus one way at a failed boot and back
  the other way at the next that loaded. A provider that is not `ready`
  writes nothing and compares nothing; the rows wait, and `reindexStale`
  keeps the promise. `readiness.test.ts` holds all four consumers to it.
- **The embedder factory answers before the model has loaded.** A bench or
  a script that uses it at once measures the lexical arm alone and reports
  a semantic result of zero. `await embedder.whenSettled()` and refuse to
  measure if it is not ready — `scripts/eval-retrieval.mjs` does.
- **`onnxruntime-node` ships every platform's binaries.** 124 MB of Windows
  and 35 MB of macOS in a Linux image; the Dockerfile removes them after
  the production install. Its postinstall is skipped under pnpm's build
  allow-list and only fetched CUDA libraries anyway.

- **A cascade layer beats specificity, so a custom class cannot outrank a
  utility.** `.help-comfortable` hides prose the compact density does not show,
  and `block help-comfortable` showed it in every density. The obvious fix —
  raising the selector to `:root:not([data-density='comfortable'])
  .help-comfortable`, three points of specificity against one — **changed
  nothing on screen**, which is the fact worth remembering: Tailwind emits its
  utilities in a later `@layer`, and a later layer wins whatever the
  specificity. The constraint therefore belongs on the element, not on the
  stylesheet: nothing may put a display utility beside that class, and
  `deploy/ratchets.mjs` refuses it. Enumerated afterwards, nine layered rules
  set a property a utility could also set, and only this one was at risk — the
  other eight are pseudo-elements no utility can reach, or a background a
  caller is entitled to override. **A new class whose job is to control a
  property callers also set has this problem**; a pseudo-element does not.

- **tailwind-merge deletes a class it does not recognise as a size.** The six
  type roles live in an `@theme` block; tailwind-merge knows nothing of it, so
  it classified `text-caption` as a text *colour* and dropped it as conflicting
  with the `text-muted` beside it. `cn('text-caption leading-relaxed
  text-muted')` returned `leading-relaxed text-muted` — the size never reached
  the DOM, anywhere a colour followed a role in one class list, which is nearly
  everywhere since prose is muted. Nothing could see it: the `literalTextSizes`
  ratchet counts roles in the *source* and reported a steadily improving number
  while none of them applied, no test asserted a size and a colour on the same
  element, and a paragraph that inherits its size still looks like a paragraph.
  `cn` now extends the merge with the scale, and `lib/utils.test.ts` pins it.
  **Any new `@theme` utility whose name collides with a Tailwind group needs
  the same declaration** — a shadow of this is waiting for the next custom
  spacing or radius token.

- **A backtick in a comment inside `AUDIT` ends the probe.** `scripts/responsive.mjs`
  ships its in-page audit as a template literal, so a comment naming
  `` `browser.mjs` `` closes the string and node reports
  `Unexpected identifier` at a line that looks structurally fine. Exactly the
  migration trap one family up, on the other side of the repo. Write the
  identifier bare inside that block.
- **An inset pseudo-element on both axes widens an ancestor's `scrollWidth`.**
  `TOUCH_TARGET` on the board's quick-add button made the column *header row*
  overflow, so the overflow probe stopped walking there instead of reaching the
  board's genuinely scrollable container, and reported four clipped buttons on a
  board that scrolls perfectly. `TOUCH_TARGET_Y` cannot do this — a third reason
  to prefer it, alongside the neighbour overlap it was written for.
- **`elementFromPoint` cannot tell "no hit area" from "the neighbour's hit area
  won".** Probing 15px out from a control's centre — the rule `browser.mjs`
  uses — reported eighteen failures here of which most were not defects: two
  28px swatches four pixels apart can no more both answer 15px to the side than
  they can occupy the same pixel, and that overlap is *designed*. `browser.mjs`
  gets away with it on six routes where no small control has a close neighbour;
  a guard that opens the dialogs meets rows of them. Measure what the control
  *offers* instead — `getComputedStyle(el, '::before')` and its negative insets
  — which a neighbour cannot change. It found sixteen genuine defects: composer
  pills, board filters, cron presets, colour swatches and every quiet link out
  of a card, all of them 19–29px under a thumb and all of them perfect on a
  desktop.

- **The web tests run under happy-dom, not jsdom.** `apps/web/vite.config.ts`
  says so and only happy-dom is installed; five entries above named the wrong
  engine for months. Measured on 20.11.6, because a trap is only worth writing
  once it has been checked against the engine that actually runs:
  `getBoundingClientRect()` returns **0×0**, so no unit test can see a
  geometry — an overflow, a clipped control, a tap target — and every
  responsive claim in a unit test is a proxy on a class string.
  `@layer`, CSS nesting and `@custom-variant` each break the **whole**
  stylesheet, so Tailwind v4's real output cannot be loaded here at all; the
  range syntax `@media (width >= 40rem)`, `oklch()`, `@property`, `:where()`
  and `@supports` all parse. A custom property redefined under an attribute
  selector **does** resolve, which is what makes the density contract testable.
  `env()` survives in `getAttribute('style')` even though the CSSOM drops it.
  `ResizeObserver` and `IntersectionObserver` are native — no mock needed.
- **happy-dom caches the computed style per element, and only a DOM mutation
  invalidates it.** `happyDOM.setViewport()` changes `innerWidth` and flips
  `matchMedia`, but a value read *before* the resize stays frozen until
  something mutates the DOM — proved by four crossed cases. So a responsive
  test passes or fails depending on whether React happened to re-render in
  between. Set the width **before** the render, never after.
- **A default every caller has to remember to override is a default that is
  wrong.** `structuredCall` defaulted to `maxTurns: 1` under a comment that
  already described the trap in full — the SDK returns a schema-constrained
  answer through a hidden tool call, so a model that spends its one turn on
  prose dies as "Reached maximum number of turns (1)" with no answer — and even
  named the fix: "a caller whose prompt is long says 2 or 3". The memory gate
  measured it and raised *its own* call to three. Nothing raised the others,
  and the reflector, which has the longest prompt of the lot (a whole
  transcript summary, up to ~12 kB), kept the failing default. Measured in
  production: ten consecutive failures, a workspace with eighteen successful
  runs and **zero** memories. A ceiling is not a target — a call that answers
  on its first turn costs the same at three — so the knowledge belonged in the
  default, not in a comment telling each caller to opt out.

- **A pass that is "logged and dropped" needs a way back, and a way to see that
  it fell.** Reflexion is out-of-band on purpose: a failure must never disturb
  the run the operator is watching. The cost of that is that nothing else can
  report it, and the screen could not tell four outcomes apart — the run was
  not eligible, the gate refused every note, the pass answered and proposed
  nothing, the pass died — because all four wrote no row. `runs.reflected_at`
  is the fix and it is worth stating generally: **when a background pass may
  fail silently, record that it ran, not only what it produced.** The mark then
  gives a Doctor check for free, and a catch-up something to iterate over —
  without it there is no set of runs to catch up *on*. Related: the insight was
  written only when a memory was *kept*, so a refusal was as invisible as a
  crash; it is now written whenever the gate returned a verdict.

- **A store the agent can read and not write grows a second store.** Memory
  reached every run as an unattributed recall block carrying "never mention
  this section", and the only write path was the post-run pass. An agent told
  something worth keeping mid-conversation therefore did the only thing it
  could and wrote Markdown files in its workspace — which the operator saw
  immediately for what it was: two memories is no memory, since the files are
  not listed, not decayed, not consolidated, not searchable beside the rest,
  and diverge from the store on the next run. `metaclaude_memory` is the fix,
  and the second half of it is that the agent has to be **told**: a tool nobody
  is told about is a tool nobody uses, so the mount and the briefing are
  computed from one predicate in `supervisor.ts` and a test asserts neither can
  appear without the other.

- **A test fixture is derived from the schema, never written from memory.**
  Five in one session were wrong, and every one looked like a broken component:
  an `outcome: 'refused'` that `GateOutcome` does not have, a
  `level: 'workspace'` absent from `GateLevel`, a settings object missing half
  its fields, `sonner` unmocked so the assertion watched the real module, a role
  never set so the branch under test never ran. The shape is always the same —
  the parse fails, the component falls back to its degraded rendering, and the
  test times out on an element that was never going to appear. Build it with
  `Schema.parse({})` where the schema has defaults, or read the enum before
  typing a value into a fixture; and when a test fails, read the contract
  before touching the code, because four times out of five here the code was
  right.

- **Moving a screen breaks everything that pointed at it, and nothing tells
  you.** The machine left Settings for a screen of its own, and four things
  went on pointing where it used to be: the guide's `Settings → Server` (caught
  by `check.sh`, which is what that check is for), three onboarding steps whose
  cards had moved, the dashboard's pairing link, and the command palette, which
  had no entry for the new screen at all. Every one of them still *resolved* —
  to a page with none of what it promised, which is the failure an operator
  reads as "this list is lying to me". After moving a screen, grep for every
  builder that names it, and pin the destinations in a test: `onboarding.test.ts`
  now asserts each step lands where its card actually is.

- **Two copies of a component have already diverged by the time you notice.**
  `SystemTabs` and `SettingsTabs` were the same forty lines — chips, current-chip
  scrolling, hit area — and differed by exactly one class: one carried
  `[&>*]:shrink-0`, the other did not. That class is what makes a chip row
  scroll rather than squeeze, and its absence is the board filter-bar defect,
  waiting in whichever copy was forgotten. `SectionTabs` is the one component;
  each section is now a table and a call. The same sweep found the owner-only
  group list written twice and the System paths written twice — both now single
  entries in `packages/shared/src/routes.ts`, with tests holding the readers to
  them.

- **`tsc` does not report an unused import, and nothing else did either.**
  Splitting Settings in two left eleven names imported and never used — five
  cards, a report view, four hooks — each still pulling its module into the
  chunk. `noUnusedLocals` is off deliberately (it fails the build on a
  half-written line), no test can see it, and it is invisible until someone
  reads the imports. The `deadImports` ratchet counts a name that appears
  exactly once in its file; ceiling zero. It found three more that predated
  this work.

- **An instrument that lies is worse than no instrument, and three of them lied
  in one session.** (1) `scripts/shots.mjs` seeded every memory with
  `content: `${title}.`` and every global with `${title}. Applies wherever the
  agent works.`, so each card showed its own sentence twice — the Memory page
  looked bloated for a reason it does not have, and cutting the card down was
  nearly the conclusion. (2) The first `measure-chrome.mjs` took "the top of
  the first vertical scroller" as the end of the chrome; on the board that
  scroller is inside a *column*, so it reported 179px against 118 on the
  screenshot. (3) Its second version reported `0px` for the board when its
  band filter matched nothing — a flattering number where "I cannot measure
  this" was the truth. **Every measurement gets checked against a picture
  once**, and a measure that finds nothing says so instead of returning zero.
  Same family as the bench trap below: what you look at has to be what ships.

- **Measure before believing a layout complaint, including your own.** "Two
  stacked navigation bars on the System screens" was the plausible defect, and
  `measure-chrome.mjs` refuted it: those screens spend **101px** on chrome,
  header included, 12% of a 390×844 phone. The real offender was the board at
  **237px (28%)**, which nothing had flagged — its filter bar wrapped to three
  rows in French, and it sits *above* the scroller so every row it grows steals
  one from the board. `FILTER_ROW` is the fix and the rule: a filter bar
  scrolls, it does not wrap. `flex-nowrap` alone is not enough — a flex child
  shrinks before it overflows, so the chips squeezed into three-line pills and
  the bar got *taller*; the row has to carry `[&>*]:shrink-0`.

- **A test double that emits what the real system never emits proves the
  opposite of what it claims.** Rewind needed the uuid of the user message a
  turn opened with, and the code waited for the CLI to volunteer it on a replay
  acknowledgement (`type: 'user'`, `isReplay: true`). Four unit tests covered
  it, green for every release — because `fakeQuery` emitted that
  acknowledgement. Instrumented against Claude Code 2.1.218 over a real run,
  the CLI sends **no `type: 'user'` message at all** in streaming-input mode:
  the only frames are `system/init`, `stream_event`, `assistant`,
  `rate_limit_event`, `system/status` and `result`. So `rewindPoint` was null
  for every run ever recorded and the Rewind button, gated on that field, could
  not appear. The fix is not to wait better: `SDKUserMessage.uuid` is a *client*
  uuid we may assign ourselves, the CLI stamps it back as `user_message_uuid`
  and — measured — accepts it as the `rewindFiles` target. **When an identifier
  can be supplied rather than awaited, supply it**; an anchor that exists
  before the process starts cannot be lost to a frame that never comes. The
  same sweep checked the other three values `execute` takes off the wire —
  `claudeSessionId`, `servedModel`, `usage` — and all three do arrive; this was
  the only dead one. What no test could have caught, and what did catch it, was
  `console.error` on every frame during `check:e2e`.

- **`typeof x === 'boolean'` is satisfied by the failure.** The live check that
  should have reported the dead rewind asserted `typeof preview.body.canRewind
  === 'boolean'`, which `false` meets — so the one test able to see the defect
  accepted "no" as an answer and stayed green beside it. Same family as the
  edge-schema trap: assert the value that means it *works*
  (`canRewind === true`), never merely its type. Worth grepping for: a
  `typeof … === 'boolean'` in a check whose point is that something succeeded
  is nearly always this bug.

- **Renaming a value is not changing it, and a ratchet cannot tell them
  apart.** Twelve lots turned `text-[13px]` into `text-body` — which is
  13px — `divide-[var(--mc-border)]` into `divide-line`, a `<div className=
  "grid">` into `<Grid>`. Every check went green, `literalTextSizes` fell
  from 360 to 10, and the deployed dashboard was identical to the previous
  release *pixel for pixel*; the operator's first words on seeing it were
  "I see no difference — all that work for this?". The ratchets measure
  consistency, and the consistency was already there. Nothing in the suite
  can answer "does this look different", so a redesign has to be judged on a
  before/after capture of the screen the operator opens first, and on nothing
  else. `scripts/shots.mjs` now takes `SHOTS_ONLY` / `SHOTS_PASSES` for
  exactly that reason — a ten-minute bench gets looked at once, at the end.

- **A primitive written against a defect, and then not applied, leaves the
  defect *and* the impression of having fixed it.** `Section` — "a titled band,
  separated by a rule rather than enclosed in a box" — carries a comment
  counting the 138 bordered blocks it exists to remove, and shipped applied
  **9 times out of 97**: never on Settings, which had sixteen, never on
  Analytics, which had fourteen, never on the dashboard. Reading the source
  suggested the problem was solved; the count said it was not. So after
  introducing a primitive, count its uses against its intended sites in the
  same session — `boxedSections` is that count made permanent for this one.

- **`window.innerWidth` lies under mobile emulation.** It reports the *visual*
  viewport, which widens with the content that overflows: measured at 530 for a
  `documentElement.clientWidth` of 390. The worse the defect, the better it
  hides. Any probe — in a test or in Playwright — compares against
  `document.documentElement.clientWidth`, never `innerWidth`.

- **A guard on truthiness cannot tell a sentinel from a choice.** The composer
  sends its model picker on every message and spells "Auto" as the string
  `default`, so `overrides.model` was *defined* for every message a person ever
  typed. `choosePolicy` gated the bandit on `!overrides.model` — false for
  `'default'` — so the learner was never consulted from the composer at all,
  the run was stamped `explicit` as though somebody had chosen it, and
  `default` reaches the CLI as "pass no `--model`", which lands on the CLI's own
  default. Measured in production over 54 runs: 46 `explicit` against 7
  `learned`, and all 42 runs submitted as Auto served by `claude-opus-5` (three
  by the 1M variant, ~3x the price). Selecting Auto did the opposite of what it
  said. Ask `isAutoModel`/`isAutoEffort`, never truthiness — same family as the
  workspace-settings guard that refused the form which round-tripped it.
- **The system prompt is the cached prefix, so anything per-message in it
  rewrites everything.** Retrieval is keyed on *this* prompt, and the block was
  appended to `systemPrompt`. Measured against the real CLI, three runs in one
  resumed session: the append **is** re-applied on `resume`, and it *replaces*
  rather than accumulates. The run whose append had changed wrote 11,498 tokens
  to cache; the next, identical, wrote 163 — a factor of seventy from nothing
  but the append moving. In production the prefix is ~34k with the MCP
  catalogues and every run paid it. Session-stable context (language directive,
  workspace conventions, the standing shelf) goes in `systemPromptAppend`;
  anything that varies with the message goes in `contextPreamble`, which rides
  the user message. `excludeDynamicSections: true` does the same for the git
  status, which an editing agent changes between its own runs.
- **A uniform prior is a claim about cost that nobody believes.** Beta(1,1) on
  every bandit arm says a $2.10 arm is as plausible as a $0.07 one, and four of
  the frontier's arms are opus or fable — so a near-uniform Thompson draw put
  most early decisions on the dear end. Don't fix it by deleting arms: omission
  is not evidence, and a frontier missing the newest model makes it structurally
  unreachable. Fix where each arm *opens*: `armPrior` asks `computeReward`
  itself what an ordinary success on that arm would score, so the prior follows
  the reward instead of contradicting it. Keep it weak (four pseudo-trials) —
  a prior that survives a dozen trials is a policy. And the model's *speed* is a
  property of the model, not of the effort: `null` effort on Haiku means "this
  model has no such knob", on Sonnet it means "the CLI will choose, and it
  chooses high". Reading both as `high` ranked `sonnet low` above `haiku`.
- **`effort` is not on the SDK's init frame.** The field is declared on the type
  and documented as "present on Remote Control bridge init frames"; measured
  through `query()` against Claude Code, the key is not in the object at all —
  for an explicit `effort: 'high'` and for the Auto path alike. There is also no
  `getSettings()` on `Query`, so `applied.effort` is unreachable too. A
  `served_effort` column would therefore have been null forever, which is the
  `rewindPoint` trap exactly. The same probe is worth reusing: dump
  `Object.keys(init)` before wiring anything to a field the SDK merely declares.
  Related and confirmed twice: with no `model` option the CLI serves
  `claude-opus-5[1m]`.

- **A declared type is not the wire — and a payload read through a 2000-character
  `slice` is not the payload.** The SDK declares `rate_limits` as an object keyed
  by window name. Claude Code sends *both*: the declared keys **and** a `limits`
  array of `{ kind, percent, scope }` rows. The first look truncated the dump,
  saw only `limits`, and concluded the object keys were absent — so the fix
  shipped with a changelog claiming the quota screen had been blank. It had not:
  `five_hour` and `seven_day` were being read and displayed correctly all along.
  What was genuinely missing is the **per-model** buckets, because `model_scoped`
  is `undefined` on this payload and the model rows live only in `limits[]`. Read
  both shapes, build the fixture from a *captured* payload, print the whole thing
  before concluding anything about what is not in it — and when neither shape
  parses, say so rather than returning an empty list.
- **A scale is a property of its source, never of its magnitude.** Two sources
  report window utilisation: the rate-limit event's `unifiedWindows` as a
  fraction, the usage payload as a percentage. Inferring with
  `u > 1 ? u / 100 : u` is unambiguous for 97 and catastrophic for 1 — and
  `rate_limits.five_hour` reported `{ utilization: 1 }` meaning *one percent*.
  The sniffing rule read it as a spent window, which would have classified every
  model-scoped quota refusal as global and stopped the model switch from ever
  firing: the feature would have shipped dead. Caught by the baseline probe, not
  by any test, because no test can see what the CLI actually sends.
- **Quota refusal is not what the enum says it is.** Two discriminators were
  written and measured wrong before the third. (1) `rateLimitType ===
  'seven_day_<model>'` reads well — the enum declares `seven_day_opus` and
  `seven_day_sonnet` — and would never have fired: a genuinely exhausted Fable
  bucket reports `seven_day_overage_included`, which names no model. (2) The
  CLI's own `fallbackModel`, documented for a primary that is "overloaded or
  unavailable", is measured **not** to cover quota: `fable` with
  `fallbackModel: 'sonnet'` returned a result byte for byte identical to `fable`
  alone. What discriminates is the rejected event's view of the *global*
  windows (`unifiedWindows`, on the wire but **not** declared — so keep a second
  source). And the retry is safe because it was measured, not assumed: a refused
  attempt still yields a resumable session id, resuming it on another model
  works, and it leaves no user turn behind — asked afterwards how many times it
  had seen the prompt's marker, the model answered "1".

- **`gh run watch --exit-status` reported success on a CI run that failed.**
  Measured: run 34212963481 had `Typecheck, tests, build: failure`, `CI:
  failure`, the tag job skipped — and the watch exited 0, so a deployment was
  started against a version that had never been tagged. The reliable signals
  are `gh run view <id> --json jobs` and the tag actually existing on the
  remote; check those, not the watcher's exit code. The tag is the better of
  the two because it is what the deployment consumes.
- **A job whose every step passed can still conclude `cancelled`, and then no
  tag is laid.** `timeout-minutes` cancels the *job* when the ceiling is hit,
  even if the running step finishes a second later and reports success — so
  the browser-check job for 0.93.0 showed thirteen green steps, a conclusion of
  `cancelled`, and a duration of 20m01 against a ceiling of 20. It reads as
  somebody pressing Cancel. The tell is the duration matching the ceiling; the
  cause was the responsive guard growing with the app (14m04 → 15m37 → 18m31
  across three releases, one route per new screen). Check the steps and the
  duration before reading `cancelled` as a person, and raise the ceiling with
  the measurements beside it rather than guessing a new round number.
- **A job ceiling bounds the sum, so one step's bad day is charged to the
  last step.** 0.93.4 died the same way at the *raised* ceiling, and the
  responsive guard was innocent: it was on track at 15m32 when "Install
  Chromium" — 21–24 s on every other run — had taken 13m41 fetching a browser
  or an apt mirror. The step that overran finished green and the one that was
  cancelled had done nothing wrong, so reading the job's step list points at
  the wrong step. Look at each step's *duration against its own norm*, not at
  which one was running when the axe fell. Two rules follow: whatever is
  downloaded per run and changes only with a lockfile is cached
  (`actions/cache` on `~/.cache/ms-playwright`), and a step that can hang on a
  network has a `timeout-minutes` of its own, so it fails under its own name.
- **A version that was never tagged must not keep its changelog section.**
  The GitHub release body is extracted from *the section carrying that
  version number* (`ci.yml`, "Publish the GitHub release"), so when 0.93.0
  died at a CI ceiling and 0.93.1 shipped the fix, the "latest" release — the
  page `UpdateCard` links to — described a twenty-minute timeout and nothing
  about the work sitting under `## [0.93.0]`. Fold the dead version into the
  one that ships, with a line saying so, and republish the release notes
  (`gh release edit v<x> --notes-file`) from the folded section. Two traps
  met doing that: Git Bash's `awk` reads `\[` as `[`, so the extraction that
  CI runs on Linux answered **zero bytes** here and `gh release edit` happily
  published an empty body — guard the size before editing, never after; and
  node resolves `/tmp/x` to `C:\tmp\x` while bash's `/tmp` is MSYS's, so a
  file node wrote was not the file bash read. Use one absolute path both
  runtimes agree on.
- **One method that reads the wall clock while its callers reason at a given
  `now` is a test that passes on one machine and fails on another three minutes
  later.** `ModelAvailability.release` took no `now` and read `Date.now()`, so
  an entry the wall clock considered expired made it return without writing —
  leaving the row in `kv` for a caller that had just been told it was gone.
  Green locally, red on CI. Every method that reasons about time takes `now`,
  including the ones where it looks like a formality; and prefer an
  unconditional write that persists the pruned map over an early return, so
  expired rows are swept instead of accumulating.

- **One observation identifies a difference, never its cause.** Three times in
  one session a single measurement was read as a fact about the thing under
  test, when the environment was the variable that moved. The quota screen was
  called blank from a payload dump truncated at 2000 characters. An SDK upgrade
  was credited with adding `model_scoped` to `rate_limits`, from one run on
  Windows — it is absent from both Linux runs, before *and* after the bump.
  `powershell_path` was reported as a version change for the same reason. The
  discipline that catches it costs almost nothing: before attributing a
  difference, ask what else differed between the two observations, and re-run
  with that held fixed. `scripts/sdk-probe.mjs` records `process.platform` and
  warns on a mismatch — the warning fired for two of these and the claim was
  made anyway, so the instrument was not the missing piece.

- **A button that works but cannot show it reads as a broken button.** `Forget`
  on a gate decision deleted the memory every time and the row never changed,
  because the note kept recording `kept` and the id of a memory that no longer
  existed. Two independent halves: the client invalidated `insights` after
  *keep* and not after *delete*, and nothing anywhere pruned the id. The prune
  belongs on the **read**, not at each deletion site — a memory leaves by the
  operator's button *and* by decay, and a read-time repair covers a door nobody
  thought of, converging because it writes the correction back. Related and
  worth stating on its own: when a record's state becomes untrue, give the
  untruth a name (`GateOutcome.forgotten`) rather than reusing a neighbouring
  value — `skipped` would have had the row claim the gate did what the operator
  did, and the exhaustive `Record` of tones is what forced the choice into the
  open.

- **Content-addressed storage makes a cleanup everybody's business.** An upload
  writes `<dataDir>/knowledge/<sha256>.<ext>` and, if the row then fails,
  removes it — correct, until two uploads of one file race. The duplicate check
  is a read and not a lock, so both pass it, both write the same bytes to the
  same name, and the unique index refuses the loser; its cleanup then deleted
  the file *by hash*, which is the original the winner had just been given.
  Measured end to end: the survivor's download answered 404. Under the same
  race, one shared `.part` name is its own bug — the first rename moves it out
  from under the others, two failures in six concurrent writes — and Windows
  refuses a rename onto a file another writer holds (EPERM) where Linux
  replaces it silently, so a fix written on one reads as flaky on the other.
  Both answers are the same shape: ask **who owns this now**, not *did I put it
  there*.
- **An empty page skipped is every page after it renumbered.** `joinPages`
  exists to keep page 7 as page 7 whether or not page 6 was blank, and
  `extractXlsx` defeated it by skipping an empty sheet before calling it — so a
  workbook with a blank tab in the middle cited its third sheet as sheet 2, and
  whoever opened sheet 2 to check found a blank page. A citation is only worth
  anything if the number leads somewhere; push the empty and let `joinPages` do
  what it is for. `pptx` maps rather than filters and never had this; `pdf`
  splits on the form feed and keeps every page.
- **The `claude` on the PATH is not the one the SDK spawns.** The Agent SDK
  vendors a Claude Code binary per platform and runs *that*, unless
  `pathToClaudeCodeExecutable` says otherwise — and nothing here sets it. The
  image also installed `@anthropic-ai/claude-code` globally at its own pinned
  version, so `probeClaudeCli` ran `claude --version` off the PATH and reported
  a binary that executed no work: measured in production, 2.1.247 on the PATH
  against 2.1.263 doing every run, in one container. Everything downstream
  inherited it — the credentials card, the doctor's line, and an update badge
  comparing the wrong number against the registry. Nothing could see it,
  because both numbers are real versions of the same product. The image now
  links the PATH entry to the SDK's binary, `check.sh` refuses a second
  install, and the rule generalises: **when a dependency vendors an executable,
  the version worth reporting is the one it spawns, not the one a shell
  resolves.**

- **A relative-time helper answers one direction, and a deadline is the
  other.** `formatRelative` computes `now - timestamp` and its first branch
  returns "just now" for anything under 45 seconds — which is every negative
  delta, i.e. every date in the future, however far. The comment above it says
  so on purpose: a recorded event in the future is a clock disagreement. Four
  call sites were deadlines rather than events, and all four rendered "just
  now" forever: a credential countdown shipped one evening was dead by the next
  morning whether the token had four days or a year left, and the automations
  list had been announcing the next run as "just now" for every schedule since
  it was written. Neither is visible to a reader or a test that only asserts
  the sentence appears — both are plausible English. `formatUntil` is the other
  direction; **a timestamp that has not happened yet never goes through
  `formatRelative`**, and a test on a time helper asserts the value, never the
  shape.

- **Two layers can each be right alone and lie together.** `extractCsv`
  answered a heading for a header-only file — text, so extraction succeeded,
  and a green test said so — and the chunker makes no passage out of a lone
  heading, so the store refused it *for having no content*, about a file whose
  text is on screen. Same shape as the edge-schema trap from the other side:
  the test stopped above the consumer. When one layer's success is another's
  input, one test has to drive the whole round trip and read the sentence a
  person actually gets.

- **The delegation tool is `Agent`, not `Task`, and the SDK declares no input
  type for `Skill` at all.** Measured against Claude Code on 2026-09-10, twice —
  once from a harness and once with every `CLAUDE_CODE_*` variable stripped,
  because one observation identifies a difference and never its cause. A
  delegation is `Agent {description, subagent_type, prompt}`; a skill call is
  `Skill {skill}`, and `ToolInputSchemas` has an entry for every other built-in
  and none for that one. `Task` had been spelled in three places here for four
  releases and nothing failed: the permission card fell through to its generic
  branch and printed raw JSON, the transcript showed a bare tool name, and every
  delegation went uncounted. Both names now live in `packages/shared/constants.ts`
  with the date beside them, and `scripts/sdk-probe.mjs` records them so a bump
  cannot move them quietly. **A tool name taken from a type declaration rather
  than from the wire is a guess.**

- **Three passes cannot tell two prompts apart.** Measuring the instruction
  arbiter, two materially different prompts scored 0–1 over-reactions each over
  three passes, and *sabotaging* the rules moved nothing — the tempting reading
  was "the rules do nothing". At five passes over ten windows the same two
  prompts scored five over-reactions and a miss against one and none. The model's
  own variance was simply larger than the effect at that sample size. A measure
  that reads the same under sabotage is a measure to **strengthen** before it is
  a result to believe, and the fix is more passes and more cases, not a
  conclusion.

- **A ratio that counts an edit script's entries scores a replacement twice.**
  `changedLineRatio` first counted removals plus additions, so replacing five
  lines of twenty came out at 0.5 while appending five to twenty came out at
  0.2 — one ceiling meaning two different things depending on the shape of the
  edit. It is the share of the larger side *not shared* instead, which is
  monotone both ways. And such a rule must not apply below a handful of lines
  at all: a one-line skill description rewritten is 100% changed by any measure,
  and rewriting it is the single most useful thing the pass does.

- **An ordered list of reasons hides every reason after the first.**
  `reviewDue` answered `opted-out` and said nothing about whether the workspace
  had the traffic for a pass, so the caller that *waives* the opt-in — the
  button — was told it could proceed on a window of two runs, promised a pass,
  and watched it skip in silence. Whatever a caller may waive has to be
  answerable on its own terms: `enoughRuns` sits beside the reason rather than
  behind it.

- **A test's own fixture is the likeliest thing wrong.** Three of the failures
  in this lot were mine, not the code's: a context test asserting three lines of
  context where the code correctly gives three and the array had eight; a
  window fixture seeding fourteen days of runs past a clock set to day ten; and
  a factory whose `...over` spread was missing, so every override was silently
  ignored and the assertion failed on an id that was never set. Read the
  fixture before the code — four times out of five here the code was right.

- **A sabotage that does not go red may not have been applied.** A `python -
  <<'PY'` replacement whose anchor no longer matches exits non-zero, and under
  `sab "$a" "$b" && run` the `&&` then quietly skips the run — which prints the
  *restored* file's green result and reads exactly like a test that cannot fail.
  Every sabotage asserts `s.count(anchor) == 1` before writing, and the anchor
  count is checked when the number surprises you.

- **A feature with two doors needs the rule on both.** The instruction review
  and the `advisor_propose_revision` tool both file the same proposal, and
  three rules lived only in the pass or only in the tool's prose: which
  workspace's texts may be rewritten, "an edit, not a rewrite", and the
  prompt's own size. The tool takes a target **id straight from a model's
  arguments**, and the surface resolved ids alone, so a run in one workspace
  could rewrite another's standing instructions on accept. Whatever a prompt
  tells a model, the service has to enforce — prose is a request, not a rule.
  Related and measured while fixing it: the authority question is *membership
  of what the workspace runs under*, never `skills.workspace_id`. That column
  records who created the row; the reach lives in `is_global` and a join table
  and an operator may widen it later, so the obvious comparison would refuse a
  skill they had deliberately shared.
- **A budget checked before a unit is emitted drops the unit whole.**
  `unifiedDiff` tested `out.length + hunk > maxLines` and `break`, so a hunk
  larger than the entire budget — which is what a wholesale rewrite is — left
  the card showing nothing but "… diff truncated". On a screen whose premise is
  that the operator approves *the text* rather than a description of it, that
  is the failure, not the mitigation. Cut the unit to the room that is left,
  and count the header over what was actually emitted.
- **A per-item cap is not a cap.** Every instruction text put to the review
  arbiter was bounded from the first day; the *number* of them was not, and
  one row per workspace plus two per skill, two per subagent and one per
  automation is four hundred thousand characters at forty skills — past the
  context window, a weekly pass that fails for good. Where such a budget is
  applied matters as much: the same list is what a revision's 1-based index is
  resolved against, so trimming in one of the two consumers lands a rewrite on
  the wrong text. Trim where the list is born.

- **A `Settings` field can be declared and be inert in the tier every other
  policy rides.** `disableBundledSkills` keeps the CLI's own seventeen skills
  — `design`, `dataviz`, `keybindings-help`, `loop` — out of a run. It is
  declared on `Settings`, and `managedSettings` is where Metaclaude's policy
  locks live, so that is where it went. Measured against CLI 2.1.267, one turn
  per cell: in `managedSettings` it does **nothing at all** — 19 skills, 2,040
  tokens, byte for byte the same as sending nothing — and in the flag
  `settings` tier it takes them to 2 and 32. Shipped on the documentation
  rather than the measurement it would have been dead on arrival and looked
  delivered, which is the `rewindPoint` family with a settings object instead
  of a field. Any new key on that payload gets the same two-cell probe.
  Related, on the same screen: the catalogue probe has to carry the payload a
  run carries, or `supportedCommands()` answers 56 against a run's 38 and the
  composer offers eighteen commands the CLI will refuse.

- **A derived artefact written at the call sites is written at some of them.**
  The workspace's skills exist in the database and the CLI only reads
  `.claude/skills/`, so something has to write them before a run. That was
  three of the eight places that submit one — the session route, the board
  route, the autopilot — and the five without it were the scheduler, the
  steward, the advisor, delegation and the gateway: every run nobody is
  watching. Those got whatever the last typed message had left behind, so a
  skill created in the morning was invisible to the nightly automation and one
  switched off went on being offered to it, for ever, in a workspace driven
  only by automations. Invisible from every screen, because the run succeeds
  either way — and `run_extension_usages` then reports the skill as *offered
  and never opened* from the **database** list, which is the sentence the
  weekly instruction review acts on. It would have proposed rewriting a
  description that was never the problem. It lives in
  `ContextProvider.prepare` now, which `execute` calls before `resolve` on
  every run. Moving it there is what makes the next three properties
  obligatory, and each has a test: no write when nothing moved (a continuous
  automation would otherwise rebuild the tree every minute), the fingerprint is
  not trusted alone (the agent has `Bash` and can delete what it was given),
  and the swap is two renames rather than a delete-and-rebuild (two runs of one
  workspace overlap, and a CLI can spawn into a half-written directory).

- **A screenshot checked alone answers "does it fit", never "does it belong".**
  The CLI-tools screen was captured on the bench three times before it
  shipped, at 1440 and 390, light and dark, French — and every capture was
  read for overflow, wrapping and untranslated copy, all of which passed. It
  boxed every one of thirty-four rows in a `Card`, the exact shape the layout
  primitives exist to end, and the operator saw it in one glance. Nothing in
  the suite can see it either: the `boxedSections` ratchet counts a *titled*
  group in a Card, not a list item in one. Before judging a new screen, open
  the sibling it will sit beside — here Plugins and `McpToolPicker`, the app's
  own list of checkable tools — and ask whether a reader could tell which one
  was added last. A card is an object one acts on; a row with one box is a
  list item, and the list of them has a vocabulary already.
- **`system/init` comes with the first user message, not with the session.**
  Measured on 2.1.267: twenty seconds of listening with no prompt, then
  `reinitialize()`, then `initializationResult()` — no init frame from any of
  them; one prompt, and it arrives at 817 ms. So anything that lives only on
  that frame (the CLI's tool list does; `initializationResult()` carries
  commands, agents and models and no tools) **cannot be read by a probe**,
  only by a run. The first CLI-tools screen read it from the catalogue probe
  with a ten-second wait, passed every test, and in production showed every
  tool as "no longer offered" under a warning — while the Skills section
  beneath it, fed by a control request, was full. The same picture had been on
  the design bench and was misread as a bench without credentials. The test
  double emitted init on open under a comment saying that is what the CLI
  does: emitting what the real thing emits *later* proves a reading order it
  never offers, which is the test-double trap with the sign reversed. The list
  is fed by `execute` now, from every run, with the run's own `forbidden`
  added back because the frame lists tools after the deny list took effect.
  `sdk-probe.mjs` records `initFrameWithoutPrompt` so a bump that changes it
  is seen.
- **`init.tools` says `Task`; the wire says `Agent`.** The opening frame lists
  the delegation tool under its internal name and the tool call arrives named
  `Agent` — both measured on CLI 2.1.267, in the same run. `disallowedTools`
  accepts *either* spelling and removes it, which is the only reason the
  `DELEGATION_TOOLS` alias in `packages/shared/constants.ts` is enough. Two
  consequences worth keeping: a screen listing the CLI's tools honestly shows
  `Task`, which needs saying in its own row or it reads as a tool nobody has
  heard of; and denying `Skill` kills skills outright while denying `Task`
  kills custom subagents — measured, the model flails and burns its turns
  rather than reporting the absence. Neither is in the shipped deny-list
  default for that reason. The tool list itself is on the `system/init`
  *message* only: `initializationResult()` looks like the place and carries
  `commands`, `agents` and `models` with no tools on it.

- **A floor and an exception do not compose, and the SDK does not say so.**
  `disableBundledSkills: true` beside `skillOverrides: { 'code-review': 'on' }`
  leaves *zero* built-in skills — measured on CLI 2.1.267, and again with
  `user-invocable-only`. The floor wins outright. Letting one of the CLI's
  skills through therefore means dropping the floor and naming every *other*
  skill `off` by hand, which is worse in exactly one way: a skill a future CLI
  ships is not on the list and arrives switched on. `CliSkillPolicy.plan()`
  keeps the floor whenever nothing is chosen for that reason, and the route
  that reads the CLI is what teaches the run path the list — a run cannot
  spawn a probe. Same trap as its neighbour: `skillOverrides` in
  `managedSettings` does nothing, in `settings` it bites. The list itself
  comes off `getContextUsage().skills.skillFrontmatter` with `source:
  'built-in'`, and `detail: 'summary'` carries it without the per-category
  token-count calls; the per-skill token figure is **model-dependent** (362 on
  haiku, 482 on the CLI's default for the same skill) and may be shown as an
  order of magnitude, never added up.

- **`alwaysLoad` on the in-process servers was measured and left alone.** The
  worry was behavioural rather than budgetary — the supervisor *tells* the
  agent that `memory_write` exists, and a tool whose schema is deferred might
  be reached for less readily. Measured end to end with the real steering
  append, three passes each: one memory written out of three with the schemas
  deferred, one out of three with them loaded. No difference the sample can
  see, against 340 tokens for the whole memory server and an `alwaysLoad` that
  also blocks startup until the server connects. Nothing to decide — written
  down so it is not measured again. What the same probe *did* show is worth its
  own line: on haiku the agent wrote the memory twice in six passes and once
  wrote Markdown files instead, which is the defect `metaclaude_memory` exists
  to end. That is a fact about the model, not about tool loading.

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

**A response body left unread holds the connection, and the server waits for
it.** `server-harness.ts` talks to a real server over real `fetch`, so a case
that asserts on a status or a header and never drains the body keeps the socket
busy and — where the route streams a file — the file handle open. `app.close()`
then waits its full timeout, and the suite reports a 30-second failure in
`afterAll` that looks like a hung server rather than a test that forgot
something. Two cases in `knowledge.test.ts` did it, and only one *ordering* of
the file made it visible. Drain what you request: `await response.arrayBuffer()`.

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
