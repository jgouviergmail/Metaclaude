/**
 * The system workspace, through the routes.
 *
 * `services/system-workspace.test.ts` proves the guard refuses the right
 * patches. What it cannot prove is that the routes *call* it, that a refusal
 * reaches the client as a 409 rather than a 500, and that the two places the
 * interface asks "which one is it?" agree. Same lesson as the edge-schema
 * trap: a guard that is tested below the route is not yet a guard.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE, type SystemHealth, type Workspace } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';
import { systemToolNames } from '../kernel/system-tools.js';
import { SYSTEM_WORKSPACE_SAFETY } from '../services/system-workspace.js';

const USERNAME = 'steward-keeper';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let systemId: string;

function send(method: 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      // Fastify answers 400 to a JSON content type over an empty body, so the
      // header only travels with one.
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function stored(): Promise<Workspace> {
  const body = await get<{ workspace: Workspace }>(`/api/workspaces/${systemId}`);
  return body.workspace;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-sysws-routes-'));

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

  systemId = context.systemWorkspace.id()!;
  expect(systemId).toBeTruthy();
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('finding it', () => {
  it('exists after boot, listed among the workspaces and named in the list', async () => {
    const body = await get<{ workspaces: Workspace[]; systemWorkspaceId: string | null }>(
      '/api/workspaces',
    );

    expect(body.systemWorkspaceId).toBe(systemId);
    const workspace = body.workspaces.find((entry) => entry.id === systemId);
    expect(workspace?.name).toBe('Metaclaude');
    expect(workspace?.settings.disallowedTools).toEqual(SYSTEM_WORKSPACE_SAFETY.disallowedTools);
    // Pre-approved by exact name, the whole table and nothing else.
    expect(workspace?.settings.allowedTools).toEqual(systemToolNames());
  });

  it('says so on its own detail, which is what locks the settings dialog', async () => {
    const detail = await get<{ isSystem: boolean }>(`/api/workspaces/${systemId}`);

    expect(detail.isSystem).toBe(true);
  });

  it('is the same one the system health names', async () => {
    const health = await get<SystemHealth>('/api/system');

    expect(health.systemWorkspaceId).toBe(systemId);
  });
});

describe('what an operator may still change', () => {
  /** What the settings modal actually sends: the whole object, one field changed. */
  it('accepts the whole settings object back with the fixed values untouched', async () => {
    const before = await stored();

    const response = await send('PATCH', `/api/workspaces/${systemId}`, {
      settings: { ...before.settings, memoryEnabled: false },
    });

    expect(response.status).toBe(200);
    expect((await stored()).settings.memoryEnabled).toBe(false);
  });

  it('accepts a rename, a description and the ordinary settings', async () => {
    const response = await send('PATCH', `/api/workspaces/${systemId}`, {
      name: 'Le Second',
      description: 'Mon second quand je n’ai pas le temps',
      settings: { language: 'fr', defaultModel: 'sonnet' },
    });

    expect(response.status).toBe(200);
    const workspace = await stored();
    expect(workspace.name).toBe('Le Second');
    expect(workspace.settings.language).toBe('fr');
    expect(workspace.settings.defaultModel).toBe('sonnet');
  });
});

describe('what it refuses', () => {
  it('answers 409 to archiving, and the workspace stays live', async () => {
    const response = await send('PATCH', `/api/workspaces/${systemId}`, { archived: true });

    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    expect(error).toMatch(/system workspace/i);
    expect((await stored()).archived).toBe(false);
  });

  it.each([
    ['defaultPermissionMode', { defaultPermissionMode: 'auto' }],
    ['allowedTools', { allowedTools: ['WebFetch'] }],
    ['disallowedTools', { disallowedTools: [] }],
    ['additionalDirectories', { additionalDirectories: ['/srv/metaclaude/workspaces/other'] }],
  ])('answers 409 to a patch naming %s, and stores nothing', async (_name, settings) => {
    const before = (await stored()).settings;

    const response = await send('PATCH', `/api/workspaces/${systemId}`, { settings });

    expect(response.status).toBe(409);
    expect((await stored()).settings).toEqual(before);
  });

  /**
   * The mixed case is the one a form produces: an ordinary field beside a
   * guarded one. The whole patch is refused — a partial apply would tell the
   * operator the save worked and quietly drop the half that mattered.
   */
  it('refuses the whole patch when a guarded setting rides with an ordinary one', async () => {
    const response = await send('PATCH', `/api/workspaces/${systemId}`, {
      description: 'never stored',
      settings: { language: 'en', allowedTools: ['WebSearch'] },
    });

    expect(response.status).toBe(409);
    const workspace = await stored();
    expect(workspace.description).not.toBe('never stored');
    expect(workspace.settings.language).toBe('fr');
  });

  it('answers 409 to deletion, with or without purge, and the directory survives', async () => {
    for (const query of ['', '?purge=true']) {
      const response = await send('DELETE', `/api/workspaces/${systemId}${query}`);
      expect(response.status).toBe(409);
    }

    const body = await get<{ workspaces: Workspace[] }>('/api/workspaces');
    expect(body.workspaces.some((entry) => entry.id === systemId)).toBe(true);
    expect(context.workspaceRepo.get(systemId)).not.toBeNull();
  });
});
