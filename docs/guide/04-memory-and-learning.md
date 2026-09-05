# Memory and learning

An agent that starts from zero every session is a very good autocomplete.
Metaclaude closes the loop: it remembers, it measures, and it adjusts — and
every part of that is visible and resettable, because a self-modifying system
you cannot read is not one you should trust.

## Memory

Three kinds, all browsable under **Memory**:

- **Episodic** — what happened: distilled records of past runs.
- **Semantic** — what is true: facts about your projects and preferences.
- **Procedural** — what works: methods that succeeded before.

Before each run, the system retrieves the memories most relevant to your
prompt — exact identifiers and paraphrases both — and hands them to the agent
as context. Memories that get retrieved into runs that *succeed* gain
confidence; the rest decay on a forgetting curve until the janitor collects
them. You can pin, edit or delete any memory, and re-index the store after
changing the embedding provider.

Memory can be disabled per workspace, for projects that should stay cold.

### Two tiers: this project, and everywhere

Every memory sits on one of two tiers, and the list is grouped by them:

- **Global** — recalled in every workspace. Standing notes about you or about
  how you like to work: the language you write in, a practice you always want
  followed.
- **A workspace** — recalled only there. Anything naming a command, a path or
  a convention that belongs to one project.

A run is given **both**: its own workspace's memories *and* every global one.
That is why the list shows both, and why it separates them — the union is what
the agent sees, and you should be able to tell at a glance which half is which.

The reflexion pass always writes into the workspace it learned in, because one
run is not evidence that a lesson travels. Deciding that it does is yours:
**Make global** on any workspace memory, **Confine to…** on any global one.
Both ask first, because promoting changes what every *other* project recalls —
a consequence you cannot see from the screen you press it on.

One consequence worth knowing: deleting a workspace deletes its memories.
Promoting one is how a lesson outlives the project it was learned in.

### The language it writes in

Switch the app's language under **Settings → Appearance** and Metaclaude
switches with it: the memories it distils, the lessons it proposes, the note a
merge would keep. A workspace can override it under its own settings, for a
project you work on in another language.

Two settings underneath, and they have to be. The interface's language is
yours, kept in your browser; what the system *writes* is a corpus with one
language whoever reads it. The picker sets both, so you only ever touch one.

Commands, paths, identifiers and error text are never translated — a procedure
whose whole value is `pnpm test:run` is worth nothing in translation.

### Consolidation

Left alone, a corpus starts repeating itself. The reflexion pass rediscovers
"this workspace works in French" in four different wordings, and since only
eight memories are recalled into a run, four of those eight go on saying one
thing.

**Maintenance → Consolidate** looks for that. It shortlists memories that sit
close together, asks one cheap model call whether they genuinely say the same
thing, and files what it finds *below*, for you to decide on. It never merges
anything by itself.

Two kinds of finding arrive:

- **Repetition** — several memories stating one fact. The card shows every one
  of them, names the one that would survive, and shows the text that would
  replace them. **Merge** folds them together; the survivor keeps the combined
  history — its use count, its reinforcement, and its place in the genesis of
  every past run that was given any of them. Where the fact does not name
  anything project-specific, **Merge and make global** is offered beside it.
- **Contradiction** — two memories that cannot both be true. There is no button
  to press here on purpose: which one is right is a judgement only you can
  make, by editing or deleting. This is the finding worth the pass — until now
  both were quietly handed to every run that matched either.

The same pass runs by itself after any run that learned something, looking only
at the neighbourhood of what was just written. Most runs cost nothing at all:
if the new memories have no close neighbour, no model call is made.

If a proposal has gone stale — a memory it names was edited or deleted since —
applying it is refused rather than merged over. Dismiss it and run the pass
again.

## The knowledge library

Memory is what the system *learned*; the knowledge library is what you *gave
it to read* — and the difference is a promise. A memory gains and loses
confidence, decays, and can be forgotten. A document never fades: the lease
says tomorrow exactly what it says today.

Add documents at the bottom of the **Memory** page: paste the text, give it a
title, and choose its shelf — **Global** reaches every workspace, a workspace
keeps its documents to itself (plus the global shelf). Runs in a sibling
workspace can never see them. On save the document is split into passages —
markdown headings become the sections passages are cited under — and each
passage is indexed twice, by meaning and by exact words, so *« quel est le
préavis ? »* finds the clause whether or not it uses the word.

During a run, the most relevant passages are retrieved automatically and
handed to the agent as quotations with their source — document title and
section — which it is told to cite rather than to paraphrase from guesswork.
The run's genesis strip shows exactly which passages were consulted, under
**Passages consulted**.

