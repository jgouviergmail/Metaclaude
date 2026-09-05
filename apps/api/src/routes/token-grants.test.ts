/**
 * A token's reach, repaired rather than reissued.
 *
 * The grant is the field that goes wrong without anyone touching it: deleting
 * a workspace prunes it from every token that named it, and a token left
 * reaching nothing makes the gateway answer "this deployment is empty" to
 * whatever holds the secret. Until this route existed the only repair was to
 * revoke and mint again, which means reconfiguring every client — for a
 * mistake none of them made.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenRecord, Workspace } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let keep: Workspace;
let doomed: Workspace;

const workspace = async (name: string, slug: string): Promise<Workspace> => {
  const response = await server.send('POST', '/api/workspaces', { name, slug, description: '' });
  expect(response.status).toBe(201);
  return ((await response.json()) as { workspace: Workspace }).workspace;
};

const mint = async (workspaceIds: string[]): Promise<ApiTokenRecord> => {
  const response = await server.send('POST', '/api/tokens', {
    name: 'LIA',
    scopes: ['run', 'read'],
    workspaceIds,
    ceiling: 'dontAsk',
    expiresInDays: 30,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: ApiTokenRecord }).token;
};

const read = async (id: string): Promise<ApiTokenRecord | undefined> => {
  const { tokens } = await server.get<{ tokens: ApiTokenRecord[] }>('/api/tokens');
  return tokens.find((token) => token.id === id);
};

beforeAll(async () => {
  server = await bootTestServer({ name: 'token-grants' });
  keep = await workspace('Keep', 'keep');
  doomed = await workspace('Doomed', 'doomed');
});

afterAll(async () => {
  await server?.close();
});

describe('a token’s grants over HTTP', () => {
  it('loses a workspace when it is deleted, and can be granted another without a new secret', async () => {
    const token = await mint([keep.id, doomed.id]);

    const deleted = await server.send('DELETE', `/api/workspaces/${doomed.id}`, undefined);
    expect(deleted.status).toBe(200);

    // Pruned, not left pointing at something that no longer exists.
    expect((await read(token.id))?.workspaceIds).toEqual([keep.id]);

    // And the audit says what it did to the tokens, because nothing else would.
    const trail = await server.get<{ entries: Array<{ action: string; detail: string | null }> }>(
      '/api/audit?limit=50',
    );
    expect(
      trail.entries.find((entry) => entry.action === 'workspace.delete')?.detail,
    ).toMatch(/removed from 1 token/);

    const patched = await server.send('PATCH', `/api/tokens/${token.id}`, {
      workspaceIds: [keep.id],
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { token: ApiTokenRecord }).token.workspaceIds).toEqual([keep.id]);
    // The hint is the token's identity: a repair that changed it would mean a
    // different credential, which is the thing this route exists to avoid.
    expect((await read(token.id))?.hint).toBe(token.hint);
  });

  it('refuses a grant on a workspace that does not exist, and an empty one', async () => {
    const token = await mint([keep.id]);

    const ghost = await server.send('PATCH', `/api/tokens/${token.id}`, {
      workspaceIds: ['ws_ghost'],
    });
    expect(ghost.status).toBe(400);

    const empty = await server.send('PATCH', `/api/tokens/${token.id}`, { workspaceIds: [] });
    expect(empty.status).toBe(400);

    const nothing = await server.send('PATCH', `/api/tokens/${token.id}`, {});
    expect(nothing.status).toBe(400);

    expect((await read(token.id))?.workspaceIds).toEqual([keep.id]);
  });

  it('refuses to edit a revoked token, and answers 404 for one that never existed', async () => {
    const token = await mint([keep.id]);
    expect((await server.send('DELETE', `/api/tokens/${token.id}`, undefined)).status).toBe(200);

    const revoked = await server.send('PATCH', `/api/tokens/${token.id}`, {
      workspaceIds: [keep.id],
    });
    expect(revoked.status).toBe(409);

    const missing = await server.send('PATCH', '/api/tokens/tok_ghost', { workspaceIds: [keep.id] });
    expect(missing.status).toBe(404);
  });
});
