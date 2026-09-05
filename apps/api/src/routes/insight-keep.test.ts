/**
 * Keeping a note the gate refused, through the route.
 *
 * The gate is a model and it is wrong sometimes. What makes that safe is
 * that every verdict rides the run's insight and the operator can overturn
 * one here — so the route has to write the memory the way the gate would
 * have, record the id so the button cannot be pressed twice, and refuse an
 * insight that carries no decisions at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Insight, Memory, ReflexionInsightPayload } from '@metaclaude/shared';
import { defaultWorkspaceSettings } from '../kernel/repositories.js';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let workspaceId: string;
let runId: string;

beforeAll(async () => {
  server = await bootTestServer({ name: 'insight-keep' });
  const workspace = server.context.workspaceRepo.create({
    name: 'Keep', slug: 'keep', description: '', path: '/tmp/metaclaude-keep', color: '#000000', icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });
  workspaceId = workspace.id;
  const session = server.context.sessionRepo.create({
    workspaceId,
    model: 'default',
    effort: null,
    permissionMode: 'default',
  });
  runId = server.context.runRepo.create({
    sessionId: session.id,
    workspaceId,
    prompt: 'a prompt long enough to reflect on',
    triggeredBy: 'user',
    policy: {
      model: 'sonnet', effort: null, permissionMode: 'default', thinking: 'adaptive',
      thinkingBudgetTokens: null, agentName: null, ultracode: false, source: 'workspace',
    },
  }).id;
});

afterAll(async () => {
  await server?.close();
});

/** File an insight the way the reflexion pass does, and hand back its id. */
function file(payload: ReflexionInsightPayload | { kind: string }): Pick<Insight, 'id'> {
  server.context.reflexion.recordInsight({
    workspaceId,
    runId,
    kind: 'lesson',
    title: 'A run',
    body: 'body',
    confidence: 0.7,
    payload: JSON.stringify(payload),
  });
  const row = server.context.db
    .prepare<[], { id: string }>('SELECT id FROM insights ORDER BY rowid DESC LIMIT 1')
    .get();
  return { id: row!.id };
}

const decisions = (): ReflexionInsightPayload => ({
  kind: 'reflexion',
  decisions: [
    {
      title: 'Tests run with pnpm', content: 'This project runs its tests with pnpm test:run.', kind: 'procedural',
      tags: ['lesson'], level: 'redundant', outcome: 'skipped', reason: 'said in the docs', memoryId: null, shelf: null,
    },
    {
      title: 'API port', content: 'The API listens on 8787.', kind: 'semantic',
      tags: [], level: 'fact', outcome: 'over-budget', reason: 'a fact, out of budget', memoryId: null, shelf: null,
    },
  ],
});

describe('POST /api/insights/:id/keep', () => {
  it('writes the note as the gate would have, records the id, and refuses a second press', async () => {
    const insight = file(decisions());

    const first = await server.send('POST', `/api/insights/${insight.id}/keep`, { index: 1 });
    expect(first.status).toBe(201);
    const { memory } = (await first.json()) as { memory: Memory };
    expect(memory).toMatchObject({ title: 'API port', shelf: 'volatile', workspaceId, sourceRunId: runId });

    const stored = server.context.memory.get(memory.id);
    expect(stored?.shelf).toBe('volatile');

    const again = await server.send('POST', `/api/insights/${insight.id}/keep`, { index: 1 });
    expect(again.status).toBe(409);

    // A lesson-level note lands on the durable shelf.
    const second = await server.send('POST', `/api/insights/${insight.id}/keep`, { index: 0 });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { memory: Memory }).memory.shelf).toBe('durable');

    const actions = server.context.audit.list({ limit: 10 });
    expect(actions.filter((entry) => entry.action === 'memory.create' && /kept from insight/.test(entry.detail ?? ''))).toHaveLength(2);
  });

  it('answers 400 for a bad index or an insight without decisions, 404 for a missing one', async () => {
    const insight = file(decisions());
    expect((await server.send('POST', `/api/insights/${insight.id}/keep`, { index: 9 })).status).toBe(400);
    expect((await server.send('POST', `/api/insights/${insight.id}/keep`, {})).status).toBe(400);

    const other = file({ kind: 'something-else' });
    expect((await server.send('POST', `/api/insights/${other.id}/keep`, { index: 0 })).status).toBe(400);

    expect((await server.send('POST', `/api/insights/ins_missing/keep`, { index: 0 })).status).toBe(404);
  });
});
