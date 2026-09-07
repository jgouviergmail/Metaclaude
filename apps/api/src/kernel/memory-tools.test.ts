/**
 * The agent's own memory, and the fence around it.
 *
 * What is worth holding here is not that a write reaches the store — the
 * forwarding test derives that from the schema — but the scope: every id the
 * agent names has to resolve inside its own workspace, and a memory belonging
 * to another workspace must answer exactly like one that does not exist.
 * Anything less turns "search your memory" into a way to read someone else's.
 *
 * The global tier is the case that is easy to get wrong: those rows *are*
 * recalled here, so "I can see it" feels like "I can edit it". They are the
 * operator's, because editing one changes what every other workspace recalls.
 */

import type { Memory } from '@metaclaude/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { registeredToolNames } from '../test/mcp.js';
import {
  MEMORY_TOOL_CATALOGUE,
  buildMemoryServer,
  createMemoryHandlers,
  memoryToolNames,
  type WorkspaceMemoryFacade,
} from './memory-tools.js';

const WS = 'ws_1';
const RUN = 'run_1';

const row = (over: Partial<Memory> = {}): Memory =>
  ({
    id: 'mem_1',
    workspaceId: WS,
    kind: 'semantic',
    shelf: 'durable',
    title: 'A fact',
    content: 'Something durable.',
    tags: [],
    confidence: 0.7,
    pinned: false,
    ...over,
  }) as unknown as Memory;

interface Call {
  method: string;
  args: unknown[];
}

let calls: Call[];
let rows: Map<string, Memory>;
let store: WorkspaceMemoryFacade;

beforeEach(() => {
  calls = [];
  rows = new Map([
    ['mem_1', row()],
    ['mem_other', row({ id: 'mem_other', workspaceId: 'ws_2' })],
    ['mem_global', row({ id: 'mem_global', workspaceId: null })],
  ]);
  store = {
    search: async (query, options) => {
      calls.push({ method: 'search', args: [query, options] });
      return [{ memory: row(), score: 0.9 }] as never;
    },
    get: (id) => rows.get(id) ?? null,
    remember: async (input) => {
      calls.push({ method: 'remember', args: [input] });
      return { memory: row({ id: 'mem_new', title: input.title }), merged: false };
    },
    update: async (id, patch) => {
      calls.push({ method: 'update', args: [id, patch] });
      return row({ id, ...(patch as Partial<Memory>) });
    },
    retire: (id, options) => {
      calls.push({ method: 'retire', args: [id, options] });
      return row({ id });
    },
  };
});

const handlers = () => createMemoryHandlers(store, { workspaceId: WS, runId: RUN });

describe('the fence around a workspace memory', () => {
  it('refuses a memory of another workspace exactly as it refuses one that does not exist', async () => {
    await expect(handlers().write({ id: 'mem_other', title: 'x' })).rejects.toThrow(
      'No such memory in this workspace: mem_other',
    );
    await expect(handlers().write({ id: 'mem_absent', title: 'x' })).rejects.toThrow(
      'No such memory in this workspace: mem_absent',
    );
    // Nothing reached the store: the guard runs before the write.
    expect(calls).toHaveLength(0);
  });

  it('refuses a global memory, which this workspace recalls but does not own', async () => {
    // Promoting or editing a global changes what *every* workspace recalls,
    // and that consequence is invisible from inside one of them.
    await expect(handlers().write({ id: 'mem_global', content: 'x' })).rejects.toThrow(
      'No such memory in this workspace',
    );
    expect(() => handlers().forget({ id: 'mem_global' })).toThrow('No such memory in this workspace');
  });

  it('scopes every search to this workspace, whatever the agent asks for', async () => {
    await handlers().search({ query: 'the boy' });
    expect(calls[0]?.args[1]).toEqual({ workspaceId: WS, limit: 8 });
  });
});

describe('writing a memory', () => {
  it('records the run that wrote it, so the page can say where it came from', async () => {
    await handlers().write({ kind: 'semantic', title: 'T', content: 'C.' });
    expect((calls[0]?.args[0] as { sourceRunId: string }).sourceRunId).toBe(RUN);
    expect((calls[0]?.args[0] as { workspaceId: string }).workspaceId).toBe(WS);
  });

  it('refuses a creation missing a part rather than storing half of one', async () => {
    await expect(handlers().write({ title: 'T' })).rejects.toThrow(
      'A new memory needs kind, title and content.',
    );
    expect(calls).toHaveLength(0);
  });

  it('edits by id, sending only the fields the agent actually named', async () => {
    // A patch that carries every field at its default would reset the ones the
    // agent never mentioned — the `.partial()` trap, from the other side.
    await handlers().write({ id: 'mem_1', content: 'Corrected.' });
    expect(calls[0]).toEqual({ method: 'update', args: ['mem_1', { content: 'Corrected.' }] });
  });

  it('retires what it supersedes, pointing the old row at the new one', async () => {
    await handlers().write({ kind: 'semantic', title: 'Now', content: 'C.', supersedes: 'mem_1' });
    expect(calls.map((call) => call.method)).toEqual(['remember', 'retire']);
    expect(calls[1]?.args).toEqual(['mem_1', { supersededBy: 'mem_new' }]);
  });

  it('will not supersede a memory of another workspace', async () => {
    await expect(
      handlers().write({ kind: 'semantic', title: 'Now', content: 'C.', supersedes: 'mem_other' }),
    ).rejects.toThrow('No such memory in this workspace');
  });
});

describe('the catalogue', () => {
  /**
   * The catalogue is what a workspace pre-approves; the server is what the run
   * can call. A name in one and not the other is either a pre-approval of
   * nothing or an approval card the operator was promised they would not see.
   */
  it('registers exactly the catalogue, under the names the pre-approvals use', () => {
    const server = buildMemoryServer(store, { workspaceId: WS, runId: RUN });

    expect(registeredToolNames(server).sort()).toEqual(
      MEMORY_TOOL_CATALOGUE.map((entry) => entry.name).sort(),
    );
    expect(memoryToolNames()).toEqual(
      MEMORY_TOOL_CATALOGUE.map((entry) => `mcp__metaclaude_memory__${entry.name}`),
    );
    expect(MEMORY_TOOL_CATALOGUE.filter((entry) => entry.ring === 1).map((entry) => entry.name)).toEqual([
      'memory_search',
    ]);
  });
});
