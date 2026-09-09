/**
 * The other workspaces of this Metaclaude, as an agent reaches them.
 *
 * Two verbs, and the order between them is the whole design:
 *
 *  - `search_workspaces` reads what those workspaces have already written
 *    down — their memories and their reference documents. Nothing executes, no
 *    model is called, and the answer comes back in milliseconds.
 *  - `delegate` asks one of them to *work*: a full run of its own agent, with
 *    its memory, conventions and permission mode. It answers better than files
 *    read cold, and it costs a run there and minutes of waiting.
 *
 * Measured on the deployment this was built for: a delegated run cost $0.34 and
 * some minutes, while the question that prompted it — a fact one workspace had
 * noted and another was asked about — was answered first by the cheap search on
 * every phrasing tried. So the description of each tool says plainly which to
 * reach for, and the briefing repeats it: an agent that only has the expensive
 * verb uses the expensive verb.
 *
 * The fence is the peer list, and it is handed in rather than computed here.
 * The supervisor derives it once — non-archived workspaces that have not opted
 * out of being consulted, minus this one — and uses that same list for the
 * mount, for the directory the agent is shown, and for this scope. A tool that
 * reached further than the directory named would be a scope nobody could read;
 * a directory naming more than the tool reaches would be a briefing for calls
 * that fail.
 *
 * `search_workspaces` deliberately excludes the global tier. The asking run
 * already receives it — its own recall covers its workspace plus the globals —
 * so returning it here would spend the answer on what has already been read.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { MemorySearchResult, Run, Workspace } from '@metaclaude/shared';
import { describeLocation, mcpToolName } from '@metaclaude/shared';
import { z } from 'zod';
import type { KnowledgeSearchResult } from '../learning/knowledge.js';

/** What the peer tools need. `MemoryStore` and `KnowledgeStore` satisfy the two searches as they stand. */
export interface PeerFacade {
  /**
   * Run a prompt in another workspace and wait for its answer.
   *
   * Takes the asking run's id rather than a description of it: the kernel reads
   * the workspace, what started the run and the ceiling it was admitted under
   * off the row, so none of the three can be misreported by a caller.
   */
  delegate(input: { fromRunId: string; target: string; prompt: string }): Promise<{
    status: Run['status'];
    finalText: string;
    error: string | null;
  }>;
  memory: {
    search(
      query: string,
      options: { workspaceIds: string[]; limit: number },
    ): Promise<MemorySearchResult[]>;
  };
  knowledge: {
    search(
      query: string,
      options: { workspaceIds: string[]; limit: number },
    ): Promise<KnowledgeSearchResult[]>;
  };
}

export interface PeerToolScope {
  /** The run doing the asking — its id is what the kernel resolves everything else from. */
  runId: string;
  /**
   * The workspaces this run may reach, in the order the directory shows them.
   *
   * The supervisor's `delegationPeers`, passed in whole rather than re-derived:
   * one list for the mount, the briefing and the scope, so the three cannot
   * come apart. Full records because each peer's own settings decide what it
   * contributes — a workspace that recalls nothing has no memories to offer.
   */
  peers: readonly Workspace[];
}

/** How many hits of each kind one search returns when the caller says nothing. */
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;

/**
 * A memory as a peer search returns it.
 *
 * The workspace rides on every hit, and it is not decoration: an agent that
 * quotes "the lease runs to December" without saying which project's lease has
 * given its operator a fact they cannot check. It is also what makes the
 * follow-up possible — the slug is exactly what `delegate` takes.
 */
const asMemory = (workspace: string, result: MemorySearchResult) => ({
  workspace,
  title: result.memory.title,
  text: result.memory.content,
  kind: result.memory.kind,
});

/**
 * A passage, and deliberately without a workspace on it.
 *
 * A memory belongs to exactly one tier, so naming its workspace is a fact. A
 * *document* can reach several at once, so naming one would be a guess — and
 * the field that looks like it answers, `KnowledgeSearchResult.workspaceId`, is
 * the record of where the document was first filed, which a later change of
 * reach leaves behind. What attributes a passage is its document, its section
 * and its page, and all three are here.
 */
