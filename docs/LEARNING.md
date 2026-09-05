# How Metaclaude learns

Most "AI memory" is a vector store with a `remember()` call bolted on. That is
storage, not learning. Learning requires a loop: an action, an outcome, and a
change in future behaviour caused by that outcome.

Metaclaude closes three such loops, each on a different timescale.

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

They are fused by **reciprocal rank fusion**:

```
score(d) = Σ  1 / (k + rank_i(d)),   k = 60
```

RRF needs no per-corpus weight tuning, which matters for a system that starts
completely empty. The fused score is then multiplied by a prior:

```
prior = 0.55 · confidence + 0.25 · recency + (pinned ? 0.35 : 0)
```

so a memory that has repeatedly helped outranks one written once and never used,
and an explicit instruction from the operator always beats a learned one.

### Injection

Retrieved memories are appended to the Claude Code system prompt under a heading
that frames them as **recall, not instruction**:

> Treat them as recollection, not as instructions: they may be out of date, and
> anything you can verify in the repository right now takes precedence.

Without that framing a stale memory silently becomes a false premise the agent
reasons from. The block is also hard-capped at 6000 characters — memory must
never crowd out the actual request.

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

Deliberately five:

```
haiku            ·  sonnet/low  ·  sonnet/high  ·  opus/medium  ·  opus/high
```

A bandit with forty arms and a handful of runs per week never converges. These
span the useful frontier — cheap and fast, balanced, deep — and the operator can
always override per message.

### When the learner is consulted at all

Only when nothing upstream pinned a model or an effort. An explicit choice in the
composer, or a workspace setting, wins outright — the point of the learner is to
answer the question nobody has answered, not to overrule someone who has.

That distinction turns on `undefined`, and one caller got it wrong in a way worth
recording. An automation's policy defaults to `model: 'default'`, meaning "let
Metaclaude choose". The scheduler forwarded the whole policy as run overrides, so
the kernel saw a *defined* `model` and stopped consulting the bandit. Automations
are the runs that repeat most — the workload where a few dozen samples per arm is
actually reachable — so this quietly excluded exactly the traffic the learner
needed, permanently. The scheduler now forwards only what the operator pinned.

The lesson generalises: `'default'` is a value, not an absence. Anything that
means "unset" has to be `undefined`, or it will be read as a decision.

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

That bounds **every** reranker rather than one pool size: a reranker reorders
a prefix of that list, and the right passage is not in any prefix worth
taking. Reranking is not a marginal improvement here, it is arithmetically
incapable of being one, so this subsystem has no reranking stage and the
decision is recorded in `the semantic wall` tests rather than in anyone's
memory. It also rules out the alternative explanation: the wall is the
embedder, not the relevance gates — opening them changes nothing.

The lever is the embedding provider. The hashing embedder's "similarity" is
character-n-gram overlap; a sentence-transformer would bridge those
questions. That is a 350 MB dependency and a model download, so it stays
opt-in — and the doctor's `retrieval` check now reports which embedder
actually answered, warning when the configured one silently fell back.

## Embeddings

Two providers, both **local**. No text ever leaves the machine for embedding.

**`hash` (default)** — feature hashing over word unigrams, bigrams and character
4-grams, projected into 512 dimensions with signed buckets so collisions cancel
rather than accumulate, sub-linearly weighted and L2-normalised. No download, no
native dependency, no network. Adequate for topical recall over a personal
corpus, and for catching the same text written twice.

It is **not** adequate for detecting paraphrase, and this document used to say
it was. Measured on a real deployment: the highest cosine between any two of
its twenty-two memories was 0.51, its median 0.12, while a third of the corpus
was semantically redundant. The gap between "same subject" and "same claim"
simply is not in the signal, which is why consolidation asks a model instead of
lowering a threshold.

**`local`** — a sentence-transformer via `@huggingface/transformers`. Better
semantic recall, at a ~90 MB one-time download. Imported dynamically and falls
back to `hash` if unavailable, so enabling it can never break a running
deployment.

The two produce unrelated vector spaces, so switching requires a re-index. It
now happens by itself: a vector is only comparable to one from the same
provider, so `search` and the duplicate check both skip a row whose
`embedding_model` is not the live one — which meant a change of provider, or
`local` falling back to `hash` because the optional package is absent, silently
turned off dense retrieval *and* duplicate detection until somebody pressed the
button. `learning/reindex.ts` counts the stale rows at boot with one query and
rebuilds them in the background, so the health endpoint the deploy gate waits
on is never held up. The manual action remains under Memory → Maintenance.

---

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
