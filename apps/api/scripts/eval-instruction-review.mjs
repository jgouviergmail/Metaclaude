#!/usr/bin/env node
/**
 * The instruction-review arbiter, measured.
 *
 * Replays labelled windows through the real prompt and the real model, and
 * reports the two numbers that matter: how many windows where the honest
 * answer is *nothing* got a proposal anyway, and how many of the windows that
 * genuinely need one got it — on the right target.
 *
 * Not a test. It spawns the Claude CLI and costs a few cents. Run it before
 * changing `ARBITER_SYSTEM_PROMPT` and after, and refuse the change if the
 * worst pass over-reacts more than the floor allows. Build first:
 *
 *   pnpm --filter @metaclaude/api build
 *   node scripts/eval-instruction-review.mjs [passes=3] [model=haiku]
 *
 * The corpus is synthetic and deliberately so — the real thing is one
 * operator's prompts and answers, and this repository is public. What it is
 * *not* synthetic about is the shape of each case: a quiet week, a description
 * written as a summary, a broken tool no instruction can fix, one bad
 * afternoon, a subagent told to use a tool it does not have, and an
 * instruction that is already right. Those six are the families the rules
 * downstream cannot catch — the rules can drop a rewrite for being ungrounded
 * or too large, and nothing in code can tell a good rewrite from a pointless
 * one.
 *
 * Exit status is non-zero when a pass over-reacts past the floor or misses a
 * case it should have caught, so a CI job with a credential could run it.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARBITER_SYSTEM_PROMPT,
  buildArbiterPrompt,
  createArbiterCall,
} from '../dist/learning/improvement-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'instruction-review-corpus.json'), 'utf8'));
const passes = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? 'haiku';
const verbose = process.argv.includes('--verbose');

/**
 * Acceptance: at most this many windows that should have been left alone got a
 * proposal, on any pass.
 *
 * One, and it is the measured band rather than a wish. Two prompts, five
 * passes each, on 2026-09-10 with haiku:
 *
 *   without the "never used is not a reason" rules   2, 1, 0, 1, 1  (5 in all)
 *                                                     and one pass missed a window
 *   with them                                        1, 0, 0, 0, 0  (1 in all)
 *
 * The recurring over-reaction — rewriting a description that already stated
 * its trigger condition, on four passes of five — disappears entirely; the one
 * that survives is a different window each time.
 *
 * Worth saying how that was nearly got wrong: at *three* passes the two
 * prompts were indistinguishable (0–1 either way), and sabotaging the rules
 * did not move the number at all. Three passes was simply too few to see past
 * the model's own variance, and the honest conclusion at that point was "this
 * bench cannot tell", not "the rules do nothing". Five passes could. A measure
 * that reads the same under sabotage is a measure to strengthen before it is a
 * result to believe.
 */
const MAX_OVER_REACTIONS = 1;

/** Turn one labelled case into the shape the arbiter is called with. */
function toInput(entry) {
  return {
    workspaceName: entry.workspaceName,
    window: {
      workspaceId: 'ws_bench',
      from: 0,
      to: 1,
      omitted: 0,
      runs: entry.runs.map((run, index) => ({
        id: run.id,
        sessionId: 'ses_bench',
        // One run a day, so every case clears the "more than one day" bar on
        // its own terms and the model is judged on the recurrence rather than
        // on a clock it cannot see.
        at: index * 86_400_000,
        status: run.status,
        triggeredBy: 'user',
        // The bench's windows carry no category; a real one does, and the
        // renderer omits it when absent — so what is measured here is a strict
        // subset of what production sends.
        category: null,
        prompt: run.prompt,
        error: run.error ?? null,
        answer: run.answer ?? null,
        automationId: null,
        tools: (run.tools ?? []).map((text) => {
          const match = /^(.+?)×(\d+)(?: \((\d+) failed\))?$/.exec(text);
          return {
            name: match?.[1] ?? text,
            calls: Number(match?.[2] ?? 1),
            errors: Number(match?.[3] ?? 0),
          };
        }),
        extensions: [
          ...(run.used ?? []).map((name) => ({
            kind: 'agent',
            extensionId: name,
            name,
            available: true,
            invoked: 1,
            failed: 0,
          })),
          ...(run.idle ?? []).map((name) => ({
            kind: 'skill',
            extensionId: name,
            name,
            available: true,
            invoked: 0,
            failed: 0,
          })),
        ],
        turns: 3,
        durationMs: 20_000,
      })),
    },
    observations: entry.observations ?? [],
    targets: entry.targets.map((target) => ({
      kind: target.kind,
      id: `${target.kind}_${target.name}`,
      name: target.name,
      field: target.field,
      text: target.text,
      whole: true,
      note: '',
    })),
    refusedKeys: [],
    language: null,
  };
}

// The second argument is the phase policy the deployment reads from its
// settings; here it is fixed to whatever the command line asked for.
const call = createArbiterCall({ env: { ...process.env }, claudeBinPath: null, cwd: tmpdir() }, () => ({
  model,
  effort: null,
}));

const shouldRevise = corpus.cases.filter((entry) => entry.expect === 'revise').length;
console.log(
  `${corpus.cases.length} windows — ${shouldRevise} that need a revision, ` +
    `${corpus.cases.length - shouldRevise} that need none. Model ${model}, ${passes} pass(es).`,
);
console.log(`Prompt is ${ARBITER_SYSTEM_PROMPT.length} characters.\n`);

let failed = false;
for (let pass = 0; pass < passes; pass += 1) {
  let overReactions = 0;
  let caught = 0;
  const notes = [];

  for (const entry of corpus.cases) {
    const input = toInput(entry);
    const { numbering } = buildArbiterPrompt(input);
    let answer;
    try {
      answer = await call(input);
    } catch (error) {
      notes.push(`  ! ${entry.name}: the call failed — ${String(error?.message ?? error).slice(0, 120)}`);
      failed = true;
      continue;
    }

    const proposed = answer.revisions.map((revision) => {
      const target = numbering[revision.target - 1];
      return target ? `${target.kind}:${target.name}:${target.field}` : `#${revision.target}`;
    });

    if (entry.expect === 'none') {
      if (proposed.length > 0) {
        overReactions += 1;
        notes.push(`  over-reacted on “${entry.name}”: ${proposed.join(', ')}`);
      }
      continue;
    }

    const wanted = `${entry.targets.find((t) => t.name === entry.target)?.kind}:${entry.target}:${entry.field}`;
    if (proposed.includes(wanted)) {
      caught += 1;
    } else {
      notes.push(
        `  missed “${entry.name}”: wanted ${wanted}, got ${proposed.length === 0 ? 'nothing' : proposed.join(', ')}`,
      );
    }
    if (verbose && answer.findings.length > 0) {
      for (const finding of answer.findings) notes.push(`    · ${finding.key}: ${finding.summary}`);
    }
  }

  const bad = overReactions > MAX_OVER_REACTIONS || caught < shouldRevise;
  if (bad) failed = true;
  console.log(
    `pass ${pass + 1}: ${caught}/${shouldRevise} caught, ${overReactions} over-reaction(s) ` +
      `(floor ${MAX_OVER_REACTIONS})${bad ? '  ← FAIL' : ''}`,
  );
  for (const note of notes) console.log(note);
}

console.log(
  failed
    ? '\nRefused: a pass either over-reacted past the floor or missed a window it should have caught.'
    : '\nOK on every pass.',
);
process.exit(failed ? 1 : 0);
