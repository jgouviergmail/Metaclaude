/**
 * The embeddings setting, through the routes, and what the health endpoint
 * and the doctor say about it.
 *
 * What is under test is the *switch*: an owner moves the setting from the
 * hashing embedder to the shipped model and back, and every reader — the
 * health endpoint, the doctor, the settings listing — must describe the same
 * state at the same moment. No model exists in a test environment and the
 * runtime never downloads one, so `local` here means the honest failure: the
 * provider keeps the model's id, is lexical-only, and says why.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeSettingRecord, SystemHealth } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;

const health = () => server.get<SystemHealth>('/api/system');
const setting = async (key: string) =>
  (await server.get<{ settings: RuntimeSettingRecord[] }>('/api/system/settings')).settings.find((entry) => entry.key === key);
const doctorRetrieval = async () => {
  const report = await server.get<{ checks: Array<{ name: string; status: string; summary: string; detail: string | null }> }>('/api/system/doctor');
  return report.checks.find((check) => check.name === 'retrieval')!;
};

beforeAll(async () => {
  server = await bootTestServer({ name: 'retrieval-settings' });
});

afterAll(async () => {
  await server?.close();
});

describe('as shipped in tests', () => {
  it('runs on the hashing embedder, ready, and says retrieval is lexical', async () => {
    const { retrieval } = await health();

    expect(retrieval).toEqual({
      embedder: 'hash-v1:512',
      family: 'hash',
      state: 'ready',
      semantic: false,
      pending: { memories: 0, documents: 0, exemplars: 0 },
    });
    expect(await setting('embeddings')).toMatchObject({ key: 'embeddings', value: 'hash', kind: 'choice', options: ['hash', 'local'] });
  });
});

describe('switching to the model', () => {
  it('flips every store at once, stays lexical-only when the model is absent, and the doctor warns', async () => {
    const response = await server.send('PUT', '/api/system/settings/embeddings', { value: 'local' });
    expect(response.status).toBe(200);

    // The verdict on a missing model arrives on the next tick; wait for it.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await health()).retrieval.state !== 'loading') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const { retrieval, embeddingProvider } = await health();
    expect(embeddingProvider).toMatch(/^st:/);
    expect(retrieval).toMatchObject({ family: 'st', state: 'lexical-only', semantic: false });
    expect(retrieval.embedder).toBe(embeddingProvider);

    const check = await doctorRetrieval();
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/lexical-only/);
    expect(await setting('embeddings')).toMatchObject({ value: 'local', source: 'stored' });
  });

  it('writes memories pending meanwhile, and counts them where the operator can see', async () => {
    const created = await server.send('POST', '/api/memory', {
      workspaceId: null, kind: 'semantic', title: 'Written while lexical-only', content: 'No vector yet.',
    });
    expect(created.status).toBe(201);

    const { retrieval } = await health();
    expect(retrieval.pending.memories).toBeGreaterThanOrEqual(1);

    const check = await doctorRetrieval();
    expect(check.detail).toMatch(/await a rebuild/);
  });

  it('switches back to hashing at once, and the rebuild clears what was pending', async () => {
    const response = await server.send('PUT', '/api/system/settings/embeddings', { value: 'hash' });
    expect(response.status).toBe(200);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { retrieval } = await health();
      if (retrieval.family === 'hash' && retrieval.pending.memories === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const { retrieval } = await health();
    expect(retrieval).toMatchObject({ family: 'hash', state: 'ready', semantic: false, pending: { memories: 0 } });
    expect((await doctorRetrieval()).status).toBe('ok');
  });
});

describe('across a restart', () => {
  /**
   * The setting is read at boot through `choice()`, not replayed through
   * `apply()` — the stores do not exist yet when stored overrides are
   * replayed. A boot over the same data directory is the only way to see it.
   */
  it('boots on the stored choice, not on the environment', async () => {
    expect((await server.send('PUT', '/api/system/settings/embeddings', { value: 'local' })).status).toBe(200);
    const { dataDir, username } = server;
    await server.close({ keep: true });

    server = await bootTestServer({ name: 'retrieval-settings', reuse: { dataDir, username } });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await health()).retrieval.state !== 'loading') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const { retrieval } = await health();
    expect(retrieval.family).toBe('st');
    expect(await setting('embeddings')).toMatchObject({ value: 'local', source: 'stored' });

    expect((await server.send('PUT', '/api/system/settings/embeddings', { value: 'hash' })).status).toBe(200);
  });
});

describe('the maintenance button', () => {
  it('re-indexes every store the model serves and reports each count', async () => {
    const response = await server.send('POST', '/api/memory/maintenance', { action: 'reindex' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { affected: number; reindex: Record<string, number> };
    expect(body.reindex).toEqual({ memories: 0, documents: 0, exemplars: 0 });
    expect(body.affected).toBe(0);
  });
});
