/**
 * Every field a tool's schema accepts reaches the code that acts on it.
 *
 * `system_memory_write` declared `confidence` and `pinned`, the store took
 * both, and the two links between them each forwarded a hand-picked subset
 * — so a memory asked for as pinned at 1 came back unpinned at 0.7, with no
 * error, and only the steward noticed. A per-tool test cannot prevent the
 * next one of those: the field that is dropped is the field nobody thought
 * to assert. So this file derives the check from the schemas themselves.
 *
 * For each in-process MCP server, every registered tool is called with an
 * argument object that fills *every* field of its input schema with a
 * distinctive value, against a facade that records what it is asked. Each
 * leaf value must then be found somewhere in what the facade received.
 * Renaming is fine (`taskId` → positional `id`); dropping is not, unless the
 * drop is listed below with its reason — and a listed drop that stops
 * happening fails too, so the list cannot go stale.
 */

import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ApiTokenRecord, BoardTask, Memory, Run, Session } from '@metaclaude/shared';
import { describe, expect, it } from 'vitest';
import { buildGatewayServer, type GatewayDeps } from '../services/mcp-gateway.js';
import { buildAdvisorServer, type AdvisorFacade } from './advisor-tools.js';
import { buildBoardServer, type BoardFacade } from './board-tools.js';
import { buildMemoryServer, type WorkspaceMemoryFacade } from './memory-tools.js';
import { buildSessionsServer, type SessionsFacade } from './sessions-tools.js';
import { buildSystemServer, type SystemFacade } from './system-tools.js';

/* -------------------------------------------------------------------------- */
/* Arguments from a schema                                                    */
/* -------------------------------------------------------------------------- */

interface ZodDefLike {
  type: string;
  innerType?: unknown;
  in?: unknown;
  shape?: Record<string, unknown>;
  element?: unknown;
  options?: unknown[];
  entries?: Record<string, string>;
  values?: unknown[];
  valueType?: unknown;
  checks?: Array<{ _zod: { def: Record<string, unknown> } }>;
}

const defOf = (schema: unknown): ZodDefLike =>
  ((schema as { def?: ZodDefLike; _def?: ZodDefLike }).def ??
    (schema as { _def: ZodDefLike })._def) as ZodDefLike;

const clamp = (value: number, min: number | undefined, max: number | undefined): number =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/** A value for `schema` that is unmistakable in a recording, and valid. */
function sample(schema: unknown, key: string): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return sample(def.innerType, key);
    case 'pipe':
      return sample(def.in, key);
    case 'string': {
      const max = def.checks?.find((c) => c._zod.def.check === 'max_length')?._zod.def.maximum as
        | number
        | undefined;
      const value = `sentinel_${key}`;
      return max !== undefined && value.length > max ? value.slice(0, max) : value;
    }
    case 'number': {
      const checks = def.checks ?? [];
      const isInt = checks.some((c) => c._zod.def.check === 'number_format');
      const min = checks.find((c) => c._zod.def.check === 'greater_than')?._zod.def.value as number | undefined;
      const max = checks.find((c) => c._zod.def.check === 'less_than')?._zod.def.value as number | undefined;
      return isInt ? clamp(7, min, max) : clamp(0.37, min, max);
    }
    case 'boolean':
      return true;
    case 'enum':
      return Object.values(def.entries ?? {})[0];
    case 'literal':
      return def.values?.[0];
    case 'array':
      return [sample(def.element, key)];
    case 'object':
      return Object.fromEntries(Object.entries(def.shape ?? {}).map(([k, v]) => [k, sample(v, k)]));
    case 'union':
      return sample(def.options?.[0], key);
    case 'record':
      return { [`key_${key}`]: sample(def.valueType, key) };
    case 'null':
      return null;
    case 'any':
    case 'unknown':
      return `sentinel_${key}`;
    default:
      throw new Error(`tool-forwarding: no sample for zod type "${def.type}" (field ${key})`);
  }
}

/** Every primitive in `value`, with the path it sits at. */
function leaves(value: unknown, path = ''): Array<{ path: string; value: unknown }> {
  if (value === null || typeof value !== 'object') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, path ? `${path}.${k}` : k),
  );
}

