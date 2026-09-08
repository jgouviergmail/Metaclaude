/**
 * The bulk registry routes, driven through the edge rather than under it.
 *
 * `registry.test.ts` proves `setSkillsEnabled` and `deleteSkills` do the right
 * thing, and that is the wrong altitude for the two decisions that actually
 * live here: what `BulkInput` accepts, and the three-way scope convention —
 * key absent means *every* scope, `null` means global only, an id means that
 * workspace plus the globals it sees. That convention is expressed as
 * `'workspaceId' in parsed.data`, which depends on the schema library omitting
 * an absent optional key rather than setting it to `undefined`. It does; a test
 * below says so, because it is a property of a dependency and not of this code.
 *
 * This is the trap CLAUDE.md names: the recovery codes were proven to work by
 * calling `auth.login()` directly, while the route rejected them at
 * `safeParse` long before that and the feature was dead with its tests green.
 * A bulk delete is the most destructive button in the registry; it gets a test
 * that presses it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const USERNAME = 'bulk-operator';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let workspaceId: string;
let otherWorkspaceId: string;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

/** A skill in one scope, returning its id. */
async function makeSkill(name: string, scope: string | null): Promise<string> {
  const response = await post('/api/skills', {
    workspaceId: scope,
    name,
    description: 'for the bulk tests',
    body: '# nothing',
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { skill: { id: string } }).skill.id;
}

async function skillsIn(scope: string | null): Promise<Array<{ id: string; enabled: boolean }>> {
  const query = scope === null ? 'scope=global' : `workspaceId=${scope}`;
  const response = await fetch(`${baseUrl}/api/skills?${query}`, { headers: { cookie: cookies } });
  return ((await response.json()) as { skills: Array<{ id: string; enabled: boolean }> }).skills;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-bulk-'));

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

  for (const [name, holder] of [
    ['Bulk A', 'workspaceId'],
    ['Bulk B', 'otherWorkspaceId'],
  ] as const) {
    const response = await post('/api/workspaces', { name });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { workspace: { id: string } }).workspace.id;
    if (holder === 'workspaceId') workspaceId = id;
    else otherWorkspaceId = id;
  }
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/skills/bulk', () => {
  it('disables and re-enables the ids it is given, reporting the count', async () => {
    const ids = [await makeSkill('bulk-one', workspaceId), await makeSkill('bulk-two', workspaceId)];

    const off = await post('/api/skills/bulk', { action: 'disable', ids, workspaceId });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ changed: 2 });

    const after = await skillsIn(workspaceId);
    expect(after.filter((skill) => ids.includes(skill.id)).every((skill) => !skill.enabled)).toBe(
      true,
    );

    const on = await post('/api/skills/bulk', { action: 'enable', ids, workspaceId });
    expect(await on.json()).toEqual({ changed: 2 });
  });

  /**
   * The property the whole design rests on. A workspace's listing includes the
   * global entries, so a server-side "everything in this scope" would let a
   * workspace screen empty the shared library. Naming a row from *another*
   * workspace must change nothing, whatever the caller claims.
   */
  it('refuses ids outside the scope it was given, silently and without a count', async () => {
    const mine = await makeSkill('bulk-mine', workspaceId);
    const theirs = await makeSkill('bulk-theirs', otherWorkspaceId);

    const response = await post('/api/skills/bulk', {
      action: 'disable',
      ids: [mine, theirs],
      workspaceId,
    });
    expect(await response.json()).toEqual({ changed: 1 });

    const other = await skillsIn(otherWorkspaceId);
    expect(other.find((skill) => skill.id === theirs)?.enabled).toBe(true);
  });

  /** `null` is global only — a workspace's own rows are out of reach. */
  it('reaches only the global entries when the scope is null', async () => {
    const global = await makeSkill('bulk-global', null);
    const mine = await makeSkill('bulk-scoped', workspaceId);

    const response = await post('/api/skills/bulk', {
      action: 'disable',
      ids: [global, mine],
      workspaceId: null,
    });
    expect(await response.json()).toEqual({ changed: 1 });
    expect((await skillsIn(workspaceId)).find((skill) => skill.id === mine)?.enabled).toBe(true);
  });

  /**
   * And the omission is a third value, not a synonym for `null`. If an absent
   * key collapsed to "global only", the management screen that lists every
   * scope would silently act on a fraction of what it showed.
   */
  it('reaches every scope when the key is omitted entirely', async () => {
    const global = await makeSkill('bulk-any-global', null);
    const mine = await makeSkill('bulk-any-scoped', workspaceId);

    const response = await post('/api/skills/bulk', {
      action: 'disable',
      ids: [global, mine],
    });
    expect(await response.json()).toEqual({ changed: 2 });
  });

  it('deletes the rows, and a second attempt changes nothing', async () => {
    const ids = [await makeSkill('bulk-gone', workspaceId)];

    expect(await (await post('/api/skills/bulk', { action: 'delete', ids })).json()).toEqual({
      changed: 1,
    });
    expect(await (await post('/api/skills/bulk', { action: 'delete', ids })).json()).toEqual({
      changed: 0,
    });
  });

  it('records one audit entry carrying the count, not one per row', async () => {
    const ids = [
      await makeSkill('bulk-audit-one', workspaceId),
      await makeSkill('bulk-audit-two', workspaceId),
    ];
    await post('/api/skills/bulk', { action: 'disable', ids, workspaceId });

    const entries = context.audit.list({ limit: 50 });
    const bulk = entries.filter((entry) => entry.action === 'skill.bulk.disable');
    expect(bulk.length).toBeGreaterThan(0);
    expect(bulk[0]?.detail).toBe('2');
  });

  it.each([
    ['an unknown action', { action: 'purge', ids: ['skl_x'] }],
    ['an empty id list', { action: 'delete', ids: [] }],
    ['more ids than the cap', { action: 'delete', ids: Array.from({ length: 501 }, () => 'skl_x') }],
    ['no ids at all', { action: 'delete' }],
    ['a non-string id', { action: 'delete', ids: [7] }],
  ])('refuses %s at the edge', async (_name, body) => {
    expect((await post('/api/skills/bulk', body)).status).toBe(400);
  });
});

