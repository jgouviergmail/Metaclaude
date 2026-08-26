/**
 * The Claude CLI's own sessions, listed and adopted into Metaclaude.
 *
 * The CLI keeps its transcripts in its own home-directory store, and the SDK's
 * `listSessions` reads that store directly — sessions Metaclaude started, and
 * sessions that arrived any other way (a transcript carried over from another
 * machine, a session created in a shell). Adoption is the bridge: a Metaclaude
 * session row bound to the CLI session id, after which resuming, steering and
 * accounting work exactly as for a native session.
 *
 * The one rule that matters is that the *listing* is the authority. A client
 * sends only an id; honouring an id the CLI did not list for this workspace's
 * directory would let a caller bind — and then talk to — a session from any
 * directory the CLI has ever seen, help sessions and other workspaces
 * included. So adoption re-lists and refuses anything not in the answer.
 */

import type { ClaudeCliSession, Session } from '@metaclaude/shared';
import type { SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';

/** The slice of the SDK's SDKSessionInfo this service reads. */
export interface CliSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
}

export interface ClaudeSessionsDeps {
  /** The SDK's `listSessions`, injectable so tests never touch the CLI store. */
  list: (options: { dir: string }) => Promise<CliSessionInfo[]>;
  workspaces: WorkspaceRepo;
  sessions: SessionRepo;
}

export class ClaudeSessionsError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'ClaudeSessionsError';
  }
}

export class ClaudeSessions {
  constructor(private readonly deps: ClaudeSessionsDeps) {}

  async listForWorkspace(workspaceId: string): Promise<ClaudeCliSession[]> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (!workspace) throw new ClaudeSessionsError('That workspace does not exist.', 404);

    const adopted = this.deps.sessions.claudeSessionIndex(workspaceId);
    const listed = await this.deps.list({ dir: workspace.path });

    return listed
      .map((info) => ({
        sessionId: info.sessionId,
        summary: info.summary,
        lastModified: info.lastModified,
        firstPrompt: info.firstPrompt ?? null,
        gitBranch: info.gitBranch ?? null,
        cwd: info.cwd ?? null,
        createdAt: info.createdAt ?? null,
        adoptedBy: adopted.get(info.sessionId) ?? null,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  async adopt(workspaceId: string, claudeSessionId: string): Promise<Session> {
    const listed = await this.listForWorkspace(workspaceId);
    const target = listed.find((session) => session.sessionId === claudeSessionId);
    if (!target) {
      throw new ClaudeSessionsError(
        'The CLI did not list that session for this workspace, so it cannot be adopted here.',
        404,
      );
    }
    const workspace = this.deps.workspaces.get(workspaceId);
    if (!workspace) throw new ClaudeSessionsError('That workspace does not exist.', 404);

    // The adopted-state in `target` is a snapshot from before the awaited CLI
    // listing, and two concurrent adoptions can both hold one. Re-read the
    // index here, in the same synchronous stretch as the write — the shape
    // the login races taught (see consumeSecondFactor): nothing may yield
    // between the check and the write it guards.
    if (this.deps.sessions.claudeSessionIndex(workspaceId).has(claudeSessionId)) {
      throw new ClaudeSessionsError('That session is already adopted — open it instead.', 409);
    }

    const session = this.deps.sessions.create({
      workspaceId,
      title: target.summary,
      model: String(workspace.settings.defaultModel),
      effort: workspace.settings.defaultEffort,
      permissionMode: workspace.settings.defaultPermissionMode,
    });
    this.deps.sessions.setClaudeSessionId(session.id, claudeSessionId);

    // Re-read rather than patching the object: what the caller gets is what
    // the database now says.
    return this.deps.sessions.get(session.id) as Session;
  }
}
