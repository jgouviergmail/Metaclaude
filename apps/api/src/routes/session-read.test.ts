/**
 * The read marker, through the routes.
 *
 * `kernel/repositories.test.ts` proves the column's rules. What only the
 * routes can prove is that the two ends meet: a session says whether it is
 * unread, `POST /read` clears it, and the workspaces list carries the per
 * workspace count the cards are painted from — the whole point being that a
 * reply which lands while nobody is looking is visible from the top level,
 * without opening anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session, Workspace } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let workspace: Workspace;

beforeAll(async () => {
  server = await bootTestServer({ name: 'session-read' });
  const created = await server.send('POST', '/api/workspaces', {
    name: 'Reading room',
    slug: 'reading-room',
    description: 'A workspace',
  });
  expect(created.status).toBe(201);
  workspace = ((await created.json()) as { workspace: Workspace }).workspace;
});

afterAll(async () => {
  await server?.close();
});

const newSession = async (): Promise<Session> => {
  const response = await server.send('POST', '/api/sessions', {
    workspaceId: workspace.id,
    title: 'Nightly',
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: Session }).session;
};

const unreadCounts = async (): Promise<Record<string, number>> => {
  const response = await server.send('GET', '/api/workspaces');
  expect(response.status).toBe(200);
  return ((await response.json()) as { unread: Record<string, number> }).unread;
};

/**
 * What a finished run does to the row, without running one: the session ages
 * a minute, then a run's usage lands on it. Ageing first because creation and
 * the write would otherwise share a millisecond, and activity *equal* to the
 * read mark is read — the boundary the repository test pins.
 */
const activityLands = (session: Session): void => {
  server.context.db
    .prepare(
      `UPDATE sessions SET last_read_at = last_read_at - 60000,
                           last_activity_at = last_activity_at - 60000
        WHERE id = ?`,
    )
    .run(session.id);
  server.context.sessionRepo.addUsage(session.id, { costUsd: 0.01, inputTokens: 10, outputTokens: 5 });
};

describe('the session read marker over HTTP', () => {
  it('starts read, goes unread when something lands, and is cleared by POST /read', async () => {
    const session = await newSession();
    expect(session.lastReadAt).toBeGreaterThan(0);
    expect(session.lastActivityAt).toBeLessThanOrEqual(session.lastReadAt);
    expect(await unreadCounts()).toEqual({});

    activityLands(session);
    expect(await unreadCounts()).toEqual({ [workspace.id]: 1 });

    const read = await server.send('POST', `/api/sessions/${session.id}/read`, undefined);
    expect(read.status).toBe(200);
    const marked = ((await read.json()) as { session: Session }).session;
    expect(marked.lastReadAt).toBeGreaterThanOrEqual(marked.lastActivityAt);
    expect(await unreadCounts()).toEqual({});
  });

  it('counts each unread session of a workspace once, and answers 404 for one that does not exist', async () => {
    const first = await newSession();
    const second = await newSession();
    activityLands(first);
    activityLands(second);

    expect(await unreadCounts()).toEqual({ [workspace.id]: 2 });

    await server.send('POST', `/api/sessions/${first.id}/read`, undefined);
    expect(await unreadCounts()).toEqual({ [workspace.id]: 1 });

    // Archiving is being done with it: the badge must be clearable.
    const archived = await server.send('PATCH', `/api/sessions/${second.id}`, { archived: true });
    expect(archived.status).toBe(200);
    expect(await unreadCounts()).toEqual({});

    const missing = await server.send('POST', '/api/sessions/ses_nope/read', undefined);
    expect(missing.status).toBe(404);
  });
});

/**
 * Archived sessions, through the routes.
 *
 * Archiving was one-way from the interface until this existed: the row left
 * the sidebar and nothing offered it back. What the routes owe the fold is a
 * count on the workspace payload and a list of its own.
 */
describe('archived sessions over HTTP', () => {
  it('counts them on the workspace, lists them on demand, and hands one back', async () => {
    const session = await newSession();

    // Relative to what the earlier cases left behind: this file shares one
    // server, and an absolute count here would be a test about test order.
    const before = await server.get<{ archivedSessionCount: number; sessions: { id: string }[] }>(
      `/api/workspaces/${workspace.id}`,
    );
    const baseline = before.archivedSessionCount;
    expect(before.sessions.some((entry) => entry.id === session.id)).toBe(true);

    const archived = await server.send('PATCH', `/api/sessions/${session.id}`, { archived: true });
    expect(archived.status).toBe(200);

    const after = await server.get<{ archivedSessionCount: number; sessions: { id: string }[] }>(
      `/api/workspaces/${workspace.id}`,
    );
    expect(after.archivedSessionCount).toBe(baseline + 1);
    // Gone from the live list, which is what made it unreachable before.
    expect(after.sessions.some((entry) => entry.id === session.id)).toBe(false);

    const list = await server.get<{ sessions: Session[] }>(
      `/api/workspaces/${workspace.id}/sessions?archived=1`,
    );
    expect(list.sessions.map((entry) => entry.id)).toContain(session.id);

    // And without the flag the same route answers the live ones.
    const live = await server.get<{ sessions: Session[] }>(`/api/workspaces/${workspace.id}/sessions`);
    expect(live.sessions.some((entry) => entry.id === session.id)).toBe(false);

    const restored = await server.send('PATCH', `/api/sessions/${session.id}`, { archived: false });
    expect(restored.status).toBe(200);
    const back = await server.get<{ archivedSessionCount: number }>(`/api/workspaces/${workspace.id}`);
    expect(back.archivedSessionCount).toBe(baseline);
  });
});