/* -------------------------------------------------------------------------- */
/* Recording facades                                                          */
/* -------------------------------------------------------------------------- */

interface Recorder {
  calls: Array<{ method: string; args: unknown[] }>;
  received(): Set<unknown>;
}

/**
 * A facade whose every method records its arguments. `answers` supplies the
 * few methods whose *return value* a handler inspects before it forwards
 * anything — the board handlers look a card up and check its workspace
 * before they update it, so `get` has to answer with a card in scope.
 */
function recorder<T extends object>(answers: Partial<Record<keyof T, (...args: unknown[]) => unknown>> = {}) {
  const calls: Recorder['calls'] = [];
  const facade = new Proxy({} as T, {
    get: (_target, method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        const answer = answers[method as keyof T];
        return answer ? answer(...args) : { method, args };
      },
  });
  const received = () => new Set(leaves(calls.map((call) => call.args)).map((leaf) => leaf.value));
  return { facade, calls, received };
}

type Server = ReturnType<typeof createSdkMcpServer>;
type Registered = Record<string, { inputSchema: unknown; handler: (args: unknown, extra: unknown) => Promise<unknown> }>;

const registered = (server: Server): Registered => {
  const table = (server.instance as unknown as { _registeredTools?: Registered })._registeredTools;
  if (!table) throw new Error('McpServer no longer exposes _registeredTools');
  return table;
};

/* -------------------------------------------------------------------------- */
/* The rule                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Drops that are the design, by tool and leaf path, each with its reason. A
 * new entry here needs the same scrutiny as a new `eslint-disable`.
 */
const RESOLVED_SLUG = 'the gateway resolves a slug to an id through workspaces.list before forwarding';
const ACCEPTED_DROPS: Record<string, Record<string, string>> = {
  system_memory_write: {
    // With `id` set the call is an edit, and a memory does not move tiers by
    // being edited: `system_memory_scope` does that, audited as a move.
    workspace: 'an edit keeps the memory where it is; moving is system_memory_scope',
  },
  session_list: {
    // Applied in the handler, not by the facade, and deliberately: the match
    // folds accents so `Évaluation` is findable typed `evaluation`, which
    // SQLite's LIKE does not do. What the check would otherwise be protecting
    // — that the filter is not applied to an already-capped page — has its own
    // case in `sessions-tools.test.ts`.
    query: 'folded and matched in the handler; the facade is asked for the whole set',
    // With a query, `limit` bounds the *answer* rather than the search: the
    // facade is asked for the searchable set and the cap is applied to what
    // matched. Without a query it is forwarded untouched, which the "without
    // query" variant exercises.
    limit: 'with a query it caps the matches, not the rows the facade returns',
  },
  /*
   * `session_read` composes rather than forwards: the facade hands back
   * events, and the three narrowing arguments shape what is made of them.
   * Each is covered where the guarantee actually lives — this check would
   * only be re-asking whether a number was passed along unchanged, and for
   * `sinceHours` it is not: it becomes an absolute instant first.
   */
  session_read: {
    sinceHours: 'converted to an absolute `since` before the facade; asserted in sessions-tools.test.ts',
    tools: 'consumed by the transcript view, not the facade; asserted in sessions-tools.test.ts',
    maxChars: 'consumed by the transcript view, not the facade; asserted in sessions-tools.test.ts',
  },
  ask_workspace: { workspace: RESOLVED_SLUG },
  start_run: { workspace: RESOLVED_SLUG },
  search_notes: { workspace: RESOLVED_SLUG },
  list_tasks: { workspace: RESOLVED_SLUG },
};

/**
 * The argument sets a tool is driven with: every field, then every field
 * but one optional, for each optional. The second family is what finds the
 * original defect — with `id` present `system_memory_write` is an *edit*,
 * which spreads its arguments whole; only the call without `id` reaches the
 * creation branch that hand-picked four fields of six. A generic check that
 * fills every field exercises exactly one branch of every tool, and the
 * branch it misses is the one behind an optional.
 */
