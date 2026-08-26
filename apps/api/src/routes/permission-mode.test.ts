/**
 * The `bypassPermissions` gate, at every route that can store the mode.
 *
 * `bypassPermissions` is a deployment-level decision: with it, every write,
 * delete, shell command and network call runs unprompted. The rule was written
 * out verbatim in five places and missing from the two that matter most — the
 * routes that *create* a workspace or a session — so a workspace could be born
 * with `defaultPermissionMode: 'bypassPermissions'` on a deployment that
 * forbids it, and the settings screen would then show a safety claim the
 * deployment does not honour.
 *
 * Not one of the five 403s had a test. Five copies of a rule with no coverage
 * is how the sixth caller comes to be forgotten, which is exactly what
 * happened, so this drives all seven paths against a real server.
 *
 * The runtime backstop — `buildOptions` downgrading a stored mode — is covered
 * in `kernel/supervisor.test.ts`. Both layers matter: the routes stop the mode
 * being stored, and the supervisor refuses one that was stored before the flag
 * was turned off.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE, SESSION_COOKIE } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const USERNAME = 'gatekeeper';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let workspaceId: string;
let sessionId: string;

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

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-gate-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
    // The default, stated explicitly because it is what every case below tests.
    METACLAUDE_ALLOW_BYPASS_PERMISSIONS: 'false',
  } as NodeJS.ProcessEnv);
  expect(config.allowBypassPermissions).toBe(false);

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
  expect(cookies).toContain(SESSION_COOKIE);

  // A plain workspace and session to hang the update cases off.
  const workspace = await post('/api/workspaces', { name: 'Gate' });
  expect(workspace.status).toBe(201);
  workspaceId = ((await workspace.json()) as { workspace: { id: string } }).workspace.id;

  const session = await post('/api/sessions', { workspaceId });
  expect(session.status).toBe(201);
  sessionId = ((await session.json()) as { session: { id: string } }).session.id;
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('bypassPermissions is refused when the deployment disables it', () => {
  it('on workspace creation', async () => {
    const response = await post('/api/workspaces', {
      name: 'Reckless',
      settings: { defaultPermissionMode: 'bypassPermissions' },
    });
    expect(response.status).toBe(403);

    // And nothing was stored: a 403 that still creates the workspace is worse
    // than no check, because the screen would then disagree with the database.
    const list = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie: cookies } });
    const { workspaces } = (await list.json()) as { workspaces: Array<{ name: string }> };
    expect(workspaces.map((workspace) => workspace.name)).not.toContain('Reckless');
  });

  it('on workspace update', async () => {
    const response = await patch(`/api/workspaces/${workspaceId}`, {
      settings: { defaultPermissionMode: 'bypassPermissions' },
    });
    expect(response.status).toBe(403);
  });

  it('on session creation', async () => {
    const response = await post('/api/sessions', {
      workspaceId,
      permissionMode: 'bypassPermissions',
    });
    expect(response.status).toBe(403);
  });

  it('on session update', async () => {
    const response = await patch(`/api/sessions/${sessionId}`, {
      permissionMode: 'bypassPermissions',
    });
    expect(response.status).toBe(403);
  });

  it('on submitting a run', async () => {
    const response = await post(`/api/sessions/${sessionId}/runs`, {
      prompt: 'do something',
      permissionMode: 'bypassPermissions',
    });
    expect(response.status).toBe(403);
  });

  it('on creating an automation', async () => {
    const response = await post('/api/automations', {
      workspaceId,
      name: 'Nightly',
      prompt: 'tidy up',
      trigger: { type: 'cron', expression: '0 3 * * *' },
      policy: { permissionMode: 'bypassPermissions' },
    });
    expect(response.status).toBe(403);
  });

  it('leaves every other permission mode alone', async () => {
    // The gate must be narrow. `acceptEdits` is the mode an operator reaches
    // for when prompts get tiring, and refusing it would push them toward the
    // deployment flag this check exists to protect.
    const response = await post('/api/sessions', { workspaceId, permissionMode: 'acceptEdits' });
    expect(response.status).toBe(201);
  });
});