const asPassage = (hit: KnowledgeSearchResult) => {
  const location = describeLocation(hit);
  return {
    document: hit.documentTitle,
    heading: hit.heading,
    ...(location ? { location } : {}),
    ...(hit.sourceName ? { source: hit.sourceName } : {}),
    text: hit.text,
  };
};

export function createPeerHandlers(facade: PeerFacade, scope: PeerToolScope) {
  const slugOf = new Map(scope.peers.map((peer) => [peer.id, peer.slug]));

  /**
   * The peers a call may read, narrowed to one when the caller names it.
   *
   * An unknown slug is refused rather than silently widened to everything: a
   * model that mistypes a slug and is answered from the whole deployment reads
   * the answer as being about the workspace it named.
   */
  const targets = (named: string | undefined): Workspace[] => {
    if (!named) return [...scope.peers];
    const found = scope.peers.find((peer) => peer.slug === named);
    if (!found) {
      throw new Error(
        `There is no workspace called "${named}" you can reach. The ones you can are: ${
          scope.peers.map((peer) => peer.slug).join(', ') || 'none'
        }.`,
      );
    }
    return [found];
  };

  return {
    async search(args: { query: string; workspace?: string; limit?: number }) {
      const chosen = targets(args.workspace);
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      // Each peer's own switches decide what it contributes. A workspace whose
      // operator turned memory off has no memory to offer, and reading its
      // documents while ignoring that switch would be answering with half a
      // setting honoured.
      const remembering = chosen.filter((peer) => peer.settings.memoryEnabled).map((peer) => peer.id);
      const filed = chosen.filter((peer) => peer.settings.knowledgeEnabled).map((peer) => peer.id);

      // Both together, which is worth being exact about: the SQL and the
      // fusion genuinely overlap, but a sentence-transformer serialises its
      // own calls, so the two query embeddings queue rather than run side by
      // side. The saving is real and partial — not the slower of the two, but
      // less than their sum.
      const [memories, passages] = await Promise.all([
        remembering.length > 0
          ? facade.memory.search(args.query, { workspaceIds: remembering, limit })
          : Promise.resolve([]),
        filed.length > 0
          ? facade.knowledge.search(args.query, { workspaceIds: filed, limit })
          : Promise.resolve([]),
      ]);

      // Two lists rather than one ranked answer, deliberately. The two stores
      // fuse their own arms and their scores are not comparable, so merging
      // them into a single order would assert a precedence that nothing
      // measured — and a passage and a memory are different kinds of evidence
      // to a reader anyway.
      return {
        searched: chosen.map((peer) => peer.slug),
        // A memory searched here always belongs to one of the peers — the
        // scope excludes the global tier — so the map answers. Its own id is
        // the fallback rather than an empty string: a label nobody can trace
        // is worse than an ugly one.
        memories: memories.map((result) =>
          asMemory(
            slugOf.get(result.memory.workspaceId ?? '') ?? result.memory.workspaceId ?? 'unknown',
            result,
          ),
        ),
        passages: passages.map(asPassage),
      };
    },

    async delegate(args: { workspace: string; prompt: string }) {
      // Resolved against the same list, so a slug this run may not reach is
      // refused here with the list of the ones it may — rather than by the
      // kernel, whose answer cannot name them.
      const [target] = targets(args.workspace);
      const result = await facade.delegate({
        fromRunId: scope.runId,
        target: target!.slug,
        prompt: args.prompt,
      });
      if (result.status !== 'succeeded') {
        throw new Error(
          `The delegated run ${result.status}${result.error ? `: ${result.error}` : '.'}`,
        );
      }
      return { workspace: target!.slug, answer: result.finalText || 'The delegated run finished without a final message.' };
    },
  };
}

/* ------------------------------- MCP server ------------------------------ */

const asToolResult = async (fn: () => unknown | Promise<unknown>) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (error) {
    // An error is a result, not a transport failure: the model has to be able
    // to read what went wrong and try something else — a mistyped slug most of
    // all, since the message names the ones that would have worked.
    return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
  }
};

/**
 * The server name, unchanged since delegation shipped and not free to change:
 * `mcp__metaclaude__delegate` is written into the pre-approved tool list of
 * every workspace whose operator has ticked it, and a rename would silently
 * un-approve them all.
 */
