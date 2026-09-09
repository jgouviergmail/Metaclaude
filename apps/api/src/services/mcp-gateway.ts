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
import type {
  ApiTokenRecord,
  ApiTokenScope,
  BoardTask,
  MemorySearchResult,
  Run,
  TranscriptEvent,
  Workspace,
} from '@metaclaude/shared';
import { describeLocation } from '@metaclaude/shared';
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

/** Statuses past which no further text will arrive. */
const FINISHED: ReadonlySet<Run['status']> = new Set(['succeeded', 'failed', 'interrupted']);

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
      options: {
        workspaceId?: string | null;
        workspaceIds?: string[];
        includeGlobal?: boolean;
        limit?: number;
      },
    ): Promise<KnowledgeSearchResult[]>;
  };
  /**
   * The agent's own notes, searched the same way.
   *
   * Added because the shelf alone could not answer: measured in production, an
   * application asked a question whose answer was a pinned memory of another
   * workspace and was told this deployment did not know. No grant, however
   * wide, would have found it — `search_notes` read documents only.
   */
  memory: {
    search(
      query: string,
      options: {
        workspaceId?: string | null;
        workspaceIds?: string[];
        includeGlobal?: boolean;
        limit?: number;
      },
    ): Promise<MemorySearchResult[]>;
  };
  board: { list(workspaceId: string): BoardTask[] };
  runs: { get(id: string): Run | null };
  transcript: { byRun(runId: string): TranscriptEvent[] };
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
  /**
   * The workspaces this token reaches, as records.
   *
   * Two callers now — the listing and the search that takes no workspace —
   * and both have to answer the same way when a token reaches nothing, or one
   * of them reintroduces the empty list that told a program this deployment
   * had no workspaces.
   */
  const reachable = (): Workspace[] =>
    deps.workspaces.list().filter((workspace) => token.workspaceIds.includes(workspace.id));

  /**
   * An empty answer is a conclusion the caller cannot check: a program asking
   * reads "nothing" as "this deployment is empty" and says so to its operator.
   * It happened — a token granted a workspace that was later deleted — so the
   * emptiness explains which of the two it is, and the deployment's own count
   * is the proof it is about permission rather than about emptiness.
   */
  const refuseEmptyReach = (): never => {
    const total = deps.workspaces.list().length;
    throw new Error(
      total === 0
        ? 'This Metaclaude has no workspaces yet. Ask its operator to create one.'
        : `This token reaches none of the ${total} workspace(s) of this Metaclaude: the ones it was granted no longer exist. Ask its operator to grant it a workspace again — Settings → MCP gateway.`,
    );
  };

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
    listWorkspaces: async (): Promise<
      Array<{ id: string; slug: string; name: string; description: string }>
    > => {
      // The description rides along because a caller choosing between
      // workspaces has the same problem an agent does: a name says what a
      // workspace is called and never what it is for. The operator writes that
      // sentence already, and until now it reached nothing outside the
      // interface.
      const mine = reachable().map((workspace) => ({
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        description: workspace.description,
      }));

      if (mine.length === 0) refuseEmptyReach();
      return mine;
    },

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
      } catch (error) {
        // Only a *timeout* means "still working". Anything else is a failure of
        // the wait itself — the kernel shutting down, a stash discarded — and
        // reporting that as "still running" would send the caller polling a run
        // that will never answer. The message is the kernel's own, matched on
        // the phrase it raises.
        if (!/did not finish in time/i.test((error as Error).message)) throw error;

        return {
          runId: started.runId,
          status: 'running',
          text:
            'This is still running — it outlived the time the gateway waits. ' +
            'It has not been cancelled; follow it with run_status.',
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
    /**
     * What became of a run, and its answer once there is one.
     *
     * The half `start_run` was missing: without it an asynchronous call handed
     * back an id nothing could redeem. The final text is not on the run row —
     * it exists only in the transcript — so it is read back from there, and the
     * *last* assistant block is the answer: everything before it is the agent
     * thinking aloud on the way.
     *
     * A run id is not a capability. The run is resolved, then its workspace is
     * put through the same `within` every other tool uses, and a run belonging
     * elsewhere answers exactly as one that does not exist.
     */
    status: async (input: {
      runId: string;
    }): Promise<{ runId: string; status: Run['status'] | 'unknown'; text: string | null }> => {
      requires('run', 'start runs');

      const run = deps.runs.get(input.runId);
      if (!run || !token.workspaceIds.includes(run.workspaceId)) {
        throw new Error(`There is no run called "${input.runId}".`);
      }

      if (!FINISHED.has(run.status)) {
        return { runId: run.id, status: run.status, text: null };
      }

      const spoken = deps.transcript
        .byRun(run.id)
        .filter((event): event is Extract<TranscriptEvent, { kind: 'assistant_text' }> =>
          event.kind === 'assistant_text',
        );
      const last = spoken.at(-1)?.text?.trim();

      return {
        runId: run.id,
        status: run.status,
        text: last || run.error || 'The run finished without a final message.',
      };
    },

    /**
     * Everything this token can read, searched at once.
     *
     * Two changes from the version that shipped, and both come from the same
     * measurement: an application asked this deployment a question whose answer
     * was a pinned memory of another workspace, and was told it did not know.
     *
     * **Memories as well as documents.** The shelf alone could not answer, so
     * no grant however wide would have helped. Each hit says which it is: a
     * passage is a quotation from the operator's own reference material, a
     * memory is what an agent noted and may be out of date, and a caller that
     * cannot tell them apart cannot weigh them.
     *
     * **The workspace is optional.** A program on the other end is not
     * supposed to know how this deployment files things; asked without one it
     * searches every workspace the token reaches, plus the global shelf, which
     * is the union of what a run in any of them would read.
     */
    searchNotes: async (input: {
      workspace?: string;
      query: string;
      limit?: number;
    }): Promise<
      Array<{
        kind: 'memory' | 'passage';
        /** Only a memory has one. See the note beside `named` below. */
        workspace?: string;
        title: string;
        heading: string;
        location?: string;
        source?: string;
        text: string;
      }>
    > => {
      requires('read', 'read this workspace');

      // One workspace named, or every one this token holds. The second is
      // refused rather than answered empty when the grant reaches nothing —
      // the same sentence `list_workspaces` gives, for the same reason.
      const scope = input.workspace
        ? { workspaceId: within(input.workspace).id }
        : (() => {
            const mine = reachable();
            if (mine.length === 0) refuseEmptyReach();
            return { workspaceIds: mine.map((workspace) => workspace.id), includeGlobal: true };
          })();

      const limit = Math.min(input.limit ?? 6, 20);
      // Both stores at once. The SQL and the fusion overlap; the two query
      // embeddings do not, because a sentence-transformer serialises its own
      // calls — so this is less than their sum rather than the slower of the
      // two, which is the honest claim.
      const [passages, memories] = await Promise.all([
        deps.knowledge.search(input.query, { ...scope, limit }),
        deps.memory.search(input.query, { ...scope, limit }),
      ]);

      // Where each hit came from travels with it: a program on the other end
      // of this gateway quotes what it is given, and a note it cannot
      // attribute is a claim it cannot check. `location` and `source` are
      // omitted rather than sent empty, so a caller can tell "no page" from
      // "page nothing".
      //
      // Only a *memory* carries a workspace, and the asymmetry is the truth
      // rather than an omission: a memory belongs to exactly one tier, while a
      // document can reach several at once — and the document field that looks
      // like it answers is the record of where it was first filed, which a
      // later change of reach leaves behind, so a passage labelled from it
      // would be confidently wrong. A passage is attributed by its document,
      // its section and its page. `global` is what a memory filed against no
      // project is called, rather than borrowing the name of the workspace
      // that happened to be asked.
      const named = (workspaceId: string | null): string =>
        workspaceId === null
          ? 'global'
          : (deps.workspaces.get(workspaceId)?.slug ?? workspaceId);

      return [
        ...passages.map((hit) => {
          const location = describeLocation(hit);
          return {
            kind: 'passage' as const,
            title: hit.documentTitle,
            heading: hit.heading,
            ...(location ? { location } : {}),
            ...(hit.sourceName ? { source: hit.sourceName } : {}),
            text: hit.text,
          };
        }),
        ...memories.map((hit) => ({
          kind: 'memory' as const,
          workspace: named(hit.memory.workspaceId),
          title: hit.memory.title,
          // What kind of note it is, in the field a passage uses for its
          // section: a caller reading a flat list needs one shape.
          heading: hit.memory.kind,
          text: hit.memory.content,
        })),
      ];
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
        'run_status',
        'What became of a run started with start_run, and its answer once it has ' +
          'finished. Poll this rather than holding a request open.',
        { runId: z.string().describe('The id start_run returned.') },
        async (args) => asText(() => handlers.status(args)),
      ),
      sdkTool(
        'search_notes',
        'Search what this Metaclaude has written down: the reference documents in ' +
          'its knowledge base and the notes its agents keep. Cheap, and nothing ' +
          'executes: prefer it over a run when the answer is something already ' +
          'recorded. Omit the workspace to search everything this token reaches, ' +
          'which is the usual case — you are not expected to know where a fact is ' +
          'filed. Every result says which workspace it came from and what kind it ' +
          'is: a `passage` is a quotation from a reference document, and carries ' +
          'the document, its section and the page and lines where it has them, so ' +
          'it can be attributed; a `memory` is something an agent noted and may be ' +
          'out of date, so weigh it as recollection rather than as a source.',
        {
          workspace: WORKSPACE.optional().describe(
            'Restrict the search to this workspace. Omit it to search all of them.',
          ),
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