describe('POST /api/agents/bulk', () => {
  it('acts on subagents through the same contract', async () => {
    const response = await post('/api/agents', {
      workspaceId,
      name: 'bulk-agent',
      description: 'for the bulk tests',
      prompt: 'do nothing',
    });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { agent: { id: string } }).agent.id;

    const off = await post('/api/agents/bulk', { action: 'disable', ids: [id], workspaceId });
    expect(await off.json()).toEqual({ changed: 1 });

    const gone = await post('/api/agents/bulk', { action: 'delete', ids: [id], workspaceId });
    expect(await gone.json()).toEqual({ changed: 1 });
  });
});

/**
 * `POST /api/automations/bulk` — the edge, not the scheduler underneath.
 *
 * `scheduler.test.ts` proves the three coupled writes; what lives only here is
 * what the route *accepts*. Two of its decisions differ from the registry's on
 * purpose, and both are the kind a later reader would "fix" without a test
 * saying otherwise: `delete` is refused, because a cron expression somebody
 * thought about is a bigger loss than a listing row; and the scope is a plain
 * optional id, because an automation belongs to exactly one workspace by
 * schema and "global only" would name an empty set.
 */
describe('POST /api/automations/bulk', () => {
  const makeAutomation = async (name: string, scope: string): Promise<string> => {
    const response = await post('/api/automations', {
      workspaceId: scope,
      name,
      prompt: 'do the thing',
      trigger: { type: 'interval', everyMs: 30 * 60_000 },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { automation: { id: string } }).automation.id;
  };

  const automationsIn = async (
    scope: string,
  ): Promise<Array<{ id: string; enabled: boolean; nextRunAt: number | null }>> => {
    const response = await fetch(`${baseUrl}/api/automations?workspaceId=${scope}`, {
      headers: { cookie: cookies },
    });
    return (
      (await response.json()) as {
        automations: Array<{ id: string; enabled: boolean; nextRunAt: number | null }>;
      }
    ).automations;
  };

  it('switches a whole screenful off, and back on with a schedule', async () => {
    const ids = [
      await makeAutomation('Bulk one', workspaceId),
      await makeAutomation('Bulk two', workspaceId),
    ];

    const off = await post('/api/automations/bulk', { action: 'disable', ids });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { changed: number }).changed).toBe(2);
    for (const one of (await automationsIn(workspaceId)).filter((a) => ids.includes(a.id))) {
      expect(one.enabled).toBe(false);
      expect(one.nextRunAt).toBeNull();
    }

    const on = await post('/api/automations/bulk', { action: 'enable', ids });
    expect(((await on.json()) as { changed: number }).changed).toBe(2);
    for (const one of (await automationsIn(workspaceId)).filter((a) => ids.includes(a.id))) {
      expect(one.enabled).toBe(true);
      // The half a single UPDATE would drop: the sweep selects on this, so an
      // enabled automation without it is one that never fires.
      expect(one.nextRunAt).not.toBeNull();
    }
  });

  it('refuses to delete, which is not a bulk action here', async () => {
    const id = await makeAutomation('Bulk keeper', workspaceId);

    const response = await post('/api/automations/bulk', { action: 'delete', ids: [id] });

    expect(response.status).toBe(400);
    expect((await automationsIn(workspaceId)).some((one) => one.id === id)).toBe(true);
  });

  it('refuses an empty list rather than reporting nothing changed', async () => {
    expect((await post('/api/automations/bulk', { action: 'disable', ids: [] })).status).toBe(400);
  });

  it('will not reach an automation outside the workspace it was scoped to', async () => {
    const other = await post('/api/workspaces', { name: 'Bulk elsewhere' });
    const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;
    const theirs = await makeAutomation('Bulk theirs', otherId);

    const response = await post('/api/automations/bulk', {
      action: 'disable',
      ids: [theirs],
      workspaceId,
    });

    expect(((await response.json()) as { changed: number }).changed).toBe(0);
    expect((await automationsIn(otherId)).find((one) => one.id === theirs)!.enabled).toBe(true);
  });
});

