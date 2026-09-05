/**
 * Shelves and retirement, through the routes.
 *
 * `learning/memory.test.ts` proves the store's rules. What only the route can
 * prove is that the interface's verbs reach them: a shelf chosen on creation
 * is stored, a PATCH with `retired` retires and restores with an audit line
 * each, a pinned memory answers 400 rather than 500, and a retired memory is
 * gone from the search the composer uses while still on the list.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Memory } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;

beforeAll(async () => {
  server = await bootTestServer({ name: 'memory-shelf' });
});

afterAll(async () => {
  await server?.close();
});

const create = async (body: Record<string, unknown>): Promise<Memory> => {
  const response = await server.send('POST', '/api/memory', {
    workspaceId: null,
    kind: 'semantic',
    title: 'Vault rotation',
    content: 'The vault key is rotated quarterly by hand.',
    ...body,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { memory: Memory }).memory;
};

describe('shelves and retirement over HTTP', () => {
  it('stores the shelf on creation and changes it on PATCH', async () => {
    const memory = await create({ title: 'Port', content: 'The API listens on 8787.', shelf: 'volatile' });
    expect(memory.shelf).toBe('volatile');

    const patched = await server.send('PATCH', `/api/memory/${memory.id}`, { shelf: 'standing' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { memory: Memory }).memory.shelf).toBe('standing');

    const bad = await server.send('PATCH', `/api/memory/${memory.id}`, { shelf: 'eternal' });
    expect(bad.status).toBe(400);
  });

  it('retires and restores through PATCH, audited, and search stops seeing a retired memory', async () => {
    const memory = await create({});
    await create({ title: 'Filler one', content: 'Deploys run from the pipeline.' });
    await create({ title: 'Filler two', content: 'Backups land nightly on the volume.' });

    const found = await server.get<{ results: Array<{ memory: Memory }> }>('/api/memory/search?q=vault%20rotated');
    expect(found.results.map((r) => r.memory.id)).toContain(memory.id);

    const retired = await server.send('PATCH', `/api/memory/${memory.id}`, { retired: true });
    expect(retired.status).toBe(200);
    expect(((await retired.json()) as { memory: Memory }).memory.retiredAt).not.toBeNull();

    const gone = await server.get<{ results: Array<{ memory: Memory }> }>('/api/memory/search?q=vault%20rotated');
    expect(gone.results.map((r) => r.memory.id)).not.toContain(memory.id);
    // Gone from the plain list every reader uses, kept where the page asks for it.
    const plain = await server.get<{ memories: Memory[]; total: number }>('/api/memory');
    expect(plain.memories.some((m) => m.id === memory.id)).toBe(false);
    const listed = await server.get<{ memories: Memory[] }>('/api/memory?includeRetired=1');
    expect(listed.memories.find((m) => m.id === memory.id)?.retiredAt).not.toBeNull();

    const restored = await server.send('PATCH', `/api/memory/${memory.id}`, { retired: false });
    expect(((await restored.json()) as { memory: Memory }).memory.retiredAt).toBeNull();

    const actions = server.context.audit.list({ limit: 20 }).map((entry) => entry.action);
    expect(actions).toContain('memory.retire');
    expect(actions).toContain('memory.restore');
  });

  it('refuses to retire a pinned memory with a 400 that says why', async () => {
    const memory = await create({ title: 'Pinned', content: 'Never lose this.', pinned: true });

    const response = await server.send('PATCH', `/api/memory/${memory.id}`, { retired: true });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/pinned/);
    expect(server.context.memory.get(memory.id)?.retiredAt).toBeNull();
  });
});
