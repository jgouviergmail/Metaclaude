/**
 * Automations — the loop engine.
 *
 * An automation is a prompt plus a trigger. On each firing the scheduler submits
 * a run to the kernel exactly as a human would, which means automations get the
 * same permissions, the same memory retrieval and the same learning loop.
 *
 * Two modes:
 *  - one-shot: each firing starts a fresh session.
 *  - continuous: every firing continues the *same* session, so the agent keeps
 *    its accumulated context across firings. This is what turns a schedule into
 *    a genuinely long-running agent rather than a repeated cold start.
 *
 * Safety rails that matter for something that runs unattended:
 *  - Consecutive failures disable the automation instead of retrying forever.
 *  - A firing is skipped, not queued, when the previous one is still running.
 *  - A missed window (server was down) fires once, never once per missed slot.
 */

import type { Automation, AutomationTrigger, RunStatus } from '@metaclaude/shared';
import { newId, workspaceTopic } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { parseJson, toBool, toInt } from '../db/index.js';
import type { EventBus } from '../kernel/bus.js';
import type { Kernel } from '../kernel/kernel.js';
import type { SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { isValidCron, nextFireTime, parseCron } from './cron.js';

export class SchedulerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'SchedulerError';
  }
}

interface AutomationRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  prompt: string;
  trigger: string;
  policy: string;
  continuous: number;
  session_id: string | null;
  max_consecutive_failures: number;
  consecutive_failures: number;
  enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  next_run_at: number | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

