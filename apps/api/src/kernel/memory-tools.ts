/**
 * The agent's hands on its own memory — an in-process MCP server, one per run.
 *
 * Why this exists at all. Memory was readable and not writable: the recall
 * block is injected into every run's system prompt, framed as recollection and
 * with an instruction never to mention it, so the agent saw notes and had no
 * idea a store was behind them. The only write path was the reflexion pass,
 * out-of-band, after the run had ended, and judged by the gate. So an agent
 * told something worth keeping *during* a conversation did the only thing it
 * could: it wrote Markdown files in its workspace. Reported from use, and the
 * operator's objection is the whole argument — a second memory is no memory.
 * The files are not listed on the Memory page, not decayed, not consolidated,
 * not searchable beside the rest, and they diverge from the store on the very
 * next run.
 *
 * Scope is the design, as it is for the board: every handler resolves an id
 * against the run's own workspace, and a memory from anywhere else — another
 * workspace, or the global tier that every workspace recalls — gets the same
 * "no such memory" as one that does not exist. Promoting a note to the global
 * tier stays the operator's, because it changes what *other* workspaces
 * recall, and that consequence is invisible from here.
 *
 * These writes do not go through the memory gate, deliberately. The gate
 * exists to stop the *automatic* pass flooding the corpus with three lessons
 * per run that nobody asked for; a note written because the operator just said
 * something is not that, and a model call per note would make the tool too
 * slow to use mid-conversation. What bounds it instead is what bounds the
 * operator's own writes: the Memory page lists them, decay lowers what is
 * never recalled, and consolidation folds the duplicates.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { Memory, MemorySearchResult } from '@metaclaude/shared';
import { MemoryKind, MemoryShelf } from '@metaclaude/shared';
import { z } from 'zod';

/** What the tools need from the store — `MemoryStore` satisfies it as it is. */
export interface WorkspaceMemoryFacade {
  search(
    query: string,
    options: { workspaceId?: string | null; limit?: number },
  ): Promise<MemorySearchResult[]>;
  get(id: string): Memory | null;
  remember(input: {
    workspaceId: string | null;
    kind: Memory['kind'];
    title: string;
    content: string;
    tags?: string[];
    confidence?: number;
    pinned?: boolean;
    shelf?: Memory['shelf'];
    sourceRunId?: string | null;
  }): Promise<{ memory: Memory; merged: boolean }>;
  update(
    id: string,
    patch: Partial<Pick<Memory, 'title' | 'content' | 'tags' | 'confidence' | 'pinned' | 'kind' | 'shelf'>>,
  ): Promise<Memory | null>;
  retire(id: string, options?: { supersededBy?: string }): Memory | null;
}

export interface MemoryToolScope {
  workspaceId: string;
  runId: string;
}

/**
 * A memory as the agent sees it. Compact on purpose: a search of eight rows
 * with full bodies would cost more context than the answer is worth, and the
 * body is what the agent asked for, so it stays.
 */
const compact = (memory: Memory) => ({
  id: memory.id,
  kind: memory.kind,
  shelf: memory.shelf,
  title: memory.title,
  content: memory.content,
  tags: memory.tags,
  confidence: memory.confidence,
  pinned: memory.pinned,
});

export function createMemoryHandlers(store: WorkspaceMemoryFacade, scope: MemoryToolScope) {
  /**
   * The scope guard. One message for "missing" and "not yours", because
   * confirming that a memory exists in another workspace is already a leak —
   * and a global memory answers the same way: it is recalled here, it is not
   * editable from here.
   */
  const mine = (id: string): Memory => {
    const memory = store.get(id);
    if (!memory || memory.workspaceId !== scope.workspaceId) {
      throw new Error(`No such memory in this workspace: ${id}`);
    }
    return memory;
  };

  return {
    async search(args: { query: string; limit?: number }) {
      const results = await store.search(args.query, {
        workspaceId: scope.workspaceId,
        limit: args.limit ?? 8,
      });
      return results.map((result) => ({ ...compact(result.memory), score: result.score }));
    },

    async write(args: {
      id?: string;
      kind?: Memory['kind'];
      title?: string;
      content?: string;
      tags?: string[];
      confidence?: number;
      pinned?: boolean;
      shelf?: Memory['shelf'];
      supersedes?: string;
    }) {
      const superseding = (newId: string): { superseded: string } | Record<string, never> => {
        if (!args.supersedes) return {};
        mine(args.supersedes);
        store.retire(args.supersedes, { supersededBy: newId });
        return { superseded: args.supersedes };
      };

      if (args.id) {
        mine(args.id);
        const patch = {
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
          ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
          ...(args.shelf !== undefined ? { shelf: args.shelf } : {}),
        };
        const memory = await store.update(args.id, patch);
        if (!memory) throw new Error(`No such memory in this workspace: ${args.id}`);
        return { ...compact(memory), ...superseding(memory.id) };
      }

      if (!args.kind || !args.title || !args.content) {
        throw new Error('A new memory needs kind, title and content.');
      }
      // Every field the schema accepts reaches the store. The steward's own
      // write forwarded four of six here and a memory asked for as pinned at
      // confidence 1 came back unpinned at 0.7, silently; `tool-forwarding.test.ts`
      // now derives that check from the schema for every in-process tool.
      const { memory, merged } = await store.remember({
        workspaceId: scope.workspaceId,
        kind: args.kind,
        title: args.title,
        content: args.content,
        tags: args.tags,
        confidence: args.confidence,
        pinned: args.pinned,
        shelf: args.shelf,
        // Provenance, so the Memory page can say which run wrote it and the
        // genesis view can trace it back.
        sourceRunId: scope.runId,
      });
      return { ...compact(memory), merged, ...superseding(memory.id) };
    },

    forget(args: { id: string }) {
      const memory = mine(args.id);
      const retired = store.retire(memory.id);
      return { id: memory.id, retired: retired !== null };
    },
  };
}

