/**
 * Permission brokering.
 *
 * The Agent SDK calls `canUseTool` whenever a tool needs a human decision. We
 * turn that call into a pending promise, push an approval card to every
 * subscribed client, and resolve when someone answers — or deny on timeout.
 *
 * Two properties matter here:
 *  1. A prompt that is never answered must not wedge the run forever.
 *  2. A denied tool must produce a message the model can actually act on,
 *     otherwise it retries the same call in a loop.
 */

import type { ApprovalRequest, PermissionMode } from '@metaclaude/shared';
import {
  APPROVAL_TIMEOUT_MS,
  DANGEROUS_COMMAND_PATTERNS,
  HIGH_RISK_TOOLS,
  NETWORK_TOOLS,
  newId,
  READ_ONLY_TOOLS,
} from '@metaclaude/shared';

export type PermissionOutcome =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

interface Pending {
  request: ApprovalRequest;
  resolve: (outcome: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface PermissionBrokerHooks {
  onRequest: (request: ApprovalRequest) => void;
  onResolved: (approvalId: string, approved: boolean) => void;
}

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  /**
   * `remember` decisions, keyed `<sessionId>::<toolName>`. Scoped to a session
   * so an "always allow" never leaks into a different project.
   */
  private readonly sessionGrants = new Map<string, boolean>();

  constructor(private readonly hooks: PermissionBrokerHooks) {}

  /**
   * Ask the operator about a tool call.
   * Resolves with the decision, or a denial once `APPROVAL_TIMEOUT_MS` elapses.
   */
  request(input: {
    runId: string;
    sessionId: string;
    workspaceId: string;
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    title?: string;
    decisionReason?: string;
    signal: AbortSignal;
  }): Promise<PermissionOutcome> {
    const grantKey = `${input.sessionId}::${input.toolName}`;
    const remembered = this.sessionGrants.get(grantKey);
    if (remembered === true) return Promise.resolve({ behavior: 'allow' });
    if (remembered === false) {
      return Promise.resolve({
        behavior: 'deny',
        message: `The operator has denied ${input.toolName} for this session. Do not retry it; find another approach or ask what to do instead.`,
      });
    }

    const now = Date.now();
    const request: ApprovalRequest = {
      id: newId('approval'),
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      input: input.toolInput,
      summary: input.title ?? summarise(input.toolName, input.toolInput),
      risk: assessRisk(input.toolName, input.toolInput),
      reason: input.decisionReason ?? null,
      createdAt: now,
      expiresAt: now + APPROVAL_TIMEOUT_MS,
    };

    return new Promise<PermissionOutcome>((resolve) => {
      const settle = (outcome: PermissionOutcome, approved: boolean): void => {
        const entry = this.pending.get(request.id);
        if (!entry) return; // Already resolved by another path.
        clearTimeout(entry.timer);
        this.pending.delete(request.id);
        this.hooks.onResolved(request.id, approved);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        settle(
          {
            behavior: 'deny',
            message: `No operator answered the permission prompt for ${input.toolName} within ${Math.round(
              APPROVAL_TIMEOUT_MS / 60_000,
            )} minutes, so it was declined. Continue with what you can do without it, or stop and summarise what you need.`,
          },
          false,
        );
      }, APPROVAL_TIMEOUT_MS);
      // A pending approval must not hold the process open at shutdown.
      timer.unref?.();

      this.pending.set(request.id, { request, resolve, timer });

      const denyAsInterrupted = (): void =>
        settle({ behavior: 'deny', message: 'The run was interrupted by the operator.' }, false);

      // An already-aborted signal never fires 'abort', so checking the flag
      // first is what stops the promise hanging for the full timeout when a
      // tool is requested after the run was cancelled.
      if (input.signal.aborted) {
        denyAsInterrupted();
        return;
      }
      input.signal.addEventListener('abort', denyAsInterrupted, { once: true });

      this.hooks.onRequest(request);
    });
  }

  /** Apply an operator decision. Returns false if the prompt already expired. */
  resolve(approvalId: string, approved: boolean, remember: boolean, reason?: string): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;

