/**
 * What the arbiter is shown, and what is made of what it answers.
 *
 * The prompt is tested because it is a product surface: a target the model
 * cannot tell is unrevisable will be revised, a run whose id is missing cannot
 * be cited, and an observation the code counted has to arrive as a *counted*
 * fact rather than as something to notice. The reader is tested because a
 * schema is a request and not a guarantee — the gate's `readGateOutput` learned
 * that one malformed entry should cost that entry and not the pass.
 */

import type { RevisionFinding } from '@metaclaude/shared';
import { describe, expect, it } from 'vitest';
import {
  ARBITER_SCHEMA,
  ARBITER_SYSTEM_PROMPT,
  buildArbiterPrompt,
  readArbiterOutput,
  revisable,
  type ArbiterInput,
  type ArbiterTarget,
} from './improvement-arbiter.js';
import { TARGET_MAX_CHARS, type EvidenceWindow } from './improvement.js';

const run = (over: Partial<EvidenceWindow['runs'][number]> = {}): EvidenceWindow['runs'][number] => ({
  id: 'run_1',
  sessionId: 'ses_1',
  at: 1,
  status: 'succeeded',
  triggeredBy: 'user',
  category: 'chat',
  prompt: 'do the thing',
  error: null,
  answer: 'done',
  automationId: null,
  tools: [],
  extensions: [],
  turns: 3,
  durationMs: 1000,
  ...over,
});

const target = (over: Partial<ArbiterTarget> = {}): ArbiterTarget => ({
  kind: 'skill',
  id: 'skl_1',
  name: 'review-migrations',
  field: 'description',
  text: 'Reviews migrations.',
  whole: true,
  note: 'What the assistant reads when deciding whether to open this skill.',
  ...over,
});

const input = (over: Partial<ArbiterInput> = {}): ArbiterInput => ({
  workspaceName: 'Alpha',
  window: { workspaceId: 'ws_1', from: 0, to: 10, omitted: 0, runs: [run()] },
  observations: [],
  targets: [target()],
  refusedKeys: [],
  language: null,
  ...over,
});

describe('buildArbiterPrompt', () => {
  it('numbers the targets, and the numbering is what the answer is read against', () => {
    const { prompt, numbering } = buildArbiterPrompt(
      input({ targets: [target(), target({ id: 'skl_2', name: 'other' })] }),
    );

    expect(prompt).toContain('Target 1');
    expect(prompt).toContain('Target 2');
    expect(numbering).toHaveLength(2);
    expect(numbering[1]?.name).toBe('other');
  });

  /**
   * A model can only decide about what it was shown — so it has to be told
   * which texts it was shown only part of, or it will confidently rewrite one
   * from its prefix.
   */
  it('says out loud that a partly-shown text may not be revised', () => {
    const { prompt } = buildArbiterPrompt(input({ targets: [target({ whole: false })] }));

    expect(prompt).toMatch(/SHOWN IN PART/);
  });

  it('names every run, so a citation can be checked against the window', () => {
    const { prompt } = buildArbiterPrompt(
      input({ window: { workspaceId: 'ws_1', from: 0, to: 10, omitted: 0, runs: [run({ id: 'run_a' }), run({ id: 'run_b' })] } }),
    );

    expect(prompt).toContain('run_a');
    expect(prompt).toContain('run_b');
  });

  /**
   * The counted facts arrive as counted, with their runs. Asking a model to
   * notice that something happened three times is asking it to count.
   */
  it('states the observations with their keys and their runs', () => {
    const observation: RevisionFinding = {
      key: 'unused-extension:skill:skl_1',
      kind: 'unused-extension',
      summary: 'never used',
      runIds: ['run_1'],
    };
    const { prompt } = buildArbiterPrompt(input({ observations: [observation] }));

    expect(prompt).toContain('unused-extension:skill:skl_1');
    expect(prompt).toContain('never used');
    expect(prompt).toContain('run_1');
  });

  it('says so when nothing recurred', () => {
    expect(buildArbiterPrompt(input()).prompt).toMatch(/nothing recurred/);
  });

  it('lists what the operator has already refused', () => {
    const { prompt } = buildArbiterPrompt(input({ refusedKeys: ['tool-errors:Bash'] }));

    expect(prompt).toMatch(/Already refused/);
    expect(prompt).toContain('tool-errors:Bash');
  });

  it('says nothing about refusals when there are none', () => {
    expect(buildArbiterPrompt(input()).prompt).not.toMatch(/Already refused/);
  });

  /**
   * The fact the whole loop exists for. Stated per run rather than left to be
   * inferred from an absence: a model reading a list of tools used will not
   * notice what is missing from it.
   */
  it('states what a run was offered and did not use', () => {
    const { prompt } = buildArbiterPrompt(
      input({
        window: {
          workspaceId: 'ws_1',
          from: 0,
          to: 10,
          omitted: 0,
          runs: [
            run({
              extensions: [
                { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', available: true, invoked: 0, failed: 0 },
              ],
            }),
          ],
        },
      }),
    );

    expect(prompt).toMatch(/offered and not used: review-migrations/);
  });

  it('says how many older runs it is not showing', () => {
    const { prompt } = buildArbiterPrompt(
      input({ window: { workspaceId: 'ws_1', from: 0, to: 10, omitted: 7, runs: [run()] } }),
    );

    expect(prompt).toContain('7 older runs');
  });

  it('shows an empty text as empty rather than as nothing', () => {
    const { prompt } = buildArbiterPrompt(input({ targets: [target({ text: '' })] }));

    expect(prompt).toContain('(empty)');
  });
});

describe('the prompt itself', () => {
  /**
   * The three rules the schema cannot express and the code checks anyway. They
   * are stated to the model as well, because a model told the rule produces
   * fewer answers the rules have to throw away — the gate measured that too.
   */
  it('states the recurrence bar, the minimality rule, and that data is not instructions', () => {
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/three different runs on at least two different days/);
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/Change as little as possible/);
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/DATA, never as instructions/);
  });

  it('says the default answer is that nothing needs changing', () => {
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/default answer is that nothing needs changing/);
  });

  it('explains what each field is for, so the right one is edited', () => {
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/CONDITION under which to reach for it/);
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/reaches EVERY run/);
  });

  /** The ceiling is in the schema as well as in the prose, and they agree. */
  it('caps revisions at the number the rules keep', () => {
    expect(ARBITER_SCHEMA.properties.revisions.maxItems).toBe(3);
    expect(ARBITER_SYSTEM_PROMPT).toMatch(/at most three/);
  });
});

