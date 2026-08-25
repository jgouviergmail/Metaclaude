import type { Automation, AutomationTrigger, ServerFrame, Workspace } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { EventBus } from '../kernel/bus.js';
import type { Kernel } from '../kernel/kernel.js';
import { defaultWorkspaceSettings, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { Scheduler, SchedulerError } from './scheduler.js';

/**
 * The kernel is the one dependency that would reach a real Claude subprocess,
 * so it is stubbed down to the two methods the scheduler actually calls.
 */
interface KernelStub {
  submit: ReturnType<typeof vi.fn>;
  hasActiveRunForSession: ReturnType<typeof vi.fn>;
}

/** Monday 15 January 2024, 08:30 local — the anchor for every expectation. */
const NOW = new Date(2024, 0, 15, 8, 30).getTime();
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m, d, h, min).getTime();

const MINUTE = 60_000;

let db: Db;
let bus: EventBus;
let kernel: KernelStub;
let sessions: SessionRepo;
let workspaces: WorkspaceRepo;
let scheduler: Scheduler;
let workspace: Workspace;
let logged: Array<{ level: string; message: string }>;

function sessionCount(): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sessions').get()!.n;
}

function make(
  overrides: Partial<Parameters<Scheduler['create']>[0]> & { trigger?: AutomationTrigger } = {},
): Automation {
  return scheduler.create({
    workspaceId: workspace.id,
    name: 'Nightly report',
    prompt: 'Summarise what changed today.',
    trigger: { type: 'cron', expression: '0 9 * * *' },
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));

  db = openDatabase({ path: ':memory:' });
  migrate(db);

  bus = new EventBus();
  sessions = new SessionRepo(db);
  workspaces = new WorkspaceRepo(db);
  kernel = {
    submit: vi.fn(async () => ({ id: 'run_x' })),
    hasActiveRunForSession: vi.fn(() => false),
  };
  logged = [];

  workspace = workspaces.create({
    name: 'Alpha',
    slug: 'alpha',
    description: '',
    path: '/tmp/alpha',
    color: '#6366f1',
    icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });

  scheduler = new Scheduler({
    db,
    bus,
    kernel: kernel as unknown as Kernel,
    sessions,
    workspaces,
    log: (level, message) => {
      logged.push({ level, message });
    },
  });
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
  db.close();
});

/* -------------------------------------------------------------------------- */
/* create / update / delete                                                    */
/* -------------------------------------------------------------------------- */

