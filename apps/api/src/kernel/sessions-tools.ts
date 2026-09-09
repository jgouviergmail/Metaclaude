/**
 * The workspace's other sessions, readable by a run of that workspace.
 *
 * Why this exists: an automation chained after another one could be told *that*
 * the upstream succeeded and nothing of what it said, and an operator writing
 * "use the data from session X" had no way for the agent to reach session X.
 * The transcript was already the source of truth for the screen; this makes it
 * one for the agent too.
 *
 * Deliberately pull, not push. Injecting other sessions into every run would
 * cost tens of thousands of tokens a turn for content that mostly does not
 * concern the question — measured on this deployment, one session holds 36 kB
 * of dialogue and a single day 120 kB of events — and anything per-message in
 * the system prompt rewrites the cached prefix, which was measured at a factor
 * of seventy on tokens written to cache. What *should* cross sessions without
 * being asked for already does: memory distils it after each run. This is for
 * what the caller names.
 *
 * The fence is the workspace. Every id resolves inside the run's own
 * workspace, and a session belonging to another answers exactly like one that
 * does not exist — a distinct refusal would confirm the id exists elsewhere in
 * the deployment, and these tools are mounted in every ordinary workspace.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { Run, Session, TranscriptEvent } from '@metaclaude/shared';
import { mcpToolName } from '@metaclaude/shared';
import { z } from 'zod';
import {
  DIALOGUE_CHARS,
  DIALOGUE_CHARS_MAX,
  FINAL_ANSWER_CHARS,
  dialogue,
  excerpt,
  finalAnswer,
  toolsCalled,
} from './transcript-view.js';

export interface SessionsFacade {
  listSessions(workspaceId: string, options: { includeArchived: boolean; limit: number }): Session[];
  getSession(id: string): Session | null;
  getRun(id: string): Run | null;
  sessionEvents(sessionId: string, options: { since?: number; limit?: number }): TranscriptEvent[];
  runEvents(runId: string): TranscriptEvent[];
}

export interface SessionsToolScope {
  workspaceId: string;
  /** The session this run is in — marked in a listing, never a secret. */
  sessionId: string;
  /** Injected so a window is testable without the wall clock. */
  now?: () => number;
}

const HOUR_MS = 3_600_000;
/**
 * How many events one read may pull before the character budget applies.
 *
 * The repository's own default, deliberately rather than a second number: it
 * keeps the newest, which is the end the budget keeps too, so the two agree
 * instead of each trimming a different edge.
 */
const EVENT_CEILING = 2000;
/**
 * How much of the workspace a title search looks at.
 *
 * Not the caller's `limit`, which bounds the *answer*: searching only the
 * first page would make an old session unfindable by name. A workspace with
 * more sessions than this has other problems, and the cap is what keeps a
 * pathological one from being loaded whole to answer a search.
 */
const SEARCH_CEILING = 1000;

/**
 * Accent- and case-insensitive matching, because the titles are French.
 *
 * `toLowerCase` alone leaves `Évaluation` unfindable by someone typing
 * `evaluation`, which is how a title gets typed on a phone. Same family as the
 * `\b` trap: an ASCII-shaped rule quietly fails on the corpus this actually
 * runs against.
 */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    // The combining marks by codepoint, not typed literally: written as
    // characters they are invisible in a diff and one stray edit turns the
    // class into something else that still compiles.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const compact = (session: Session, currentId: string) => ({
  id: session.id,
  title: session.title,
  status: session.status,
  archived: session.archived,
  runCount: session.runCount,
  totalCostUsd: session.totalCostUsd,
  lastActivityAt: session.lastActivityAt,
  /** So the agent does not read back the conversation it is having. */
  isCurrent: session.id === currentId,
});