/* ------------------------------- MCP server ------------------------------ */

const asToolResult = async (fn: () => unknown | Promise<unknown>) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
  }
};

const MEMORY_ID = z.string().describe('The memory id, as returned by memory_search or memory_write.');

export const MEMORY_SERVER_NAME = 'metaclaude_memory';

/**
 * The tools by name and ring; the workspace that mounts them pre-approves
 * exactly these. Nothing here is ring 3: `memory_forget` is a soft delete —
 * the row leaves recall at once, stays readable for thirty days and is
 * restorable from the Memory page — which is the same bargain the board makes
 * by never deleting a card.
 *
 * The server below must register exactly these names; a test holds the two
 * together, because a name that drifts is a tool that silently writes nothing.
 */
export const MEMORY_TOOL_CATALOGUE: ReadonlyArray<{ name: string; ring: 1 | 2; description: string }> = [
  { name: 'memory_search', ring: 1, description: 'Search what is already remembered about this workspace.' },
  { name: 'memory_write', ring: 2, description: 'Remember something, or correct a memory by id.' },
  { name: 'memory_forget', ring: 2, description: 'Retire a memory that no longer holds — reversible for thirty days.' },
];

/** The names as the CLI and the broker see them. */
export function memoryToolNames(): string[] {
  return MEMORY_TOOL_CATALOGUE.map((entry) => `mcp__${MEMORY_SERVER_NAME}__${entry.name}`);
}

export function buildMemoryServer(
  store: WorkspaceMemoryFacade,
  scope: MemoryToolScope,
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createMemoryHandlers(store, scope);

  return createSdkMcpServer({
    name: MEMORY_SERVER_NAME,
    version: '1.0.0',
    tools: [
      sdkTool(
        'memory_search',
        'Search this workspace’s memory — what earlier sessions recorded about this project and the people in it. ' +
          'Use it before asking the user something they may already have told you, and before writing a memory that may already exist.',
        {
          query: z.string().min(1).max(2000).describe('What you are trying to recall, in words.'),
          limit: z.number().int().min(1).max(25).optional().describe('How many to return; defaults to 8.'),
        },
        async (args) => asToolResult(() => handlers.search(args)),
      ),
      sdkTool(
        'memory_write',
        'Remember something durable, or correct a memory by passing its id. ' +
          'Write what will still matter in a month — a preference, a fact about the project or the people in it, a way of working that succeeded — ' +
          'not what happened in this conversation. One fact per memory, stated so it reads on its own out of context. ' +
          'Prefer correcting an existing memory over adding a second one that says nearly the same thing.',
        {
          id: MEMORY_ID.optional().describe('Correct this memory; omit to record a new one.'),
          kind: MemoryKind.optional().describe(
            'semantic = a durable fact; procedural = a repeatable way of doing something here; episodic = a specific event worth recalling.',
          ),
          title: z.string().min(1).max(300).optional().describe('One line, specific enough to recognise later.'),
          content: z.string().min(1).max(20_000).optional(),
          tags: z.array(z.string().min(1).max(64)).max(20).optional(),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('How sure you are. Below 0.5 will be forgotten by decay before long.'),
          pinned: z.boolean().optional().describe('Exempt from decay. For what the user stated outright.'),
          shelf: MemoryShelf.optional().describe(
            'standing = a convention or preference, injected into every run of this workspace; durable = the default; volatile = a fact that can stop being true.',
          ),
          supersedes: MEMORY_ID.optional().describe(
            'A memory this one replaces — the same subject, later. It is retired pointing at this one.',
          ),
        },
        async (args) => asToolResult(() => handlers.write(args)),
      ),
      sdkTool(
        'memory_forget',
        'Retire a memory that no longer holds. A soft delete: it leaves recall at once, stays readable for thirty days ' +
          'and the operator can restore it. Prefer this over editing a title to say “obsolete”.',
        { id: MEMORY_ID },
        async (args) => asToolResult(() => handlers.forget(args)),
      ),
    ],
  });
}
