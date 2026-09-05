/**
 * The two memory routes that change what a run will be given.
 *
 * Driven against a real server, because what is under test is the *edge*: the
 * store's own rules have their own tests, and the thing that made those tests
 * worth nothing for a release elsewhere in this repository was a contract that
 * refused the request before the store ever saw it.
 *
 * Two properties, and both are about refusing:
 *
 *  - **Scope is its own verb.** `PATCH /api/memory/:id` cannot move a memory
 *    between tiers, and must not start being able to: every other field there
 *    is the memory's own content, while this one decides which projects recall
 *    it at all.
 *  - **A consolidation is applied against the corpus as it is now**, not as it
 *    was when the proposal was drawn up. A memory edited in between is the
 *    case that matters: merging over it would delete an edit nobody ever saw.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_COOKIE, type Insight, type Memory } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { fingerprint } from '../learning/consolidation.js';
import { buildServer } from '../server.js';

const USERNAME = 'memory-keeper';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let workspaceId: string;

function send(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });

/** A memory written straight through the store, so a test states its own fixture. */
async function remember(input: {
  workspaceId: string | null;
  title: string;
  content: string;
}): Promise<Memory> {
  const { memory } = await context.memory.remember({
    kind: 'semantic',
    tags: [],
    ...input,
  });
  return memory;
}

/** A consolidation proposal, filed the way the pass files one. */
function fileProposal(payload: Record<string, unknown>): string {
  const id = `insight_test_${Math.random().toString(36).slice(2, 10)}`;
  context.db
    .prepare(
      `INSERT INTO insights (id, workspace_id, run_id, kind, title, body, confidence, status, payload, created_at)
       VALUES (?, NULL, NULL, 'consolidation', 'proposal', 'body', 0.7, 'new', ?, ?)`,
    )
    .run(id, JSON.stringify(payload), Date.now());
  return id;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-memscope-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
  } as NodeJS.ProcessEnv);

  context = await createAppContext(config, pino({ level: 'silent' }));
  await context.auth.createUser({ username: USERNAME, password: PASSWORD, role: 'owner' });
  app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const setCookies = login.headers.getSetCookie();
  cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
  csrfToken = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);

  const workspace = await send('POST', '/api/workspaces', { name: 'Scoped' });
  expect(workspace.status).toBe(201);
  workspaceId = ((await workspace.json()) as { workspace: { id: string } }).workspace.id;
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  context.db.prepare('DELETE FROM memories').run();
  context.db.prepare('DELETE FROM insights').run();
});

describe('moving a memory between tiers', () => {
  it('promotes, and the memory is then retrieved from another workspace', async () => {
    const memory = await remember({
      workspaceId,
      title: 'Test command',
      content: 'The tests run with pnpm test:run from the repository root.',
    });

    const response = await send('POST', `/api/memory/${memory.id}/scope`, { workspaceId: null });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { memory: Memory; moved: boolean };
    expect(body.moved).toBe(true);
    expect(body.memory.workspaceId).toBeNull();

    const other = await send('POST', '/api/workspaces', { name: 'Elsewhere' });
    const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;
    const hits = await context.memory.search('pnpm test', { workspaceId: otherId });
    expect(hits).toHaveLength(1);
  });

  it('confines, and names the workspace it could not find', async () => {
    const memory = await remember({ workspaceId: null, title: 'Anywhere', content: 'Applies broadly.' });

    const bad = await send('POST', `/api/memory/${memory.id}/scope`, { workspaceId: 'ws_nope' });
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as { error: string }).error).toMatch(/no such workspace/i);

    const good = await send('POST', `/api/memory/${memory.id}/scope`, { workspaceId });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { memory: Memory }).memory.workspaceId).toBe(workspaceId);
  });

  it('answers 404 for a memory that is gone, rather than 500', async () => {
    const response = await send('POST', '/api/memory/mem_nope/scope', { workspaceId: null });
    expect(response.status).toBe(404);
  });

  it('refuses a body that is not a tier', async () => {
    const memory = await remember({ workspaceId, title: 'A', content: 'B' });
    expect((await send('POST', `/api/memory/${memory.id}/scope`, {})).status).toBe(400);
    expect((await send('POST', `/api/memory/${memory.id}/scope`, { workspaceId: 7 })).status).toBe(400);
  });

  /**
   * The tier is not a property of the memory's content, and `PATCH` is where
   * content is edited. Keeping them apart is what makes one audit line mean
   * "somebody changed what every workspace recalls" — and what stops a form
   * that round-trips a whole `Memory` from moving it by accident.
   */
  it('cannot be done through the ordinary edit route', async () => {
    const memory = await remember({ workspaceId, title: 'Stays put', content: 'Here only.' });

    const response = await send('PATCH', `/api/memory/${memory.id}`, {
      workspaceId: null,
      title: 'Renamed',
    });

    expect(response.status).toBe(200);
    expect(context.memory.get(memory.id)?.workspaceId).toBe(workspaceId);
    expect(context.memory.get(memory.id)?.title).toBe('Renamed');
  });

  it('writes an audit line only when the tier actually moved', async () => {
    const memory = await remember({ workspaceId: null, title: 'Already global', content: 'x' });
    const before = context.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'memory.promote'")
      .get()!.n;

    const response = await send('POST', `/api/memory/${memory.id}/scope`, { workspaceId: null });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { moved: boolean }).moved).toBe(false);
    expect(
      context.db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'memory.promote'")
        .get()!.n,
    ).toBe(before);
  });
});