export function createSessionsHandlers(facade: SessionsFacade, scope: SessionsToolScope) {
  const now = scope.now ?? (() => Date.now());

  /**
   * The scope guard, and the reason both refusals read the same.
   *
   * Confirming that a session exists in another workspace is already a leak:
   * these tools are mounted everywhere, so a distinct message would let one
   * workspace's agent probe another's ids one guess at a time.
   */
  const mineSession = (id: string): Session => {
    const session = facade.getSession(id);
    if (!session || session.workspaceId !== scope.workspaceId) {
      throw new Error(`No session in this workspace: ${id}`);
    }
    return session;
  };

  const mineRun = (id: string): Run => {
    const run = facade.getRun(id);
    if (!run || run.workspaceId !== scope.workspaceId) {
      throw new Error(`No run in this workspace: ${id}`);
    }
    return run;
  };

  return {
    list(args: { query?: string; includeArchived?: boolean; limit?: number }) {
      const limit = Math.min(args.limit ?? 40, 200);
      const needle = args.query?.trim() ? fold(args.query) : null;
      /*
       * Filter first, cap second.
       *
       * A caller's `limit` says how many results they want back, not how much
       * of the workspace is searchable — filtering a capped listing would make
       * a session older than the cap unfindable by name, and "the session
       * about the API" is usually an old one by the time it is named that way.
       * The filter is here rather than in SQL because it folds accents, which
       * SQLite's LIKE does not: `Évaluation` has to be findable typed
       * `evaluation`, which is how it gets typed on a phone.
       */
      const found = facade.listSessions(scope.workspaceId, {
        includeArchived: args.includeArchived ?? false,
        limit: needle ? SEARCH_CEILING : limit,
      });
      const matching = needle
        ? found.filter((entry) => fold(entry.title).includes(needle)).slice(0, limit)
        : found;
      return { sessions: matching.map((entry) => compact(entry, scope.sessionId)) };
    },

    read(args: { sessionId: string; sinceHours?: number; tools?: boolean; maxChars?: number }) {
      const session = mineSession(args.sessionId);
      const since =
        args.sinceHours === undefined ? undefined : now() - args.sinceHours * HOUR_MS;
      const events = facade.sessionEvents(session.id, { since, limit: EVENT_CEILING });
      const rendered = dialogue(events, {
        includeTools: args.tools ?? false,
        maxChars: Math.min(args.maxChars ?? DIALOGUE_CHARS, DIALOGUE_CHARS_MAX),
      });
      return {
        id: session.id,
        title: session.title,
        archived: session.archived,
        lastActivityAt: session.lastActivityAt,
        ...rendered,
      };
    },

    runResult(args: { runId: string }) {
      const run = mineRun(args.runId);
      const events = facade.runEvents(run.id);
      return {
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
        triggeredBy: run.triggeredBy,
        // Bounded like the answer: an automation's prompt may be 100 000
        // characters by schema, and a chained firing calls this on the run
        // that triggered it — unbounded, the upstream's instructions would sit
        // in front of the downstream's own.
        prompt: excerpt(run.prompt, FINAL_ANSWER_CHARS),
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        toolCalls: toolsCalled(events),
        finalText: finalAnswer(events),
      };
    },
  };
}

const asToolResult = (fn: () => unknown) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(fn(), null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
  }
};

export const SESSIONS_SERVER_NAME = 'metaclaude_sessions';

/**
 * The tools by name and ring; the workspace that mounts them pre-approves
 * exactly these. Everything here is ring 1 because everything here *reads* —
 * which is what makes the pre-approval sound rather than generous. A run under
 * `dontAsk` cannot raise a card at all, and an automation is exactly that run:
 * without the pre-approval these would be refused outright, every night,
 * silently, with the run still landing as a success.
 *
 * The server below must register exactly these names; a test holds the two
 * together, because a name that drifts is a tool that silently opens a card.
 */
export const SESSIONS_TOOL_CATALOGUE: ReadonlyArray<{
  name: string;
  ring: 1 | 2;
  description: string;
}> = [
  { name: 'session_list', ring: 1, description: 'The other sessions of this workspace, by title.' },
  { name: 'session_read', ring: 1, description: 'Read a session’s conversation, optionally windowed.' },
  { name: 'run_result', ring: 1, description: 'One run: its prompt, outcome and final answer.' },
];

/** The names as the CLI and the broker see them. */
export function sessionsToolNames(): string[] {
  return SESSIONS_TOOL_CATALOGUE.map((entry) => mcpToolName(SESSIONS_SERVER_NAME, entry.name));
}

export function buildSessionsServer(
  facade: SessionsFacade,
  scope: SessionsToolScope,
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createSessionsHandlers(facade, scope);

  return createSdkMcpServer({
    name: SESSIONS_SERVER_NAME,
    version: '1.0.0',
    tools: [
      sdkTool(
        'session_list',
        'The sessions of this workspace, most recently active first — this is how you turn a name the ' +
          'operator used ("the session about the API") into an id for session_read. The session you are ' +
          'in is marked isCurrent.',
        {
          query: z
            .string()
            .max(200)
            .optional()
            .describe('Match against the title; accents and case are ignored.'),
          includeArchived: z.boolean().optional().describe('Archived sessions too. Default false.'),
          limit: z.number().int().min(1).max(200).optional().describe('Default 40.'),
        },
        async (args) => asToolResult(() => handlers.list(args)),
      ),
      sdkTool(
        'session_read',
        'Read what was said in one session of this workspace: the messages and the replies, oldest first. ' +
          'Use it when you are asked to work from another session — "use the data from session X", "what ' +
          'did we conclude last week". Narrow with sinceHours rather than reading everything. If truncated ' +
          'is true the oldest turns were dropped to fit: say so rather than treating what you got as the ' +
          'whole conversation.',
        {
          sessionId: z.string().min(1).max(64).describe('From session_list.'),
          sinceHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 365)
            .optional()
            .describe('Only what was said in this many hours. 168 is the last seven days.'),
          tools: z
            .boolean()
            .optional()
            .describe('Include the tools each turn called. Default false — the dialogue alone.'),
          maxChars: z
            .number()
            .int()
            .min(500)
            .max(DIALOGUE_CHARS_MAX)
            .optional()
            .describe(`Character budget for the conversation. Default ${DIALOGUE_CHARS}.`),
        },
        async (args) => asToolResult(() => handlers.read(args)),
      ),
      sdkTool(
        'run_result',
        'One run of this workspace in full: what it was asked, how it ended, the tools it called and its ' +
          'final answer. This is how a chained automation reads what the automation before it produced — ' +
          'the run id is in the line that opens your prompt.',
        { runId: z.string().min(1).max(64) },
        async (args) => asToolResult(() => handlers.runResult(args)),
      ),
    ],
  });
}
