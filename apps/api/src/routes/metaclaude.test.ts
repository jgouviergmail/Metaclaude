/**
 * Talking to Metaclaude, through the routes.
 *
 * The conversation logic is proven in `services/steward.test.ts`. What this
 * adds is the edge: the request schema, the 202 that carries where to look,
 * the 409 for a conversation already answering, the audit line under the
 * operator's name — and that the whole thing lands in the system workspace
 * the boot prepared, not somewhere invented. The kernel's `submit` is stubbed
 * on the live instance: a test must not spawn the CLI.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE, type Run } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';
import { CONVERSATION_TITLE } from '../services/steward.js';
import { SYSTEM_AUTOMATION_NAME } from '../services/system-automation.js';

const USERNAME = 'talker';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let systemId: string;
let submitted: Array<{ sessionId: string; prompt: string }>;
let busy: Set<string>;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies, 'x-metaclaude-csrf': csrfToken },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-metaclaude-routes-'));

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

  // The steward holds the kernel by reference, so stubbing the instance's
  // methods is enough — and nothing below ever reaches a CLI.
  vi.spyOn(context.kernel, 'submit').mockImplementation(async (options) => {
    submitted.push({ sessionId: options.sessionId, prompt: options.prompt });
    return { id: `run_${submitted.length}`, sessionId: options.sessionId, status: 'queued' } as Run;
  });
  vi.spyOn(context.kernel, 'hasActiveRunForSession').mockImplementation((id) => busy.has(id));
});

beforeEach(() => {
  submitted = [];
  busy = new Set();
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('before anyone has spoken', () => {
  it('reports the system workspace and no conversation', async () => {
    const state = await get<{ workspaceId: string; session: unknown; running: boolean }>('/api/metaclaude');

    expect(state).toMatchObject({ workspaceId: systemId, session: null, running: false });
  });

  it('ships the morning review, disabled, in the system workspace', async () => {
    const automations = context.scheduler.list(systemId);

    expect(automations.map((entry) => [entry.name, entry.enabled])).toEqual([[SYSTEM_AUTOMATION_NAME, false]]);
  });
});

describe('asking', () => {
  it('starts a run in a Conversation session of the system workspace and says where', async () => {
    const response = await post('/api/metaclaude/ask', { prompt: '  How are we doing?  ' });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; workspaceId: string; sessionId: string; runId: string };
    expect(body).toMatchObject({ status: 'started', workspaceId: systemId, runId: 'run_1' });
    const session = context.sessionRepo.get(body.sessionId);
    expect(session?.workspaceId).toBe(systemId);
    expect(session?.title).toBe(CONVERSATION_TITLE);
    // Trimmed at the edge, so a stray newline never becomes a prompt of its own.
    expect(submitted).toEqual([{ sessionId: body.sessionId, prompt: 'How are we doing?' }]);

    const state = await get<{ session: { id: string } | null }>('/api/metaclaude');
    expect(state.session?.id).toBe(body.sessionId);

    const audit = context.audit.list({ action: 'metaclaude.ask' });
    expect(audit[0]).toMatchObject({ actor: USERNAME, target: body.sessionId, detail: 'run_1' });
  });

  it('refuses an empty prompt at the edge', async () => {
    const response = await post('/api/metaclaude/ask', { prompt: '   ' });

    expect(response.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  it('answers 409 with the session to open while Metaclaude is still answering', async () => {
    const first = await post('/api/metaclaude/ask', { prompt: 'one' });
    const { sessionId } = (await first.json()) as { sessionId: string };
    busy.add(sessionId);

    const second = await post('/api/metaclaude/ask', { prompt: 'two' });

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ workspaceId: systemId, sessionId });
    expect(submitted).toHaveLength(1);
  });
});
