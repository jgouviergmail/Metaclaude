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
