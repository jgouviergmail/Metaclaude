/**
 * The board autopilot — the kanban as a work queue that drains itself.
 *
 * Everything it does composes pieces that already exist: `startTaskRun` is
 * the same path as the card's "Send to the agent" button, the outcome hook
 * already lands success in Review and failures in a blocked reason, and the
 * column order is the human's. What this adds is only the loop: when a card
 * run ends and the workspace opted in, the next To do card starts by
 * itself.
 *
 * The rules that keep it trustworthy, in order of importance:
 *
 *  - One card at a time per workspace. A backlog is a queue, not a fan-out,
 *    and two card runs would collide on one working tree anyway.
 *  - The human's order decides. The top unblocked To do card is next —
 *    never the machine's own idea of priority.
 *  - Blocked cards are skipped, not retried into the ground. Unblocking is
 *    a human act (or the agent's, with a reason), and either shows.
 *  - The quota guard stops *automatic* starts above the threshold. A human
 *    pressing the button outranks it: the guard exists to keep the
 *    machinery from eating the window, not to refuse people.
 */

import type { BoardTask, Run, Workspace } from '@metaclaude/shared';

const ACTIVE = new Set<Run['status']>(['queued', 'running', 'waiting_approval']);

export type AutopilotReason = 'started' | 'busy' | 'empty' | 'quota' | 'off';

export interface BoardAutopilotDeps {
  boardTasks: { board(workspaceId: string): BoardTask[] };
  workspaces: {
    get(id: string): Workspace | null;
    list(includeArchived?: boolean): Workspace[];
  };
  runs: { get(id: string): Run | null };
  /** `startTaskRun`, bound to its own deps; the username signs the board history. */
  start: (taskId: string, username: string) => Promise<unknown>;
  /**
   * The plan's worst window utilization (0–100) for the workspace's
   * directory, or null when unknowable — API-key mode, a failed probe.
   */
  quota: { utilization(workspacePath: string): Promise<number | null> };
  /** Automatic starts wait above this percentage. 100 disables the guard. */
  guardPct: number;
  log: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export class BoardAutopilot {
  constructor(private readonly deps: BoardAutopilotDeps) {}

  /** The card the autopilot would start: the top unblocked To do. */
  nextCard(workspaceId: string): BoardTask | null {
    // Sorted here rather than trusted: the real board() orders by
    // (status, orderKey) in SQL, but relying on a dependency's implicit
    // ordering is how a refactor two files away reorders the queue.
    const todo = this.deps.boardTasks
      .board(workspaceId)
      .filter((task) => task.status === 'todo' && task.blockedReason === null)
      .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
    return todo[0] ?? null;
  }

  /** True while any card in the workspace has a live run on it. */
  busy(workspaceId: string): boolean {
    return this.deps.boardTasks.board(workspaceId).some((task) => {
      if (!task.runId) return false;
      const run = this.deps.runs.get(task.runId);
      return run !== null && ACTIVE.has(run.status);
    });
  }

  /**
   * Start the next card, if the rules allow. `manual` marks a human press:
   * it bypasses the opt-in and the quota guard, never the busy rule.
   */
  async workNext(
    workspaceId: string,
    options: { manual: boolean; username?: string },
  ): Promise<{ started: BoardTask | null; reason: AutopilotReason }> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (!workspace) return { started: null, reason: 'off' };
    if (!options.manual && !workspace.settings.autoWorkBoard) {
      return { started: null, reason: 'off' };
    }
    if (this.busy(workspaceId)) return { started: null, reason: 'busy' };

    const next = this.nextCard(workspaceId);
    if (!next) return { started: null, reason: 'empty' };

    if (!options.manual) {
      const utilization = await this.deps.quota.utilization(workspace.path).catch(() => null);
      // Fail open on null: an unknowable quota (API-key mode, a broken
      // probe) must not silently freeze the queue — runs stay visible,
      // a frozen board is not.
      if (utilization !== null && utilization >= this.deps.guardPct) {
        this.deps.log('info', 'autopilot deferred to the quota guard', {
          workspaceId,
          utilization,
          guardPct: this.deps.guardPct,
        });
        return { started: null, reason: 'quota' };
      }
    }

    await this.deps.start(next.id, options.username ?? 'autopilot');
    this.deps.log('info', 'autopilot started the next card', {
      workspaceId,
      taskId: next.id,
    });
    return { started: next, reason: 'started' };
  }

  /**
   * The chain: a finished run in an opted-in workspace pulls the next card.
   * Never rejects; the kernel hook fires it and forgets it, tests await it.
   */
  onRunFinished(run: Run): Promise<void> {
    return this.workNext(run.workspaceId, { manual: false }).then(
      () => undefined,
      (error: Error) => {
        this.deps.log('warn', 'autopilot could not chain after a run', {
          workspaceId: run.workspaceId,
          message: error.message,
        });
      },
    );
  }

  /**
   * The safety net: revisit every opted-in workspace. Catches the stalls
   * the chain cannot see — a quota deferral with nothing left to finish, a
   * kernel refusal, cards added while the board was idle.
   */
  async sweep(): Promise<void> {
    for (const workspace of this.deps.workspaces.list(false)) {
      if (!workspace.settings.autoWorkBoard) continue;
      try {
        await this.workNext(workspace.id, { manual: false });
      } catch (error) {
        // One workspace's refusal is weather; the sweep visits the rest.
        this.deps.log('warn', 'autopilot sweep skipped a workspace', {
          workspaceId: workspace.id,
          message: (error as Error).message,
        });
      }
    }
  }
}

/**
 * The plan windows' worst utilization, from the CLI's usage answer.
 * Model buckets are ignored on purpose: one saturated model must not stall
 * cards that would run on another.
 */
export function planUtilization(usage: {
  windows: { key: string; utilization: number | null }[];
}): number | null {
  let worst: number | null = null;
  for (const window of usage.windows) {
    if (window.key.startsWith('model:')) continue;
    if (window.utilization === null) continue;
    worst = worst === null ? window.utilization : Math.max(worst, window.utilization);
  }
  return worst;
}
