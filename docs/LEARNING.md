# How Metaclaude learns

Most "AI memory" is a vector store with a `remember()` call bolted on. That is
storage, not learning. Learning requires a loop: an action, an outcome, and a
change in future behaviour caused by that outcome.

Metaclaude closes four such loops, each on a different timescale — and the
fourth is the one that changes the *instructions* rather than the context.

---

## Loop 1 — Memory: what is true about this project?

**Timescale: hours to months.**

### Writing

Memory is written from two places: the operator, explicitly, and the reflexion
pass, automatically. Both go through `MemoryStore.remember()`, which does
something important before inserting anything: it looks for a near-duplicate.

```
cosine(new, existing) ≥ 0.92  ⟹  merge, don't insert
```

On a merge, the existing memory's confidence rises (repetition is evidence) but
is capped below 1.0, so nothing ever becomes unfalsifiable.

**This catches the same text written twice, and only that.** The threshold is
deliberately high, and on the hashing embedder that ships by default it is
essentially unreachable by paraphrase: measured on a real deployment, the
*highest* cosine between any two of its twenty-two memories was **0.51** —
while four of them said the workspace worked in French and five described the
same quota behaviour. A third of the corpus was redundant and nothing here
could see it. Semantic repetition is caught by a different mechanism, below.

The candidate set is the writer's own scope **plus the global tier**, and it
ignores the memory's kind. Both matter: the same observation had been recorded
as `semantic` on one row and `procedural` on another, so filtering by kind let
one fact live once per kind; and a fact the global tier already carries is
already reachable from the workspace, so writing a local copy of it creates a
duplicate spanning two tiers. The reverse is refused — a global write only ever
matches another global — or a fact that belongs everywhere would be quietly
demoted into whichever workspace observed it first.

Three kinds, following the standard cognitive-architecture split:

| Kind | Holds | Example |
|---|---|---|
| `semantic` | durable facts | "This project uses pnpm workspaces, not npm." |
| `procedural` | repeatable methods | "To add a migration: append to MIGRATIONS, never edit a shipped one." |
| `episodic` | what happened in a run | "The 2026-04 auth refactor broke session resume." |

### Shelves — how long a memory is meant to hold

The kind says what a memory *is*; since 0.50.0 the **shelf** says how long it
is meant to hold, and it is the shelf that decides how the store treats it.
Measured on a day of production before it existed: twenty-seven notes written
by the reflexion pass, two worth keeping, five of them the same fact restated
at five moments, and nothing in the row that could tell a convention from a
count.

| Shelf | Holds | Reaches a run | Forgets | May be replaced by a machine |
|---|---|---|---|---|
| `standing` | a convention or preference the operator stated | injected **whole** into every run of its scope, whatever the request | never | never |
| `durable` | a lesson, a method that worked, a fact no document carries | retrieved by relevance | 90-day half-life | no — consolidation, with a person |
| `volatile` | a fact that can stop being true: a version, a count, what is or is not implemented | retrieved by relevance | 30-day half-life | yes, by a newer note on the same subject |

**Standing memories are not retrieved, and that is the point.** The search
scores only what its two arms already found; a pinned "propose defaults rather
than ask three questions" was never recalled for a request about deployments,
because nothing in that request resembled it. So the kernel injects the
standing shelf first — pinned first, within a budget of 1 500 characters — and
leaves it out of the similarity search so a convention does not arrive twice.
The block is framed as rules to follow, where recalled memories are framed as
fallible recollection. The doctor warns past ten conventions in one scope: a
list of rules that needs more than that has started to contradict itself.

**Retirement is a soft delete.** A retired memory leaves retrieval, injection,
the duplicate check and consolidation at once, stays readable and restorable
for thirty days on the Memory page, and is collected by the janitor after
that. A *supersession* is a retirement that names the newer memory, and it is
bounded by rule rather than by anyone's judgement: only a volatile, unpinned
loser, in the same scope. The arbiter below was measured wanting to replace
the operator's pinned convention with a note derived from it; the rule is what
makes that verdict inert whatever the prompt says.

### The gate — what a machine may write

An operator's explicit write goes straight to the store. Everything the
machine writes — the reflexion pass — goes through `learning/gatekeeper.ts`
first: one cheap model call per run that produced candidates, never for zero
candidates, shown every candidate of the run together, each one's nearest
existing memories, and an excerpt of the workspace's standing instructions.
For each note it answers a level — `preference`, `lesson`, `fact`, `state`,
`redundant`, `episodic` — and whether the note describes an existing memory
at a later time. Only the first three are kept: a preference or a lesson as
`durable`, a fact as `volatile`. A preference the model inferred is *not*
promoted to standing — a false positive there would be injected into every
run — the operator promotes it in one gesture from the Memory page.

What the model is not trusted with is bounded outside the prompt: at most two
memories per run, three on a failed run, six per workspace per rolling day; a
supersession only onto a volatile neighbour the model was actually shown; and
on any failure of the call, nothing written — every candidate rides the run's
insight as *unjudged*, where the operator can keep any of them. Every verdict,
kept or refused, is on that insight with its reason, so a wrong refusal is a
button press away rather than a loss.

Four more rules sit after the model, because the bench showed it would not
apply them itself. A keep must say what a future session would get *wrong*
without the note; a verdict that cannot is a skip, whatever level it chose. A
note that cites a file or a line of code is describing the code, which can be
read: `state`. A note that names one of the assistant's own tools — for the
system workspace, its whole catalogue and the built-ins it is told it lacks —
is about tooling the instructions describe at every session: `redundant`. And
a preference is somebody's rule: a note the model called a preference that
never mentions the operator is judged as a lesson, and then by the two rules
above; one that does is exempt from them, since the operator's rule may well
name a tool. Each overrule is written into the reason beside what the model
had said.

Why a model at all: the cosine cannot make this decision. Measured under
bge-m3, a contrary claim sits at 0.76 from its original while two paraphrases
of one fact sit at 0.57 — "the same thing, later" and "another thing, same
subject" are not separable by distance. And why the small model: replayed over
the labelled corpus in `apps/api/scripts/memory-gate-corpus.json` — the
twenty-seven notes of that production day, judged by hand — the prompt alone
kept eight or nine of the twenty-two notes that should have been refused; the
counterfactual and the structural rules brought that to four or five, with
haiku and sonnet alike, and no note worth keeping was ever lost. What remains
is always the same handful: an interpretation heuristic, a judgement about one
cost, three notes about the code that name no file. Against the twenty-seven
that were all kept before, that is the flood reduced by four fifths, with the
budgets bounding the rest. The bench `scripts/eval-memory-gate.mjs` replays
that corpus through the real prompt on three passes and refuses a change whose
worst pass misses a keep or keeps more than five skips — the number the
prompt may not worsen without.

