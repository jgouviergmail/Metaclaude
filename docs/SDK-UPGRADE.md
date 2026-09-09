# Upgrading the Claude Agent SDK

Metaclaude is a supervisor around a subprocess it does not control. The SDK
version therefore decides what the product can do, what it silently stops
doing, and what it starts reporting differently. This is how that version moves.

It is written down because the failure mode is not a red test. It is a feature
that keeps compiling, keeps passing, and quietly does nothing.

## Why this needs more than `pnpm up`

The type declarations are not the wire. Measured against Claude Code in one
session, all five of these were true at once:

| what the types say | what the CLI does |
|---|---|
| `rate_limits` is an object keyed by window | it sends that object **and** a `limits` array; the per-model buckets live only in the array |
| `SDKRateLimitInfo` has no `unifiedWindows` | every rejection carries one, and it is the only in-band discriminator |
| `fallbackModel` covers a model that is "unavailable" | it does **not** cover quota |
| the init frame carries `effort` | the key is not in the object |
| — | a resumed run re-applies **and replaces** the system-prompt append |

Four shipped features rest on the right-hand column. A test cannot see any of
it, because all of it is the behaviour of a live subprocess.

So the upgrade has a static half, which the existing checks cover well, and a
behavioural half, which nothing covers unless somebody measures it.

## The rule that shapes everything else

**An SDK bump ships alone.** No feature, no refactor, no drive-by fix in the
same version. When something regresses three days later, the whole question is
whether the SDK did it, and a version that changed two things cannot answer.

## The five phases

### 0 — Freeze a baseline, before touching anything

```bash
cd apps/api
node scripts/sdk-probe.mjs --out deploy/sdk-baseline.json
```

The probe needs a live CLI credential, so run it where one exists: the
production container, or a signed-in machine. It costs a few hundred haiku
tokens.

Commit the baseline. It is the only record of what the current version does,
and it is worthless if captured *after* the bump.

**Capture and compare on the same platform.** The init frame carries
platform-specific keys — `powershell_path` on Windows, absent on Linux — so a
baseline taken in the container and a measurement taken on a laptop differ for
reasons that have nothing to do with the version. The probe records
`process.platform` and warns when they disagree; the honest comparison is the
one run on the machine that actually serves. In practice that means the local
run in phase 3 is a *smoke test*, and the run against production in phase 4 is
the comparison that counts.

Two of its probes — the quota refusal and the CLI's own fallback — can only run
while a model is genuinely spent, which cannot be forced. They report an
explicit skip rather than a pass. **A skip is "unknown", not "unchanged"**; if
the quota path matters to the release, wait for a window that is actually
exhausted, or accept the gap knowingly.

### 1 — Read the delta before installing it

The single highest-value step, and the one that is easy to skip.

```bash
# What changed in the declarations, which is where breakage announces itself.
diff <(cd /tmp && npm pack @anthropic-ai/claude-agent-sdk@<old> >/dev/null 2>&1 && tar xzf *.tgz -O package/sdk.d.ts) \
     <(cd /tmp && npm pack @anthropic-ai/claude-agent-sdk@<new> >/dev/null 2>&1 && tar xzf *.tgz -O package/sdk.d.ts)
```

Read it for three things: message types added or removed, fields removed from
types Metaclaude reads, and — most important — *comments that changed*. This
SDK documents behaviour in prose on the type, and a reworded comment is often
the only notice that behaviour moved.

### 2 — Bump, and let the static guards speak

```bash
pnpm up @anthropic-ai/claude-agent-sdk@<new> -r
pnpm verify
```

Two guards exist precisely for this moment, and both are meant to fail:

- **`sdk-narrator.test.ts` reads the message union out of the installed `.d.ts`**
  and fails naming every type that is neither narrated nor listed in
  `IGNORED_SDK_MESSAGES`. Expect it to fail. Each new type is a decision: narrate
  it, or ignore it deliberately and say why.
- **`typecheck`** names every field that was removed or retyped under code that
  reads it.

Neither can see a field the types never declared. That is phase 3.

### 3 — Re-measure, and diff against the baseline

```bash
node scripts/sdk-probe.mjs --baseline deploy/sdk-baseline.json
```

It exits non-zero when anything it can see has moved, and prints each change as
`path: before -> after`.

It compares *conclusions*, not magnitudes, and that distinction was learned the
hard way on its first use: the raw cache-write figures move with the prompt and
the mounted tools — 11,455 tokens on one run, 15,556 on the next, for behaviour
that had not changed at all — so diffing them reported three changes where there
were none. An instrument that cries wolf is one you stop reading. The raw
numbers stay in the report under `raw` for the record; what the diff watches is
whether changing the append still rewrites the prefix at all.

**A change is not automatically a regression.** `quotaFallback.coversQuota`
turning `true` would mean the CLI now handles what Metaclaude handles itself,
and roughly a hundred lines could go. `rateLimitsShape.shape` returning to
`object` would mean the reader's second branch is live again. Every line in that
output needs a decision recorded in the commit message; none of them may be
waved through.

If nothing moved, say so in the commit. "Measured, unchanged" is a result.

### 4 — Deploy alone, and watch four things

Deploy as usual, then observe for at least a full day of real traffic — the
window matters because the failures this catches are silent rather than loud.

| signal | where | what a regression looks like |
|---|---|---|
| run success rate | Analytics | a step change on the deploy, not a drift |
| cache writes per run | Analytics tokens, or the runs table | a jump means the cached prefix is being rewritten again |
| quota narrations | any transcript | switches that no longer happen, or that happen on a global window |
| `unavailable` on the usage endpoint | Settings → Analytics | `rate_limits` there means the shape moved again |

The rollback is the ordinary one: deposit the previous version through the
update button, which is health-gated and reverts on failure. Because the bump
shipped alone, rolling it back costs nothing else.

## What to write down afterwards

Whatever the probe could not measure, and why. The next person needs to know
that the quota path was untested on this version because no bucket happened to
be empty that day — not to assume it was fine because nothing was red.