Two controls worth knowing. The switch on each document **pauses** it —
kept and editable, never retrieved — which beats deleting a document you
might need next month. And **Rehearse a retrieval** asks the library what a
run would be shown for a query of yours: same search, same relevance gates,
scores included. If the rehearsal returns nothing, a run would get nothing —
the library refuses to pad the context with irrelevant passages, because
eight wrong quotations are worse than none.

The library can be switched off per workspace (Workspace settings →
Learning), separately from memory: what the system learned and what it was
handed to read are different trusts.

### What it finds, and what it does not

This is worth knowing before you rely on it, because the shape is sharp
rather than gradual. Retrieval was measured against a corpus of a hundred
passages with a labelled answer for each question:

- **Ask in the document's own words and it is exact.** Every labelled
  question — including paraphrases like *« combien de temps pour récupérer le
  dépôt de garantie ? »* against a passage that says *restitué dans un délai
  de deux mois* — comes back at rank 1. It stays at rank 1 as the shelf grows
  past three hundred passages, and when several documents differ only by
  their title (three leases, three different notice periods) the right one
  still wins, because each passage is indexed with its document title.
- **Ask in words the document never uses and it finds nothing.** *« puis-je
  partir avant la fin ? »* does not reach a passage about *préavis*; *« on
  m'a cambriolé »* does not reach one about *vol*; an English question does
  not reach a French answer. Measured at zero.

The cause is the embedding provider. By default Metaclaude uses a built-in
hashing embedder — no model download, no network, works everywhere — whose
"similarity" is really character-overlap. It is a very good fuzzy word
matcher and not a semantic one. **Settings → System → Doctor** now names
which embedder is actually running and says which of the two regimes you are
in.

To cross that wall, enable a real sentence-transformer: install
`@huggingface/transformers` in the image, set `METACLAUDE_EMBEDDINGS=local`,
restart, then press **Re-index** on the knowledge library (and Re-index under
Memory maintenance) so existing passages are re-embedded in the new space.
Until that re-index runs, the exact-word arm keeps answering and the
semantic one stays silent — which is why the doctor warns rather than
failing.

Until then, the practical habit is simple: **phrase the question with a word
the document actually contains.** The **Rehearse a retrieval** box is there
to check in two seconds.

## The policy learner

Under **Auto**, the model and effort for each run are chosen by a learner that
treats every (model, effort) pair as a slot-machine arm and plays the odds —
Thompson sampling, if you want the term. Reward blends the run's success, its
cost and its latency; **your thumbs up or down overrides all of it**, because
your judgement is the ground truth being learned.

Analytics shows the posterior for every arm in plain language — *"across 34
runs, sonnet at high effort performs best"* — and a **Reset** button, because
unlearning must be as easy as learning.

An explicit choice always wins: pick a model in the composer and the learner
stands aside for that message.

## Reflexion

After a run, a cheap, tool-less pass reads the transcript and extracts durable
lessons into memory — the mechanism by which "the tests need the shared
package built first" stops being rediscovered weekly. It writes into the
workspace the run happened in, and each memory it writes says which session it
came from, so you can open the conversation that taught it. Reflexion can be
toggled per workspace.

## Distilling a skill

Reflexion learns one run at a time; **Distil a skill** (on the Memory page,
with a workspace selected) reads *across* runs: the workspace's accumulated
procedures are handed to one cheap model call that either drafts a coherent,
reusable skill from them or answers that they do not cohere — refusal being
the common, correct case. A draft lands in the same review queue as every
other proposal: nothing changes the agent's behaviour until you accept it.

## Reading the posteriors

The Analytics screen draws each arm's Beta posterior as a curve, not a bar,
because the mean is the least interesting thing a posterior knows. A narrow
spike is an arm the learner has settled on; a broad hump is one it is still
unsure about — and that width is exactly why a trailing arm keeps getting
occasional trials. Watch a curve sharpen over a week of runs and you are
watching the system learn.

## The sky

Above the list, the Memory page draws its constellation. Every visual
dimension carries a real datum: each kind owns a sector of the sky, a
star's size is its confidence, its distance from the centre is how long
since a run last recalled it — so watching a star drift toward the rim *is*
watching the forgetting curve — and a star recalled in the last day
breathes gently. Pinned memories wear a ring: exempt from decay, and
visibly so. Tap a star to land on its card below. Positions are
deterministic, so the sky holds still between visits and only genuine
reinforcement or decay moves a star.