### The language it writes in

Every pass in this document produces prose an operator reads — a lesson, a
merged note, a drafted skill — and until 0.44 none of them carried an opinion
about which language that should be. The run's own answers followed the
operator, because `WorkspaceSettings.language` reaches the run's system prompt;
everything the system wrote *about* the run followed whatever the transcript
happened to be in. Measured on a French deployment: twenty-two memories, all of
them in English.

The decision is server-side, and deliberately not the interface's language: a
browser preference cannot decide what a shared corpus is written in, because
two people reading one store of text in two languages is not a thing that
exists. So there are two settings and one rule —

```
workspace.language ≠ auto   ⟹  that
otherwise deployment.language ≠ auto ⟹  that
otherwise                       ⟹  no directive, as before
```

— resolved at the point of use in `learning/language.ts`, so a change takes
effect on the next run rather than the next restart. The interface's language
picker writes the deployment setting too, for an owner, so "the app is in
French" stays one idea with one control.

The directive is worded for a *structured* call rather than a conversation, and
both halves of that are load-bearing: it says the language governs the values
and not the field names — a model told only "write in French" will translate
the keys and make its own answer unparseable — and it exempts what must survive
verbatim, because a procedure whose entire value is `pnpm test:run` is worth
nothing translated.

The consolidation pass batches by language before size. A group never spans two
workspaces, so each has exactly one answer, and no single call is ever asked to
reply in two.

### Two tiers, and moving between them

`memories.workspace_id` is nullable, and the null is the global tier. Retrieval
unions them — a workspace run is given its own memories *and* every global one
— which is the whole reason a standing note reaches every project.

The reflexion pass always writes scoped, because one run is not evidence that a
lesson travels. Promotion is therefore an operator decision, and it is its own
verb (`POST /api/memory/:id/scope`) rather than a field on the patch route:
every other field there is what the memory *says*, while this one decides which
projects recall it at all. It carries its own audit line, and the interface
confirms it, because promoting changes what every other workspace's runs are
given and that consequence is invisible from the screen it is pressed on.

One consequence has nothing to do with retrieval: `workspace_id` cascades on
workspace delete, so the tier a memory sits on decides whether it survives its
project.