function variants(tool: Registered[string], name: string): Array<{ label: string; args: Record<string, unknown> }> {
  const all = sample(tool.inputSchema, name) as Record<string, unknown>;
  const shape = defOf(tool.inputSchema).shape ?? {};
  const optionals = Object.entries(shape)
    .filter(([, field]) => ['optional', 'default'].includes(defOf(field).type))
    .map(([key]) => key);
  return [
    { label: 'every field', args: all },
    ...optionals.map((key) => {
      const { [key]: _omitted, ...rest } = all;
      return { label: `without ${key}`, args: rest };
    }),
  ];
}

async function assertForwards(
  name: string,
  tool: Registered[string],
  facade: { received(): Set<unknown>; calls: Recorder['calls'] },
): Promise<void> {
  const accepted = ACCEPTED_DROPS[name] ?? {};
  const observedDrops = new Set<string>();
  let reached = 0;

  for (const variant of variants(tool, name)) {
    facade.calls.length = 0;
    await tool.handler(variant.args, {});
    // A variant the handler refuses before touching the facade — a creation
    // missing a required part — proves nothing about forwarding; skip it,
    // but every tool must reach its facade in at least one variant.
    if (facade.calls.length === 0) continue;
    reached += 1;

    const received = facade.received();
    const dropped = leaves(variant.args)
      .filter((leaf) => !received.has(leaf.value))
      .map((leaf) => leaf.path);
    for (const path of dropped) observedDrops.add(path);
    const unexpected = dropped.filter((path) => !(path in accepted));
    expect(
      unexpected,
      `${name} (${variant.label}): accepted by the schema, never forwarded: ${unexpected.join(', ')}`,
    ).toEqual([]);
  }

  expect(reached, `${name}: no variant reached the facade`).toBeGreaterThan(0);
  const stale = Object.keys(accepted).filter((path) => !observedDrops.has(path));
  expect(stale, `${name}: listed as a deliberate drop but forwarded now — remove the entry`).toEqual([]);
}