describe('create', () => {
  it('stores the automation and reads it back through the domain mapping', () => {
    const automation = make({ description: 'daily digest', maxConsecutiveFailures: 5 });

    expect(automation.id.startsWith('aut_')).toBe(true);
    expect(automation.workspaceId).toBe(workspace.id);
    expect(automation.name).toBe('Nightly report');
    expect(automation.description).toBe('daily digest');
    expect(automation.prompt).toBe('Summarise what changed today.');
    expect(automation.trigger).toEqual({ type: 'cron', expression: '0 9 * * *' });
    expect(automation.enabled).toBe(true);
    expect(automation.continuous).toBe(false);
    expect(automation.sessionId).toBeNull();
    expect(automation.runCount).toBe(0);
    expect(automation.consecutiveFailures).toBe(0);
    expect(automation.maxConsecutiveFailures).toBe(5);
    expect(automation.lastRunAt).toBeNull();
    expect(automation.lastStatus).toBeNull();
    expect(scheduler.get(automation.id)).toEqual(automation);
  });

  it('merges the supplied policy over the defaults', () => {
    const automation = make({ policy: { model: 'sonnet', effort: 'high' } });
    expect(automation.policy).toEqual({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      agentName: null,
      maxTurns: null,
    });
  });

  it('rejects an invalid cron expression', () => {
    expect(() => make({ trigger: { type: 'cron', expression: 'not a cron' } })).toThrow(
      SchedulerError,
    );
    try {
      make({ trigger: { type: 'cron', expression: '60 * * * *' } });
      expect.unreachable('an out-of-range cron expression must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SchedulerError);
      expect((error as SchedulerError).statusCode).toBe(400);
      expect((error as Error).message).toContain('not a valid cron expression');
    }
    expect(scheduler.list()).toHaveLength(0);
  });

  it('rejects a sub-minute interval', () => {
    for (const everyMs of [0, 1, 1000, 59_999]) {
      try {
        make({ trigger: { type: 'interval', everyMs } });
        expect.unreachable(`${everyMs}ms must be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(SchedulerError);
        expect((error as Error).message).toBe('The shortest interval is one minute.');
      }
    }
    // Exactly one minute is allowed.
    expect(make({ trigger: { type: 'interval', everyMs: MINUTE } }).nextRunAt).toBe(NOW + MINUTE);
  });

  it('rejects an unknown workspace', () => {
    try {
      scheduler.create({
        workspaceId: 'ws_nope',
        name: 'x',
        prompt: 'y',
        trigger: { type: 'manual' },
      });
      expect.unreachable('an unknown workspace must be rejected');
    } catch (error) {
      expect((error as SchedulerError).statusCode).toBe(404);
    }
  });

  it('computes nextRunAt for a cron trigger', () => {
    expect(make({ trigger: { type: 'cron', expression: '0 9 * * *' } }).nextRunAt).toBe(
      at(2024, 0, 15, 9, 0),
    );
    expect(make({ name: 'b', trigger: { type: 'cron', expression: '*/15 * * * *' } }).nextRunAt).toBe(
      at(2024, 0, 15, 8, 45),
    );
    expect(make({ name: 'c', trigger: { type: 'cron', expression: '0 0 1 * *' } }).nextRunAt).toBe(
      at(2024, 1, 1, 0, 0),
    );
  });

  it('computes nextRunAt for an interval trigger', () => {
    expect(make({ trigger: { type: 'interval', everyMs: 15 * MINUTE } }).nextRunAt).toBe(
      NOW + 15 * MINUTE,
    );
  });

  it('leaves nextRunAt null for manual and event triggers', () => {
    expect(make({ trigger: { type: 'manual' } }).nextRunAt).toBeNull();
    expect(
      make({ name: 'b', trigger: { type: 'event', event: 'run_failed' } }).nextRunAt,
    ).toBeNull();
  });

  it('leaves nextRunAt null when the automation is created disabled', () => {
    const automation = make({ enabled: false });
    expect(automation.enabled).toBe(false);
    expect(automation.nextRunAt).toBeNull();
  });

  it('leaves nextRunAt null for a cron expression that can never fire', () => {
    expect(make({ trigger: { type: 'cron', expression: '0 0 30 2 *' } }).nextRunAt).toBeNull();
  });

  it('publishes the new automation on the workspace topic', () => {
    const frames: ServerFrame[] = [];
    bus.subscribe(`workspace:${workspace.id}`, (frame) => frames.push(frame));
    const automation = make();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: 'automation',
      topic: `workspace:${workspace.id}`,
      automation,
    });
  });
});

describe('update / delete / list', () => {
  it('patches fields and recomputes the schedule', () => {
    const automation = make();
    vi.setSystemTime(new Date(at(2024, 0, 15, 10, 0)));

    const updated = scheduler.update(automation.id, {
      name: 'Renamed',
      prompt: 'A different prompt',
      trigger: { type: 'cron', expression: '0 12 * * *' },
    })!;

    expect(updated.name).toBe('Renamed');
    expect(updated.prompt).toBe('A different prompt');
    expect(updated.nextRunAt).toBe(at(2024, 0, 15, 12, 0));
    expect(updated.updatedAt).toBe(at(2024, 0, 15, 10, 0));
  });

  it('validates a patched trigger and leaves the row untouched when it is bad', () => {
    const automation = make();
    expect(() =>
      scheduler.update(automation.id, { trigger: { type: 'cron', expression: 'garbage' } }),
    ).toThrow(SchedulerError);
    expect(scheduler.get(automation.id)!.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
    });
  });

  it('clears nextRunAt when the automation is disabled', () => {
    const automation = make();
    expect(automation.nextRunAt).not.toBeNull();
    expect(scheduler.update(automation.id, { enabled: false })!.nextRunAt).toBeNull();
  });

  it('clears the failure counter when a disabled automation is re-enabled', () => {
    const automation = make({ maxConsecutiveFailures: 2 });
    db.prepare('UPDATE automations SET consecutive_failures = 2, enabled = 0 WHERE id = ?').run(
      automation.id,
    );
    expect(scheduler.get(automation.id)!.consecutiveFailures).toBe(2);

    const reenabled = scheduler.update(automation.id, { enabled: true })!;
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.consecutiveFailures).toBe(0);
    expect(reenabled.nextRunAt).toBe(at(2024, 0, 15, 9, 0));
  });

  it('keeps the failure counter when the automation was already enabled', () => {
    const automation = make();
    db.prepare('UPDATE automations SET consecutive_failures = 2 WHERE id = ?').run(automation.id);
    expect(scheduler.update(automation.id, { name: 'Renamed' })!.consecutiveFailures).toBe(2);
  });

  it('returns null for an unknown automation and reports deletion honestly', () => {
    expect(scheduler.get('aut_nope')).toBeNull();
    expect(scheduler.update('aut_nope', { name: 'x' })).toBeNull();
    expect(scheduler.delete('aut_nope')).toBe(false);

    const automation = make();
    expect(scheduler.delete(automation.id)).toBe(true);
    expect(scheduler.get(automation.id)).toBeNull();
  });

  it('lists newest first and scopes by workspace', () => {
    const other = workspaces.create({
      name: 'Beta',
      slug: 'beta',
      description: '',
      path: '/tmp/beta',
      color: '#6366f1',
      icon: 'folder',
      settings: defaultWorkspaceSettings(),
    });

    const first = make({ name: 'first' });
    vi.setSystemTime(new Date(NOW + 1000));
    const second = make({ name: 'second' });
    const foreign = scheduler.create({
      workspaceId: other.id,
      name: 'foreign',
      prompt: 'p',
      trigger: { type: 'manual' },
    });

    expect(scheduler.list().map((a) => a.id)).toContain(foreign.id);
    expect(scheduler.list()).toHaveLength(3);
    expect(scheduler.list(workspace.id).map((a) => a.name)).toEqual(['second', 'first']);
    expect(scheduler.list(workspace.id).map((a) => a.id)).toEqual([second.id, first.id]);
    expect(scheduler.list(other.id).map((a) => a.name)).toEqual(['foreign']);
  });
});

/* -------------------------------------------------------------------------- */
/* fire                                                                        */
/* -------------------------------------------------------------------------- */

describe('fire', () => {
  it('submits the prompt with the automation policy as overrides', async () => {
    const automation = make({
      policy: {
        model: 'opus',
        effort: 'high',
        permissionMode: 'acceptEdits',
        agentName: 'reviewer',
      },
    });

    const runId = await scheduler.fire(automation.id);

    expect(runId).toBe('run_x');
    expect(kernel.submit).toHaveBeenCalledTimes(1);
    const call = kernel.submit.mock.calls[0]![0] as {
      sessionId: string;
      prompt: string;
      triggeredBy: string;
      overrides: Record<string, unknown>;
    };
    expect(call.prompt).toBe('Summarise what changed today.');
    expect(call.triggeredBy).toBe('automation');
    expect(call.overrides).toEqual({
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      agentName: 'reviewer',
    });
    expect(sessions.get(call.sessionId)).not.toBeNull();
  });

  it('records the firing on the automation row', async () => {
    const automation = make();
    await scheduler.fire(automation.id);

    const after = scheduler.get(automation.id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBe(NOW);
    expect(after.sessionId).toBe(kernel.submit.mock.calls[0]![0].sessionId);
    expect(after.sessionId).not.toBeNull();
  });

  it('recomputes nextRunAt from the moment of firing', async () => {
    const automation = make({ trigger: { type: 'cron', expression: '0 9 * * *' } });
    expect(automation.nextRunAt).toBe(at(2024, 0, 15, 9, 0));

    // Fire exactly on the scheduled instant; the next slot is tomorrow.
    vi.setSystemTime(new Date(at(2024, 0, 15, 9, 0)));
    await scheduler.fire(automation.id);
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(at(2024, 0, 16, 9, 0));
  });

  it('recomputes nextRunAt for an interval trigger relative to the firing', async () => {
    const automation = make({ trigger: { type: 'interval', everyMs: 5 * MINUTE } });
    vi.setSystemTime(new Date(NOW + 7 * MINUTE));
    await scheduler.fire(automation.id);
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(NOW + 12 * MINUTE);
  });

  it('leaves nextRunAt null when a disabled automation is fired by hand', async () => {
    const automation = make({ enabled: false });
    await scheduler.fire(automation.id, 'user');
    const after = scheduler.get(automation.id)!;
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBeNull();
    expect(kernel.submit.mock.calls[0]![0].triggeredBy).toBe('user');
  });

  it('creates a fresh session on every firing of a one-shot automation', async () => {
    const automation = make({ trigger: { type: 'manual' }, continuous: false });

    await scheduler.fire(automation.id);
    const firstSession = scheduler.get(automation.id)!.sessionId;
    await scheduler.fire(automation.id);
    const secondSession = scheduler.get(automation.id)!.sessionId;

    expect(firstSession).not.toBeNull();
    expect(secondSession).not.toBe(firstSession);
    expect(sessionCount()).toBe(2);
    expect(scheduler.get(automation.id)!.runCount).toBe(2);
    expect(kernel.submit.mock.calls.map((c) => c[0].sessionId)).toEqual([
      firstSession,
      secondSession,
    ]);
    expect(sessions.get(firstSession as string)!.title).toBe('⏱ Nightly report');
  });

  it('reuses one session across every firing of a continuous automation', async () => {
    const automation = make({ trigger: { type: 'manual' }, continuous: true });

    await scheduler.fire(automation.id);
    const first = scheduler.get(automation.id)!.sessionId;
    await scheduler.fire(automation.id);
    const second = scheduler.get(automation.id)!.sessionId;
    await scheduler.fire(automation.id);
    const third = scheduler.get(automation.id)!.sessionId;

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(sessionCount()).toBe(1);
    expect(sessions.get(first as string)!.title).toBe('↻ Nightly report');
    // Continuous firings are attributed to the loop, not to the automation.
    for (const call of kernel.submit.mock.calls) {
      expect(call[0].sessionId).toBe(first);
      expect(call[0].triggeredBy).toBe('loop');
    }
  });

  it('starts a new session when the continuous session was archived', async () => {
    const automation = make({ trigger: { type: 'manual' }, continuous: true });
    await scheduler.fire(automation.id);
    const first = scheduler.get(automation.id)!.sessionId as string;

    sessions.update(first, { archived: true });
    await scheduler.fire(automation.id);

    expect(scheduler.get(automation.id)!.sessionId).not.toBe(first);
    expect(sessionCount()).toBe(2);
  });

  it('skips rather than queues when the previous run is still in flight', async () => {
    const automation = make({ trigger: { type: 'manual' }, continuous: true });
    await scheduler.fire(automation.id);
    kernel.submit.mockClear();
    kernel.hasActiveRunForSession.mockReturnValue(true);

    await expect(scheduler.fire(automation.id)).rejects.toThrow(SchedulerError);
    await scheduler.fire(automation.id).catch((error: SchedulerError) => {
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain('still in flight');
    });

    expect(kernel.submit).not.toHaveBeenCalled();
    // Nothing was recorded: the run count stays where it was.
    expect(scheduler.get(automation.id)!.runCount).toBe(1);
  });

  it('rejects an unknown automation and an automation whose workspace vanished', async () => {
    await expect(scheduler.fire('aut_nope')).rejects.toThrow(SchedulerError);
    await scheduler.fire('aut_nope').catch((error: SchedulerError) => {
      expect(error.statusCode).toBe(404);
    });

    const automation = make({ trigger: { type: 'manual' } });
    // Break the reference without cascading the automation away.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
    await scheduler.fire(automation.id).catch((error: SchedulerError) => {
      expect(error.statusCode).toBe(404);
      expect(error.message).toContain('workspace');
    });
    db.pragma('foreign_keys = ON');
  });
});

/* -------------------------------------------------------------------------- */
/* tick                                                                        */
/* -------------------------------------------------------------------------- */

describe('tick', () => {
  it('fires only the automations that are due', async () => {
    const due = make({ name: 'due', trigger: { type: 'cron', expression: '0 9 * * *' } });
    const later = make({ name: 'later', trigger: { type: 'cron', expression: '0 12 * * *' } });

    expect(await scheduler.tick(at(2024, 0, 15, 9, 0))).toBe(1);
    expect(kernel.submit).toHaveBeenCalledTimes(1);
    expect(scheduler.get(due.id)!.runCount).toBe(1);
    expect(scheduler.get(later.id)!.runCount).toBe(0);
  });

  it('fires nothing when nothing is due', async () => {
    make();
    expect(await scheduler.tick(at(2024, 0, 15, 8, 59))).toBe(0);
    expect(kernel.submit).not.toHaveBeenCalled();
  });

  it('never fires a disabled automation, even when its next_run_at is in the past', async () => {
    const disabled = make({ name: 'disabled', enabled: false });
    // Force a stale, overdue schedule onto the disabled row.
    db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(1, disabled.id);

    expect(await scheduler.tick(at(2024, 0, 15, 9, 0))).toBe(0);
    expect(kernel.submit).not.toHaveBeenCalled();
    expect(scheduler.get(disabled.id)!.runCount).toBe(0);
  });

  it('fires several due automations in one tick', async () => {
    make({ name: 'a', trigger: { type: 'cron', expression: '0 9 * * *' } });
    make({ name: 'b', trigger: { type: 'cron', expression: '*/15 * * * *' } });
    make({ name: 'c', trigger: { type: 'manual' } }); // never scheduled

    expect(await scheduler.tick(at(2024, 0, 15, 9, 0))).toBe(2);
    expect(kernel.submit).toHaveBeenCalledTimes(2);
  });

  it('refuses to overlap with a tick that is still in flight', async () => {
    make({ trigger: { type: 'cron', expression: '0 9 * * *' } });

    let release!: (value: { id: string }) => void;
    kernel.submit.mockReturnValue(
      new Promise<{ id: string }>((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = scheduler.tick(at(2024, 0, 15, 9, 0));
    // The first tick is parked inside `kernel.submit`; a second one must be a
    // no-op rather than double-firing the same automation.
    expect(await scheduler.tick(at(2024, 0, 15, 9, 0))).toBe(0);
    expect(kernel.submit).toHaveBeenCalledTimes(1);

    release({ id: 'run_x' });
    expect(await inFlight).toBe(1);
    expect(kernel.submit).toHaveBeenCalledTimes(1);

    // Once the first tick has finished the gate is open again.
    kernel.submit.mockResolvedValue({ id: 'run_y' });
    expect(await scheduler.tick(at(2024, 0, 16, 9, 0))).toBe(1);
  });

  it('moves the schedule forward even when firing fails, so it is not retried every tick', async () => {
    const automation = make({ trigger: { type: 'cron', expression: '*/5 * * * *' } });
    db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(
      at(2024, 0, 15, 9, 0),
      automation.id,
    );
    kernel.submit.mockRejectedValue(new Error('the kernel is unhappy'));

    const now = at(2024, 0, 15, 9, 0);
    expect(await scheduler.tick(now)).toBe(0);

    const after = scheduler.get(automation.id)!;
    expect(after.nextRunAt).toBe(at(2024, 0, 15, 9, 5));
    expect(after.nextRunAt as number).toBeGreaterThan(now);
    // The failure is logged, and the automation is not left due.
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
    expect(await scheduler.tick(now)).toBe(0);
    expect(kernel.submit).toHaveBeenCalledTimes(1);
  });

  it('moves the schedule forward on a 409 conflict without logging it as a failure', async () => {
    const automation = make({ trigger: { type: 'cron', expression: '*/5 * * * *' }, continuous: true });
    db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(
      at(2024, 0, 15, 9, 0),
      automation.id,
    );
    kernel.hasActiveRunForSession.mockReturnValue(true);

    expect(await scheduler.tick(at(2024, 0, 15, 9, 0))).toBe(0);
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(at(2024, 0, 15, 9, 5));
    expect(logged.filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });

  it('lets one failing automation not stop the others', async () => {
    make({ name: 'broken', trigger: { type: 'cron', expression: '0 9 * * *' } });
    make({ name: 'healthy', trigger: { type: 'cron', expression: '0 9 * * *' } });
    kernel.submit.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ id: 'run_ok' });

    expect(await scheduler.tick(at(2024, 0, 15, 9, 0))).toBe(1);
    expect(kernel.submit).toHaveBeenCalledTimes(2);
  });

  it('fires a missed window once, not once per missed slot', async () => {
    const automation = make({ trigger: { type: 'cron', expression: '0 * * * *' } });
    // Pretend the server was down for a day.
    const wokeUp = at(2024, 0, 16, 8, 30);
    vi.setSystemTime(new Date(wokeUp));

    expect(await scheduler.tick(wokeUp)).toBe(1);
    expect(kernel.submit).toHaveBeenCalledTimes(1);
    expect(scheduler.get(automation.id)!.runCount).toBe(1);
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(at(2024, 0, 16, 9, 0));
  });
});

/* -------------------------------------------------------------------------- */
/* recordOutcome                                                               */
/* -------------------------------------------------------------------------- */

describe('recordOutcome', () => {
  async function fired(overrides: Parameters<typeof make>[0] = {}): Promise<{
    automation: Automation;
    sessionId: string;
  }> {
    const automation = make({ trigger: { type: 'manual' }, continuous: true, ...overrides });
    await scheduler.fire(automation.id);
    return { automation, sessionId: scheduler.get(automation.id)!.sessionId as string };
  }

  it('ignores a session that belongs to no automation', () => {
    expect(() => scheduler.recordOutcome('ses_unknown', 'succeeded')).not.toThrow();
  });

  it('records the status and resets the failure counter on success', async () => {
    const { automation, sessionId } = await fired();
    scheduler.recordOutcome(sessionId, 'failed');
    expect(scheduler.get(automation.id)!.consecutiveFailures).toBe(1);

    scheduler.recordOutcome(sessionId, 'succeeded');
    const after = scheduler.get(automation.id)!;
    expect(after.lastStatus).toBe('succeeded');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.enabled).toBe(true);
  });

  it('counts consecutive failures and disables the automation at the limit', async () => {
    const frames: ServerFrame[] = [];
    bus.subscribe('system', (frame) => frames.push(frame));
    const { automation, sessionId } = await fired({
      trigger: { type: 'cron', expression: '0 9 * * *' },
      maxConsecutiveFailures: 3,
    });
    expect(scheduler.get(automation.id)!.nextRunAt).not.toBeNull();

    scheduler.recordOutcome(sessionId, 'failed');
    expect(scheduler.get(automation.id)!.consecutiveFailures).toBe(1);
    expect(scheduler.get(automation.id)!.enabled).toBe(true);

    scheduler.recordOutcome(sessionId, 'failed');
    expect(scheduler.get(automation.id)!.consecutiveFailures).toBe(2);
    expect(scheduler.get(automation.id)!.enabled).toBe(true);
    expect(frames).toHaveLength(0);

    scheduler.recordOutcome(sessionId, 'failed');
    const disabled = scheduler.get(automation.id)!;
    expect(disabled.consecutiveFailures).toBe(3);
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();
    expect(disabled.lastStatus).toBe('failed');

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'notification',
      level: 'error',
      title: 'Automation disabled',
    });
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('does not count interrupted or queued outcomes as failures', async () => {
    const { automation, sessionId } = await fired({ maxConsecutiveFailures: 1 });
    scheduler.recordOutcome(sessionId, 'interrupted');
    const after = scheduler.get(automation.id)!;
    expect(after.lastStatus).toBe('interrupted');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.enabled).toBe(true);
  });

  it('never auto-disables when the guard is switched off with 0', async () => {
    const { automation, sessionId } = await fired({ maxConsecutiveFailures: 0 });
    for (let i = 1; i <= 10; i += 1) {
      scheduler.recordOutcome(sessionId, 'failed');
      const current = scheduler.get(automation.id)!;
      expect(current.consecutiveFailures).toBe(i);
      expect(current.enabled).toBe(true);
    }
  });

  it('keeps the pending schedule intact while the automation is still alive', async () => {
    const { automation, sessionId } = await fired({
      trigger: { type: 'cron', expression: '0 9 * * *' },
      maxConsecutiveFailures: 3,
    });
    const pending = scheduler.get(automation.id)!.nextRunAt;
    scheduler.recordOutcome(sessionId, 'failed');
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(pending);
  });
});

/* -------------------------------------------------------------------------- */
/* rescheduleAll                                                               */
/* -------------------------------------------------------------------------- */

describe('rescheduleAll', () => {
  it('recomputes nextRunAt from the given time for enabled automations only', () => {
    const enabled = make({ name: 'enabled', trigger: { type: 'cron', expression: '0 9 * * *' } });
    const interval = make({ name: 'interval', trigger: { type: 'interval', everyMs: MINUTE } });
    const disabled = make({ name: 'disabled', enabled: false });

    // Stale values, as after a long downtime.
    db.prepare('UPDATE automations SET next_run_at = 1 WHERE id IN (?, ?)').run(
      enabled.id,
      interval.id,
    );
    db.prepare('UPDATE automations SET next_run_at = 12345 WHERE id = ?').run(disabled.id);

    const from = at(2024, 0, 20, 11, 0);
    scheduler.rescheduleAll(from);

    expect(scheduler.get(enabled.id)!.nextRunAt).toBe(at(2024, 0, 21, 9, 0));
    expect(scheduler.get(interval.id)!.nextRunAt).toBe(from + MINUTE);
    // Untouched: disabled automations are not rescheduled.
    expect(scheduler.get(disabled.id)!.nextRunAt).toBe(12345);
  });

  it('clears the schedule of an enabled automation that can never fire', () => {
    const automation = make({ trigger: { type: 'cron', expression: '0 0 30 2 *' } });
    db.prepare('UPDATE automations SET next_run_at = 1 WHERE id = ?').run(automation.id);
    scheduler.rescheduleAll(NOW);
    expect(scheduler.get(automation.id)!.nextRunAt).toBeNull();
  });

  it('defaults to now', () => {
    const automation = make({ trigger: { type: 'interval', everyMs: 3 * MINUTE } });
    db.prepare('UPDATE automations SET next_run_at = 1 WHERE id = ?').run(automation.id);
    scheduler.rescheduleAll();
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(NOW + 3 * MINUTE);
  });

  it('is what `start` uses to clear a burst of stale schedules', () => {
    const automation = make({ trigger: { type: 'cron', expression: '0 9 * * *' } });
    db.prepare('UPDATE automations SET next_run_at = 1 WHERE id = ?').run(automation.id);

    scheduler.start();
    expect(scheduler.get(automation.id)!.nextRunAt).toBe(at(2024, 0, 15, 9, 0));
    scheduler.stop();
  });
});
