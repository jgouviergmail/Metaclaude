# Metaclaude

A private, self-hosted agentic OS built on the Claude CLI. Node/Fastify API
supervising Claude CLI subprocesses, plus a React PWA.

## Commands

```bash
pnpm install
pnpm --filter @metaclaude/shared build   # run first — the others depend on it
pnpm build                               # shared → api → web
pnpm typecheck
pnpm test:run                            # 1162 tests, ~17s
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
- **Every Zod schema in `packages/shared` ships in the web app's entry chunk.**
  `parseWireFrame` validates socket frames, so `TranscriptEvent`, `Run`,
  `Session`, `ApprovalRequest` and everything they reference are genuinely
  reachable and *should* be there. The rest — the request/response contracts
  only the API validates — are retained too, because `z.object(...)` is a call
  Rollup cannot prove side-effect-free, and `sideEffects: false` only lets it
  drop a whole unused module, not a declaration inside a used one. Each new
  contract therefore costs the entry roughly a kilobyte gzipped. To reclaim it,
  move the API-only schemas into their own module that nothing in the entry's
  runtime graph imports; annotating declarations `/*#__PURE__*/` also works and
  is easier to get subtly wrong.
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
- **The shipped image nests `workspacesDir` inside `dataDir`.**
  `METACLAUDE_DATA_DIR=/var/lib/metaclaude` with
  `METACLAUDE_WORKSPACES_DIR=/var/lib/metaclaude/workspaces`, so any check
  phrased as "is this inside the data directory?" is true for every legitimate
  workspace path. That is how `additionalDirectories` came to reject
  everything in production while every test used a sibling layout. Any new
  containment rule needs a case in `security/directories.test.ts` under the
  layout that actually ships.
- **A ratchet that greps text cannot tell code from prose.** Writing
  `bg-gray-800` inside a *comment* explaining the raw-palette rule trips the
  raw-palette ratchet. Say `bg-gray-<n>`.
- **The web app's `maxPayload` is the frame-size control, not the app check.**
  `server.ts` sets ws's own limit, so an oversized frame closes with the
  standard 1009 and the `raw.length > 64 * 1024` branch in `ws.ts` is a backstop
  that only becomes reachable if the two figures diverge. Keep them in step.

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

The two checks that *do* need a live agent live in `apps/api/scripts/` and are
run by hand (`check:e2e`, `check:browser`). They boot the real server against a
throwaway data directory, so they exercise the deployed code path rather than a
test double — the guards, the migrations, the static handler and the CSP. Add to
them when a change is only observable end to end: a socket that reconnects, a
tap target, a CSP violation.
