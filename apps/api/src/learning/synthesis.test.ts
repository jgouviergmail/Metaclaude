/**
 * Skill synthesis — distilling a workspace's accumulated procedures into a
 * proposed skill.
 *
 * The model call is injected; what is under test is the judgement around it:
 * when synthesis is even worth attempting, what the model is shown, and that
 * the output lands as a *proposal* in the existing review queue — never as an
 * installed skill.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HashingEmbedder } from './embeddings.js';
import { MemoryStore } from './memory.js';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { SkillSynthesizer, SynthesisError, type SynthesisOutput } from './synthesis.js';

let db: Db;
let memory: MemoryStore;

const OUTPUT: SynthesisOutput = {
  worthIt: true,
  name: 'release-checklist',
  description: 'How releases are cut here',
  body: '# Release checklist\n1. ...',
};

function makeSynthesizer(
  call: (prompt: string) => Promise<SynthesisOutput | null> = async () => OUTPUT,
) {
  const spy = vi.fn(call);
  return {
    synthesizer: new SkillSynthesizer({
      db,
      memory,
      call: spy,
      log: () => {},
      now: () => 5_000,
    }),
    call: spy,
  };
}

async function seedProcedure(workspaceId: string, title: string, confidence: number) {
  await memory.remember({
    workspaceId,
    kind: 'procedural',
    title,
    content: `steps for ${title}`,
    tags: [],
    confidence,
  });
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
     VALUES ('ws_1', 'Alpha', 'alpha', '', '/srv/metaclaude/workspaces/alpha', '#000000', 'folder', '{}', 0, 0)`,
  ).run();
  memory = new MemoryStore(db, new HashingEmbedder());
});

afterEach(() => db.close());

describe('when synthesis is worth attempting', () => {
  it('refuses with too few procedures — there is nothing to distil', async () => {
    await seedProcedure('ws_1', 'one lonely procedure', 0.8);

    const { synthesizer, call } = makeSynthesizer();
    await expect(synthesizer.synthesise('ws_1')).rejects.toThrow(SynthesisError);
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the model the highest-confidence procedures, bounded', async () => {
    for (let i = 0; i < 5; i += 1) await seedProcedure('ws_1', `procedure ${i}`, 0.5 + i / 10);

    const { synthesizer, call } = makeSynthesizer();
    await synthesizer.synthesise('ws_1');

    const prompt = call.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('procedure 4');
    expect(prompt.length).toBeLessThan(20_000);
  });
});

describe('what the synthesis produces', () => {
  it('stores a skill_proposal insight — never an installed skill', async () => {
    for (let i = 0; i < 3; i += 1) await seedProcedure('ws_1', `procedure ${i}`, 0.8);

    const { synthesizer } = makeSynthesizer();
    const insight = await synthesizer.synthesise('ws_1');

    expect(insight?.kind).toBe('skill_proposal');
    expect(JSON.parse(insight?.payload ?? '{}')).toMatchObject({ name: 'release-checklist' });
    // The registry stays untouched: installing is the operator's click, via
    // the same review path as per-run proposals.
    expect(db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 0 });
  });

  it('returns null — and stores nothing — when the model says it does not cohere', async () => {
    for (let i = 0; i < 3; i += 1) await seedProcedure('ws_1', `procedure ${i}`, 0.8);

    const { synthesizer } = makeSynthesizer(async () => ({ worthIt: false }));
    const insight = await synthesizer.synthesise('ws_1');

    expect(insight).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
  });

  it('propagates a model failure as an error the route can surface', async () => {
    for (let i = 0; i < 3; i += 1) await seedProcedure('ws_1', `procedure ${i}`, 0.8);

    const { synthesizer } = makeSynthesizer(async () => null);
    await expect(synthesizer.synthesise('ws_1')).rejects.toThrow(SynthesisError);
  });
});