`MemoryStore.reconcile()` is the primitive underneath all of it — promote,
confine and merge are one operation, because the hard part is shared. A memory
is not just its text: it carries the runs that used it (`memory_usages`, which
`recalledFor` reads to show a run's genesis), the reinforcement those runs
earned it, and an operator's pin. Anything that ends a row has to say what
becomes of all of that, and "nothing" is the wrong answer — the usage rows are
repointed before any delete, with the primary-key collision (a run that saw
both) resolved by keeping the larger score.

### Consolidation — semantic repetition, judged rather than thresholded

The duplicate check above cannot see paraphrase, and no threshold fixes that.
Swept over the same production corpus: catching every genuine duplicate pair
needs a floor of **0.15**, which also admits **fifty-eight unrelated pairs out
of seventy-seven**. The cosine cannot be the decision. It can only be the
shortlist — at 0.25 it proposes nineteen pairs, fifteen of them real, which is
a small enough question to put to a model.

So `learning/consolidation.ts`:

1. **A star per memory** — the memory plus its nearest neighbours above 0.25,
   capped at four. *Not* a connected component: union-find over the same
   neighbour graph swallowed eight unrelated memories into one group at that
   floor and fifteen of twenty-two at 0.20, because "somewhat similar" is
   transitive and meaning is not.
2. **One group per cluster** — a group is dropped when it shares more than half
   its members with one already kept. Without that, a cluster of four produced
   four overlapping stars: four model calls for one question, and four
   competing proposals of which applying any one leaves the other three stale.
   On the production corpus this turns fourteen groups into seven.
3. **One tool-less `haiku` call** judges each batch, answering `duplicate`,
   `contradictory` or `complementary` — the last being the common and correct
   answer.
4. **Nothing is applied.** Every verdict becomes a row in the operator's
   existing review queue.

`contradictory` is the verdict that pays for the pass. Two memories close
enough to be retrieved together that tell the agent opposite things are far
more dangerous than two that repeat, and before this nothing anywhere noticed:
both were injected side by side.

Three properties are load-bearing and each is pinned by a test:

- **A group never spans two workspaces.** `reconcile` refuses it too, but a
  group that cannot be formed is a proposal that cannot be made.
- **A memory the arbiter cannot be shown whole is never grouped.** Its answer
  *becomes* the surviving text, so judging a longer memory on a prefix would
  fold its tail away into a note derived from that prefix — approved by an
  operator shown the same prefix.
- **Every proposal carries a fingerprint** of the exact text it was drawn
  against, taken from the snapshot the arbiter saw rather than from a fresh
  read. Applying one whose members have moved since is refused, not merged
  over.

The pass runs incrementally at the end of the reflexion pass, seeded only with
what was just written — the one place a fresh duplicate can have appeared — and
in full from **Memory → Maintenance → Consolidate**. A run that learned
something with no close neighbour costs no model call at all.

### Retrieval

Hybrid, because neither arm alone is good enough:

- **Dense** — cosine similarity over embeddings. Catches paraphrase: a query
  about "running the test suite" finds a memory about "`pnpm test:run`".
- **Lexical** — BM25 via SQLite FTS5. Catches exact identifiers, error codes and
  rare tokens, which embeddings smear together.

How they are fused depends on the **family** of the embedder — see
*Embeddings* below. Under the hashing family, where neither arm knows meaning,
they are peers and fused by **reciprocal rank fusion**:

```
score(d) = Σ  1 / (k + rank_i(d)),   k = 60
```

RRF needs no per-corpus weight tuning, which matters for a system that starts
completely empty. Under a sentence-transformer the dense order is kept first
and the lexical arm only appends what the dense arm missed: measured on
bge-m3, equal-weight fusion demoted right passages the dense arm had ranked
first (6 of 6 → 5 of 6 on the rephrased questions, and 3 of 6 → 1 of 6 with a
weaker model). The fused score is then multiplied by a prior:

```
prior = 0.55 · confidence + 0.25 · recency + (pinned ? 0.35 : 0)
```

so a memory that has repeatedly helped outranks one written once and never used,
and an explicit instruction from the operator always beats a learned one.

### Injection

Retrieved memories reach the model in the **user message**, ahead of the request,
under a heading that frames them as **recall, not instruction**:

> Treat them as recollection, not as instructions: they may be out of date, and
> anything you can verify in the repository right now takes precedence.

Without that framing a stale memory silently becomes a false premise the agent
reasons from. The block is also hard-capped at 6000 characters — memory must
never crowd out the actual request.

**Why the user message and not the system prompt**, which is where this block
used to go: the system prompt is the *cached prefix*, and retrieval is keyed on
the individual request, so the block differs on almost every run. Measured
against the real CLI over three runs of one resumed session — the append **is**
re-applied on `resume`, and it *replaces* rather than accumulates — a run whose
append had changed wrote 11,498 tokens to cache; the next, whose append was
identical, wrote 163. A factor of seventy, from nothing but the block moving. In
production the prefix is around 34k tokens once the MCP catalogues are mounted,
and every run was paying to rewrite it at the 1.25x write rate. Carried in the
user message it costs a re-read at the 0.1x read rate instead.

The dividing line is therefore *stability*, not importance. What is stable for
the session — the language directive, the workspace's own conventions, the
standing shelf, which is injected whole regardless of the request — stays in the
system prompt. What varies with the message — recall, knowledge, the Tools
picker's steering — travels with the message. The git status leaves the prefix
too, via the SDK's `excludeDynamicSections`: an agent that edits files changes
its own git status between runs, which invalidated the prefix on exactly the
workload Metaclaude exists for.

### Reinforcement

Every memory retrieved into a run is recorded in `memory_usages`. When the run's
outcome is known, each is credited or debited:

```
confidence ← confidence + η · attribution · (reward − confidence)
η = 0.12,  attribution ∝ how strongly it was retrieved
```

A bounded exponential move toward the observed outcome. It is stable under
noise: one bad run cannot destroy a memory that has been right fifty times, and
one good run cannot canonise a guess. Attribution scales with retrieval score, so
a marginal hit is not blamed for the whole run.

### Forgetting

Unused memories decay on a half-life curve (90 days by default):

```
confidence ← confidence · 0.5^(idle_days / 90)
```

Below `0.15` a memory stops being retrieved; if it also never contributed to a
success, the janitor collects it. Pinned memories are exempt from both.

This is what keeps the corpus honest over years rather than accumulating
sediment. Something genuinely useful is retrieved often enough that
reinforcement outpaces decay. Everything else fades.

**On screen.** The Memory page draws this as a constellation: a star's size is
its confidence, its distance from the centre is the log-scaled time since a run
last recalled it, and a ring marks the pinned memories decay cannot touch. A
star drifting toward the rim is not an illustration of the forgetting curve —
it *is* the curve, plotted from the same `last_used_at` the decay reads. And
what a given run actually recalled is on the run itself: the genesis strip in
the transcript lists the injected memories with the rank-normalised retrieval
score that `recordUsage` stored, which is the same number the attribution term
above uses.

---

## The knowledge library — what the operator handed over

Beside the memory store sits its deliberate opposite. `KnowledgeStore`
(`learning/knowledge.ts`) holds reference documents — no confidence, no
decay, no reaping, because reference material that quietly faded would be
the worst failure the store could have. What the two stores share, they
share by construction rather than by copy: the embedding provider, the
measured relevance floors, the fts5 configuration and the RRF fusion all
come from the same modules, so a lesson measured once holds in both.

Ingestion chunks each document (`learning/chunker.ts`): paragraphs packed
toward ~1100 characters, oversized ones split at sentence then word
boundaries, ~150 characters of overlap at each seam, and the nearest
markdown heading carried with every chunk. Each chunk is embedded with its
document title and heading prefixed — the cheap version of contextual
retrieval, and the part of it that pays: "the notice period is 45 days"
cannot match a query about terminating the lease unless the context travels
with the passage. A content hash makes re-saving identical text a metadata
write, never a re-embed.

Search is the memory shape — dense ∪ BM25, RRF fusion, the same measured
gates — with three additions of its own, each traceable to a measurement:
a dense-solo floor (0.18) because French stopword n-grams soak a French
corpus into a flat band the relative gate admits; stopword abstention in the
lexical arm, because on a small corpus a function word carries real IDF
straight through the clamp gate; and a two-passages-per-document cap, so one
strong document cannot silence the second-best. Scoping is the memory rule:
a run reads its workspace's shelf plus the global one, and never a
sibling's.

Injection mirrors memory exactly: retrieved passages are rendered as
quotations with their source, budgeted (9000 characters), and only what was
*injected* is credited to `document_usages` — the genesis shows what the run
actually saw, not what retrieval considered.

## Loop 2 — Policy: which model for which kind of task?

**Timescale: tens of runs.**

Using Opus for a one-line rename wastes money; using Haiku for an architecture
review wastes the operator's afternoon. The right answer depends on the task, and
nobody wants to choose per message.

This is a **contextual multi-armed bandit**. The context is a task category; the
arms are `(model, effort)` pairs; the reward is a composite score.

### Why Thompson sampling

Each arm keeps a Beta posterior over its success probability. To choose, we draw
one sample per arm and take the highest.

Compared with the alternatives:

- **ε-greedy** explores at a fixed rate forever. Every exploration step costs
  real money and real minutes of the operator's time.
- **UCB1** needs a tuned exploration constant, and behaves poorly before it has
  seen each arm several times.
- **Thompson sampling** explores in proportion to genuine uncertainty. A clearly
  better arm stops being second-guessed quickly, and it needs no tuning constant
  — which matters for a system that must behave sensibly from run one.

Sampling is exact: Beta via the ratio of two Gamma draws, Gamma via
Marsaglia–Tsang. The random source is injectable, so the tests are deterministic.

### The arms

Deliberately eight:

```
haiku  ·  sonnet/low  ·  sonnet/medium  ·  sonnet/high
opus/medium  ·  opus/high  ·  fable/high  ·  fable/xhigh
```

A bandit with forty arms and a handful of runs per week never converges. These
span the useful frontier — cheap and fast, balanced, deep reasoning, and the
flagship tier — and the operator can always override per message.

The fable arms are there because a frontier frozen at the previous generation
makes the newest model structurally unreachable under Auto however the runs
score: omission is not evidence. `sonnet/medium` was added later still, because
the gap between `low` and `high` was the one place a common workspace default
sat with no arm beside it.

### Where each arm opens

Listing an expensive arm is not the same as *starting* on it, and the two were
conflated for as long as every arm was seeded `Beta(1, 1)` — the uniform prior,
which says an arm costing $2.10 a run is exactly as plausible as one costing
$0.07. Four of the eight are opus or fable, so with near-identical posteriors a
Thompson draw is close to uniform and more than half of every early decision
landed on the dear end of the range. That is the opposite of how you find a
threshold: you start low and let the failures push you up.

`armPrior` asks the reward function itself what an *ordinary success* on that
arm would score, given what it costs and how long it takes. Quality cannot be
known in advance — `computeReward` gives every success the same 0.8 — so cost
and latency are the only honest things that can separate two unproven arms, and
they are exactly what the remaining two terms price. Deriving the prior through
`computeReward` rather than a hand-written table also means it follows the
reward: change a weight and the opening beliefs move with it instead of
silently contradicting it.

It is worth four pseudo-trials — small on purpose. Two or three real runs on an
arm outweigh it, so it steers the opening moves and then gets out of the way. A
prior that survived a dozen trials would not be a prior, it would be a policy.

One detail that had to be measured rather than reasoned: a model's *speed* is a
property of the model, not of the effort level. `null` effort on Haiku means
"this model has no such knob"; on Sonnet it means "the CLI will choose, and it
chooses high". Reading both as `high` priced the cheapest, fastest arm as though
it were the slowest, and ranked `sonnet/low` above `haiku`.

### When the learner is consulted at all

Only when nothing upstream pinned a model or an effort. An explicit choice in the
composer, or a workspace setting, wins outright — the point of the learner is to
answer the question nobody has answered, not to overrule someone who has.

**Two callers got that wrong, in the same way, and the second went on doing it
after the first was fixed and its lesson written down here.**

The first was the scheduler. An automation's policy defaults to
`model: 'default'`, meaning "let Metaclaude choose", and the scheduler forwarded
the whole policy as run overrides — so the kernel saw a *defined* `model` and
stopped consulting the bandit. Automations are the runs that repeat most, the
workload where a few dozen samples per arm is actually reachable, so this quietly
excluded exactly the traffic the learner needed. The scheduler now forwards only
what the operator pinned.

The second was the composer, and it was the larger of the two. Its model picker
spells "Auto" as the literal value `default`, and it sends its pickers on *every*
message — so `overrides.model` was defined for every message a person ever typed.
`choosePolicy` gated the bandit on `!overrides.model`, which is false for the
non-empty string `'default'`. Measured in production over 54 runs: 46 stamped
`explicit` against 7 `learned`, and every one of the 42 runs submitted as Auto
was served by `claude-opus-5` — the CLI's own default, which is the most
expensive tier, three of them by the 1M variant at roughly three times the price.
Choosing Auto did the exact opposite of what it said: it switched the learner off
*and* pinned the flagship.

A third instance hid one level below, in the fallback. `session.model ||
settings.defaultModel` treats Auto as a choice for the same reason, so a session
left on Auto never reached the workspace default either — it resolved to
`'default'` and landed on the CLI's. That is the cold-start path, taken until a
(workspace, category) pair has eight trials, which makes it the ordinary path in
a young deployment: the learner's *absence* was being routed to the dearest model
available.

The lesson as first written here was "anything that means unset has to be
`undefined`". That is right for a caller that can simply omit the field, and it
is what fixed the scheduler. It is not available to the composer: the sentinel is
what the session *stores*, and a picker has to send something. So the rule is
better stated as a question about intent — **"did the operator pin one?", never
"is the field present?"** — and it is answered by `isAutoModel` / `isAutoEffort`
in `packages/shared`, exported precisely so the two sides cannot drift again.
Same family as the workspace-settings guard that refused the very form which
round-tripped it.

### When the subscription refuses the arm

A model can be unavailable rather than merely expensive: subscriptions meter each
model separately as well as overall, so one arm can be spent while the rest still
serve. That is not something the reward can express — a refusal says nothing
about a model's quality — so it is handled beside the learner rather than inside
it.

A refused run is classified. If the exhausted window belongs to one model, the
run resumes the same CLI session on the **next arm the learner ranks**, skipping
anything already refused or known spent, and the operator gets a line saying what
changed and why. Three switches, then the failure stands. If the exhausted window
is a global one, no switch is attempted: every arm draws on it.

Two details matter for the learner's sake. The arm credited at the end is the one
that **actually ran**, not the one that was asked for — crediting a refused arm
would teach the bandit about a model that never answered. And the ranking comes
from `list()`, the posterior *mean*, not from `select()`'s Thompson draw: a retry
must be predictable, and an operator reading two identical warnings should not
see two different models. Since the prior became cost-aware that ordering is
meaningful from the very first run, which is what makes this work on a workspace
with no history at all.

The discriminator took three attempts, and the two that failed both read well.
Switching on `rateLimitType === 'seven_day_<model>'` follows the SDK's own enum
and would never have fired: a genuinely exhausted Fable bucket reports
`seven_day_overage_included`, which names no model. Passing the CLI's
`fallbackModel`, documented for a primary that is "overloaded or unavailable",
returns a result byte for byte identical to no fallback at all — it does not
cover quota. What discriminates is the rejected event's view of the *global*
windows: `seven_day` at 0.97 and still serving while Fable was refused.

### The reward

```
reward = 0.72·quality + 0.16·cost + 0.12·latency        ∈ [0, 1]
```

- **quality** — 0.8 for success, penalised by failed tool calls and hit limits;
  0.05 for failure; 0.4 for interruption (ambiguous: the operator may simply
  have changed their mind, so it is scored neutrally rather than punished).
- **cost** — `exp(−usd / 0.35)`. Decays to near zero by a dollar a run.
- **latency** — `1 / (1 + ms / 120000)`. Half weight at two minutes.

**An explicit rating overrides the inferred quality entirely.** Thumbs up or down
is the ground truth being learned; everything else is a proxy for it.

### Cold start

Below eight recorded trials for a category, `select()` returns `null` and the
workspace default is used. Acting on one data point would be worse than not
learning at all.

### Inspectability

The Analytics screen renders each posterior in plain language:

> Across 34 runs, sonnet at high effort performs best (82% expected quality,
> $0.041 and 47s on average).

with a Reset button beside it. A self-modifying policy the operator cannot read
and cannot revert is not one they should trust.

**On screen.** Beside that sentence each arm's posterior is drawn as its actual
Beta density rather than a bar, because the mean is the least interesting thing
a posterior knows: Beta(3,3) and Beta(30,30) share one, and only the width says
which belief is settled. That width is also the honest picture of Thompson
sampling — a broad, trailing hump is exactly an arm whose samples still
sometimes win, which is why it keeps getting trials. The same curve appears in
a transcript's genesis strip for the one arm that run stood on, so "why this
model?" is answered where the question is asked.

---

## Loop 3 — Reflexion: what did we just learn?

**Timescale: one run.**

After a run completes, a small, **tool-less** Claude call reads a compressed
transcript and returns structured JSON: durable lessons, and occasionally a
proposed skill.

Constraints that make this safe rather than a liability:

- **No tools, no filesystem.** `allowedTools: []`, an explicit disallow list,
  `permissionMode: 'dontAsk'`, and a scratch working directory. The reflector
  reads text and returns JSON. It cannot act.
- **Cheap and bounded.** Haiku, one turn, thinking disabled, 120-second timeout.
  Reflection must never become a meaningful share of the operator's usage.
- **Out of band.** It runs after the operator already has their answer, and a
  failure is logged and dropped. A broken learner degrades improvement, never
  correctness.
- **Skipped when there is nothing to learn.** Trivial prompts and interrupted
  runs are filtered out before the call is made.

The prompt is deliberately harsh about quality:

> A lesson must be specific and actionable. "Write good code" is worthless.
> "This project's tests run with `pnpm -w test:run`, not `npm test`" is valuable.
> If the run was routine and taught you nothing new, return an empty array. That
> is the correct answer most of the time.

Lessons enter memory at **85% of the reflector's stated confidence, capped at
0.75**. A lesson earns trust by being retrieved into runs that then succeed —
not by asserting it.

### Skill proposals are never auto-installed

When a run follows a genuinely repeatable procedure, the reflector may propose a
skill. It lands in a review queue. Installing it is a click the operator makes.

Auto-installing generated instructions into every future run is exactly the kind
of unreviewed drift that turns a helpful system into an unpredictable one.

---

## Loop 4 — Revision: are the instructions right?

**Timescale: a week of one workspace's runs.**

The three loops above change what a run is *told* (memory), what serves it (the
bandit) and what is remembered afterwards (reflexion). None of them has ever
touched the instructions themselves — a workspace's standing prompt, a skill's
description, a subagent's prompt, an automation's script. Those are written
once by the operator and then left alone however often the runs show them to be
wrong.

Measured on this deployment on 2026-09-10, which is what forced the loop:

| | |
|---|---|
| Runs in eight days | 63, of which **0 failed** |
| Runs the operator rated | **2** |
| Skills enabled | 5 |
| Subagents enabled | 5 |
| Invocations of either, in 173 tool calls | **0** |

Two things follow. "What is not working" is not in `status = 'failed'` — this
deployment has no failures at all — and the largest single defect on it is that
ten extensions are carried into every run and never once used. Every enabled
skill puts its *description* in front of the model on every run of its
workspace; one that never fires is paid for on every one of them and returns
nothing.

Nothing could see that, either. `skills.use_count` was displayed on two screens
and incremented by no code path at all, so it read zero whether a skill was
working perfectly or had never been opened in its life — the `rewindPoint`
family of defect, a surface with no source.

### What a run did with what it was given

`run_extension_usages` is the first half and it costs no model call. At the end
of every run — before anything that can be switched off, because whether a
skill was opened is a fact rather than an opinion — the kernel folds the
transcript against the list of extensions that run was *offered*, and writes
one row per `(run, kind, name)` with `available`, `invoked` and `failed`.

The shape of an invocation on the wire had to be measured, because the SDK does
not declare it: `ToolInputSchemas` has an entry for every built-in tool except
`Skill`. Measured twice against Claude Code, once from a harness and once with
every `CLAUDE_CODE_*` variable stripped — because one observation identifies a
difference and never its cause:

```
a skill      Skill  { skill: "probe-widget" }
a delegation Agent  { description, subagent_type, prompt }
```

**The delegation tool is `Agent`, and this repository spelled it `Task` in
three places for four releases**: the permission card's summary, the
transcript's tool label, and a comment reasoning about which tools only read.
Nothing failed — the card printed raw JSON where it meant to print a sentence,
and every delegation ever made went uncounted. `scripts/sdk-probe.mjs` now
records both names so an SDK bump cannot move them quietly.

`available` comes from the registry's list, and until 0.93 that list and the
disk could disagree. The skills were written to `.claude/skills/` — the only
place the CLI reads them — from three of the eight paths that submit a run,
and the five without were the scheduler, the steward, the advisor, delegation
and the gateway. An automation therefore ran against whatever the last typed
message had left on disk, and this table recorded its skills as *offered and
never opened* when the CLI had never been shown them at all — which is the
sentence the instruction review acts on, so it would have proposed rewriting a
description that was never the problem. The write lives in
`ContextProvider.prepare` now, on the path of every run, and `available` means
what it says.

Rows are keyed by *name*, not by id, because the name is what the CLI reports
and what the model chooses between — and because an id does not exist for every
invocation: a skill shipped by a plugin and a subagent type the CLI ships
itself are real work no row here owns. Those carry a null id, which is what
keeps the "offered and never used" query honest, since it joins on the id.

### The window, and what is counted in it

A pass runs at most once a week per workspace, and only where the operator has
opted in (`improvementAuto`, off by default — an accepted revision is in force
on the very next run, which is a stronger thing than the advisor's proposals,
all of which land *disabled*). It reads the runs finished since the last
completed pass, oldest first, at most forty of them: forty at ~1.8 kB is ~72 kB
of prompt, and a window is *a period of work* rather than a corpus.

Then, **in code and before any model sees it**, the recurrences are counted:

| Observation | The bar |
|---|---|
| an extension offered and never invoked | 12 runs, 2 distinct days |
| a subagent that fails when used | 3 runs, 2 days, over half its invocations |
| a tool erroring again and again | 3 runs, 2 days |
| an automation whose firings fail | 3 runs, 2 days |
| instructions past 70% of the field's ceiling | — |

Three runs on two days is the whole of "do not over-react", made arithmetic: one
run is an incident, one day is a busy afternoon. Asking a model to notice that
something happened three times is asking it to count, which it does
confidently and unverifiably — the memory gate measured that four rules had to
sit *after* the model there, and these are the same four in a different key.

**The unused-extension bar is deliberately a blunt count and not a relevance
test.** The obvious refinement — only count runs the extension was plausibly
*for*, by cosine between its description and the prompt — was written and then
rejected. Every floor in `retrieval.ts` is a measurement *of retrieval*, and
reusing one for a question nobody has measured is how a number comes to mean
two things; worse, it would mean two different things on two deployments, since
under the hashing family a cosine carries no meaning at all and a small host
still ships it. What the blunt rule costs is patience with a skill written for
a rare job. What it buys is that being indicted means something.

### The arbiter

One tool-less, schema-constrained call on the cheap model, shown: the window,
the counted facts *as counted facts*, the instruction texts, and the findings
the operator has already refused. It answers with findings of its own — the
things code cannot count, "these three runs failed because the calendar was
down, which no instruction can fix" — and with at most three revisions, each
naming its target by the **number** it carried in the prompt. The gate's
`candidate` discipline: a model answering with an index cannot name a target it
was never shown, while one answering with an id will occasionally invent a
plausible one, and an invented id is a revision applied to the wrong text.

A text too long to show whole is listed and marked unrevisable. `ARBITER_EXCERPT`
from the consolidation pass, and with more force: the answer *becomes* the
surviving text, so judging a long instruction on a prefix folds its tail away
into a rewrite derived from that prefix, approved by an operator shown the same
prefix.

### The rules that sit after it

Every one exists because a prompt cannot enforce its own:

- the revision must cite a finding whose runs are **in this window**, and that
  finding must name at least three of them — an invented citation is the same
  as no citation;
- not a finding the operator already refused;
- not a text shown only in part, nor a field the target does not have;
- not the text that is already there (trailing whitespace ignored — a model
  hands back the prompt with a newline on the end often enough to matter);
- not a *rewrite*: past six lines, no more than two fifths of the larger side
  may stop being shared. Below six lines a full replacement is allowed and
  normal — the single most useful edit this pass makes is turning "Reviews
  migrations." into "Use when reviewing a database migration before it ships",
  which is a hundred per cent of the text by any measure;
- one revision per text, three per pass;
- and, at the service, one *pending* proposal per text and a fortnight's
  cooldown after a refusal.

### What it produces, and what closes the loop

A row in the advisor's existing inbox, kind `revision`, carrying `before`,
`after`, a fingerprint of `before`, the unified diff, and the runs behind it as
links. Applying is refused when the fingerprint no longer matches — the
consolidation rule, for the consolidation reason. **Nothing else in that inbox
can be accepted by the steward, and neither can this**: every other kind lands
*disabled*, so "accepted" is the end of it, while a revision shapes the next
run of its workspace including runs nobody is watching. Reversible has to be a
button, and `revert` is it — refused in turn when what stands is no longer what
the revision wrote, so an operator who has edited since cannot lose that edit
to something labelled *undo*.

At the following pass, each revision applied *before the oldest run of the new
window* gets a `followUp`: the same deterministic observation, recomputed, and
whether the finding it answered came back. It costs no model call. A background
pass that cannot say whether its own advice worked is one nobody should take
advice from — and it is the half of "what works and what does not" an operator
cannot see for themselves, because it needs the same measurement repeated on
the same terms.

### What it may read, and what that costs

Every text put to the arbiter was capped from the first day; the number of them
was not, and one row per workspace plus two per enabled skill, two per enabled
subagent and one per automation is four hundred thousand characters at forty
skills — about a hundred thousand tokens on top of the window, weekly, per
workspace, and past the model's context a pass that fails for good. The budget
is `reviewTargetChars` on the Configuration screen, read per pass so a change
applies without a restart, and it is spent greedily in list order: descriptions
are small and nearly always fit, which is the right outcome because a
description is what this pass most often has something useful to say about. The
workspace's own instructions are never what is dropped to make room, and the
prompt says how many texts are not shown so the arbiter does not propose
creating one that already exists.

### Every pass leaves a row

`revision_reviews`, whether or not anything was proposed — including what the
rules refused and why, and whether the call died. The `runs.reflected_at`
lesson applied before it could be learned twice: without it, four outcomes are
indistinguishable and every one renders as an empty screen — the window was not
ready, the pass found nothing, the rules dropped everything it found, the model
call failed. Three of those are correct and one is a defect, and the operator is
entitled to know which. It is also the cursor: the newest completed row says how
far the last pass read, so no second table holds a copy of something these rows
already say. A pass that died does not move it.

### Measured, and how it was nearly got wrong

`scripts/eval-instruction-review.mjs` replays ten labelled windows — two that
need a revision, eight where the honest answer is *nothing* — through the real
prompt and the real model. Two prompts, five passes each, on haiku:

| | over-reactions per pass | missed |
|---|---|---|
| without the "never used is not by itself a reason" rules | 2, 1, 0, 1, 1 | 1 |
| with them | 1, 0, 0, 0, 0 | 0 |

The recurring over-reaction — rewriting a description that already stated its
trigger condition, on four passes of five — disappears; the survivor is a
different window each time.

Worth recording how that was nearly got wrong. At **three** passes the two
prompts were indistinguishable, and sabotaging the rules did not move the
number at all. The tempting conclusion was "the rules do nothing"; the true one
was "this bench cannot tell yet". Three passes over six windows was simply too
few to see past the model's own variance. **A measure that reads the same under
sabotage is a measure to strengthen before it is a result to believe.**
---

## What each pass runs on

Every loop above ends in a model call, and until 0.92 the model was a constant
in the source: `haiku` for the five structured passes, the workspace's own
model for the advisor. That was the right default and the wrong arrangement —
an operator who wanted better judgement on the weekly instruction review, or
cheaper reflexion on a chatty deployment, had no way to say so.

Twelve settings now say it, one model and one effort per pass, on the
Configuration screen and independent of every workspace:

| Pass | What it does | Ships on |
|---|---|---|
| Reflexion | reads a finished run's transcript | `haiku` |
| Memory gate | judges each proposed note | `haiku` |
| Consolidation | merges overlapping memories | `haiku` |
| Synthesis | distils a repeated procedure into a skill | `haiku` |
| Revision | the weekly instruction review | `haiku` |
| Advisor | the agentic run that comments on a workspace | the workspace's model |

Four properties are worth stating, because each one is a way the obvious
implementation is wrong.

**The sentinel is `auto`, not `default`.** `default` is the CLI's own alias and
means "whatever the CLI would pick", which on a subscription is Opus. An
operator choosing it for the reflexion pass expecting "leave it alone" would
move every post-run call from Haiku to Opus at roughly thirty times the price,
with nothing on screen to say so. `auto` is the word the `language` setting
already uses and it resolves to the phase's shipped default, which each row
states in plain words rather than leaving the operator to infer it.

**Absence is not `null`.** A pinned value is spread into the request; an
unpinned one is *omitted*. An absent model lets the call take its own default,
and an absent effort lets the CLI choose for the model it is serving —
`effort: null` would be a value the SDK carries. One helper, `pinnedFields`,
knows this, and every factory spreads it.

**Every pass reads its setting at the moment of the call.** The five call
contexts are built once, at boot, inside `context.ts`; a captured model would
need a restart to change, which for a setting about spend is the wrong answer.
So each factory takes a getter rather than a value, and
`learning/phase-policy.test.ts` builds each call once and fires it twice with
the setting moved in between — the only shape of test that can tell the two
apart. Written the other way round, with the factory rebuilt between firings,
it passed against a deliberately captured policy.

**An effort has no meaning on a model without the knob.** Haiku has none, and a
level pinned on it is silently downgraded — measured. So pinning an effort
alone does nothing until the model is also changed, and the screen says so
rather than letting the operator believe otherwise.

The same reasoning reaches one row that is not a setting: `revision_reviews`
records which model judged a window, and that value is read per review from the
same setting. A captured name would have recorded `haiku` on a window an
operator had just moved to `fable` — a column that is worse than absent,
because it reads as an answer.

---

## The classifier

The bandit needs a context. That is a coarse task category, produced in two
stages:

1. **Rules** — Unicode-aware lexical cues in English and French. Fast,
   transparent, and working from run one.
2. **kNN** — distance-weighted vote over embedded exemplars of the operator's
   own past prompts. Takes over once it has seen enough (≥12 exemplars, ≥0.62
   agreement) to beat the rules.

Every classification carries a human-readable reason — *"Matched 9 similar past
tasks in this workspace"* — surfaced in the policy preview.

> A note on the rules: JavaScript's `\b` is defined against ASCII `\w`, so there
> is no word boundary between a space and `é`. Written naively, every French cue
> beginning with an accented letter is silently unmatchable. The patterns use
> `(?<![\p{L}\p{N}_])` lookarounds with the `u` flag instead. This was a real bug,
> caught by tests, and it is the kind that fails silently forever.

---

## Measuring retrieval, and what it measured

`learning/eval.ts` is the instrument: recall@k, MRR and nDCG@k over labelled
queries, macro-averaged. `learning/eval-corpus.ts` is the corpus — five real
documents, eight distractor seeds replicated to reach a few hundred chunks,
and ten questions each naming what it probes. `retrieval-quality.test.ts`
guards the result; `scripts/eval-retrieval.mjs` re-measures it after a change.

It exists because retrieval improvements are exactly the kind that feel
obviously right and are not. Two measurements decided this subsystem's
direction:

**On questions phrased in the corpus' own words, retrieval is already
perfect.** recall@5, MRR and nDCG all 1.0 — including paraphrases, including
at three hundred chunks, including three leases that differ only by the
address in their title (which works because each chunk is embedded and
indexed with its document title prefixed; remove that and the test notices).

**On questions sharing no content word with their answer, it finds nothing.**
Zero on all three metrics — and zero *at the candidate pool*, not merely
below k. Pressed further, with every gate, the fusion and the limit stripped
away so the embedder ranks the whole corpus by raw cosine on its own, the
right passage comes back **34th to 76th of 113**, scoring −0.009 to 0.089
while the best-ranked (wrong) chunk sits at 0.098–0.204. The answer is not
merely ranked low; it is scored like noise. The same measurement on
in-vocabulary questions returns rank 1.

Under the hashing embedder, that bounds **every** reranker rather than one
pool size: a reranker reorders a prefix of that list, and the right passage is
not in any prefix worth taking. It also rules out the alternative
explanation — the wall is the embedder, not the relevance gates; opening them
changes nothing.

**And it was re-measured once bge-m3 shipped, because the argument above stops
applying the moment the pool contains the right passage.** With a real model
in front of it, five of six rephrased questions are found at rank 1, so there
*is* something for a reranker to reorder. Two multilingual cross-encoders were
run over the same corpus, the same queries and the same metrics, in the image
this product ships:

| | recall@5, in-vocabulary | recall@5, rephrased | 24 pairs | resident memory |
| --- | --- | --- | --- | --- |
| bge-m3 alone | 100% | 83.3% | — | ~600 MB |
| + `bge-reranker-base` q8 | 100% | **50.0%** | 633 ms | 1.5 GB |
| + `bge-reranker-v2-m3` q8 | 100% | **66.7%** | 950 ms | 2.0 GB |

Both make it *worse*, and both lose the same two French questions the dense
arm had at rank 1. The logits offer no absolute gate either: relevant p10 sits
at −7.1 against irrelevant p90 at −6.6, overlapping. On the two-core host this
runs on, the second model does not fit beside the first inside the container's
memory limit at all.

So there is still no reranking stage, for a better reason than before, and
`scripts/eval-retrieval.mjs --rerank <model>` is how to re-open the question
if the host ever changes shape. Six rephrased questions is a small sample —
16.7 points per question — and that is said out loud rather than hidden: what
makes the conclusion safe is that two models agree on the direction and the
resource ceiling decides it on its own.

The lever is the embedding provider. The hashing embedder's "similarity" is
character-n-gram overlap; a sentence-transformer bridges those questions, and
since 0.46 one ships in the image and is the default. The same bench, run
through `scripts/eval-retrieval.mjs` against every candidate, is what chose
it — the numbers are in *Embeddings* below — and the doctor's `retrieval`
check reports which embedder is answering and in which regime.

## Embeddings

Two providers, both **local**. No text ever leaves the machine for embedding.

**`local` (default)** — `Xenova/bge-m3` through `@huggingface/transformers`,
quantised, CLS-pooled, 1024 dimensions, pinned by revision and shipped in the
image: the runtime never downloads a model. Multilingual, which the corpus
requires — the memories are French, the documentation English, and a question
in one language must reach an answer in the other.

**`hash`** — feature hashing over word unigrams, bigrams and character 4-grams,
projected into 512 dimensions with signed buckets so collisions cancel rather
than accumulate, sub-linearly weighted and L2-normalised. No model in memory,
no native dependency. It catches the same text written twice and nothing that
is merely *meant* twice, and it is kept for hosts that cannot spare the
gigabyte — at the price of matching words rather than meaning, which the
doctor, the Settings screen and the Memory page all say out loud.

### Why this model

Measured on the labelled corpus above — six questions sharing no content word
with their answer, recall@5 of the dense arm alone, then through the pipeline
as it was before the profiles below existed:

| Embedder | Dense arm alone | Old pipeline | Process RSS | On disk |
|---|---|---|---|---|
| `hash-v1:512` | 0/6 | 0/6 | 148 MB | — |
| `all-MiniLM-L6-v2` (English) | 0/6 | 0/6 | 154 MB | 22 MB |
| `paraphrase-multilingual-MiniLM-L12-v2` | 3/6 | 1/6 | 561 MB | 113 MB |
| `multilingual-e5-small` / `-base` | 2/6 | 2/6 | 562–708 MB | 113–280 MB |
| **`bge-m3`** | **6/6** | 5/6 | 1 009 MB | 570 MB |

Two things that table says beyond the winner. The English model the code used
to name as its default does not separate French at all — 0.44 between two
unrelated sentences, 0.46 for a paraphrase — so "install the package and set
`local`" was never going to work on this deployment. And the old pipeline,
tuned on hashing, *cost* every model recall: that is the origin of the
profiles.

Cost, on this machine and scaled by the ×3 measured against the production
CPU: bge-m3 loads in about 30 s (≈ 90 s on the server), answers a query in
about 17 ms (≈ 50 ms), indexes a hundred chunks in about 11 s (≈ 33 s), and
holds the process near 1 GB — 1.27 GB while embedding a batch of long chunks,
which is why model calls are serialised and batched by eight.

### One profile per family

Every floor in `retrieval.ts` is a measurement, and the two families measure
differently. On bge-m3, memory-scale texts:

| Pair | Cosine |
|---|---|
| a query of function words, against the corpus | ≤ 0.36 |
| unrelated memories | 0.27–0.42 |
| same project, different facts | 0.38–0.54 |
| the weakest genuine paraphrase (query → passage) | 0.46 |
| the same fact, paraphrased, between two memories | 0.57 |
| a contrary claim on the same subject | 0.76 |
| the same fact restated in other words | 0.87 |

So `retrievalProfile(family)` chooses, per family: the dense floors, the
knowledge store's solo-dense floor, the automatic-merge threshold (0.92 for
hashing, 0.85 for the sentence-transformer — above a contrary claim, below a
restatement), the consolidation shortlist floor (0.25 and 0.50 — the hashing
value would shortlist an entire bge-m3 corpus) and the fusion rule.
`retrieval-profile.test.ts` holds each number against the band it was
measured in rather than against a value, and `retrieval-quality-semantic.test.ts`
guards the pipeline with a fake that has exactly one property of a real
model — words that mean the same thing land close — so no gate or fusion may
ever again put a right passage below where the dense arm ranked it.