describe('applying a consolidation', () => {
  async function pair(): Promise<[Memory, Memory]> {
    const first = await remember({ workspaceId, title: 'Le workspace est en francais', content: 'Tout y est ecrit en francais.' });
    const second = await remember({ workspaceId, title: 'On ecrit en francais ici', content: 'La langue de ce projet est le francais.' });
    return [first, second];
  }

  const planFor = (winner: Memory, loser: Memory, over: Record<string, unknown> = {}) => ({
    key: [winner.id, loser.id].sort().join('|'),
    verdict: 'duplicate',
    reason: 'Both say the workspace works in French.',
    members: [winner, loser].map((memory) => ({
      id: memory.id,
      title: memory.title,
      fingerprint: fingerprint(memory.title, memory.content),
      workspaceId: memory.workspaceId,
    })),
    winnerId: winner.id,
    merged: { title: 'Le workspace travaille en francais', content: 'Tout y est ecrit en francais.', tags: ['langue'] },
    promotable: false,
    ...over,
  });

  it('folds the members into the survivor and marks the proposal applied', async () => {
    const [winner, loser] = await pair();
    const insightId = fileProposal(planFor(winner, loser));

    const response = await send('POST', `/api/insights/${insightId}/consolidate`, { promote: false });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { memory: Memory; absorbed: string[]; moved: boolean };
    expect(body.absorbed).toEqual([loser.id]);
    expect(body.memory.title).toBe('Le workspace travaille en francais');
    expect(context.memory.get(loser.id)).toBeNull();

    const insights = (await (await get('/api/insights?status=applied')).json()) as {
      insights: Insight[];
    };
    expect(insights.insights.map((insight) => insight.id)).toContain(insightId);
  });

  /**
   * The case the fingerprints exist for. A proposal is a plan written against
   * particular text and reviewed by a person some time later; a run reinforcing
   * a memory, or the operator editing one, makes the plan describe something
   * that is no longer there.
   */
  it('refuses once a member has been edited, naming it, and merges nothing', async () => {
    const [winner, loser] = await pair();
    const insightId = fileProposal(planFor(winner, loser));
    await context.memory.update(loser.id, { content: 'Une precision ajoutee entre-temps.' });

    const response = await send('POST', `/api/insights/${insightId}/consolidate`, { promote: false });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(loser.title);
    expect(context.memory.get(loser.id)).not.toBeNull();
    expect(context.memory.get(winner.id)?.title).toBe(winner.title);
  });

  it('refuses once a member has been deleted', async () => {
    const [winner, loser] = await pair();
    const insightId = fileProposal(planFor(winner, loser));
    context.memory.delete(loser.id);

    const response = await send('POST', `/api/insights/${insightId}/consolidate`, { promote: false });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/no longer exists/i);
  });

  it('promotes when asked, but only where the pass judged it could', async () => {
    const [winner, loser] = await pair();

    const refused = fileProposal(planFor(winner, loser, { promotable: false }));
    const no = await send('POST', `/api/insights/${refused}/consolidate`, { promote: true });
    expect(no.status).toBe(409);
    expect(context.memory.get(winner.id)?.workspaceId).toBe(workspaceId);

    const allowed = fileProposal(planFor(winner, loser, { promotable: true }));
    const yes = await send('POST', `/api/insights/${allowed}/consolidate`, { promote: true });
    expect(yes.status).toBe(200);
    expect(((await yes.json()) as { moved: boolean }).moved).toBe(true);
    expect(context.memory.get(winner.id)?.workspaceId).toBeNull();
  });

  /** A contradiction has no merged text: which one is right is not ours to say. */
  it('refuses a contradiction, which has nothing to apply', async () => {
    const [winner, loser] = await pair();
    const insightId = fileProposal({
      ...planFor(winner, loser),
      verdict: 'contradictory',
      merged: undefined,
    });

    const response = await send('POST', `/api/insights/${insightId}/consolidate`, { promote: false });

    expect(response.status).toBe(409);
    expect(context.memory.get(loser.id)).not.toBeNull();
  });

  /**
   * Two guards refuse a replay and the order matters for the *message*, not
   * for the outcome: the members are gone by then, so the fingerprint check
   * would refuse it too — with "no longer exists", which sends the operator
   * looking for a memory that was folded away on purpose. Asserting the text
   * is what makes the status check load-bearing rather than decoration.
   */
  it('refuses to apply the same proposal twice, and says why', async () => {
    const [winner, loser] = await pair();
    const insightId = fileProposal(planFor(winner, loser));

    expect((await send('POST', `/api/insights/${insightId}/consolidate`, {})).status).toBe(200);

    const again = await send('POST', `/api/insights/${insightId}/consolidate`, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/already been applied/i);
  });

  it('refuses an insight that is not a consolidation, and one that is unknown', async () => {
    const other = `insight_other_${Date.now()}`;
    context.db
      .prepare(
        `INSERT INTO insights (id, workspace_id, run_id, kind, title, body, confidence, status, payload, created_at)
         VALUES (?, NULL, NULL, 'lesson', 't', 'b', 0.5, 'new', NULL, ?)`,
      )
      .run(other, Date.now());

    expect((await send('POST', `/api/insights/${other}/consolidate`, {})).status).toBe(400);
    expect((await send('POST', '/api/insights/insight_nope/consolidate', {})).status).toBe(404);
  });

  it('refuses a payload it cannot read', async () => {
    const insightId = fileProposal({ shape: 'from another version' });

    const response = await send('POST', `/api/insights/${insightId}/consolidate`, {});

    expect(response.status).toBe(422);
  });
});

