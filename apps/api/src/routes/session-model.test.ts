/**
 * What a session stores for its model, effort and permission mode.
 *
 * One rule for the three: the workspace gives the base value, a session
 * follows it until a caller pins one, and a pinned one stays. The route used
 * to copy the workspace's defaults into the row, the composer seeded its
 * pickers from the row and sent them back with every message, and the kernel
 * read a non-Auto value as a pin — so a model set on the workspace reached
 * only sessions created afterwards, and an operator who changed it saw
 * nothing happen in the session they were in. `kernel.test.ts` covers the
 * run-time half; this is the edge, where `null` has to be accepted as "back
 * to inheriting" or the way back does not exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session, Workspace } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let workspace: Workspace;

beforeAll(async () => {
  server = await bootTestServer({ name: 'session-model' });
  const created = await server.send('POST', '/api/workspaces', {
    name: 'Modelled',
    slug: 'modelled',
    description: 'A workspace with settings of its own',
    settings: { defaultModel: 'haiku', defaultEffort: 'low', defaultPermissionMode: 'acceptEdits' },
  });
  expect(created.status).toBe(201);
  workspace = ((await created.json()) as { workspace: Workspace }).workspace;
  expect(workspace.settings.defaultModel).toBe('haiku');
  expect(workspace.settings.defaultPermissionMode).toBe('acceptEdits');
});

afterAll(async () => {
  await server?.close();
});

const create = async (body: Record<string, unknown>): Promise<Session> => {
  const response = await server.send('POST', '/api/sessions', { workspaceId: workspace.id, ...body });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: Session }).session;
};

const patch = async (id: string, body: Record<string, unknown>): Promise<Session> => {
  const response = await server.send('PATCH', `/api/sessions/${id}`, body);
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: Session }).session;
};

describe('POST /api/sessions', () => {
  it('stores all three as inherited rather than as copies of the workspace’s values', async () => {
    // As the web creates every session: the workspace id and nothing else.
    const session = await create({ title: 'Plain' });
    expect(session.model).toBe('default');
    expect(session.effort).toBeNull();
    expect(session.permissionMode).toBeNull();
  });

  it('keeps what the caller actually pinned', async () => {
    const session = await create({ title: 'Pinned', model: 'opus', effort: 'high', permissionMode: 'plan' });
    expect(session.model).toBe('opus');
    expect(session.effort).toBe('high');
    expect(session.permissionMode).toBe('plan');
  });
});

describe('PATCH /api/sessions/:id', () => {
  it('pins a setting, one field at a time, and leaves the others inherited', async () => {
    const session = await create({ title: 'Customised' });
    const afterModel = await patch(session.id, { model: 'sonnet' });
    expect(afterModel.model).toBe('sonnet');
    expect(afterModel.effort).toBeNull();
    expect(afterModel.permissionMode).toBeNull();

    const afterMode = await patch(session.id, { permissionMode: 'dontAsk' });
    expect(afterMode.model).toBe('sonnet');
    expect(afterMode.permissionMode).toBe('dontAsk');
  });

  it('accepts null as the way back to inheriting, for the mode as for the effort', async () => {
    // The edge-schema trap: a `PermissionMode.optional()` here would answer
    // 400 to the one request that resets the field, and every test below the
    // route would stay green.
    const session = await create({ title: 'Reset', effort: 'high', permissionMode: 'plan' });
    const back = await patch(session.id, { effort: null, permissionMode: null });
    expect(back.effort).toBeNull();
    expect(back.permissionMode).toBeNull();
  });

  it('still refuses a mode that is not one of the six', async () => {
    const session = await create({ title: 'Strict' });
    const response = await server.send('PATCH', `/api/sessions/${session.id}`, { permissionMode: 'inherit' });
    expect(response.status).toBe(400);
    await response.arrayBuffer();
  });
});
