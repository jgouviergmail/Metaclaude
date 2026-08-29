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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { ApiTokenRecord } from '@metaclaude/shared';
import { buildGatewayServer, createGatewayHandlers, type GatewayDeps } from './mcp-gateway.js';

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
      // Declared, because the kernel keeps a finished run's final text only
      // for a caller that says it is coming back for it.
      awaited: true,
    });
  });

  /**
   * The other half of the same contract, and the one that leaks if it is
   * wrong: `start_run` walks away on purpose, so the kernel must keep nothing.
   * An automation polling every minute would otherwise grow the stash all day.
   */
  it('tells the kernel that start_run will not come back for the answer', async () => {
    const wired = deps();
    const handlers = createGatewayHandlers(wired, TOKEN);

    await handlers.start({ workspace: 'ws_mine', prompt: 'long job' });

    expect(wired.kernel.startForToken).toHaveBeenCalledWith(
      expect.objectContaining({ awaited: false }),
    );
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

  /**
   * The other side of the timeout branch, and the reason it is not a bare
   * `catch`. A wait that fails for any other reason — the kernel shutting down,
   * a stash discarded — is a failure, and calling it "still running" would send
   * the caller polling a run that will never answer.
   */
  it('does not dress a genuine failure up as work in progress', async () => {
    const wired = deps({
      kernel: {
        startForToken: vi.fn(async () => ({
          run: { id: 'run_x', status: 'running' },
          sessionId: 'ses_1',
        })),
        awaitRun: vi.fn(async () => {
          throw new Error('The server is shutting down.');
        }),
      },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, TOKEN);

    await expect(handlers.ask({ workspace: 'ws_mine', prompt: 'x' })).rejects.toThrow(
      /shutting down/i,
    );
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

/**
 * The input schemas are enforced by the agent SDK, not by this code.
 *
 * That is the trap CLAUDE.md names about edge schemas, seen from the other
 * side: every handler test below calls the handlers directly, so a schema that
 * silently stopped validating would break nothing here — while a caller could
 * push a megabyte of prompt straight into a run. When a dependency decides
 * what may be submitted, test the dependency's decision.
 */
describe('what the protocol refuses before a handler ever runs', () => {
  const connect = async (wired: GatewayDeps) => {
    const server = buildGatewayServer(wired, TOKEN).instance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'outside', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  };

  it('rejects an oversized prompt without reaching the kernel', async () => {
    const wired = deps();
    const client = await connect(wired);

    const result = (await client.callTool({
      name: 'ask_workspace',
      arguments: { workspace: 'mine', prompt: 'x'.repeat(30_000) },
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/too_big|Too big/);
    // The point: no run was started. A prompt that fails validation must cost
    // nothing at all.
    expect(wired.kernel.startForToken).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects a missing argument and an out-of-range one', async () => {
    const wired = deps();
    const client = await connect(wired);

    const missing = (await client.callTool({
      name: 'ask_workspace',
      arguments: { workspace: 'mine' },
    })) as { isError?: boolean };
    expect(missing.isError).toBe(true);

    const tooMany = (await client.callTool({
      name: 'search_notes',
      arguments: { workspace: 'mine', query: 'x', limit: 999 },
    })) as { isError?: boolean };
    expect(tooMany.isError).toBe(true);

    expect(wired.knowledge.search).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('run_status', () => {
  const finished = (overrides = {}) =>
    ({
      id: 'run_1',
      workspaceId: 'ws_mine',
      status: 'succeeded',
      error: null,
      startedAt: 1,
      finishedAt: 2,
      ...overrides,
    }) as never;

  /**
   * The half `start_run` was missing. Without this, an asynchronous call
   * returned an id that nothing could ever redeem: the run's final text lives
   * in the transcript, and no tool read it.
   */
  it('reads a finished run’s answer back out of the transcript', async () => {
    const wired = deps({
      runs: { get: vi.fn(() => finished()) },
      transcript: {
        byRun: vi.fn(() => [
          { kind: 'assistant_text', text: 'first thought' },
          { kind: 'tool_call', name: 'Bash' },
          { kind: 'assistant_text', text: 'the answer' },
        ]),
      },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, TOKEN);

    const result = await handlers.status({ runId: 'run_1' });

    expect(result.status).toBe('succeeded');
    // The *last* assistant block, not the first: everything before it is the
    // agent thinking aloud on the way there.
    expect(result.text).toBe('the answer');
  });

  it('says a run is still working rather than inventing an answer', async () => {
    const wired = deps({
      runs: { get: vi.fn(() => finished({ status: 'running', finishedAt: null })) },
      transcript: { byRun: vi.fn(() => []) },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, TOKEN);

    const result = await handlers.status({ runId: 'run_1' });

    expect(result.status).toBe('running');
    expect(result.text).toBeNull();
  });

  /**
   * A run id is not a capability. Anyone holding a token could otherwise
   * enumerate ids and read work done in a workspace they were never given —
   * and the answer must not distinguish "not yours" from "does not exist".
   */
  it('refuses a run in a workspace this token cannot reach', async () => {
    const wired = deps({
      runs: { get: vi.fn(() => finished({ workspaceId: 'ws_theirs' })) },
      transcript: { byRun: vi.fn(() => []) },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, TOKEN);

    await expect(handlers.status({ runId: 'run_1' })).rejects.toThrow(/no run/i);
    await expect(handlers.status({ runId: 'run_1' })).rejects.not.toThrow(/permission|scope|allowed/i);
  });

  it('answers the same way for a run that does not exist at all', async () => {
    const wired = deps({
      runs: { get: vi.fn(() => null) },
      transcript: { byRun: vi.fn(() => []) },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, TOKEN);

    await expect(handlers.status({ runId: 'run_nope' })).rejects.toThrow(/no run/i);
  });

  it('needs the run capability, since it reads what a run produced', async () => {
    const wired = deps({
      runs: { get: vi.fn(() => finished()) },
      transcript: { byRun: vi.fn(() => []) },
    } as unknown as Partial<GatewayDeps>);
    const handlers = createGatewayHandlers(wired, { ...TOKEN, scopes: ['read'] });

    await expect(handlers.status({ runId: 'run_1' })).rejects.toThrow(/not allowed to start runs/i);
  });
});

describe('search_notes', () => {
  /**
   * Named here because the answer is not the obvious one: the store returns
   * that workspace *plus* the global shelf, which is what a run there would
   * read. An earlier version of this test claimed "never the whole shelf",
   * which was wrong in the direction that matters — a token granted `read` on
   * one project can reach anything filed globally.
   */
  it('asks for exactly what a run in that workspace would see', async () => {
    const wired = deps();
    const handlers = createGatewayHandlers(wired, TOKEN);

    await handlers.searchNotes({ workspace: 'ws_mine', query: 'deployment' });

    expect(wired.knowledge.search).toHaveBeenCalledWith(
      'deployment',
      expect.objectContaining({ workspaceId: 'ws_mine' }),
    );
  });
});
