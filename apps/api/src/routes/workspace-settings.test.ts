/**
 * The settings a workspace may store about what its runs are allowed to do.
 *
 * Two guards, both driven against a real server, and both on *creation* as
 * well as update. That symmetry is the point: `additionalDirectories` was
 * reviewed on `PATCH` and not on `POST`, so a workspace could be born naming a
 * directory the server would refuse at run time. Nothing unsafe followed — the
 * supervisor reviews it again and drops what it must — but the operator was
 * told the setting had been saved and it never did anything. The same
 * asymmetry, in the same file, is what `permission-mode.test.ts` exists for.
 *
 * The tool guard is the new one, and its rule is measured rather than assumed:
 * a scoped rule such as `WebFetch(domain:example.com)` handed to the CLI on
 * this channel allowed a fetch of a *different* domain, so writing one in
 * order to narrow an approval silently widens it instead. It is refused at the
 * edge, where the operator can still be told, and again in the supervisor,
 * where a row written by an older version cannot slip through.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEER_TOOL_CATALOGUE } from '../kernel/peer-tools.js';
import { CSRF_COOKIE } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const USERNAME = 'settings-keeper';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let workspaceId: string;

function send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

const post = (path: string, body: unknown) => send('POST', path, body);
const patch = (path: string, body: unknown) => send('PATCH', path, body);

/** The stored settings, read back so a 200 is never taken on trust. */
async function storedSettings(): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}`, {
    headers: { cookie: cookies },
  });
  const body = (await response.json()) as {
    workspace: { settings: Record<string, unknown> };
  };
  return body.workspace.settings;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-wssettings-'));

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

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const setCookies = response.headers.getSetCookie();
  cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
  csrfToken = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);

  const workspace = await post('/api/workspaces', { name: 'Settings' });
  expect(workspace.status).toBe(201);
  workspaceId = ((await workspace.json()) as { workspace: { id: string } }).workspace.id;
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the pre-approved and forbidden tool lists', () => {
  it('stores well-formed names, trimmed and de-duplicated', async () => {
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { allowedTools: [' WebSearch ', 'WebFetch', 'WebSearch'] },
    });
    expect(response.status).toBe(200);
    expect(await storedSettings()).toMatchObject({ allowedTools: ['WebSearch', 'WebFetch'] });
  });

  it('refuses a scoped rule, and names it in the message', async () => {
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { allowedTools: ['WebFetch(domain:example.com)'] },
    });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('WebFetch(domain:example.com)');
    expect(error).toMatch(/widen/i);

    // And nothing was stored: a 400 that still saves is worse than no check.
    expect(await storedSettings()).toMatchObject({ allowedTools: ['WebSearch', 'WebFetch'] });
  });

  it('refuses a name that is not shaped like a tool', async () => {
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { disallowedTools: ['rm -rf /'] },
    });
    expect(response.status).toBe(400);
  });

  it('refuses the same shapes on creation, not only on update', async () => {
    const response = await post('/api/workspaces', {
      name: 'Born wrong',
      settings: { allowedTools: ['WebFetch(domain:example.com)'] },
    });
    expect(response.status).toBe(400);

    const list = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie: cookies } });
    const { workspaces } = (await list.json()) as { workspaces: Array<{ name: string }> };
    expect(workspaces.map((workspace) => workspace.name)).not.toContain('Born wrong');
  });

  it('refuses a tool that is both pre-approved and forbidden, rather than picking one', async () => {
    // The supervisor resolves the contradiction safely — forbidding wins — but
    // a settings screen that accepts both and then honours one is a screen
    // that lies about what it stored.
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { allowedTools: ['Bash'], disallowedTools: ['Bash'] },
    });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('Bash');
  });

  it('accepts an empty list, which is the default and means nothing is pre-approved', async () => {
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { allowedTools: [] },
    });
    expect(response.status).toBe(200);
    expect(await storedSettings()).toMatchObject({ allowedTools: [] });
  });
});

describe('additionalDirectories is reviewed wherever it can be stored', () => {
  it('refuses an out-of-bounds directory on update', async () => {
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { additionalDirectories: ['/etc'] },
    });
    expect(response.status).toBe(400);
  });

  /**
   * The asymmetry this closes: the review ran on `PATCH` and not on `POST`, so
   * a workspace could be created naming a directory the run-time guard then
   * dropped in silence. The operator saw a saved setting that did nothing.
   */
  it('refuses one on creation too', async () => {
    const response = await post('/api/workspaces', {
      name: 'Reaching out',
      settings: { additionalDirectories: ['/etc'] },
    });
    expect(response.status).toBe(400);

    const list = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie: cookies } });
    const { workspaces } = (await list.json()) as { workspaces: Array<{ name: string }> };
    expect(workspaces.map((workspace) => workspace.name)).not.toContain('Reaching out');
  });
});

describe('the contradiction guard sees what is already stored', () => {
  /**
   * My own first version compared only within the patch, so a request naming
   * one list while the other already held the same tool sailed through — the
   * exact "the form accepted it and the run honours something else" case the
   * guard exists to prevent. The dialog always sends both lists, so this is
   * reachable only through the API; that is precisely why the check has to be
   * on the merged state rather than on the body.
   */
  it('refuses a pre-approval for a tool the stored settings already forbid', async () => {
    const created = await post('/api/workspaces', {
      name: 'Half a patch',
      settings: { disallowedTools: ['Bash'] },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    const response = await patch(`/api/workspaces/${id}`, { settings: { allowedTools: ['Bash'] } });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('Bash');
  });

  it('accepts it once the other list lets go of the tool in the same request', async () => {
    const created = await post('/api/workspaces', {
      name: 'Whole patch',
      settings: { disallowedTools: ['Bash'] },
    });
    const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    const response = await patch(`/api/workspaces/${id}`, {
      settings: { allowedTools: ['Bash'], disallowedTools: [] },
    });
    expect(response.status).toBe(200);
  });
});

/**
 * The same trap, on the control it actually cost data on.
 *
 * The automations list toggles a row with `PATCH { enabled }` and nothing
 * else. Under `.partial()` the route received `description: ''`,
 * `continuous: false` and `maxConsecutiveFailures: 3` alongside it — every
 * field's default — and `scheduler.update` merged each one over the stored
 * automation. Turning an automation off wiped its description, ended its
 * continuous loop and reset its failure ceiling, with nothing to say so.
 *
 * Driven through the real server rather than against the schema alone,
 * because the schema was only half of it: the loss happened in the merge.
 */
describe('a partial patch leaves alone what it does not name', () => {
  it('keeps an automation’s description, loop and ceiling when only enabled changes', async () => {
    const created = await post('/api/automations', {
      workspaceId,
      name: 'Nightly tidy',
      description: 'Sweeps the branch and reports',
      prompt: 'tidy up',
      trigger: { type: 'cron', expression: '0 3 * * *' },
      continuous: true,
      maxConsecutiveFailures: 7,
    });
    expect(created.status).toBe(201);
    const before = ((await created.json()) as { automation: Record<string, unknown> }).automation;
    expect(before).toMatchObject({
      description: 'Sweeps the branch and reports',
      continuous: true,
      maxConsecutiveFailures: 7,
    });

    const toggled = await patch(`/api/automations/${before.id as string}`, { enabled: false });
    expect(toggled.status).toBe(200);
    const after = ((await toggled.json()) as { automation: Record<string, unknown> }).automation;

    expect(after.enabled).toBe(false);
    expect(after.description).toBe('Sweeps the branch and reports');
    expect(after.continuous).toBe(true);
    expect(after.maxConsecutiveFailures).toBe(7);
  });

  it('keeps the rest of an automation’s policy when one field of it changes', async () => {
    const created = await post('/api/automations', {
      workspaceId,
      name: 'Policy holder',
      prompt: 'work',
      trigger: { type: 'manual' },
      policy: { model: 'opus', maxTurns: 12 },
    });
    const id = ((await created.json()) as { automation: { id: string } }).automation.id;

    const updated = await patch(`/api/automations/${id}`, { policy: { permissionMode: 'plan' } });
    expect(updated.status).toBe(200);
    const after = ((await updated.json()) as {
      automation: { policy: Record<string, unknown> };
    }).automation;

    expect(after.policy).toMatchObject({ permissionMode: 'plan', model: 'opus', maxTurns: 12 });
  });

  it('keeps a workspace’s other settings when one of them changes', async () => {
    await patch(`/api/workspaces/${workspaceId}`, {
      settings: { systemPromptAppend: 'House style: British spelling.', maxTurns: 25 },
    });

    await patch(`/api/workspaces/${workspaceId}`, { settings: { allowedTools: ['WebSearch'] } });

    expect(await storedSettings()).toMatchObject({
      allowedTools: ['WebSearch'],
      systemPromptAppend: 'House style: British spelling.',
      maxTurns: 25,
    });
  });
});

/**
 * The MCP tools a workspace could pre-approve.
 *
 * The endpoint exists because the rule it answers — which servers reach a
 * workspace — belongs to the runtime, and a copy of it in the browser would be
 * free to disagree the day that rule changes. So what is pinned here is that
 * the answer *matches the mounting rule*, not merely that the route returns a
 * list: a global server reaches the workspace, another workspace's does not,
 * and a disabled one is absent because it is never mounted.
 *
 * The defect all this exists for: under `dontAsk` the CLI refuses everything
 * not pre-approved, and the interface could only ever tick seven built-ins —
 * so an operator with a working MCP server had no way to make it run
 * unattended, and nothing on the screen said why.
 */
describe('the MCP tools a workspace can pre-approve', () => {
  const tools = async (): Promise<{
    servers: Array<{
      name: string;
      describedAt: number | null;
      tools: Array<{ bare: string; qualified: string; description: string }>;
    }>;
  }> => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/mcp-tools`, {
      headers: { cookie: cookies },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as never;
  };

  /** Register a server and, when tools are given, record what it says it offers. */
  const server = async (
    name: string,
    options: { enabled?: boolean; workspaceId?: string | null; toolNames?: string[] } = {},
  ): Promise<string> => {
    const created = await post('/api/mcp', {
      name,
      transport: 'stdio',
      command: '/bin/true',
      args: [],
      ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
      ...(options.enabled === false ? { enabled: false } : {}),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { server: { id: string } }).server.id;

    if (options.toolNames) {
      // Straight into the store rather than through a probe: what is under test
      // is which servers the route reports, not whether a stdio server answers.
      context.registry.saveDescription(id, {
        instructions: null,
        tools: options.toolNames.map((tool) => ({ name: tool, description: `Does ${tool}.` })),
      });
    }
    return id;
  };

  it('offers a global server’s tools, fully qualified', async () => {
    await server('mailer', { toolNames: ['send', 'search'] });

    const found = (await tools()).servers.find((one) => one.name === 'mailer');

    expect(found).toBeTruthy();
    expect(found!.tools.map((tool) => tool.qualified)).toEqual([
      'mcp__mailer__send',
      'mcp__mailer__search',
    ]);
    expect(found!.tools[0]!.bare).toBe('send');
    expect(found!.describedAt).toBeTypeOf('number');
  });

  it('leaves out a server this workspace does not have', async () => {
    const other = await post('/api/workspaces', { name: 'Elsewhere' });
    const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;
    await server('theirs', { workspaceId: otherId, toolNames: ['peek'] });

    expect((await tools()).servers.map((one) => one.name)).not.toContain('theirs');
  });

  it('leaves out a disabled server, which nothing mounts', async () => {
    // Ticking a box that decides nothing is worse than the box being absent:
    // the operator would believe the tool runs unattended, and it would not.
    await server('paused', { enabled: false, toolNames: ['idle'] });

    expect((await tools()).servers.map((one) => one.name)).not.toContain('paused');
  });

  /**
   * A server nobody has described yet is listed with no tools and a null date.
   * Hiding it would be worse: the operator would look for it, not find it, and
   * have no way to learn that the fix is to ask the server what it offers.
   */
  it('lists a server nobody has asked yet, and says as much', async () => {
    await server('silent');

    const found = (await tools()).servers.find((one) => one.name === 'silent');

    expect(found).toBeTruthy();
    expect(found!.describedAt).toBeNull();
    expect(found!.tools).toEqual([]);
  });

  /**
   * The delegation tool, which Metaclaude mounts itself and which no registry
   * row describes. It is the one in-process tool an operator must be able to
   * tick: under `Don't ask` nothing unapproved runs, so a workspace in that
   * mode could not consult another one at all — and nothing on the screen
   * could say why, because the picker only ever knew the registry.
   */
  it('offers the delegation tool once there is somebody to consult', async () => {
    await post('/api/workspaces', { name: 'A peer', description: 'Does peer things.' });

    const found = (await tools()).servers.find((one) => one.name === 'metaclaude');

    expect(found).toBeTruthy();
    expect(found!.tools.map((tool) => tool.qualified)).toEqual(['mcp__metaclaude__delegate']);
    expect(found!.describedAt).toBeNull();
  });

  /**
   * The picker offers the tools an operator *decides*, and only those.
   *
   * The peer server carries two verbs and they sit in different tiers: the
   * cheap search is pre-approved with its own mount, so a tick for it would be
   * a control that changes nothing, while `delegate` spends another
   * workspace's quota and stays the operator's call. Derived from the
   * catalogue on both sides so a tool moved between rings shows up here rather
   * than silently gaining or losing a control.
   */
  it('offers exactly the peer tools that are an operator’s decision, with copy for each', async () => {
    await post('/api/workspaces', { name: 'A peer', description: 'Does peer things.' });

    const found = (await tools()).servers.find((one) => one.name === 'metaclaude');
    const ringTwo = PEER_TOOL_CATALOGUE.filter((entry) => entry.ring === 2).map((entry) => entry.name);

    expect(found!.tools.map((tool) => tool.bare)).toEqual(ringTwo);
    // Written for a person rather than for the model: every offered tool has
    // its own sentence about what ticking it permits.
    for (const tool of found!.tools) {
      expect(tool.description, tool.bare).toMatch(/Ticking it/);
    }
  });

  it('names a tool exactly as the pre-approval list stores it', async () => {
    // The round trip that matters: what this endpoint offers has to be what a
    // PATCH can store and what `isPreapprovedTool` later matches.
    await server('under_scored', { toolNames: ['do_thing'] });
    const found = (await tools()).servers.find((one) => one.name === 'under_scored')!;

    await patch(`/api/workspaces/${workspaceId}`, {
      settings: { allowedTools: [found.tools[0]!.qualified] },
    });

    expect(await storedSettings()).toMatchObject({
      allowedTools: ['mcp__under_scored__do_thing'],
    });
  });
});