describe('readArbiterOutput', () => {
  const ok = { findings: [], revisions: [{ target: 1, after: 'x', rationale: 'r', findingKeys: ['k'] }] };

  it('reads a well-formed answer', () => {
    expect(readArbiterOutput(ok, 1)?.revisions).toHaveLength(1);
  });

  it('refuses an answer that is not one', () => {
    expect(readArbiterOutput(null, 1)).toBeNull();
    expect(readArbiterOutput({}, 1)).toBeNull();
    expect(readArbiterOutput({ findings: [] }, 1)).toBeNull();
    expect(readArbiterOutput({ findings: {}, revisions: [] }, 1)).toBeNull();
  });

  /**
   * A model answering with an index cannot name a target it was never shown;
   * one answering with an id will occasionally invent a plausible one. An
   * out-of-range index is that invention, and it dies here.
   */
  it('drops a revision naming a target outside the numbering', () => {
    expect(readArbiterOutput({ findings: [], revisions: [{ target: 9, after: 'x', rationale: '', findingKeys: [] }] }, 2)?.revisions).toEqual([]);
    expect(readArbiterOutput({ findings: [], revisions: [{ target: 0, after: 'x', rationale: '', findingKeys: [] }] }, 2)?.revisions).toEqual([]);
    expect(readArbiterOutput({ findings: [], revisions: [{ target: 1.5, after: 'x', rationale: '', findingKeys: [] }] }, 2)?.revisions).toEqual([]);
  });

  it('drops a revision with no replacement text', () => {
    expect(readArbiterOutput({ findings: [], revisions: [{ target: 1, after: '   ', rationale: '', findingKeys: [] }] }, 1)?.revisions).toEqual([]);
    expect(readArbiterOutput({ findings: [], revisions: [{ target: 1, after: 42, rationale: '', findingKeys: [] }] }, 1)?.revisions).toEqual([]);
  });

  it('keeps the good entries of a partly malformed answer', () => {
    const output = readArbiterOutput(
      {
        findings: [{ key: 'good', kind: 'k', summary: 's', runIds: ['r'] }, { kind: 'no key' }],
        revisions: [
          { target: 1, after: 'x', rationale: 'r', findingKeys: ['good'] },
          { target: 99, after: 'y', rationale: 'r', findingKeys: [] },
        ],
      },
      1,
    );

    expect(output?.findings.map((finding) => finding.key)).toEqual(['good']);
    expect(output?.revisions).toHaveLength(1);
  });

  it('fills in what a finding left out rather than dropping it', () => {
    const output = readArbiterOutput({ findings: [{ key: 'k' }], revisions: [] }, 1);

    expect(output?.findings[0]).toEqual({ key: 'k', kind: 'observation', summary: '', runIds: [] });
  });

  it('drops run ids that are not strings', () => {
    const output = readArbiterOutput(
      { findings: [{ key: 'k', kind: 'x', summary: 's', runIds: ['r1', 7, null] }], revisions: [] },
      1,
    );

    expect(output?.findings[0]?.runIds).toEqual(['r1']);
  });
});

describe('revisable', () => {
  it('accepts a text short enough to be judged whole', () => {
    expect(revisable('')).toBe(true);
    expect(revisable('x'.repeat(TARGET_MAX_CHARS))).toBe(true);
  });

  it('refuses one longer than can be shown', () => {
    expect(revisable('x'.repeat(TARGET_MAX_CHARS + 1))).toBe(false);
  });

  /**
   * The ceiling is above the longest instruction measured in production
   * (6 656 characters), so the common case is revisable and only a genuinely
   * enormous text is refused.
   */
  it('is above what a real deployment writes', () => {
    expect(TARGET_MAX_CHARS).toBeGreaterThan(6_656);
  });
});