describe('the memory listing', () => {
  it('carries where each memory was learned, as a session to open', async () => {
    const session = context.sessionRepo.create({
      workspaceId,
      title: 'A session',
      model: 'default',
      effort: null,
      permissionMode: 'default',
    });
    const runId = 'run_source_1';
    context.db
      .prepare(
        `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
         VALUES (?, ?, ?, 'a prompt', 'succeeded', ?)`,
      )
      .run(runId, session.id, workspaceId, Date.now());
    await context.memory.remember({
      workspaceId,
      kind: 'semantic',
      title: 'Learned somewhere',
      content: 'From a run.',
      sourceRunId: runId,
    });

    const body = (await (await get('/api/memory')).json()) as {
      sources: Record<string, { sessionId: string; workspaceId: string }>;
    };

    expect(body.sources[runId]).toEqual({ sessionId: session.id, workspaceId });
  });

  /** A run past its retention window leaves the id behind. It is not a link. */
  it('omits a source whose run no longer exists', async () => {
    await context.memory.remember({
      workspaceId,
      kind: 'semantic',
      title: 'Orphaned',
      content: 'Its run was pruned.',
      sourceRunId: null,
    });

    const body = (await (await get('/api/memory')).json()) as { sources: Record<string, unknown> };

    expect(body.sources).toEqual({});
  });
});