export const PEER_SERVER_NAME = 'metaclaude';

/**
 * The tools by name and ring.
 *
 * `search_workspaces` is ring 1 and pre-approved with the mount, on memory's
 * own argument: it reads what is already written, executes nothing, and a run
 * under `dontAsk` cannot raise a card at all — so without the pre-approval it
 * would be refused outright, which is how an automation ends up unable to look
 * anything up while still landing as a success.
 *
 * `delegate` is ring 2 and deliberately *not* pre-approved with the mount. It
 * spends another workspace's quota and starts a full run there with nobody
 * watching; that one stays an explicit tick in the workspace's settings.
 */
export const PEER_TOOL_CATALOGUE: ReadonlyArray<{
  name: string;
  ring: 1 | 2;
  description: string;
}> = [
  {
    name: 'search_workspaces',
    ring: 1,
    description: 'Search what the other workspaces have written down. Cheap, and nothing runs.',
  },
  {
    name: 'delegate',
    ring: 2,
    description: 'Ask another workspace’s agent to work, and wait. Costs a full run there.',
  },
];

/**
 * The two names the supervisor pre-approves by, qualified as the CLI and the
 * broker see them.
 *
 * Named individually rather than as one list, because the two are decided
 * separately: the search rides with its own mount, `delegate` waits for the
 * workspace's tick. A `peerToolNames()` covering both would have exactly one
 * caller — its own test — which is a helper that exists to be tested.
 */
export const PEER_SEARCH_TOOL = mcpToolName(PEER_SERVER_NAME, 'search_workspaces');
export const PEER_DELEGATE_TOOL = mcpToolName(PEER_SERVER_NAME, 'delegate');

const WORKSPACE_SLUG = z
  .string()
  .min(1)
  .max(64)
  .describe('The workspace’s slug, exactly as written in the directory in your instructions.');

export function buildPeerServer(
  facade: PeerFacade,
  scope: PeerToolScope,
  /** Which verbs this run actually has. See `AgentSupervisor.peerDirectory`. */
  verbs: { search: boolean; delegate: boolean },
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createPeerHandlers(facade, scope);

  return createSdkMcpServer({
    name: PEER_SERVER_NAME,
    version: '1.0.0',
    tools: [
      ...(verbs.search
        ? [
            sdkTool(
              'search_workspaces',
              'Search what the other workspaces of this Metaclaude have written down — the notes their ' +
                'agents keep and the reference documents filed with them. Read-only, no model call, and ' +
                'it answers at once. **Try this before delegate**, and before telling anyone this ' +
                'deployment does not know something: most questions about another project are answered ' +
                'by what that project already noted. Attribute what you use: a note names the workspace ' +
                'that holds it, a passage names its document, section and page. Your own workspace and ' +
                'anything filed globally are already in front of you and are not searched again here.',
              {
                query: z.string().min(1).max(500).describe('What you are looking for, in words.'),
                workspace: WORKSPACE_SLUG.optional().describe(
                  'Search only this one. Omit to search every workspace you can reach.',
                ),
                limit: z
                  .number()
                  .int()
                  .min(1)
                  .max(MAX_LIMIT)
                  .optional()
                  .describe(`Hits of each kind. Default ${DEFAULT_LIMIT}.`),
              },
              async (args) => asToolResult(() => handlers.search(args)),
            ),
          ]
        : []),
      ...(verbs.delegate
        ? [
            sdkTool(
              'delegate',
              'Ask another workspace of this Metaclaude to work on something and return its answer. The ' +
                'target runs with its own memory, skills, conventions and permission mode — use this to ' +
                'consult a project through its own agent rather than reading its files cold. It costs a ' +
                'full run there and the answer can take minutes, so try search_workspaces first when what ' +
                'you need is something already written down. The target cannot delegate further.',
              {
                workspace: WORKSPACE_SLUG,
                prompt: z
                  .string()
                  .min(1)
                  .max(20_000)
                  .describe('What to ask. Self-contained — the target does not see this conversation.'),
              },
              async (args) => asToolResult(() => handlers.delegate(args)),
            ),
          ]
        : []),
    ],
  });
}
