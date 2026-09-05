#!/usr/bin/env node
/**
 * The memory gate, measured.
 *
 * Replays the labelled corpus in `memory-gate-corpus.json` — the notes the
 * reflexion pass wrote in production on one day, run by run, with a person's
 * verdict on each — through the real gate prompt and the real model, and
 * reports two numbers per pass: recall of the notes worth keeping, and how
 * many of the notes worth skipping were kept anyway. Several passes, because
 * the model is not deterministic and the prompt is judged on its worst pass.
 *
 * Not a test: it spawns the Claude CLI and costs a few cents. Run it before
 * changing GATE_SYSTEM_PROMPT and after, and refuse the change if the worst
 * pass falls under the floor below. Build first:
 *
 *   pnpm --filter @metaclaude/api build
 *   node scripts/eval-memory-gate.mjs [passes=3] [model=haiku]
 *
 * Exit status is non-zero when a pass misses a keep or keeps more skips than
 * the floor allows, so a CI job with a credential could run it.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateCall, GATE_MIN_COUNTERFACTUAL, GATE_PER_RUN, GATE_PER_FAILED_RUN, structuralLevel } from '../dist/learning/gatekeeper.js';
import { BOARD_TOOL_CATALOGUE } from '../dist/kernel/board-tools.js';
import { ADVISOR_TOOL_CATALOGUE } from '../dist/kernel/advisor-tools.js';
import { SYSTEM_SERVER_NAME, SYSTEM_TOOLS, systemToolNames } from '../dist/kernel/system-tools.js';
import { SYSTEM_WORKSPACE_SAFETY, SystemWorkspace } from '../dist/services/system-workspace.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'memory-gate-corpus.json'), 'utf8'));
const passes = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? 'haiku';

/**
 * Acceptance: every keep recalled, at most this many skips kept, on every
 * pass. Five is the band measured at 0.50.0 with the counterfactual and the
 * structural rules in place — four to five per pass, with haiku and sonnet
 * alike, always the same handful: an interpretation heuristic, a judgement
 * about a single cost, and three notes about the code that name no file. The
 * floor is what a prompt change may not worsen, not a claim that these five
 * are acceptable; a rule that catches them without losing a keep lowers it.
 */
const MAX_FALSE_KEEPS = 5;

const call = createGateCall({ env: { ...process.env }, claudeBinPath: null, cwd: tmpdir() });

// The instructions the gate is shown in production for the system workspace:
// the generated CLAUDE.md itself, not a summary of it. The constructor touches
// none of its dependencies, so the render can be driven with stubs.
const instructions = new SystemWorkspace({
  db: null, workspaces: null, workspacesRoot: '', docsDir: null, sourceRoot: null, version: 'bench',
  language: () => 'fr',
  preapproved: () => systemToolNames(),
  tools: () => SYSTEM_TOOLS.map((entry) => ({ name: `mcp__${SYSTEM_SERVER_NAME}__${entry.name}`, ring: entry.ring, description: entry.description })),
  log: () => {},
}).renderClaudeMd({ docsCopied: true, codeCopied: true });
const verbose = process.argv.includes('--verbose');
const describedTools = [
  ...[...SYSTEM_TOOLS, ...BOARD_TOOL_CATALOGUE, ...ADVISOR_TOOL_CATALOGUE].map((entry) => entry.name),
  ...SYSTEM_WORKSPACE_SAFETY.disallowedTools,
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
];

const notes = corpus.runs.flatMap((run) => run.notes.map((note) => ({ ...note, run: run.run })));
const keeps = notes.filter((note) => note.label === 'keep').length;
const skips = notes.filter((note) => note.label === 'skip').length;
console.log(`${notes.length} notes from ${corpus.runs.length} runs — ${keeps} to keep, ${skips} to skip, ${notes.length - keeps - skips} either. Model ${model}, ${passes} pass(es).\n`);

let failed = false;
for (let pass = 0; pass < passes; pass += 1) {
  let recalled = 0;
  let falseKeeps = 0;
  const flips = [];
  for (const run of corpus.runs) {
    const candidates = run.notes.map((note) => ({
      kind: note.kind,
      title: note.title,
      content: note.content,
      confidence: 0.8,
      tags: [],
    }));
    let verdicts;
    try {
      // The bench shows no neighbours: it measures the level rubric alone,
      // which is the half the prompt controls. Supersession is covered by
      // gatekeeper.test.ts against the store's rules.
      verdicts = await call({ candidates, neighbours: [], instructions, language: null });
    } catch (error) {
      console.error(`pass ${pass + 1} · ${run.run}: the gate could not be reached — ${error.message}`);
      failed = true;
      continue;
    }
    // The gate's own budget, applied the way the gate applies it: keeps in level order, at most N.
    const order = { preference: 0, lesson: 1, fact: 2 };
    const kept = verdicts
      // The gate's structural rules: a keep with no counterfactual is a skip,
      // and a note citing code or naming a described tool is overruled.
      .filter((v) => v.keep && v.level in order && (v.without ?? '').trim().length >= GATE_MIN_COUNTERFACTUAL)
      .filter((v) => !structuralLevel(candidates[v.candidate - 1], v.level, describedTools))
      .sort((a, b) => order[a.level] - order[b.level] || a.candidate - b.candidate)
      .slice(0, run.failed ? GATE_PER_FAILED_RUN : GATE_PER_RUN)
      .map((v) => v.candidate);
    run.notes.forEach((note, index) => {
      const wasKept = kept.includes(index + 1);
      const verdict = verdicts.find((v) => v.candidate === index + 1);
      if (verbose) console.log(`   ${note.label.padEnd(6)} ${wasKept ? 'KEPT' : '    '} ${(verdict?.level ?? '-').padEnd(10)} ${note.title.slice(0, 64)}`);
      if (note.label === 'keep' && wasKept) recalled += 1;
      if (note.label === 'keep' && !wasKept) flips.push(`MISSED  ${note.title.slice(0, 70)} (${verdict?.level ?? 'no verdict'})`);
      if (note.label === 'skip' && wasKept) {
        falseKeeps += 1;
        flips.push(`KEPT    ${note.title.slice(0, 70)} (${verdict?.level})`);
      }
    });
  }
  const ok = recalled === keeps && falseKeeps <= MAX_FALSE_KEEPS;
  if (!ok) failed = true;
  console.log(`pass ${pass + 1}: recall ${recalled}/${keeps} · false keeps ${falseKeeps}/${skips} ${ok ? 'OK' : 'BELOW THE FLOOR'}`);
  for (const line of flips) console.log(`   ${line}`);
}
console.log(`\nfloor: recall ${keeps}/${keeps}, false keeps ≤ ${MAX_FALSE_KEEPS} on every pass.`);
process.exit(failed ? 1 : 0);