Pooling is part of the model, not the pipeline: bge-m3 is trained with CLS
pooling and answers noise under the sentence-transformers default of mean
pooling. `MODEL_PROFILES` carries it, and the dimension is discovered from the
first vector rather than declared. The e5 family is deliberately not listed:
it embeds queries and passages with different prefixes, which this interface
has no seam for, and without them every text scores 0.8 against every other.

### Readiness, and what happens without a model

The provider exists at once and is **not ready** until the model has answered
a first vector — tens of seconds — and stays not ready for good if it cannot.
The rule that follows is one line, with four consumers: nothing writes or
compares a vector under a provider that is not ready. A memory written
meanwhile is stored *pending* (no vector, no model id); a document is written
with its text and its fts index, marked pending, and found by its words; a
classifier exemplar is stored empty; the consolidation sweep compares nothing.
Search runs its lexical arm alone and says nothing false.

Pending is a promise only if something keeps it: `reindexStale` rebuilds every
stale row — memories, documents *and* the classifier's exemplars, which a
change of embedder used to leave silently invisible — and is asked for at
boot, when the model becomes ready, when the setting changes, and whenever a
document too large to embed inside its request is saved. One pass runs at a
time; asks that arrive mid-pass collapse into one more.

What it never does is fall back to hashing. It used to: a failed load became
the hashing embedder, the boot re-embedded the whole corpus in hashing, and
the next boot that loaded did it all again the other way. Now a provider that
cannot load keeps its own id, the doctor warns with the reason, a push
notification says so once, and the Memory page shows the regime and the count
of vectors still waiting.

### The setting is hot

`METACLAUDE_EMBEDDINGS` is a runtime setting like the others: switching to
`hash` takes effect at once and starts the rebuild; switching to `local`
switches every store to the model's id at once — they answer lexically until
it is ready — and the rebuild follows. A stored choice is read at boot, so it
outlives a restart. Toggling keeps one local provider: switched away and back,
it is handed to the stores again — loading or loaded — rather than loaded a
second time, and only a provider that gave up is reloaded, which is how fixing
missing model files needs no restart (`learning/embedder-switch.ts`). The
manual **Re-index** under Memory → Maintenance now rebuilds all three stores
and reports each count.

## What this is not

Worth being precise, because the field is full of overclaiming:

- **No model weights are updated.** Claude is unchanged. What changes is the
  context it receives and the configuration it runs under.
- **No online gradient descent.** The bandit is a closed-form conjugate update;
  memory reinforcement is a bounded exponential average. Both are auditable
  arithmetic on rows you can read in the UI.
- **No autonomous self-modification.** The system proposes; the operator
  installs. Every learned artefact is listable, editable and resettable.

The claim is narrower and, I think, more interesting: **a system that gets
measurably better at your work, in ways you can inspect and undo.**
