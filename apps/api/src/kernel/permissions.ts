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
  bareToolName,
  DANGEROUS_COMMAND_PATTERNS,
  HIGH_RISK_TOOLS,
  isDelegationTool,
  NETWORK_TOOLS,
  newId,
  READ_ONLY_TOOLS,
  SKILL_TOOL,
  SKILL_TOOL_FIELD,
  TOOL_SEARCH_TOOL,
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
  /** A previously remembered decision auto-approved a call, with no prompt. */
  onGrantUsed?: (info: {
    sessionId: string;
    runId: string;
    toolName: string;
    summary: string;
  }) => void;
}

/**
 * Key for a remembered decision.
 *
 * Deliberately narrower than the tool name. Keyed on the tool alone, an
 * operator approving `Bash: git status` and ticking "remember" would silently
 * authorise every later `Bash` in that session — including a destructive one
 * that would otherwise have raised a high-risk prompt. The key therefore also
 * carries the assessed risk and, for a shell command, its leading verb, so a
 * grant only covers calls that look like the one actually shown to the human.
 */
export function grantKey(
  sessionId: string,
  toolName: string,
  risk: 'low' | 'medium' | 'high',
  input: Record<string, unknown>,
): string {
  const bare = bareToolName(toolName);
  if ((bare === 'Bash' || bare === 'BashOutput') && typeof input.command === 'string') {
    // First bare word of the command — `git`, `pnpm`, `rm`. Anything with a
    // shell metacharacter before it is not a simple invocation and gets a key
    // that nothing else will match: the regex admits no NUL, so no real verb
    // can collide with this one.
    //
    // Written as the escape `\0`, never as a raw NUL byte in the source. Both
    // compile to the same string, but a raw one makes git treat the whole file
    // as binary — no diff, no blame, no review — and this file spent releases
    // that way without anyone noticing.
    const verb = /^\s*([A-Za-z0-9._/-]+)/.exec(input.command)?.[1] ?? '\0unparsed';
    return `${sessionId}::${toolName}::${risk}::${verb}`;
  }
  return `${sessionId}::${toolName}::${risk}`;
}

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  /**
   * Remembered decisions, keyed by `grantKey`. Scoped to a session so an
   * "always allow" never leaks into a different project.
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
    const risk = assessRisk(input.toolName, input.toolInput);
    const key = grantKey(input.sessionId, input.toolName, risk, input.toolInput);

    const remembered = this.sessionGrants.get(key);
    if (remembered === true) {
      // Surfaced so a remembered allow still leaves a trace; a grant that
      // silently authorises tool calls is a grant nobody can audit.
      this.hooks.onGrantUsed?.({
        sessionId: input.sessionId,
        runId: input.runId,
        toolName: input.toolName,
        summary: input.title ?? summarise(input.toolName, input.toolInput),
      });
      return Promise.resolve({ behavior: 'allow' });
    }
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
      risk,
      reason: input.decisionReason ?? null,
      createdAt: now,
      expiresAt: now + APPROVAL_TIMEOUT_MS,
    };

    return new Promise<PermissionOutcome>((resolve) => {
      let cleanupListener: (() => void) | null = null;

      const settle = (outcome: PermissionOutcome, approved: boolean): void => {
        const entry = this.pending.get(request.id);
        if (!entry) return; // Already resolved by another path.
        clearTimeout(entry.timer);
        cleanupListener?.();
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
      // The signal is run-scoped and shared by every tool call in the run, so
      // without this a run with many approvals accumulates one live closure per
      // approval and trips the max-listeners warning.
      cleanupListener = () => input.signal.removeEventListener('abort', denyAsInterrupted);

      this.hooks.onRequest(request);
    });
  }

  /** Apply an operator decision. Returns false if the prompt already expired. */
  resolve(approvalId: string, approved: boolean, remember: boolean, reason?: string): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;

    // The UI withholds "always allow" on a high-risk prompt, but that is a
    // client-side courtesy; enforce it here, where a hand-crafted request
    // cannot route around it. A remembered *denial* stays allowed at any risk —
    // it only ever narrows what the agent can do.
    const mayRemember = remember && (approved === false || entry.request.risk !== 'high');

    if (mayRemember) {
      this.sessionGrants.set(
        grantKey(
          entry.request.sessionId,
          entry.request.toolName,
          entry.request.risk,
          (entry.request.input ?? {}) as Record<string, unknown>,
        ),
        approved,
      );
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

  /** Remembered decisions for a session, for display in the UI. */
  listSessionGrants(sessionId: string): Array<{ key: string; approved: boolean }> {
    const prefix = `${sessionId}::`;
    return [...this.sessionGrants.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, approved]) => ({ key: key.slice(prefix.length), approved }));
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
  const bare = bareToolName(toolName);

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

  // Before the switch, because the delegation tool answers to two names and a
  // `case` per name would be two branches of one sentence. It is `Agent` in
  // every Claude Code measured here; `Task` is the name this repository
  // believed in for four releases and is kept as an alias, at the cost of one
  // array entry, because nothing here can see what a future CLI calls it.
  const bare = bareToolName(toolName);
  if (isDelegationTool(bare)) {
    return `Delegate to a subagent: ${truncate(str('description') ?? '', 100)}`;
  }

  switch (bare) {
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
    case SKILL_TOOL:
      return `Open the skill: ${truncate(str(SKILL_TOOL_FIELD) ?? '?', 100)}`;
    // Never an approval card — the CLI answers this one itself — but it *is*
    // in the transcript, and without a case here it fell through to the branch
    // that prints raw JSON. An operator reading a run sees it before nearly
    // every MCP call, so an unexplained blob there reads as the agent doing
    // something odd rather than as the CLI fetching a tool it was told about.
    case TOOL_SEARCH_TOOL:
      return `Load the tools matching: ${truncate(str('query') ?? '?', 80)}`;
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

/**
 * Cap a permission mode at what an unattended caller may have.
 *
 * A run started through the MCP gateway has nobody behind it. Two modes are
 * therefore unusable rather than merely risky: `default` and `auto` can open a
 * permission prompt, and a prompt nobody answers sits for ten minutes and then
 * fails — a worse outcome than refusing the tool outright, because it burns a
 * slot and reports a timeout instead of a reason. `bypassPermissions` is the
 * one mode a token must never reach at all.
 *
 * So the workspace's own mode is *not* honoured when it is one of those three;
 * the token's ceiling stands in for it. Where both are non-interactive, the
 * lesser wins: a workspace set to `plan` is not widened by a token allowed to
 * edit. The ceiling is a maximum, never a grant.
 */
const UNATTENDED_RANK: Record<string, number> = { plan: 0, dontAsk: 1, acceptEdits: 2 };

export function capPermissionMode(
  workspaceMode: PermissionMode,
  ceiling: 'plan' | 'dontAsk' | 'acceptEdits',
): PermissionMode {
  const requested = UNATTENDED_RANK[workspaceMode];
  // Interactive or unbounded: there is nothing here to take the lesser of.
  if (requested === undefined) return ceiling;
  return requested <= UNATTENDED_RANK[ceiling]! ? workspaceMode : ceiling;
}
