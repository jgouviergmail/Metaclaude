/**
 * The gateway's tools — what an outside program can actually reach.
 *
 * These are handler tests rather than protocol tests: the transport is the
 * SDK's and is exercised end to end in `routes/gateway.test.ts`. What lives
 * here is the part nobody else can check — that a token's scope is enforced on
 * *every* path into the application, not on the one the author was thinking
 * about.
 *
 * The shape of every test is the same, and it is deliberate: ask for something
 * outside the token's reach, and require the answer to be indistinguishable
 * from asking for something that does not exist. A gateway that says "that
 * workspace exists but is not yours" has already leaked the deployment's map.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ApiTokenRecord } from '@metaclaude/shared';
import { createGatewayHandlers, type GatewayDeps } from './mcp-gateway.js';

const TOKEN: ApiTokenRecord = {
  id: 'tok_1',
  name: 'n8n',
  scopes: ['run', 'read'],
  workspaceIds: ['ws_mine'],
  ceiling: 'dontAsk',
  createdBy: 'jules',
  createdAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  lastUsedAt: null,
  revokedAt: null,
  hint: 'mck_tok_01',
};

const workspace = (id: string, slug: string) =>
  ({ id, slug, name: slug, settings: {} }) as never;

function deps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    workspaces: {
      list: vi.fn(() => [workspace('ws_mine', 'mine'), workspace('ws_theirs', 'theirs')]),
      get: vi.fn((id: string) =>
        id === 'ws_mine' || id === 'ws_theirs' ? workspace(id, id.slice(3)) : null,
      ),
    },
    kernel: {
      startForToken: vi.fn(async () => ({
        run: { id: 'run_1', status: 'running' },
        sessionId: 'ses_1',
      })),
      awaitRun: vi.fn(async () => ({
        run: { id: 'run_1', status: 'succeeded', error: null },
        finalText: 'Done.',
      })),
    },
    knowledge: { search: vi.fn(async () => []) },
    board: { list: vi.fn(() => []) },
    audit: { record: vi.fn() },
    ...overrides,
  } as unknown as GatewayDeps;
}

describe('list_workspaces', () => {
  it('lists only what the token reaches', async () => {
    const handlers = createGatewayHandlers(deps(), TOKEN);

    const listed = await handlers.listWorkspaces();

    expect(listed.map((one) => one.id)).toEqual(['ws_mine']);
  });
});

describe('scope', () => {
  /**
   * Every tool that names a workspace goes through the same check, so the test
   * goes through every tool. A new tool that forgets it is exactly the bug
   * this file exists to catch, which is why this is a loop and not four
   * separate cases that a fifth tool can quietly sit beside.
   */
  const asking: Array<[string, (h: ReturnType<typeof createGatewayHandlers>) => Promise<unknown>]> =
    [
      ['ask', (h) => h.ask({ workspace: 'ws_theirs', prompt: 'hello' })],
      ['start', (h) => h.start({ workspace: 'ws_theirs', prompt: 'hello' })],
      ['searchNotes', (h) => h.searchNotes({ workspace: 'ws_theirs', query: 'x' })],
      ['listTasks', (h) => h.listTasks({ workspace: 'ws_theirs' })],
    ];

  for (const [name, call] of asking) {
    it(`${name} refuses a workspace outside the token, as if it did not exist`, async () => {
      const handlers = createGatewayHandlers(deps(), TOKEN);

      await expect(call(handlers)).rejects.toThrow(/no workspace/i);
      // And says nothing that distinguishes it from an unknown id.
      await expect(call(handlers)).rejects.not.toThrow(/permission|scope|allowed|forbidden/i);
    });
  }

  it('accepts a workspace by slug as well as by id — an agent speaks names', async () => {
    const handlers = createGatewayHandlers(deps(), TOKEN);

    await expect(handlers.ask({ workspace: 'mine', prompt: 'hello' })).resolves.toBeDefined();
  });
});

describe('capabilities', () => {
  it('refuses to run at all without the run scope', async () => {
    const handlers = createGatewayHandlers(deps(), { ...TOKEN, scopes: ['read'] });

    await expect(handlers.ask({ workspace: 'ws_mine', prompt: 'hi' })).rejects.toThrow(
      /not allowed to start runs/i,
    );
  });

  it('refuses to read without the read scope', async () => {
    const handlers = createGatewayHandlers(deps(), { ...TOKEN, scopes: ['run'] });

    await expect(handlers.searchNotes({ workspace: 'ws_mine', query: 'x' })).rejects.toThrow(
      /not allowed to read/i,
    );
  });
});

describe('ask', () => {
  it('carries the token’s ceiling and name into the run', async () => {
    const wired = deps();
    const handlers = createGatewayHandlers(wired, TOKEN);

    await handlers.ask({ workspace: 'ws_mine', prompt: 'summarise the repo' });

    expect(wired.kernel.startForToken).toHaveBeenCalledWith({
      workspaceId: 'ws_mine',
      prompt: 'summarise the repo',
      ceiling: 'dontAsk',
      label: 'n8n',
    });
  });

  /**
   * A run that outlives the wait is still running. Saying "it failed" would be
   * false, and saying nothing would leave the caller with no way back to it —
   * so the id is part of the timeout.
   */
  it('reports a timeout as unfinished work, with the run id to follow up on', async () => {
    const wired = deps({
      kernel: {
        startForToken: vi.fn(async () => ({
          run: { id: 'run_slow', status: 'running' },
          sessionId: 'ses_1',
        })),
        awaitRun: vi.fn(async () => {
          throw new Error('The delegated run did not finish in time.');
        }),
      },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, TOKEN);

    const result = await handlers.ask({ workspace: 'ws_mine', prompt: 'long one' });

    expect(result.status).toBe('running');
    expect(result.runId).toBe('run_slow');
    expect(result.text).toMatch(/still running/i);
  });

  it('records every run it starts in the audit trail, under the token', async () => {
    const wired = deps();
    const handlers = createGatewayHandlers(wired, TOKEN);

    await handlers.ask({ workspace: 'ws_mine', prompt: 'do the thing' });

    expect(wired.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'token:n8n', action: 'gateway.run' }),
    );
  });
});

describe('search_notes', () => {
  it('scopes the search to the named workspace, never the whole shelf', async () => {
    const wired = deps();
    const handlers = createGatewayHandlers(wired, TOKEN);

    await handlers.searchNotes({ workspace: 'ws_mine', query: 'deployment' });

    expect(wired.knowledge.search).toHaveBeenCalledWith(
      'deployment',
      expect.objectContaining({ workspaceId: 'ws_mine' }),
    );
  });
});
