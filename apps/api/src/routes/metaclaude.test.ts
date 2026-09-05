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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '@metaclaude/shared';
import { CONVERSATION_TITLE } from '../services/steward.js';
import { SYSTEM_AUTOMATION_NAME } from '../services/system-automation.js';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

const USERNAME = 'talker';

let server: ServerHarness;
let systemId: string;
let submitted: Array<{ sessionId: string; prompt: string }>;
let busy: Set<string>;

beforeAll(async () => {
  server = await bootTestServer({ name: 'metaclaude-routes', username: USERNAME });
  systemId = server.context.systemWorkspace.id()!;

  // The steward holds the kernel by reference, so stubbing the instance's
  // methods is enough — and nothing below ever reaches a CLI.
  vi.spyOn(server.context.kernel, 'submit').mockImplementation(async (options) => {
    submitted.push({ sessionId: options.sessionId, prompt: options.prompt });
    return { id: `run_${submitted.length}`, sessionId: options.sessionId, status: 'queued' } as Run;
  });
  vi.spyOn(server.context.kernel, 'hasActiveRunForSession').mockImplementation((id) => busy.has(id));
});

beforeEach(() => {
  submitted = [];
  busy = new Set();
});

afterAll(async () => {
  await server?.close();
});

describe('before anyone has spoken', () => {
  it('reports the system workspace and no conversation', async () => {
    const state = await server.get<{ workspaceId: string; session: unknown; running: boolean }>('/api/metaclaude');

    expect(state).toMatchObject({ workspaceId: systemId, session: null, running: false });
  });

  it('ships the morning review, disabled, in the system workspace', async () => {
    const automations = server.context.scheduler.list(systemId);

    expect(automations.map((entry) => [entry.name, entry.enabled])).toEqual([[SYSTEM_AUTOMATION_NAME, false]]);
  });
});

describe('asking', () => {
  it('starts a run in a Conversation session of the system workspace and says where', async () => {
    const response = await server.send('POST', '/api/metaclaude/ask', { prompt: '  How are we doing?  ' });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; workspaceId: string; sessionId: string; runId: string };
    expect(body).toMatchObject({ status: 'started', workspaceId: systemId, runId: 'run_1' });
    const session = server.context.sessionRepo.get(body.sessionId);
    expect(session?.workspaceId).toBe(systemId);
    expect(session?.title).toBe(CONVERSATION_TITLE);
    // Trimmed at the edge, so a stray newline never becomes a prompt of its own.
    expect(submitted).toEqual([{ sessionId: body.sessionId, prompt: 'How are we doing?' }]);

    const state = await server.get<{ session: { id: string } | null }>('/api/metaclaude');
    expect(state.session?.id).toBe(body.sessionId);

    const audit = server.context.audit.list({ action: 'metaclaude.ask' });
    expect(audit[0]).toMatchObject({ actor: USERNAME, target: body.sessionId, detail: 'run_1' });
  });

  it('refuses an empty prompt at the edge', async () => {
    const response = await server.send('POST', '/api/metaclaude/ask', { prompt: '   ' });

    expect(response.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  it('answers 409 with the session to open while Metaclaude is still answering', async () => {
    const first = await server.send('POST', '/api/metaclaude/ask', { prompt: 'one' });
    const { sessionId } = (await first.json()) as { sessionId: string };
    busy.add(sessionId);

    const second = await server.send('POST', '/api/metaclaude/ask', { prompt: 'two' });

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ workspaceId: systemId, sessionId });
    expect(submitted).toHaveLength(1);
  });
});