    if (remember) {
      this.sessionGrants.set(`${entry.request.sessionId}::${entry.request.toolName}`, approved);
    }

    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    this.hooks.onResolved(approvalId, approved);

    entry.resolve(
      approved
        ? { behavior: 'allow' }
        : {
            behavior: 'deny',
            message:
              reason?.trim() ||
              `The operator declined ${entry.request.toolName}. Do not retry the same call; either take a different approach or explain what you need and stop.`,
          },
    );
    return true;
  }

  /** Approvals still awaiting an answer, for rendering on reconnect. */
  listPending(filter?: { sessionId?: string }): ApprovalRequest[] {
    const all = [...this.pending.values()].map((p) => p.request);
    return filter?.sessionId ? all.filter((r) => r.sessionId === filter.sessionId) : all;
  }

  /** Deny every prompt belonging to a run — used when the run is interrupted. */
  cancelRun(runId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.runId === runId) {
        this.resolve(id, false, false, 'The run was interrupted.');
      }
    }
  }

  /** Forget the "always allow/deny" grants for a session. */
  clearSessionGrants(sessionId: string): void {
    for (const key of this.sessionGrants.keys()) {
      if (key.startsWith(`${sessionId}::`)) this.sessionGrants.delete(key);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Risk heuristics                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Classify a tool call so the UI can colour the prompt and pick a safe default.
 * This is advisory only — it never grants anything, it just informs the human.
 */
export function assessRisk(
  toolName: string,
  input: Record<string, unknown>,
): 'low' | 'medium' | 'high' {
  const bare = toolName.replace(/^mcp__[^_]+__/, '');

  if (bare === 'Bash' || bare === 'BashOutput') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return 'high';
    return 'medium';
  }

  if ((HIGH_RISK_TOOLS as readonly string[]).includes(bare)) return 'medium';
  if ((NETWORK_TOOLS as readonly string[]).includes(bare)) return 'medium';
  if ((READ_ONLY_TOOLS as readonly string[]).includes(bare)) return 'low';

  // An unknown MCP tool reaches an external system we cannot reason about.
  if (toolName.startsWith('mcp__')) return 'medium';
  return 'low';
}

/** One-line, human-readable description of what a tool call will do. */
export function summarise(toolName: string, input: Record<string, unknown>): string {
  const str = (key: string): string | null =>
    typeof input[key] === 'string' ? (input[key] as string) : null;

  switch (toolName.replace(/^mcp__[^_]+__/, '')) {
    case 'Bash':
      return `Run: ${truncate(str('command') ?? '', 160)}`;
    case 'Read':
      return `Read ${str('file_path') ?? 'a file'}`;
    case 'Write':
      return `Write ${str('file_path') ?? 'a file'}`;
    case 'Edit':
      return `Edit ${str('file_path') ?? 'a file'}`;
    case 'Glob':
      return `Find files matching ${str('pattern') ?? '?'}`;
    case 'Grep':
      return `Search for ${truncate(str('pattern') ?? '?', 80)}`;
    case 'WebFetch':
      return `Fetch ${str('url') ?? 'a URL'}`;
    case 'WebSearch':
      return `Search the web for ${truncate(str('query') ?? '?', 80)}`;
    case 'Task':
      return `Delegate to a subagent: ${truncate(str('description') ?? '', 100)}`;
    default:
      return `${toolName}${describeArgs(input)}`;
  }
}

function describeArgs(input: Record<string, unknown>): string {
  const keys = Object.keys(input).slice(0, 3);
  if (keys.length === 0) return '';
  const parts = keys.map((key) => {
    const value = input[key];
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    return `${key}=${truncate(rendered ?? '', 48)}`;
  });
  return ` (${parts.join(', ')})`;
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Map our permission mode onto what the SDK accepts, refusing `bypassPermissions`
 * unless the deployment explicitly enabled it.
 */
export function resolvePermissionMode(
  requested: PermissionMode,
  allowBypass: boolean,
): PermissionMode {
  if (requested === 'bypassPermissions' && !allowBypass) return 'default';
  return requested;
}
