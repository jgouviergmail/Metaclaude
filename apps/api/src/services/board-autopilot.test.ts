/**
 * The board autopilot — the kanban as a work queue that drains itself.
 *
 * The properties that keep it trustworthy: one card at a time per workspace
 * (a backlog is not a fan-out), the human's column order decides what is
 * next (never the machine's own idea of priority), a blocked card is
 * skipped rather than retried into the ground, the quota guard stops
 * automatic starts — and only automatic ones: a human pressing the button
 * outranks the guard — and a workspace that never opted in never moves.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BoardTask, Run, Workspace } from '@metaclaude/shared';
import { BoardAutopilot, planUtilization } from './board-autopilot.js';

const card = (over: Partial<BoardTask>): BoardTask =>
  ({
    id: 'tsk_1',
    workspaceId: 'ws_1',
    parentId: null,
    title: 'A card',
    description: '',
    status: 'todo',
    priority: 'normal',
    assignee: null,
    runId: null,
    dueAt: null,
    orderKey: 'a',
    blockedReason: null,
    createdBy: 'user:o',
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...over,
  }) as BoardTask;

const workspace = (over: Partial<Workspace['settings']> = {}): Workspace =>
  ({
    id: 'ws_1',
    path: '/srv/metaclaude/workspaces/test',
    settings: { autoWorkBoard: true, ...over },
  }) as unknown as Workspace;

function build(options: {
  cards?: BoardTask[];
  runs?: Record<string, Pick<Run, 'status'>>;
  settings?: Partial<Workspace['settings']>;
  utilization?: number | null;
  guardPct?: number;
  startFails?: boolean;
}) {
  const started: string[] = [];
  const autopilot = new BoardAutopilot({
    boardTasks: { board: () => options.cards ?? [] },
    workspaces: {
      get: (id) => (id === 'ws_1' ? workspace(options.settings) : null),
      list: () => [workspace(options.settings)],
    },
    runs: { get: (id) => (options.runs?.[id] as Run | undefined) ?? null },
    start: vi.fn(async (taskId: string, _username: string) => {
      if (options.startFails) throw new Error('the kernel said no');
      started.push(taskId);
      return {} as never;
    }),
    quota: { utilization: async () => options.utilization ?? null },
    guardPct: options.guardPct ?? 85,
    log: () => {},
  });
  return { autopilot, started };
}

describe('which card is next', () => {
  it('is the top unblocked To do, in the human’s column order', async () => {
    const { autopilot, started } = build({
      cards: [
        card({ id: 'tsk_review', status: 'review', orderKey: 'a' }),
        card({ id: 'tsk_blocked', status: 'todo', orderKey: 'a', blockedReason: 'stuck' }),
        card({ id: 'tsk_second', status: 'todo', orderKey: 'c' }),
        card({ id: 'tsk_top', status: 'todo', orderKey: 'b' }),
      ],
    });
    const outcome = await autopilot.workNext('ws_1', { manual: false });
    expect(outcome.reason).toBe('started');
    expect(started).toEqual(['tsk_top']);
  });

  it('starts nothing while any card in the workspace is being worked', async () => {
    // One card at a time: a backlog is a queue, not a fan-out — parallel
    // card runs would also collide on the same working tree.
    const { autopilot, started } = build({
      cards: [
        card({ id: 'tsk_active', status: 'in_progress', runId: 'run_live' }),
        card({ id: 'tsk_next', status: 'todo' }),
      ],
      runs: { run_live: { status: 'running' } },
    });
    expect((await autopilot.workNext('ws_1', { manual: false })).reason).toBe('busy');
    expect(started).toEqual([]);
  });

  it('ignores a finished run still linked to a card', async () => {
    const { autopilot, started } = build({
      cards: [
        card({ id: 'tsk_done', status: 'review', runId: 'run_old' }),
        card({ id: 'tsk_next', status: 'todo' }),
      ],
      runs: { run_old: { status: 'succeeded' } },
    });
    expect((await autopilot.workNext('ws_1', { manual: false })).reason).toBe('started');
    expect(started).toEqual(['tsk_next']);
  });

  it('reports an empty column as empty', async () => {
    const { autopilot } = build({ cards: [card({ id: 'tsk_r', status: 'review' })] });
    expect((await autopilot.workNext('ws_1', { manual: true })).reason).toBe('empty');
  });
});

describe('the quota guard', () => {
  it('defers an automatic start above the threshold', async () => {
    const { autopilot, started } = build({
      cards: [card({ id: 'tsk_next' })],
      utilization: 91,
      guardPct: 85,
    });
    expect((await autopilot.workNext('ws_1', { manual: false })).reason).toBe('quota');
    expect(started).toEqual([]);
  });

  it('never refuses a human — pressing the button outranks the guard', async () => {
    const { autopilot, started } = build({
      cards: [card({ id: 'tsk_next' })],
      utilization: 99,
    });
    expect((await autopilot.workNext('ws_1', { manual: true })).reason).toBe('started');
    expect(started).toEqual(['tsk_next']);
  });

  it('fails open when the quota is unknowable, so a broken probe never freezes the queue', async () => {
    const { autopilot, started } = build({ cards: [card({ id: 'tsk_next' })], utilization: null });
    expect((await autopilot.workNext('ws_1', { manual: false })).reason).toBe('started');
    expect(started).toEqual(['tsk_next']);
  });
});

describe('the opt-in and the chain', () => {
  it('does nothing automatically for a workspace that never opted in', async () => {
    const { autopilot, started } = build({
      cards: [card({ id: 'tsk_next' })],
      settings: { autoWorkBoard: false },
    });
    expect((await autopilot.workNext('ws_1', { manual: false })).reason).toBe('off');
    expect(started).toEqual([]);
    // The button still works there: manual is the human's call.
    expect((await autopilot.workNext('ws_1', { manual: true })).reason).toBe('started');
  });

  it('chains on a finished run: the next card starts by itself', async () => {
    const { autopilot, started } = build({ cards: [card({ id: 'tsk_next' })] });
    await autopilot.onRunFinished({ workspaceId: 'ws_1' } as Run);
    expect(started).toEqual(['tsk_next']);
  });

  it('sweeps every opted-in workspace, and survives one that throws', async () => {
    const { autopilot, started } = build({ cards: [card({ id: 'tsk_next' })], startFails: true });
    // A refusal from the kernel (reservation window, run in flight) must be
    // survivable weather for the sweep, not a crash.
    await expect(autopilot.sweep()).resolves.not.toThrow();
    expect(started).toEqual([]);
  });
});

describe('planUtilization', () => {
  const usage = (windows: { key: string; utilization: number | null }[]) => ({ windows });

  it('answers the worst plan window and ignores per-model buckets', () => {
    expect(
      planUtilization(
        usage([
          { key: 'five_hour', utilization: 40 },
          { key: 'seven_day', utilization: 72 },
          // One saturated model must not stall cards that would run on another.
          { key: 'model:Opus', utilization: 100 },
        ]),
      ),
    ).toBe(72);
  });

  it('answers null when nothing is knowable', () => {
    expect(planUtilization(usage([]))).toBeNull();
    expect(planUtilization(usage([{ key: 'five_hour', utilization: null }]))).toBeNull();
  });
});