describe('every field a tool accepts reaches its facade', () => {
  it('holds for the system tools', async () => {
    const rec = recorder<SystemFacade>();
    const tools = registered(buildSystemServer(rec.facade, { runId: 'run_1', sessionId: 'ses_1' }));
    expect(Object.keys(tools).length).toBeGreaterThan(20);
    for (const [name, tool] of Object.entries(tools)) await assertForwards(name, tool, rec);
  });

  it('holds for the board tools', async () => {
    const scope = { workspaceId: 'ws_1', runId: 'run_1' };
    const card = (id: unknown): BoardTask =>
      ({
        id: String(id),
        workspaceId: scope.workspaceId,
        title: 'card',
        description: '',
        status: 'todo',
        priority: 'medium',
        assignee: 'agent',
        parentId: null,
        blockedReason: null,
        dueAt: null,
        position: 0,
        createdAt: 0,
        updatedAt: 0,
        archivedAt: null,
      }) as unknown as BoardTask;
    const rec = recorder<BoardFacade>({
      get: (id) => card(id),
      create: (input) => card((input as { title: string }).title),
      update: (id) => card(id),
      move: (id) => card(id),
      list: () => [],
      children: () => [],
      comments: () => [],
    });
    const tools = registered(buildBoardServer(rec.facade, scope));
    expect(Object.keys(tools).length).toBe(7);
    for (const [name, tool] of Object.entries(tools)) await assertForwards(name, tool, rec);
  });

  it('holds for the workspace memory tools', async () => {
    // `get` answers for any id, and always inside this workspace: the scope
    // guard runs before every write, so a recorder that refuses would keep
    // each handler from ever reaching the facade.
    const mem = (id: unknown): Memory =>
      ({
        id: String(id),
        workspaceId: 'ws_1',
        kind: 'semantic',
        shelf: 'durable',
        title: 'm',
        content: 'c',
        tags: [],
        confidence: 0.7,
        pinned: false,
      }) as unknown as Memory;
    const rec = recorder<WorkspaceMemoryFacade>({
      get: (id) => mem(id),
      search: async () => [],
      remember: async (input) => ({ memory: mem((input as { title: string }).title), merged: false }),
      update: async (id) => mem(id),
      retire: (id) => mem(id),
    });
    const tools = registered(buildMemoryServer(rec.facade, { workspaceId: 'ws_1', runId: 'run_1' }));
    expect(Object.keys(tools).length).toBe(3);
    for (const [name, tool] of Object.entries(tools)) await assertForwards(name, tool, rec);
  });

  /**
   * The sessions tools, whose every argument narrows a read.
   *
   * `sinceHours`, `tools` and `maxChars` each change what comes back, and each
   * is exactly the kind of field that gets declared on a schema and dropped by
   * a handler that forwards a hand-picked subset — which is how
   * `system_memory_write` lost `pinned` and `confidence`, silently, for a
   * release. Every id resolves inside `ws_1` because the scope guard runs
   * before the facade is reached at all.
   */
  it('holds for the sessions tools', async () => {
    const session = (id: unknown): Session =>
      ({ id: String(id), workspaceId: 'ws_1', title: 't', archived: false, runCount: 1,
         totalCostUsd: 0, lastActivityAt: 0, status: 'idle' }) as unknown as Session;
    const rec = recorder<SessionsFacade>({
      listSessions: () => [],
      getSession: (id) => session(id),
      getRun: (id) =>
        ({ id: String(id), workspaceId: 'ws_1', sessionId: 'ses_1', prompt: 'p', status: 'succeeded',
           triggeredBy: 'user', error: null, startedAt: 0, finishedAt: 1 }) as unknown as Run,
      sessionEvents: () => [],
      runEvents: () => [],
    });
    const tools = registered(
      buildSessionsServer(rec.facade, { workspaceId: 'ws_1', sessionId: 'ses_1' }),
    );
    expect(Object.keys(tools).length).toBe(3);
    for (const [name, tool] of Object.entries(tools)) await assertForwards(name, tool, rec);
  });

  it('holds for the proposal tools', async () => {
    const rec = recorder<AdvisorFacade>();
    const tools = registered(buildAdvisorServer(rec.facade, { workspaceId: 'ws_1', runId: 'run_1' }));
    expect(Object.keys(tools).length).toBe(5);
    for (const [name, tool] of Object.entries(tools)) await assertForwards(name, tool, rec);
  });

  /**
   * The gateway's dependencies are nested and its handlers read what they
   * return before forwarding — a workspace must resolve, a run must exist —
   * so the recorder is built by hand, one answering function per method.
   */
  it('holds for the gateway tools', async () => {
    const calls: Recorder['calls'] = [];
    const rec = <A extends unknown[], R>(method: string, answer: (...args: A) => R) =>
      (...args: A): R => {
        calls.push({ method, args });
        return answer(...args);
      };
    const workspace = { id: 'ws_1', slug: 'sentinel_workspace', name: 'w', settings: {} } as never;
    const run = { id: 'run_1', status: 'succeeded', error: null, workspaceId: 'ws_1' } as never;
    const deps: GatewayDeps = {
      workspaces: { list: rec('workspaces.list', () => [workspace]), get: rec('workspaces.get', () => workspace) },
      kernel: {
        startForToken: rec('kernel.startForToken', async () => ({ run, sessionId: 'ses_1' })),
        awaitRun: rec('kernel.awaitRun', async () => ({ run, finalText: 'done' })),
      },
      knowledge: { search: rec('knowledge.search', async () => []) },
      board: { list: rec('board.list', () => []) },
      runs: { get: rec('runs.get', () => run) },
      transcript: { byRun: rec('transcript.byRun', () => []) },
      audit: { record: rec('audit.record', () => undefined) },
    };
    const token = {
      id: 'tok_1', name: 'n8n', scopes: ['run', 'read'], workspaceIds: ['ws_1'], ceiling: 'dontAsk',
      createdBy: 'op', createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, lastUsedAt: null, revokedAt: null, hint: 'mck',
    } as ApiTokenRecord;
    const facade = {
      calls,
      received: () => new Set(leaves(calls.map((call) => call.args)).map((leaf) => leaf.value)),
    };

    const tools = registered(buildGatewayServer(deps, token));
    expect(Object.keys(tools).length).toBe(6);
    for (const [name, tool] of Object.entries(tools)) {
      if (name === 'list_workspaces') continue; // no arguments to forward
      await assertForwards(name, tool, facade);
    }
  });
});