const DEFAULT_POLICY: Automation['policy'] = {
  model: 'default',
  effort: null,
  permissionMode: 'default',
  agentName: null,
  maxTurns: null,
};

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    trigger: parseJson<AutomationTrigger>(row.trigger, { type: 'manual' }),
    policy: parseJson<Automation['policy']>(row.policy, DEFAULT_POLICY),
    continuous: toBool(row.continuous),
    sessionId: row.session_id,
    maxConsecutiveFailures: row.max_consecutive_failures,
    consecutiveFailures: row.consecutive_failures,
    enabled: toBool(row.enabled),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as RunStatus | null,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SchedulerDeps {
  db: Db;
  bus: EventBus;
  kernel: Kernel;
  sessions: SessionRepo;
  workspaces: WorkspaceRepo;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** How often the scheduler wakes to look for due automations. */
const TICK_INTERVAL_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                    */
  /* ---------------------------------------------------------------------- */

  list(workspaceId?: string): Automation[] {
    const rows = workspaceId
      ? this.deps.db
          .prepare<[string], AutomationRow>(
            'SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at DESC',
          )
          .all(workspaceId)
      : this.deps.db
          .prepare<[], AutomationRow>('SELECT * FROM automations ORDER BY created_at DESC')
          .all();
    return rows.map(toAutomation);
  }

  get(id: string): Automation | null {
    const row = this.deps.db
      .prepare<[string], AutomationRow>('SELECT * FROM automations WHERE id = ?')
      .get(id);
    return row ? toAutomation(row) : null;
  }

  create(input: {
    workspaceId: string;
    name: string;
    description?: string;
    prompt: string;
    trigger: AutomationTrigger;
    policy?: Partial<Automation['policy']>;
    continuous?: boolean;
    maxConsecutiveFailures?: number;
    enabled?: boolean;
  }): Automation {
    this.validateTrigger(input.trigger);
    if (!this.deps.workspaces.get(input.workspaceId)) {
      throw new SchedulerError('Unknown workspace.', 404);
    }

    const id = newId('automation');
    const now = Date.now();
    const enabled = input.enabled ?? true;

    this.deps.db
      .prepare(
        `INSERT INTO automations
           (id, workspace_id, name, description, prompt, trigger, policy, continuous,
            max_consecutive_failures, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.description ?? '',
        input.prompt,
        JSON.stringify(input.trigger),
        JSON.stringify({ ...DEFAULT_POLICY, ...(input.policy ?? {}) }),
        toInt(input.continuous ?? false),
        input.maxConsecutiveFailures ?? 3,
        toInt(enabled),
        enabled ? this.computeNextRun(input.trigger, now) : null,
        now,
        now,
      );

    const automation = this.get(id) as Automation;
    this.publish(automation);
    return automation;
  }

  update(id: string, patch: Partial<Omit<Automation, 'id' | 'workspaceId'>>): Automation | null {
    const current = this.get(id);
    if (!current) return null;
    if (patch.trigger) this.validateTrigger(patch.trigger);

    const trigger = patch.trigger ?? current.trigger;
    const enabled = patch.enabled ?? current.enabled;

    this.deps.db
      .prepare(
        `UPDATE automations SET
           name = ?, description = ?, prompt = ?, trigger = ?, policy = ?, continuous = ?,
           max_consecutive_failures = ?, enabled = ?, next_run_at = ?,
           consecutive_failures = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        patch.prompt ?? current.prompt,
        JSON.stringify(trigger),
        JSON.stringify({ ...current.policy, ...(patch.policy ?? {}) }),
        toInt(patch.continuous ?? current.continuous),
        patch.maxConsecutiveFailures ?? current.maxConsecutiveFailures,
        toInt(enabled),
        enabled ? this.computeNextRun(trigger, Date.now()) : null,
        // Re-enabling clears the failure counter: the operator has presumably
        // fixed whatever was wrong.
        enabled && !current.enabled ? 0 : (patch.consecutiveFailures ?? current.consecutiveFailures),
        Date.now(),
        id,
      );

    const updated = this.get(id) as Automation;
    this.publish(updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.deps.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
  }

  private validateTrigger(trigger: AutomationTrigger): void {
    if (trigger.type === 'cron' && !isValidCron(trigger.expression)) {
      throw new SchedulerError(`"${trigger.expression}" is not a valid cron expression.`);
    }
    if (trigger.type === 'interval' && trigger.everyMs < 60_000) {
      throw new SchedulerError('The shortest interval is one minute.');
    }
  }

  private computeNextRun(trigger: AutomationTrigger, from: number): number | null {
    switch (trigger.type) {
      case 'cron':
        try {
          return nextFireTime(parseCron(trigger.expression), from);
        } catch {
          return null;
        }
      case 'interval':
        return from + trigger.everyMs;
      default:
        // `manual` and `event` triggers are never time-scheduled.
        return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                               */
  /* ---------------------------------------------------------------------- */

  /** Fire an automation now, regardless of its schedule. */
  async fire(id: string, triggeredBy: 'automation' | 'loop' | 'user' = 'automation'): Promise<string> {
    const automation = this.get(id);
    if (!automation) throw new SchedulerError('Unknown automation.', 404);

    const workspace = this.deps.workspaces.get(automation.workspaceId);
    if (!workspace) throw new SchedulerError('The automation’s workspace no longer exists.', 404);

    const sessionId = this.resolveSession(automation, workspace.id);

    // Skipping rather than queueing: a slow automation firing every minute
    // would otherwise build an unbounded backlog.
    if (this.deps.kernel.hasActiveRunForSession(sessionId)) {
      throw new SchedulerError('The previous run of this automation is still in flight.', 409);
    }

    const run = await this.deps.kernel.submit({
      sessionId,
      prompt: automation.prompt,
      triggeredBy: automation.continuous ? 'loop' : triggeredBy,
      overrides: {
        model: automation.policy.model,
        effort: automation.policy.effort,
        permissionMode: automation.policy.permissionMode,
        agentName: automation.policy.agentName,
      },
    });

    this.deps.db
      .prepare(
        `UPDATE automations SET
           last_run_at = ?, run_count = run_count + 1, session_id = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        sessionId,
        automation.enabled ? this.computeNextRun(automation.trigger, Date.now()) : null,
        Date.now(),
        id,
      );

    this.publish(this.get(id) as Automation);
    return run.id;
  }

  /**
   * Pick the session an automation should run in.
   * Continuous automations reuse one session so context accumulates; one-shot
   * automations get a fresh session per firing.
   */
  private resolveSession(automation: Automation, workspaceId: string): string {
    if (automation.continuous && automation.sessionId) {
      const existing = this.deps.sessions.get(automation.sessionId);
      if (existing && !existing.archived) return existing.id;
    }

    const session = this.deps.sessions.create({
      workspaceId,
      title: automation.continuous ? `↻ ${automation.name}` : `⏱ ${automation.name}`,
      model: String(automation.policy.model),
      effort: automation.policy.effort,
      permissionMode: automation.policy.permissionMode,
      agentName: automation.policy.agentName,
    });
    return session.id;
  }

  /**
   * Record how a run belonging to an automation ended.
   * Wired to the event bus in `context.ts`; a session with no automation is a
   * no-op, so this is safe to call for every finished run.
   *
   * `attended` distinguishes a human pressing "Run now" from an unattended
   * firing. Both update `lastStatus` — the UI shows it either way — but only an
   * unattended failure counts toward the auto-disable guard. Someone actively
   * debugging an automation should not have it switched off underneath them.
   */
  recordOutcome(sessionId: string, status: RunStatus, attended = false): void {
    const row = this.deps.db
      .prepare<[string], AutomationRow>('SELECT * FROM automations WHERE session_id = ?')
      .get(sessionId);
    if (!row) return;

    const failed = status === 'failed';
    const consecutive = attended ? row.consecutive_failures : failed ? row.consecutive_failures + 1 : 0;
    const shouldDisable =
      !attended &&
      failed &&
      row.max_consecutive_failures > 0 &&
      consecutive >= row.max_consecutive_failures;

    this.deps.db
      .prepare(
        `UPDATE automations SET last_status = ?, consecutive_failures = ?, enabled = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        consecutive,
        shouldDisable ? 0 : row.enabled,
        shouldDisable ? null : row.next_run_at,
        Date.now(),
        row.id,
      );

    if (shouldDisable) {
      this.deps.log('warn', `automation "${row.name}" disabled after ${consecutive} failures`);
      this.deps.bus.publish('system', {
        type: 'notification',
        topic: 'system',
        level: 'error',
        title: 'Automation disabled',
        message: `"${row.name}" failed ${consecutive} times in a row and was switched off.`,
        href: `/automations`,
      });
    }
    this.publish(this.get(row.id) as Automation);
  }

  /* ---------------------------------------------------------------------- */
  /* Ticking                                                                 */
  /* ---------------------------------------------------------------------- */

  start(): void {
    if (this.timer) return;
    // On boot, re-derive every next_run_at: expressions may have changed and
    // stale values from before a long downtime would fire a burst.
    this.rescheduleAll();

    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();
    this.deps.log('info', 'scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire everything that is due. Exposed for tests. */
  async tick(now: number = Date.now()): Promise<number> {
    // Overlapping ticks would double-fire; a slow kernel submit is enough to
    // make that reachable at a 30s interval.
    if (this.ticking) return 0;
    this.ticking = true;

    try {
      const due = this.deps.db
        .prepare<[number], AutomationRow>(
          'SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
        )
        .all(now);

      let fired = 0;
      for (const row of due) {
        try {
          await this.fire(row.id);
          fired += 1;
        } catch (error) {
          // A conflict (previous run still going) is expected and benign; log
          // anything else, but never let one automation stop the others.
          const status = (error as SchedulerError).statusCode;
          if (status !== 409) {
            this.deps.log('warn', `automation "${row.name}" failed to fire`, {
              message: (error as Error).message,
            });
          }
          // Always move the schedule forward, otherwise a permanently failing
          // automation is retried on every single tick.
          this.deps.db
            .prepare('UPDATE automations SET next_run_at = ? WHERE id = ?')
            .run(this.computeNextRun(toAutomation(row).trigger, now), row.id);
        }
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }

  /** Recompute `next_run_at` for every enabled automation from now. */
  rescheduleAll(now: number = Date.now()): void {
    const rows = this.deps.db
      .prepare<[], AutomationRow>('SELECT * FROM automations WHERE enabled = 1')
      .all();
    const update = this.deps.db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?');

    for (const row of rows) {
      update.run(this.computeNextRun(toAutomation(row).trigger, now), row.id);
    }
  }

  private publish(automation: Automation): void {
    const topic = workspaceTopic(automation.workspaceId);
    this.deps.bus.publish(topic, { type: 'automation', topic, automation });
  }
}