/**
 * The reach, set through the edge rather than under it.
 *
 * `registry-attachments.test.ts` proves `setReach` replaces rather than adds.
 * What lives only here is that the route *accepts* it, and — the half a schema
 * change silently breaks — that a save which does **not** mention the reach
 * leaves it alone. A form that saves a name must not narrow a reach it never
 * showed the operator, which is the `.partial()` trap in another costume.
 */
describe('POST /api/skills — the reach', () => {
  const makeIn = async (name: string, reach?: unknown): Promise<{ id: string }> => {
    const response = await post('/api/skills', {
      workspaceId: null,
      name,
      description: 'for the reach tests',
      body: '# nothing',
      ...(reach ? { reach } : {}),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { skill: { id: string } }).skill;
  };

  const read = async (id: string) => {
    // `scope=all`: with no parameter the route answers globals only, and
    // these are attached rather than global.
    const response = await fetch(`${baseUrl}/api/skills?scope=all`, {
      headers: { cookie: cookies },
    });
    const body = (await response.json()) as {
      skills: Array<{ id: string; isGlobal: boolean; workspaceIds: string[] }>;
    };
    return body.skills.find((one) => one.id === id)!;
  };

  it('stores the workspaces an editor names', async () => {
    const skill = await makeIn('reach-one', { global: false, workspaceIds: [workspaceId] });

    const stored = await read(skill.id);
    expect(stored.isGlobal).toBe(false);
    expect(stored.workspaceIds).toEqual([workspaceId]);
  });

  it('accepts the empty set, which means nowhere', async () => {
    const skill = await makeIn('reach-none', { global: false, workspaceIds: [] });

    const stored = await read(skill.id);
    expect(stored.workspaceIds).toEqual([]);
    expect(stored.isGlobal).toBe(false);
  });

  it('leaves the reach alone when a save does not mention it', async () => {
    const skill = await makeIn('reach-kept', { global: false, workspaceIds: [workspaceId] });

    const again = await post('/api/skills', {
      id: skill.id,
      workspaceId: null,
      name: 'reach-kept',
      description: 'edited, and saying nothing about reach',
      body: '# still nothing',
    });
    expect(again.status).toBe(200);

    expect((await read(skill.id)).workspaceIds).toEqual([workspaceId]);
  });

  it('refuses a reach that is not one', async () => {
    const response = await post('/api/skills', {
      workspaceId: null,
      name: 'reach-bad',
      description: 'x',
      body: '',
      reach: { global: 'yes', workspaceIds: 'everywhere' },
    });

    expect(response.status).toBe(400);
  });
});
