/**
 * The steward's tools — the table, and the thin layer that binds it.
 *
 * The rules live in `services/steward.test.ts`. What is worth proving here is
 * that the table is sound (unique names, two rings, nothing irreversible has
 * crept in under a friendly name), that every tool reaches its verb with the
 * arguments reshaped as the facade expects, and that a refusal comes back as
 * a tool error the model can read rather than an exception the run swallows.
 */

import { describe, expect, it } from 'vitest';
import { StewardError } from '../services/steward.js';
import { registeredToolNames } from '../test/mcp.js';
import {
  SYSTEM_SERVER_NAME,
  SYSTEM_TOOLS,
  buildSystemServer,
  createSystemHandlers,
  systemToolNames,
  type SystemFacade,
} from './system-tools.js';

const SCOPE = { runId: 'run_1', sessionId: 'ses_1' };

/** A facade that records every call and answers with what it was asked. */
function recordingFacade(overrides: Partial<Record<keyof SystemFacade, unknown>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const facade = new Proxy({} as SystemFacade, {
    get: (_target, method: string) =>
      method in overrides
        ? overrides[method as keyof SystemFacade]
        : (...args: unknown[]) => {
            calls.push({ method, args });
            return { method, args };
          },
  });
  return { facade, calls };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as unknown;

describe('the table', () => {
  it('names every tool once, under the system_ prefix, in ring 1 or 2', () => {
    const names = SYSTEM_TOOLS.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.startsWith('system_'))).toBe(true);
    expect(SYSTEM_TOOLS.every((entry) => entry.ring === 1 || entry.ring === 2)).toBe(true);
    expect(SYSTEM_TOOLS.filter((entry) => entry.ring === 1).length).toBeGreaterThan(10);
    expect(SYSTEM_TOOLS.filter((entry) => entry.ring === 2).length).toBeGreaterThan(5);
  });

  /**
   * Ring 3 is absent by construction, and this is where "by construction" is
   * checked: no verb that deletes, purges, deploys, restores or hands out a
   * credential may appear in the table, whatever it is called.
   */
  it('carries nothing irreversible', () => {
    const forbidden = /delete|purge|remove|apply|deploy|rollback|restore|backup|token|credential|secret|vault|revoke|reset/i;

    for (const entry of SYSTEM_TOOLS) {
      expect(entry.name, entry.name).not.toMatch(forbidden);
    }
  });

  it('pre-approves exactly the table, under the names the CLI and the broker use', () => {
    const names = systemToolNames();

    expect(names).toHaveLength(SYSTEM_TOOLS.length);
    expect(names.every((name) => name.startsWith(`mcp__${SYSTEM_SERVER_NAME}__system_`))).toBe(true);
    expect(names.every((name) => /^[A-Za-z0-9_.-]+$/.test(name))).toBe(true);
  });
});

describe('the binding', () => {
  it('reaches the facade with the run as scope and returns JSON', async () => {
    const { facade, calls } = recordingFacade();
    const handlers = createSystemHandlers(facade, SCOPE);

    const result = await handlers.system_overview!({});
    expect(parse(result)).toEqual({ method: 'overview', args: [] });

    await handlers.system_run_ask!({ workspace: 'project', prompt: 'hi' });
    expect(calls.at(-1)).toEqual({ method: 'runAsk', args: [SCOPE, 'project', 'hi'] });
  });

  it('reshapes a memory write into an edit or a creation, and refuses a creation missing its parts', async () => {
    const { facade, calls } = recordingFacade();
    const handlers = createSystemHandlers(facade, SCOPE);

    await handlers.system_memory_write!({ id: 'mem_1', workspace: 'ignored', pinned: true, title: 'T' });
    expect(calls.at(-1)).toEqual({
      method: 'memoryWrite',
      args: [SCOPE, { id: 'mem_1', patch: { pinned: true, title: 'T' } }],
    });

    await handlers.system_memory_write!({ workspace: 'global', kind: 'semantic', title: 'T', content: 'C' });
    expect(calls.at(-1)).toEqual({
      method: 'memoryWrite',
      args: [SCOPE, { workspace: 'global', kind: 'semantic', title: 'T', content: 'C', tags: undefined }],
    });

    const refused = await handlers.system_memory_write!({ title: 'no workspace' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^\[refused\]/);
  });

  it('splits a session update into its id and its patch', async () => {
    const { facade, calls } = recordingFacade();
    const handlers = createSystemHandlers(facade, SCOPE);

    await handlers.system_session_update!({ id: 'ses_2', archived: true });

    expect(calls.at(-1)).toEqual({ method: 'sessionUpdate', args: [SCOPE, 'ses_2', { archived: true }] });
  });

  it('turns a refusal into a readable tool error, naming the ring', async () => {
    const { facade } = recordingFacade({
      approvalDecide: () => {
        throw new StewardError('That is the operator’s decision.', 'refused');
      },
      run: () => {
        throw new Error('database is locked');
      },
    });
    const handlers = createSystemHandlers(facade, SCOPE);

    const refused = await handlers.system_approval_decide!({ id: 'ap_1', approved: true });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe('[refused] That is the operator’s decision.');

    const crashed = await handlers.system_run!({ runId: 'run_x' });
    expect(crashed.isError).toBe(true);
    expect(crashed.content[0]!.text).toBe('database is locked');
  });

  it('awaits an asynchronous verb before answering', async () => {
    const { facade } = recordingFacade({ doctor: async () => ({ status: 'ok' }) });
    const handlers = createSystemHandlers(facade, SCOPE);

    expect(parse(await handlers.system_doctor!({}))).toEqual({ status: 'ok' });
  });

  it('builds an SDK server under the name the pre-approvals expect', () => {
    const { facade } = recordingFacade();

    const server = buildSystemServer(facade, SCOPE);

    expect(server.name).toBe(SYSTEM_SERVER_NAME);
    expect(server.type).toBe('sdk');
    // The table and the server are one module; this is the check that they
    // stayed so, in the same terms the board and advisor servers are held to.
    expect(registeredToolNames(server).sort()).toEqual(SYSTEM_TOOLS.map((entry) => entry.name).sort());
  });
});
