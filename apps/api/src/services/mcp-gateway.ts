/**
 * Metaclaude as an MCP server — the tools an outside program may reach.
 *
 * The registry's servers are the ones this deployment *consumes*. This is the
 * other direction: one endpoint that other applications connect to, so an
 * agent that lives here can be asked things from anywhere the operator's own
 * software runs.
 *
 * Two rules shape everything below, and both come from the same fact — the
 * caller is a program holding a token, and nobody is watching it.
 *
 * **Scope is checked on every path, and it is checked the same way.** A token
 * names the workspaces it may reach. Every tool that takes a workspace resolves
 * it through `within`, which answers "no such workspace" for a workspace that
 * exists but is not this token's — the same answer as for one that does not
 * exist at all. Confirming the existence of a workspace the caller cannot use
 * is already a leak of the deployment's map, and a leak that costs nothing to
 * avoid.
 *
 * **Nothing here invents a capability.** Every tool is something the
 * application already does, reached under a narrower identity. What a token
 * must never touch — secrets, users, integrations, the update button — is
 * absent rather than guarded, because absent cannot be forgotten.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ApiTokenRecord, ApiTokenScope, BoardTask, Run, Workspace } from '@metaclaude/shared';
import type { KnowledgeSearchResult } from '../learning/knowledge.js';

/**
 * How long a blocking ask waits before handing back the run id instead.
 *
 * Below the proxy's own 30-minute read timeout, so the answer that arrives is
 * ours and says something useful, rather than the gateway's connection dying
 * mid-sentence. A run that outlives it is not cancelled — it is still running,
 * and the caller is told so.
 */
export const ASK_TIMEOUT_MS = 10 * 60_000;

/** The slice of the application the gateway is allowed to see. */
export interface GatewayDeps {
  workspaces: {
    list(includeArchived?: boolean): Workspace[];
    get(id: string): Workspace | null;
  };
  kernel: {
    startForToken(input: {
      workspaceId: string;
      prompt: string;
      ceiling: ApiTokenRecord['ceiling'];
      label: string;
      awaited: boolean;
    }): Promise<{ run: Run; sessionId: string }>;
    awaitRun(runId: string, timeoutMs: number): Promise<{ run: Run; finalText: string }>;
  };
  knowledge: {
    search(
      query: string,
      options: { workspaceId?: string | null; limit?: number },
    ): Promise<KnowledgeSearchResult[]>;
  };
  board: { list(workspaceId: string): BoardTask[] };
  audit: { record(input: { actor: string; action: string; target?: string; detail?: string }): void };
}

export interface AskResult {
  runId: string;
  status: Run['status'];
  text: string;
}

/**
 * The handlers, bound to one token.
 *
 * Separated from the MCP server itself so the scope rules can be tested
 * without a protocol round trip — the rules are what is worth testing, and a
 * transport in the way of them only makes the tests slower to write and easier
 * to write incompletely.
 */
