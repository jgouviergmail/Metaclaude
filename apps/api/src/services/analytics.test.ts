import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { AnalyticsService, percentile } from './analytics.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

/** 2024-01-01T00:00:00Z — exactly on an hour and a day boundary. */
const T0 = Date.UTC(2024, 0, 1);
/** Buckets are pure epoch arithmetic, so the week containing T0 starts here. */
const WEEK0 = T0 - 4 * DAY; // 2023-12-28T00:00:00Z

let db: Db;
let analytics: AnalyticsService;
let wsA: string;
let wsB: string;

interface RunSeed {
  startedAt: number;
  status?: string;
  workspaceId?: string;
  /** `undefined` writes a policy with no `model` key at all. */
  model?: string;
  category?: string | null;
  reward?: number | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

let runCounter = 0;

function insertRun(seed: RunSeed): string {
  runCounter += 1;
  const id = `run_seed_${runCounter}`;
  const workspaceId = seed.workspaceId ?? wsA;
  const status = seed.status ?? 'succeeded';
  const finished = ['queued', 'running', 'waiting_approval'].includes(status);

  const usage = {
    inputTokens: seed.inputTokens ?? 0,
    outputTokens: seed.outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: seed.costUsd ?? 0,
    durationMs: seed.durationMs ?? 0,
    turns: 1,
  };
  const policy: Record<string, unknown> = {
    effort: null,
    permissionMode: 'default',
    thinking: 'adaptive',
    thinkingBudgetTokens: null,
    agentName: null,
    source: 'workspace',
  };
  if (seed.model !== undefined) policy.model = seed.model;

  db.prepare(
    `INSERT INTO runs
       (id, session_id, workspace_id, prompt, status, policy, usage, category, reward,
        triggered_by, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
  ).run(
    id,
    `ses_${workspaceId}`,
    workspaceId,
    'a prompt',
    status,
    JSON.stringify(policy),
    JSON.stringify(usage),
    seed.category === undefined ? null : seed.category,
    seed.reward ?? null,
    seed.startedAt,
    finished ? null : seed.startedAt + (seed.durationMs ?? 0),
  );
  return id;
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  runCounter = 0;

  const insertWorkspace = db.prepare(
    'INSERT INTO workspaces (id, name, slug, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [id, slug] of [
    ['ws_alpha', 'alpha'],
    ['ws_beta', 'beta'],
  ] as Array<[string, string]>) {
    insertWorkspace.run(id, slug, slug, `/tmp/${slug}`, T0, T0);
    insertSession.run(`ses_${id}`, id, T0, T0, T0);
  }
  wsA = 'ws_alpha';
  wsB = 'ws_beta';

  analytics = new AnalyticsService(db);
});

afterEach(() => {
  db.close();
});

/* -------------------------------------------------------------------------- */
/* percentile                                                                  */
/* -------------------------------------------------------------------------- */

describe('percentile', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([], 0)).toBe(0);
  });

  it('returns the only element of a single-element sample, whatever q is', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('returns the exact middle value for an odd-sized sample', () => {
    expect(percentile([1, 2, 3], 0.5)).toBe(2);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([100, 200, 300, 400, 500, 600, 700], 0.5)).toBe(400);
  });

  it('interpolates the median of an even-sized sample', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([500, 1000, 2000, 3000], 0.5)).toBe(1500);
  });

  it('interpolates p95 on a known series', () => {
    // 1..100: position = 99 × 0.95 = 94.05 → 95 + 0.05 × (96 − 95) = 95.05
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBeCloseTo(95.05, 10);
    // 1..101: position = 100 × 0.95 = 95 exactly → the 96th value.
    expect(percentile(Array.from({ length: 101 }, (_, i) => i + 1), 0.95)).toBe(96);
    // Four samples: position = 3 × 0.95 = 2.85 → 2000×0.15 + 3000×0.85
    expect(percentile([500, 1000, 2000, 3000], 0.95)).toBeCloseTo(2850, 10);
  });

  it('returns the minimum at q = 0 and the maximum at q = 1', () => {
    const values = [7, 3, 9, 1, 5];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(9);
  });

  it('sorts numerically, not lexicographically', () => {
    expect(percentile([10, 9, 100], 0.5)).toBe(10);
    expect(percentile([2, 10, 1], 1)).toBe(10);
  });

  it('does not mutate the caller’s array', () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

/* -------------------------------------------------------------------------- */
/* summary                                                                     */
/* -------------------------------------------------------------------------- */

describe('summary', () => {
  /**
   * Four finished runs with hand-picked numbers:
   *   costs     0.10 + 0.20 + 0.05 + 0.00 = 0.35
   *   input     100 + 200 + 50 + 0        = 350
   *   output    10 + 20 + 5 + 0           = 35
   *   durations 1000, 3000, 2000, 500     → sorted 500, 1000, 2000, 3000
   *   succeeded 2 of 4                    → 0.5
   */
  function seedFinished(): void {
    insertRun({
      startedAt: T0,
      status: 'succeeded',
      model: 'sonnet',
      category: 'code',
      reward: 0.8,
      costUsd: 0.1,
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 1000,
    });
    insertRun({
      startedAt: T0 + HOUR,
      status: 'succeeded',
      model: 'sonnet',
      category: 'code',
      costUsd: 0.2,
      inputTokens: 200,
      outputTokens: 20,
      durationMs: 3000,
    });
    insertRun({
      startedAt: T0 + 2 * HOUR,
      status: 'failed',
      model: 'opus',
      category: 'research',
      reward: 0.2,
      costUsd: 0.05,
      inputTokens: 50,
      outputTokens: 5,
      durationMs: 2000,
    });
    insertRun({
      startedAt: T0 + 3 * HOUR,
      status: 'interrupted',
      model: 'sonnet',
      category: null,
      durationMs: 500,
    });
  }

  const window = { since: T0, until: T0 + DAY };

  it('is all zeros on an empty range', () => {
    expect(analytics.summary(window)).toEqual({
      totalRuns: 0,
      successRate: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      medianDurationMs: 0,
      p95DurationMs: 0,
      averageReward: null,
      byModel: [],
      byCategory: [],
      byWorkspace: [],
    });
  });

  it('totals runs, cost and tokens', () => {
    seedFinished();
    const summary = analytics.summary(window);
    expect(summary.totalRuns).toBe(4);
    expect(summary.totalCostUsd).toBe(0.35);
    expect(summary.totalInputTokens).toBe(350);
    expect(summary.totalOutputTokens).toBe(35);
  });

  it('computes the success rate over finished runs only', () => {
    seedFinished();
    expect(analytics.summary(window).successRate).toBe(0.5);
  });

  it('computes the median and p95 duration', () => {
    seedFinished();
    const summary = analytics.summary(window);
    // sorted 500, 1000, 2000, 3000 → median 1500, p95 2850
    expect(summary.medianDurationMs).toBe(1500);
    expect(summary.p95DurationMs).toBeCloseTo(2850, 10);
  });

  it('averages only the runs that carry a reward', () => {
    seedFinished();
    // rewards 0.8 and 0.2 → 0.5, over four runs.
    expect(analytics.summary(window).averageReward).toBe(0.5);
  });

  it('reports a null average reward when nothing has been rewarded', () => {
    insertRun({ startedAt: T0, status: 'succeeded' });
    insertRun({ startedAt: T0 + HOUR, status: 'failed' });
    expect(analytics.summary(window).averageReward).toBeNull();
    expect(analytics.summary(window).totalRuns).toBe(2);
  });

  it('distinguishes a reward of 0 from no reward at all', () => {
    insertRun({ startedAt: T0, reward: 0 });
    insertRun({ startedAt: T0 + HOUR, reward: null });
    expect(analytics.summary(window).averageReward).toBe(0);
  });

  it('groups by model, most-used first, with per-model cost and success rate', () => {
    seedFinished();
    const { byModel } = analytics.summary(window);
    expect(byModel.map((entry) => entry.model)).toEqual(['sonnet', 'opus']);
    expect(byModel[0]).toEqual({
      model: 'sonnet',
      runs: 3,
      costUsd: 0.3,
      successRate: 2 / 3,
    });
    expect(byModel[1]).toEqual({ model: 'opus', runs: 1, costUsd: 0.05, successRate: 0 });
  });

  it('falls back to "default" for a policy with no model', () => {
    insertRun({ startedAt: T0 });
    insertRun({ startedAt: T0 + HOUR, model: 'haiku' });
    const { byModel } = analytics.summary(window);
    expect(byModel.map((entry) => entry.model).sort()).toEqual(['default', 'haiku']);
  });

  it('groups by category, most-used first, with "uncategorised" for null', () => {
    seedFinished();
    const { byCategory } = analytics.summary(window);
    expect(byCategory).toEqual([
      { category: 'code', runs: 2, averageReward: 0.8 },
      { category: 'research', runs: 1, averageReward: 0.2 },
      { category: 'uncategorised', runs: 1, averageReward: null },
    ]);
  });

  it('excludes in-flight runs entirely', () => {
    seedFinished();
    const baseline = analytics.summary(window);

    for (const status of ['queued', 'running', 'waiting_approval']) {
      insertRun({
        startedAt: T0 + 4 * HOUR,
        status,
        model: 'ghost',
        category: 'phantom',
        reward: 1,
        costUsd: 999,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        durationMs: 999_999,
      });
    }

    const after = analytics.summary(window);
    expect(after).toEqual(baseline);
    expect(after.totalRuns).toBe(4);
    expect(after.byModel.map((entry) => entry.model)).not.toContain('ghost');
    expect(after.byCategory.map((entry) => entry.category)).not.toContain('phantom');
  });

  it('honours the time window at both ends', () => {
    insertRun({ startedAt: T0 - 1, costUsd: 1 }); // before `since`
    insertRun({ startedAt: T0, costUsd: 2 }); // `since` is inclusive
    insertRun({ startedAt: T0 + DAY - 1, costUsd: 4 });
    insertRun({ startedAt: T0 + DAY, costUsd: 8 }); // `until` is exclusive

    const summary = analytics.summary(window);
    expect(summary.totalRuns).toBe(2);
    expect(summary.totalCostUsd).toBe(6);
  });

  it('scopes to one workspace', () => {
    insertRun({ startedAt: T0, workspaceId: wsA, costUsd: 1, model: 'sonnet' });
    insertRun({ startedAt: T0 + HOUR, workspaceId: wsA, costUsd: 2, model: 'sonnet' });
    insertRun({ startedAt: T0 + 2 * HOUR, workspaceId: wsB, costUsd: 4, model: 'opus' });

    expect(analytics.summary({ ...window, workspaceId: wsA }).totalRuns).toBe(2);
    expect(analytics.summary({ ...window, workspaceId: wsA }).totalCostUsd).toBe(3);
    expect(analytics.summary({ ...window, workspaceId: wsB }).totalRuns).toBe(1);
    expect(analytics.summary({ ...window, workspaceId: wsB }).byModel).toEqual([
      { model: 'opus', runs: 1, costUsd: 4, successRate: 1 },
    ]);
    expect(analytics.summary({ ...window, workspaceId: 'ws_nothing' }).totalRuns).toBe(0);
    // Unscoped sees everything.
    expect(analytics.summary(window).totalRuns).toBe(3);
  });

  it('rounds money to six decimals rather than accumulating float noise', () => {
    for (let i = 0; i < 3; i += 1) insertRun({ startedAt: T0 + i, costUsd: 0.1 });
    expect(analytics.summary(window).totalCostUsd).toBe(0.3);
  });

  it('defaults `until` to now', () => {
    insertRun({ startedAt: Date.now() - 1000, costUsd: 1 });
    expect(analytics.summary({ since: Date.now() - 10_000 }).totalRuns).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* series                                                                      */
/* -------------------------------------------------------------------------- */

describe('series', () => {
  it('buckets by hour and emits the empty hours in between', () => {
    insertRun({ startedAt: T0, status: 'succeeded', costUsd: 1, inputTokens: 10, outputTokens: 1, durationMs: 100 });
    insertRun({ startedAt: T0 + 30 * 60_000, status: 'failed', costUsd: 2, inputTokens: 20, outputTokens: 2, durationMs: 300 });
    insertRun({ startedAt: T0 + 3 * HOUR, status: 'succeeded', costUsd: 4, inputTokens: 40, outputTokens: 4, durationMs: 700 });

    const points = analytics.series({ since: T0, until: T0 + 4 * HOUR, granularity: 'hour' });

    expect(points.map((p) => p.bucket)).toEqual([
      T0,
      T0 + HOUR,
      T0 + 2 * HOUR,
      T0 + 3 * HOUR,
      T0 + 4 * HOUR,
    ]);
    expect(points[0]).toEqual({
      bucket: T0,
      runs: 2,
      costUsd: 3,
      inputTokens: 30,
      outputTokens: 3,
      successRate: 0.5,
      medianDurationMs: 200, // (100 + 300) / 2
    });
    expect(points[3]).toEqual({
      bucket: T0 + 3 * HOUR,
      runs: 1,
      costUsd: 4,
      inputTokens: 40,
      outputTokens: 4,
      successRate: 1,
      medianDurationMs: 700,
    });
  });

  it('emits zeroed points for gaps, never NaN', () => {
    insertRun({ startedAt: T0, status: 'succeeded', costUsd: 1, durationMs: 100 });
    const points = analytics.series({ since: T0, until: T0 + 3 * HOUR, granularity: 'hour' });

    expect(points).toHaveLength(4);
    for (const empty of points.slice(1)) {
      expect(empty.runs).toBe(0);
      expect(empty.costUsd).toBe(0);
      expect(empty.inputTokens).toBe(0);
      expect(empty.outputTokens).toBe(0);
      expect(empty.medianDurationMs).toBe(0);
      // The important part: an empty bucket has a real 0, not 0/0.
      expect(empty.successRate).toBe(0);
      expect(Number.isNaN(empty.successRate)).toBe(false);
    }
  });

  it('covers the whole requested range even when there is no data at all', () => {
    const points = analytics.series({ since: T0, until: T0 + 5 * DAY, granularity: 'day' });
    expect(points).toHaveLength(6);
    expect(points[0]!.bucket).toBe(T0);
    expect(points[5]!.bucket).toBe(T0 + 5 * DAY);
    expect(points.every((p) => p.runs === 0)).toBe(true);
  });

  it('buckets by day', () => {
    insertRun({ startedAt: T0 + 1 * HOUR, costUsd: 1 });
    insertRun({ startedAt: T0 + 23 * HOUR, costUsd: 1 }); // same day
    insertRun({ startedAt: T0 + 2 * DAY + HOUR, costUsd: 5, status: 'failed' });

    const points = analytics.series({ since: T0, until: T0 + 3 * DAY, granularity: 'day' });
    expect(points.map((p) => p.bucket)).toEqual([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY]);
    expect(points.map((p) => p.runs)).toEqual([2, 0, 1, 0]);
    expect(points[0]!.costUsd).toBe(2);
    expect(points[0]!.successRate).toBe(1);
    expect(points[2]!.successRate).toBe(0);
  });

  it('defaults to day granularity', () => {
    insertRun({ startedAt: T0 + HOUR });
    const points = analytics.series({ since: T0, until: T0 + 2 * DAY });
    expect(points.map((p) => p.bucket)).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
  });

  it('buckets by week, aligned to the epoch week', () => {
    insertRun({ startedAt: T0, costUsd: 1 }); // week of 2023-12-28
    insertRun({ startedAt: T0 + 2 * DAY, costUsd: 1 }); // same week
    insertRun({ startedAt: WEEK0 + WEEK + 1, costUsd: 3 }); // the next week

    const points = analytics.series({ since: T0, until: WEEK0 + 2 * WEEK, granularity: 'week' });
    expect(points.map((p) => p.bucket)).toEqual([WEEK0, WEEK0 + WEEK, WEEK0 + 2 * WEEK]);
    expect(points.map((p) => p.runs)).toEqual([2, 1, 0]);
    expect(points[0]!.costUsd).toBe(2);
    expect(points[1]!.costUsd).toBe(3);
  });

  it('excludes in-flight runs from every bucket', () => {
    insertRun({ startedAt: T0, status: 'succeeded', costUsd: 1, durationMs: 100 });
    for (const status of ['queued', 'running', 'waiting_approval']) {
      insertRun({ startedAt: T0, status, costUsd: 999, inputTokens: 5000, durationMs: 999_999 });
    }

    const points = analytics.series({ since: T0, until: T0 + HOUR, granularity: 'hour' });
    expect(points[0]).toEqual({
      bucket: T0,
      runs: 1,
      costUsd: 1,
      inputTokens: 0,
      outputTokens: 0,
      successRate: 1,
      medianDurationMs: 100,
    });
  });

  it('counts interrupted and failed runs but not as successes', () => {
    insertRun({ startedAt: T0, status: 'failed' });
    insertRun({ startedAt: T0 + 60_000, status: 'interrupted' });
    insertRun({ startedAt: T0 + 120_000, status: 'succeeded' });

    const [point] = analytics.series({ since: T0, until: T0 + HOUR, granularity: 'hour' });
    expect(point!.runs).toBe(3);
    expect(point!.successRate).toBeCloseTo(1 / 3, 10);
  });

  it('scopes to one workspace', () => {
    insertRun({ startedAt: T0, workspaceId: wsA, costUsd: 1 });
    insertRun({ startedAt: T0, workspaceId: wsB, costUsd: 2 });

    const alpha = analytics.series({
      workspaceId: wsA,
      since: T0,
      until: T0 + HOUR,
      granularity: 'hour',
    });
    expect(alpha[0]!.runs).toBe(1);
    expect(alpha[0]!.costUsd).toBe(1);

    const both = analytics.series({ since: T0, until: T0 + HOUR, granularity: 'hour' });
    expect(both[0]!.runs).toBe(2);
    expect(both[0]!.costUsd).toBe(3);
  });

  it('starts the first bucket at the boundary containing `since`', () => {
    // `since` lands mid-hour; the bucket that contains it is still emitted.
    const points = analytics.series({
      since: T0 + 90 * 60_000,
      until: T0 + 3 * HOUR,
      granularity: 'hour',
    });
    expect(points[0]!.bucket).toBe(T0 + HOUR);
    expect(points.map((p) => p.bucket)).toEqual([T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
  });

  it('returns nothing when the range is inverted', () => {
    insertRun({ startedAt: T0 });
    expect(analytics.series({ since: T0 + DAY, until: T0, granularity: 'hour' })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* byWorkspace                                                                 */
/* -------------------------------------------------------------------------- */

describe('byWorkspace', () => {
  /**
   * Where the subscription is actually going.
   *
   * The page could already scope to one workspace at a time, which answers
   * "how much did this one cost" and never "which one is eating the quota".
   * On a subscription with a weekly ceiling that second question is the one
   * that matters, and it is the only one that needs every workspace at once.
   */
  it('splits usage by workspace, heaviest first', () => {
    insertRun({ startedAt: T0, workspaceId: wsA, costUsd: 1, inputTokens: 100, outputTokens: 10 });
    insertRun({ startedAt: T0, workspaceId: wsB, costUsd: 5, inputTokens: 900, outputTokens: 90 });
    insertRun({ startedAt: T0, workspaceId: wsB, costUsd: 2, inputTokens: 100, outputTokens: 10 });

    const { byWorkspace } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace.map((entry) => entry.workspaceId)).toEqual([wsB, wsA]);
    expect(byWorkspace[0]).toMatchObject({ runs: 2, costUsd: 7, inputTokens: 1000, outputTokens: 100 });
  });

  it('carries the workspace name and colour, so the chart can be read', () => {
    // Rendering ids would make the ranking unreadable, and a second round trip
    // per row to resolve them would make it slow.
    insertRun({ startedAt: T0, workspaceId: wsA, costUsd: 1 });

    const { byWorkspace } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace[0]?.name).toBe('alpha');
    expect(byWorkspace[0]?.color).toBeTruthy();
  });

  it('ranks by tokens when nothing reported a cost', () => {
    // A subscription reports no per-run dollar cost, so ordering purely by
    // money would leave every row at zero and the ranking arbitrary — on
    // exactly the plan this feature exists for.
    insertRun({ startedAt: T0, workspaceId: wsA, costUsd: 0, inputTokens: 10, outputTokens: 1 });
    insertRun({ startedAt: T0, workspaceId: wsB, costUsd: 0, inputTokens: 900, outputTokens: 90 });

    const { byWorkspace } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace.map((entry) => entry.workspaceId)).toEqual([wsB, wsA]);
  });

  it('reports a success rate per workspace', () => {
    insertRun({ startedAt: T0, workspaceId: wsA, status: 'succeeded' });
    insertRun({ startedAt: T0, workspaceId: wsA, status: 'failed' });

    const { byWorkspace } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace[0]?.successRate).toBe(0.5);
  });

  it('honours the window like every other figure', () => {
    insertRun({ startedAt: T0 - DAY - 1, workspaceId: wsA, costUsd: 100 });
    insertRun({ startedAt: T0, workspaceId: wsB, costUsd: 1 });

    const { byWorkspace } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace).toHaveLength(1);
    expect(byWorkspace[0]?.workspaceId).toBe(wsB);
  });

  it('omits a workspace with no runs in the window', () => {
    // An empty row is not information; it is a line that has to be scanned
    // past on every read.
    insertRun({ startedAt: T0, workspaceId: wsA });

    expect(analytics.summary({ since: T0 - DAY }).byWorkspace).toHaveLength(1);
  });

  it('loses a deleted workspace’s runs, because the rows cascade', () => {
    // Worth pinning rather than assuming: `runs.workspace_id` is ON DELETE
    // CASCADE and `foreign_keys` is ON, so deleting a workspace really does
    // remove its history. Every total on this page is computed from those rows,
    // so this is what "deleted" costs — and if a later migration softens the
    // cascade, the row will reappear here and someone will have to decide
    // deliberately how to attribute it.
    insertRun({ startedAt: T0, workspaceId: wsA, costUsd: 3 });
    insertRun({ startedAt: T0, workspaceId: wsB, costUsd: 1 });
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsA);

    const { byWorkspace } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace.map((entry) => entry.workspaceId)).toEqual([wsB]);
  });

  it('names an orphaned run rather than dropping it from the totals', () => {
    // Defence in depth against the join, not a description of today: with the
    // cascade in place this row cannot normally exist. An INNER JOIN would make
    // one silently vanish from every figure on the page if it ever did, which
    // is strictly worse than a row labelled as orphaned.
    db.pragma('foreign_keys = OFF');
    insertRun({ startedAt: T0, workspaceId: 'ws_vanished', costUsd: 3 });

    const { byWorkspace, totalCostUsd } = analytics.summary({ since: T0 - DAY });

    expect(byWorkspace).toHaveLength(1);
    expect(byWorkspace[0]?.name).toBeTruthy();
    expect(byWorkspace[0]?.costUsd).toBe(3);
    // The point of not dropping it: the parts still add up to the whole.
    expect(totalCostUsd).toBe(3);
  });

  it('is a single row when the query is already scoped to one workspace', () => {
    insertRun({ startedAt: T0, workspaceId: wsA });
    insertRun({ startedAt: T0, workspaceId: wsB });

    const { byWorkspace } = analytics.summary({ workspaceId: wsA, since: T0 - DAY });

    expect(byWorkspace.map((entry) => entry.workspaceId)).toEqual([wsA]);
  });
});
