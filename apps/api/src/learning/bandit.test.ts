import type { RunUsage } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { type Arm, DEFAULT_ARMS, PolicyLearner, computeReward, sampleBeta } from './bandit.js';

/** Deterministic PRNG so every statistical assertion below is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function usage(overrides: Partial<RunUsage> = {}): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.05,
    durationMs: 30_000,
    turns: 3,
    ...overrides,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function draws(alpha: number, beta: number, seed: number, count = 2000): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => sampleBeta(alpha, beta, random));
}

describe('mulberry32 (the test PRNG itself)', () => {
  it('is deterministic and uniform enough to be a fair source', () => {
    expect(Array.from({ length: 5 }, mulberry32(1))).not.toEqual([]);
    const a = Array.from({ length: 10 }, mulberry32(7));
    const b = Array.from({ length: 10 }, mulberry32(7));
    expect(a).toEqual(b);

    const values = Array.from({ length: 5000 }, mulberry32(99));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(mean(values)).toBeGreaterThan(0.45);
    expect(mean(values)).toBeLessThan(0.55);
  });
});

describe('sampleBeta', () => {
  it('always lands inside [0, 1]', () => {
    for (const [alpha, beta] of [
      [1, 1],
      [0.5, 0.5],
      [20, 2],
      [2, 20],
      [100, 100],
      [0.1, 5],
    ] as Array<[number, number]>) {
      for (const value of draws(alpha, beta, 12345, 2000)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('Beta(1,1) is uniform: mean near 0.5 and both halves populated', () => {
    const values = draws(1, 1, 4242);
    expect(mean(values)).toBeGreaterThan(0.45);
    expect(mean(values)).toBeLessThan(0.55);
    expect(values.filter((v) => v < 0.5).length).toBeGreaterThan(800);
    expect(values.filter((v) => v > 0.5).length).toBeGreaterThan(800);
  });

  it('Beta(20,2) sits clearly above Beta(2,20)', () => {
    const high = mean(draws(20, 2, 777));
    const low = mean(draws(2, 20, 777));
    expect(high).toBeGreaterThan(0.8);
    expect(low).toBeLessThan(0.2);
    expect(high - low).toBeGreaterThan(0.5);
  });

  it('concentrates as evidence accumulates', () => {
    const spread = draws(2, 2, 31337);
    const tight = draws(200, 200, 31337);
    const variance = (values: number[]): number => {
      const m = mean(values);
      return mean(values.map((v) => (v - m) ** 2));
    };
    expect(mean(tight)).toBeCloseTo(0.5, 1);
    expect(variance(tight)).toBeLessThan(variance(spread) / 5);
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    expect(draws(3, 5, 11, 20)).toEqual(draws(3, 5, 11, 20));
    expect(draws(3, 5, 11, 20)).not.toEqual(draws(3, 5, 12, 20));
  });

  it('degenerates gracefully when both shapes are zero', () => {
    expect(sampleBeta(0, 0, mulberry32(1))).toBe(0.5);
  });
});

describe('computeReward', () => {
  it('orders failed < interrupted < succeeded at identical cost and latency', () => {
    const shared = { usage: usage(), rating: null } as const;
    const failed = computeReward({ ...shared, status: 'failed' });
    const interrupted = computeReward({ ...shared, status: 'interrupted' });
    const succeeded = computeReward({ ...shared, status: 'succeeded' });

    expect(failed).toBeLessThan(interrupted);
    expect(interrupted).toBeLessThan(succeeded);
  });

  it('lets an explicit rating override the inferred quality entirely', () => {
    const base = { usage: usage(), status: 'failed' } as const;
    const inferred = computeReward({ ...base, rating: null });
    const praised = computeReward({ ...base, rating: 1 });
    const panned = computeReward({ ...base, rating: -1 });

    expect(praised).toBeGreaterThan(inferred);
    // A rated failure outranks an unrated success, because the operator's
    // judgement is the ground truth.
    expect(praised).toBeGreaterThan(
      computeReward({ usage: usage(), status: 'succeeded', rating: null }),
    );
    expect(panned).toBeLessThan(inferred);
    expect(computeReward({ ...base, rating: 0 })).toBeGreaterThan(panned);

    // A panned success is worse than an unrated one.
    expect(computeReward({ usage: usage(), status: 'succeeded', rating: -1 })).toBeLessThan(
      computeReward({ usage: usage(), status: 'succeeded', rating: null }),
    );
  });

  it('prefers the cheaper run at equal quality', () => {
    const cheap = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage({ costUsd: 0.01 }),
    });
    const expensive = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage({ costUsd: 2.5 }),
    });
    expect(cheap).toBeGreaterThan(expensive);
  });

  it('prefers the faster run at equal quality', () => {
    const fast = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage({ durationMs: 5_000 }),
    });
    const slow = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage({ durationMs: 20 * 60_000 }),
    });
    expect(fast).toBeGreaterThan(slow);
  });

  it('weights quality above cost and latency', () => {
    // A cheap, instant failure must still score below an expensive, slow success.
    const cheapFailure = computeReward({
      status: 'failed',
      rating: null,
      usage: usage({ costUsd: 0, durationMs: 0 }),
    });
    const costlySuccess = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage({ costUsd: 5, durationMs: 30 * 60_000 }),
    });
    expect(cheapFailure).toBeLessThan(costlySuccess);
  });

  it('penalises hitting a limit and erroring tool calls, with a saturating cap', () => {
    const clean = computeReward({ status: 'succeeded', rating: null, usage: usage() });
    const limited = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage(),
      hitLimit: true,
    });
    const fewErrors = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage(),
      toolErrors: 2,
    });
    const manyErrors = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage(),
      toolErrors: 5,
    });
    const absurdErrors = computeReward({
      status: 'succeeded',
      rating: null,
      usage: usage(),
      toolErrors: 500,
    });

    expect(limited).toBeLessThan(clean);
    expect(fewErrors).toBeLessThan(clean);
    expect(manyErrors).toBeLessThan(fewErrors);
    // The tool-error penalty saturates at 0.2 quality, so 5 and 500 are equal.
    expect(absurdErrors).toBeCloseTo(manyErrors, 10);
  });

  it('always stays inside [0, 1] across extreme inputs', () => {
    const random = mulberry32(5150);
    for (let i = 0; i < 500; i += 1) {
      const reward = computeReward({
        status: (['succeeded', 'failed', 'interrupted'] as const)[Math.floor(random() * 3)]!,
        rating: random() < 0.5 ? null : random() * 2 - 1,
        usage: usage({ costUsd: random() * 100, durationMs: Math.floor(random() * 3_600_000) }),
        hitLimit: random() < 0.5,
        toolErrors: Math.floor(random() * 100),
      });
      expect(reward).toBeGreaterThanOrEqual(0);
      expect(reward).toBeLessThanOrEqual(1);
      expect(Number.isFinite(reward)).toBe(true);
    }

    // Degenerate usage must not produce NaN or a value out of range either.
    expect(
      computeReward({
        status: 'succeeded',
        rating: 1,
        usage: usage({ costUsd: 0, durationMs: 0 }),
      }),
    ).toBeLessThanOrEqual(1);
  });
});

describe('PolicyLearner', () => {
  let db: Db;
  let learner: PolicyLearner;

  const BEST: Arm = { model: 'opus', effort: 'high' };
  const CATEGORY = 'debug';

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    migrate(db);
    learner = new PolicyLearner(db, mulberry32(20260825));
  });

  afterEach(() => {
    db.close();
  });

  it('declines to act before it has enough evidence', () => {
    expect(learner.select(null, CATEGORY)).toBeNull();
    // Even so, it has seeded the default arms with a uniform prior.
    const arms = learner.list(null, CATEGORY);
    expect(arms).toHaveLength(DEFAULT_ARMS.length);
    for (const arm of arms) {
      expect(arm.alpha).toBe(1);
      expect(arm.beta).toBe(1);
      expect(arm.trials).toBe(0);
    }
  });

  it('respects a custom minTrialsToAct threshold', () => {
    for (let i = 0; i < 3; i += 1) {
      learner.update({
        workspaceId: null,
        category: CATEGORY,
        arm: BEST,
        reward: 1,
        usage: usage(),
      });
    }
    expect(learner.select(null, CATEGORY, { minTrialsToAct: 8 })).toBeNull();
    expect(learner.select(null, CATEGORY, { minTrialsToAct: 3 })).not.toBeNull();
  });

  it('keeps one row per (workspace, category, arm) rather than appending', () => {
    for (let i = 0; i < 10; i += 1) {
      learner.update({
        workspaceId: null,
        category: CATEGORY,
        arm: BEST,
        reward: 0.5,
        usage: usage(),
      });
    }
    const arms = learner.list(null, CATEGORY);
    expect(arms).toHaveLength(1);
    const best = arms.find((a) => a.model === 'opus' && a.effort === 'high')!;
    expect(best.trials).toBe(10);
    expect(best.alpha).toBeCloseTo(1 + 10 * 0.5, 6);
    expect(best.beta).toBeCloseTo(1 + 10 * 0.5, 6);
    expect(best.totalReward).toBeCloseTo(5, 6);

    // Seeding the remaining default arms must not disturb the exercised one,
    // and further updates still land on the same row.
    learner.select(null, CATEGORY);
    expect(learner.list(null, CATEGORY)).toHaveLength(DEFAULT_ARMS.length);
    learner.update({ workspaceId: null, category: CATEGORY, arm: BEST, reward: 1, usage: usage() });
    expect(learner.list(null, CATEGORY)).toHaveLength(DEFAULT_ARMS.length);
    expect(
      learner.list(null, CATEGORY).find((a) => a.model === 'opus' && a.effort === 'high')!.trials,
    ).toBe(11);
  });

  it('clamps rewards into [0, 1] before folding them in', () => {
    learner.update({ workspaceId: null, category: CATEGORY, arm: BEST, reward: 5, usage: usage() });
    learner.update({ workspaceId: null, category: CATEGORY, arm: BEST, reward: -3, usage: usage() });
    const best = learner.list(null, CATEGORY).find((a) => a.effort === 'high' && a.model === 'opus')!;
    expect(best.alpha).toBeCloseTo(2, 6); // 1 + 1 + 0
    expect(best.beta).toBeCloseTo(2, 6); // 1 + 0 + 1
  });

  it('tracks running means of cost and duration', () => {
    learner.update({
      workspaceId: null,
      category: CATEGORY,
      arm: BEST,
      reward: 1,
      usage: usage({ costUsd: 0.2, durationMs: 10_000 }),
    });
    learner.update({
      workspaceId: null,
      category: CATEGORY,
      arm: BEST,
      reward: 1,
      usage: usage({ costUsd: 0.4, durationMs: 30_000 }),
    });
    const best = learner.list(null, CATEGORY).find((a) => a.effort === 'high' && a.model === 'opus')!;
    expect(best.meanCostUsd).toBeCloseTo(0.3, 6);
    expect(best.meanDurationMs).toBeCloseTo(20_000, 6);
  });

  it('converges on a clearly better arm', () => {
    for (let i = 0; i < 40; i += 1) {
      learner.update({
        workspaceId: null,
        category: CATEGORY,
        arm: BEST,
        reward: 1,
        usage: usage(),
      });
      for (const arm of DEFAULT_ARMS) {
        if (arm.model === BEST.model && arm.effort === BEST.effort) continue;
        learner.update({
          workspaceId: null,
          category: CATEGORY,
          arm,
          reward: 0,
          usage: usage(),
        });
      }
    }

    let wins = 0;
    for (let i = 0; i < 200; i += 1) {
      const choice = learner.select(null, CATEGORY);
      expect(choice).not.toBeNull();
      if (choice!.arm.model === BEST.model && choice!.arm.effort === BEST.effort) wins += 1;
    }
    expect(wins).toBeGreaterThan(150);

    const choice = learner.select(null, CATEGORY)!;
    expect(choice.confidence).toBeGreaterThan(0.9);
    expect(choice.confidence).toBeLessThanOrEqual(1);
  });

  it('orders list() by posterior mean, best first', () => {
    const scores = new Map<string, number>([
      ['haiku|null', 0.1],
      ['sonnet|low', 0.3],
      ['sonnet|high', 0.5],
      ['opus|medium', 0.7],
      ['opus|high', 0.95],
    ]);
    for (let i = 0; i < 20; i += 1) {
      for (const arm of DEFAULT_ARMS) {
        learner.update({
          workspaceId: null,
          category: CATEGORY,
          arm,
          reward: scores.get(`${arm.model}|${arm.effort}`)!,
          usage: usage(),
        });
      }
    }

    const arms = learner.list(null, CATEGORY);
    expect(arms.map((a) => `${a.model}|${a.effort}`)).toEqual([
      'opus|high',
      'opus|medium',
      'sonnet|high',
      'sonnet|low',
      'haiku|null',
    ]);

    const means = arms.map((a) => a.alpha / (a.alpha + a.beta));
    for (let i = 1; i < means.length; i += 1) {
      expect(means[i - 1]!).toBeGreaterThanOrEqual(means[i]!);
    }
  });

  it('keeps categories and workspaces separate', () => {
    learner.update({ workspaceId: null, category: 'debug', arm: BEST, reward: 1, usage: usage() });
    learner.update({ workspaceId: null, category: 'plan', arm: BEST, reward: 1, usage: usage() });

    expect(learner.list(null, 'debug').find((a) => a.effort === 'high' && a.model === 'opus')!.trials).toBe(1);
    expect(learner.list(null, 'plan').find((a) => a.effort === 'high' && a.model === 'opus')!.trials).toBe(1);

    const categories = learner.categories(null);
    expect(categories.map((c) => c.category).sort()).toEqual(['debug', 'plan']);
    expect(categories.every((c) => c.trials === 1)).toBe(true);

    // update() only touches the arm it was given; the full default set is
    // materialised lazily, the first time a selection is attempted.
    expect(learner.list(null)).toHaveLength(2);
    learner.select(null, 'debug');
    expect(learner.list(null, 'debug')).toHaveLength(DEFAULT_ARMS.length);
    expect(learner.list(null, 'plan')).toHaveLength(1);

    // list() without a category returns every arm across categories.
    learner.select(null, 'plan');
    expect(learner.list(null)).toHaveLength(2 * DEFAULT_ARMS.length);
  });

  it('explains itself in plain language', () => {
    expect(learner.explain(null, 'never-seen')).toBe('No runs recorded yet for this kind of task.');

    learner.update({
      workspaceId: null,
      category: CATEGORY,
      arm: BEST,
      reward: 1,
      usage: usage({ costUsd: 0.123, durationMs: 45_000 }),
    });
    const single = learner.explain(null, CATEGORY);
    expect(single.length).toBeGreaterThan(0);
    expect(single).toContain('Across 1 run,');
    expect(single).toContain('opus at high effort');
    expect(single).toContain('0.123 USD');
    expect(single).toContain('45s');

    learner.update({
      workspaceId: null,
      category: CATEGORY,
      arm: BEST,
      reward: 1,
      usage: usage(),
    });
    expect(learner.explain(null, CATEGORY)).toContain('Across 2 runs,');
  });

  it('reset() unlearns a category, or everything for the workspace', () => {
    for (const category of ['debug', 'plan']) {
      learner.update({ workspaceId: null, category, arm: BEST, reward: 1, usage: usage() });
      learner.select(null, category); // materialise the full default arm set
    }
    expect(learner.list(null)).toHaveLength(2 * DEFAULT_ARMS.length);

    expect(learner.reset(null, 'debug')).toBe(DEFAULT_ARMS.length);
    expect(learner.list(null, 'debug')).toEqual([]);
    expect(learner.list(null, 'plan')).toHaveLength(DEFAULT_ARMS.length);

    expect(learner.reset(null)).toBe(DEFAULT_ARMS.length);
    expect(learner.list(null)).toEqual([]);
    expect(learner.select(null, 'debug')).toBeNull();
    expect(learner.explain(null, 'debug')).toBe('No runs recorded yet for this kind of task.');
  });
});