export function createGatewayHandlers(deps: GatewayDeps, token: ApiTokenRecord) {
  const actor = `token:${token.name}`;

  const requires = (scope: ApiTokenScope, doing: string): void => {
    if (!token.scopes.includes(scope)) {
      throw new Error(`This token is not allowed to ${doing}.`);
    }
  };

  /**
   * Resolve a workspace this token may reach, by id or by slug.
   *
   * Both spellings, because a program configured by a human will hold a slug
   * — that is what the operator sees — while anything reading `list_workspaces`
   * back will hold an id. One message for "unknown" and "not yours": see the
   * note at the top of this file.
   */
  const within = (name: string): Workspace => {
    const found = deps.workspaces
      .list()
      .find((workspace) => workspace.id === name || workspace.slug === name);

    if (!found || !token.workspaceIds.includes(found.id)) {
      throw new Error(`There is no workspace called "${name}".`);
    }
    return found;
  };

  const start = async (input: { workspace: string; prompt: string }, awaited = false) => {
    requires('run', 'start runs');
    const workspace = within(input.workspace);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('The prompt is empty.');

    const { run } = await deps.kernel.startForToken({
      workspaceId: workspace.id,
      prompt,
      ceiling: token.ceiling,
      label: token.name,
      awaited,
    });

    // Recorded at the start, not at the end: a run that never returns is
    // exactly the one an operator will want to find in the trail.
    deps.audit.record({
      actor,
      action: 'gateway.run',
      target: run.id,
      detail: `${workspace.slug}: ${prompt.slice(0, 200)}`,
    });

    return { runId: run.id, status: run.status };
  };

  return {
    listWorkspaces: async (): Promise<Array<{ id: string; slug: string; name: string }>> =>
      deps.workspaces
        .list()
        .filter((workspace) => token.workspaceIds.includes(workspace.id))
        .map((workspace) => ({ id: workspace.id, slug: workspace.slug, name: workspace.name })),

    start,

    /**
     * Start a run and wait for its answer.
     *
     * The waiting is bounded, and a run that outlives the bound is reported as
     * still running with its id — not as a failure. It genuinely is still
     * working, and telling the caller otherwise would be the one thing worse
     * than making them wait.
     */
    ask: async (input: { workspace: string; prompt: string }): Promise<AskResult> => {
      // Declared here, not inferred downstream: the kernel keeps a finished
      // run's final text only for a caller that said it would come back for it.
      const started = await start(input, true);

      try {
        const settled = await deps.kernel.awaitRun(started.runId, ASK_TIMEOUT_MS);
        return {
          runId: started.runId,
          status: settled.run.status,
          text:
            settled.finalText ||
            settled.run.error ||
            'The run finished without a final message.',
        };
      } catch {
        return {
          runId: started.runId,
          status: 'running',
          text:
            'This is still running — it outlived the time the gateway waits. ' +
            'It has not been cancelled; follow it in Metaclaude by its run id.',
        };
      }
    },

    /**
     * Search one workspace's knowledge — **and the global shelf**.
     *
     * That is the store's contract for a named workspace, and it is the right
     * one: it returns exactly what a run in that workspace would retrieve, so
     * the tool cannot answer better or worse than the agent it stands in for.
     * Worth stating plainly, because "scoped to a workspace" reads as "only
     * that workspace" — a token scoped to one project can read anything filed
     * globally, and an operator granting `read` should know that.
     */
    searchNotes: async (input: {
      workspace: string;
      query: string;
      limit?: number;
    }): Promise<Array<{ title: string; heading: string; text: string }>> => {
      requires('read', 'read this workspace');
      const workspace = within(input.workspace);

      const found = await deps.knowledge.search(input.query, {
        workspaceId: workspace.id,
        limit: Math.min(input.limit ?? 6, 20),
      });
      return found.map((hit) => ({
        title: hit.documentTitle,
        heading: hit.heading,
        text: hit.text,
      }));
    },

    listTasks: async (input: { workspace: string }) => {
      requires('read', 'read this workspace');
      const workspace = within(input.workspace);

      return deps.board.list(workspace.id).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee,
      }));
    },
  };
}

/** Everything a tool returns, as the text block the protocol carries. */
const asText = async (produce: () => Promise<unknown>) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await produce(), null, 2) }] };
  } catch (error) {
    // An error is a result, not a transport failure: the model on the other
    // side has to be able to read what went wrong and try something else.
    return {
      content: [{ type: 'text' as const, text: (error as Error).message }],
      isError: true,
    };
  }
};

const WORKSPACE = z
  .string()
  .describe('The workspace slug or id, as returned by list_workspaces.');

/**
 * Build the MCP server one authenticated request will be answered by.
 *
 * A fresh instance per request, which is what the stateless transport wants:
 * nothing is remembered between calls, so there is no session table to grow,
 * to leak, or to confuse one token's request with another's.
 */
export function buildGatewayServer(
  deps: GatewayDeps,
  token: ApiTokenRecord,
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createGatewayHandlers(deps, token);

  return createSdkMcpServer({
    name: 'metaclaude',
    version: '1.0.0',
    tools: [
      sdkTool(
        'list_workspaces',
        'The Metaclaude workspaces this token can reach. Start here: every other ' +
          'tool takes one of these.',
        {},
        async () => asText(() => handlers.listWorkspaces()),
      ),
      sdkTool(
        'ask_workspace',
        "Ask a workspace's agent to do something, and wait for its answer. It runs " +
          'with that workspace’s own memory, skills and conventions — this is the ' +
          'main way to use Metaclaude from another application.',
        {
          workspace: WORKSPACE,
          prompt: z.string().min(1).max(20_000).describe('What you want done, in plain words.'),
        },
        async (args) => asText(() => handlers.ask(args)),
      ),
      sdkTool(
        'start_run',
        'The same as ask_workspace but without waiting: returns a run id immediately. ' +
          'Use it for work that takes longer than a request should be held open.',
        {
          workspace: WORKSPACE,
          prompt: z.string().min(1).max(20_000),
        },
        async (args) => asText(() => handlers.start(args)),
      ),
      sdkTool(
        'search_notes',
        "Search a workspace's knowledge base, plus anything filed globally — the " +
          'same shelf a run there would read. Cheap, and nothing executes: prefer ' +
          'it over a run when the answer is something already written down.',
        {
          workspace: WORKSPACE,
          query: z.string().min(1).max(500),
          limit: z.number().int().min(1).max(20).optional(),
        },
        async (args) => asText(() => handlers.searchNotes(args)),
      ),
      sdkTool(
        'list_tasks',
        "A workspace's kanban board: every active card with its column and priority.",
        { workspace: WORKSPACE },
        async (args) => asText(() => handlers.listTasks(args)),
      ),
    ],
  });
}
