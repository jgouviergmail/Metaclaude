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
package built first" stops being rediscovered weekly. Reflexion can be toggled
per workspace.

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
