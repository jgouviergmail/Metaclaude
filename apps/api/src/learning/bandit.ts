/**
 * Policy learning — which model and effort level to use for a given task.
 *
 * This is a contextual multi-armed bandit. The context is the task category
 * produced by the classifier; the arms are (model, effort) pairs; the reward is
 * a composite of success, cost and latency. We use Thompson sampling over a Beta
 * posterior per arm, which is the standard choice when rewards are bounded in
 * [0,1] and you care about regret rather than pure exploitation.
 *
 * Why Thompson sampling rather than ε-greedy or UCB:
 *  - It explores in proportion to genuine uncertainty, so a clearly-better arm
 *    stops being second-guessed quickly. That matters here because every
 *    exploration step costs the operator real money and real time.
 *  - It needs no tuning constant, which is important for a system that must
 *    behave sensibly from the very first run.
 *
 * Everything is auditable: the posterior for each arm is a row the operator can
 * inspect, and `explain()` renders the current belief in plain language.
 */

import type { EffortLevel, ModelSelector, PolicyArm, RunUsage } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';

export interface Arm {
  model: ModelSelector;
  effort: EffortLevel | null;
}

interface ArmRow {
  id: string;
  workspace_id: string | null;
  category: string;
  model: string;
  effort: string | null;
  alpha: number;
  beta: number;
  trials: number;
  total_reward: number;
  mean_cost_usd: number;
  mean_duration_ms: number;
  updated_at: number;
}

/**
 * The arms we consider.
 *
 * Deliberately small: a bandit with forty arms and a handful of runs per week
 * never converges. These span the useful trade-off frontier — cheap and fast,
 * balanced, deep reasoning, and the flagship tier — and the operator can
 * always override. The fable arms exist because a frontier frozen at the
 * previous generation makes the newest model structurally unreachable under
 * Auto, however the runs score; the reward prices cost in, so an arm that is
 * not worth its money loses on evidence instead of by omission. On a
 * subscription without fable the CLI refuses visibly (the refusal is narrated
 * and the served-model chip shows what ran instead), the reward drops, and
 * the bandit routes around it.
 *
 * Listing an expensive arm is not the same as *starting* on it, and the two
 * were conflated for as long as the prior was uniform: four of these are opus
 * or fable, so a near-uniform Thompson draw put more than half of every early
 * decision on the dear end of the range. The frontier stays complete —
 * omission is not evidence — and `armPrior` decides where each arm opens.
 * `sonnet medium` was added because the gap between `low` and `high` was the
 * one place the operator's own workspace default sat with no arm beside it.
 */
export const DEFAULT_ARMS: readonly Arm[] = [
  { model: 'haiku', effort: null },
  { model: 'sonnet', effort: 'low' },
  { model: 'sonnet', effort: 'medium' },
  { model: 'sonnet', effort: 'high' },
  { model: 'opus', effort: 'medium' },
  { model: 'opus', effort: 'high' },
  { model: 'fable', effort: 'high' },
  { model: 'fable', effort: 'xhigh' },
];

/* -------------------------------------------------------------------------- */
/* The prior                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a model costs per million tokens, whether it takes an effort level at
 * all, and how long an ordinary run on it takes at `medium`.
 *
 * These exist to *rank* the arms before any evidence, not to bill anything —
 * the CLI reports the real cost and `update()` overwrites the estimate with it.
 * An alias the table does not name falls back to the middle of the range, which
 * is the honest answer for a dated model id the operator pinned by hand.
 *
 * `effort: false` is load-bearing rather than decorative. Haiku takes no effort
 * parameter, so a `null` on it means "this model has no such knob", while a
 * `null` on Sonnet means "the CLI will choose, and it chooses high". Reading
 * both as `high` priced the cheapest, fastest arm in the frontier as though it
 * were the slowest, and the first version of this ranked `sonnet low` above
 * `haiku` — which is not what "start low" means.
 */
interface ModelProfile {
  in: number;
  out: number;
  effort: boolean;
  durationMs: number;
}
const MODEL_PROFILE: Readonly<Record<string, ModelProfile>> = {
  haiku: { in: 1, out: 5, effort: false, durationMs: 25_000 },
  sonnet: { in: 2, out: 10, effort: true, durationMs: 45_000 },
  opus: { in: 5, out: 25, effort: true, durationMs: 60_000 },
  opusplan: { in: 5, out: 25, effort: true, durationMs: 60_000 },
  fable: { in: 10, out: 50, effort: true, durationMs: 75_000 },
};
const UNKNOWN_MODEL: ModelProfile = { in: 5, out: 25, effort: true, durationMs: 60_000 };

/**
 * What one run costs and how long it takes, per effort level.
 *
 * Measured on this deployment rather than guessed: 285 turns read 12.04M cached
 * tokens, so a turn carries ~42k of context, and 54 runs produced 171.7k output
 * tokens, so a run writes ~3.2k. Effort moves the output (it is thinking depth)
 * and the wall clock; it does not move the context the run has to re-read.
 */
const REFERENCE_INPUT_TOKENS = 42_000;
const REFERENCE_OUTPUT_TOKENS = 3_200;
const NEUTRAL_EFFORT = { output: 1, duration: 1 };
const EFFORT_FACTOR: Readonly<Record<string, { output: number; duration: number }>> = {
  low: { output: 0.6, duration: 0.6 },
  medium: NEUTRAL_EFFORT,
  high: { output: 1.6, duration: 1.6 },
  xhigh: { output: 2.4, duration: 2.4 },
  max: { output: 3.2, duration: 3 },
};

/**
 * How much evidence the prior is worth, in pseudo-trials.
 *
 * Four is deliberately small: two or three real runs on an arm already
 * outweigh it, so this steers the opening moves and then gets out of the way.
 * A prior that survived a dozen trials would not be a prior, it would be a
 * policy — and the whole point of the bandit is that measurement wins.
 */
const PRIOR_STRENGTH = 4;

/**
 * The opening belief about an arm, before it has ever run.
 *
 * Beta(1,1) — the uniform prior this used to seed — says an arm costing $2.10
 * is exactly as plausible as one costing $0.07. With eight arms whose
 * posteriors are near-identical, Thompson sampling is then close to uniform,
 * so more than half of every early decision landed on an opus or fable arm.
 * That is the opposite of how you find a threshold: you start low and let the
 * failures push you up.
 *
 * So the prior is the reward function's own answer for a *typical successful
 * run* on that arm. Quality is unmeasurable in advance — `computeReward` gives
 * every success the same 0.8 — so the only honest thing that can separate two
 * unproven arms is what they will cost and how long they will take, which is
 * exactly what the remaining two terms price. Deriving it through
 * `computeReward` rather than a hand-written table also means the prior follows
 * the reward: change a weight and the opening beliefs move with it, instead of
 * silently contradicting it.
 */
export function armPrior(arm: Arm): { alpha: number; beta: number } {
  const model = MODEL_PROFILE[String(arm.model)] ?? UNKNOWN_MODEL;
  // A model that takes no effort level has no default to infer; one that does
  // and was left on Auto gets the CLI's own default, which is `high`.
  const level = arm.effort ?? (model.effort ? 'high' : null);
  const effort = (level === null ? NEUTRAL_EFFORT : EFFORT_FACTOR[level]) ?? NEUTRAL_EFFORT;

  const outputTokens = REFERENCE_OUTPUT_TOKENS * effort.output;
  const costUsd = (REFERENCE_INPUT_TOKENS * model.in + outputTokens * model.out) / 1_000_000;

  const mean = computeReward({
    status: 'succeeded',
    rating: null,
    usage: {
      inputTokens: REFERENCE_INPUT_TOKENS,
      outputTokens: Math.round(outputTokens),
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
      durationMs: Math.round(model.durationMs * effort.duration),
      turns: 0,
    },
  });

  // Beta(1,1) plus the pseudo-trials, so every arm keeps a proper prior and
  // sampling stays defined however the numbers move.
  return { alpha: 1 + PRIOR_STRENGTH * mean, beta: 1 + PRIOR_STRENGTH * (1 - mean) };
}

function toArm(row: ArmRow): PolicyArm {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    model: row.model,
    effort: row.effort as EffortLevel | null,
    alpha: row.alpha,
    beta: row.beta,
    trials: row.trials,
    totalReward: row.total_reward,
    meanCostUsd: row.mean_cost_usd,
    meanDurationMs: row.mean_duration_ms,
    updatedAt: row.updated_at,
  };
}

/** Cost and duration are already recorded; a revision only changes the reward. */
const EMPTY_USAGE_FOR_REVISION: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  turns: 0,
};

export class PolicyLearner {
  constructor(
    private readonly db: Db,
    /** Injectable for deterministic tests; defaults to `Math.random`. */
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Choose an arm for a task.
   *
   * Returns `null` when there is not enough evidence to prefer anything — the
   * caller then falls back to the workspace default. Acting on one data point
   * would be worse than not learning at all.
   */
  select(
    workspaceId: string | null,
    category: string,
    options: { minTrialsToAct?: number } = {},
  ): { arm: Arm; confidence: number } | null {
    const arms = this.ensureArms(workspaceId, category);
    const totalTrials = arms.reduce((sum, arm) => sum + arm.trials, 0);

    // Below this we have no signal worth acting on; explore via the default.
    const minTrials = options.minTrialsToAct ?? 8;
    if (totalTrials < minTrials) return null;

    let best: { arm: PolicyArm; sample: number } | null = null;
    for (const arm of arms) {
      const sample = sampleBeta(arm.alpha, arm.beta, this.random);
      if (!best || sample > best.sample) best = { arm, sample };
    }
    if (!best) return null;

    return {
      arm: { model: best.arm.model, effort: best.arm.effort },
      // Posterior mean of the chosen arm — how good we currently believe it is.
      confidence: best.arm.alpha / (best.arm.alpha + best.arm.beta),
    };
  }

  /**
   * Fold an observed outcome into the posterior.
   *
   * The reward is treated as a fractional success, so `alpha` and `beta` accept
   * continuous evidence rather than only win/lose. This is the standard
   * Bernoulli relaxation and keeps the conjugate update exact in expectation.
   */
  update(input: {
    workspaceId: string | null;
    category: string;
    arm: Arm;
    reward: number;
    usage: RunUsage;
  }): void {
    const reward = Math.min(1, Math.max(0, input.reward));

    tx(this.db, () => {
      const row = this.findOrCreate(input.workspaceId, input.category, input.arm);
      const trials = row.trials + 1;

      this.db
        .prepare(
          `UPDATE policy_arms SET
             alpha = ?, beta = ?, trials = ?, total_reward = ?,
             mean_cost_usd = ?, mean_duration_ms = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          row.alpha + reward,
          row.beta + (1 - reward),
          trials,
          row.total_reward + reward,
          // Running means, so a long history does not need to be replayed.
          row.mean_cost_usd + (input.usage.costUsd - row.mean_cost_usd) / trials,
          row.mean_duration_ms + (input.usage.durationMs - row.mean_duration_ms) / trials,
          Date.now(),
          row.id,
        );
    });
  }

  /**
   * Replace a previously recorded observation with a corrected one.
   *
   * Used when the operator rates a run whose inferred reward was already folded
   * in. Applying the new reward with `update()` would count the same run twice —
   * and rating it repeatedly would count it repeatedly. Moving by the delta
   * leaves the posterior exactly where a single observation of the corrected
   * value would have put it, and `trials` unchanged.
   */
  revise(input: {
    workspaceId: string | null;
    category: string;
    arm: Arm;
    /** The reward previously applied, or null if none was. */
    previousReward: number | null;
    reward: number;
  }): void {
    const reward = Math.min(1, Math.max(0, input.reward));
    if (input.previousReward === null) {
      // Nothing was applied for this run yet, so this is an ordinary update.
      this.update({ ...input, reward, usage: EMPTY_USAGE_FOR_REVISION });
      return;
    }
    const previous = Math.min(1, Math.max(0, input.previousReward));
    if (previous === reward) return;

    tx(this.db, () => {
      const row = this.findOrCreate(input.workspaceId, input.category, input.arm);
      const floor = armPrior(input.arm);
      this.db
        .prepare(
          'UPDATE policy_arms SET alpha = ?, beta = ?, total_reward = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          // Clamped at the arm's own prior so a correction can never drive a
          // parameter to zero or negative, which would make sampling undefined.
          // It used to clamp at 1 — the old uniform prior — which on an arm
          // whose prior is now above 1 would have let a revision erase it.
          Math.max(floor.alpha, row.alpha - previous + reward),
          Math.max(floor.beta, row.beta - (1 - previous) + (1 - reward)),
          row.total_reward - previous + reward,
          Date.now(),
          row.id,
        );
    });
  }

  /** All arms for a context, best posterior mean first. */
  list(workspaceId: string | null, category?: string): PolicyArm[] {
    const rows = category
      ? this.db
          .prepare<[string | null, string], ArmRow>(
            'SELECT * FROM policy_arms WHERE workspace_id IS ? AND category = ?',
          )
          .all(workspaceId, category)
      : this.db
          .prepare<[string | null], ArmRow>('SELECT * FROM policy_arms WHERE workspace_id IS ?')
          .all(workspaceId);

    return rows
      .map(toArm)
      .sort((a, b) => b.alpha / (b.alpha + b.beta) - a.alpha / (a.alpha + a.beta));
  }

  /** Categories the learner has seen, most-exercised first. */
  categories(workspaceId: string | null): Array<{ category: string; trials: number }> {
    return this.db
      .prepare<[string | null], { category: string; trials: number }>(
        `SELECT category, SUM(trials) AS trials FROM policy_arms
         WHERE workspace_id IS ? GROUP BY category ORDER BY trials DESC`,
      )
      .all(workspaceId);
  }

  /** Plain-language summary of the current belief, for the UI. */
  explain(workspaceId: string | null, category: string): string {
    const arms = this.list(workspaceId, category).filter((arm) => arm.trials > 0);
    if (arms.length === 0) return 'No runs recorded yet for this kind of task.';

    const total = arms.reduce((sum, arm) => sum + arm.trials, 0);
    const best = arms[0] as PolicyArm;
    const mean = best.alpha / (best.alpha + best.beta);
    const label = best.effort ? `${best.model} at ${best.effort} effort` : String(best.model);

    return (
      `Across ${total} run${total === 1 ? '' : 's'}, ${label} performs best ` +
      `(${Math.round(mean * 100)}% expected quality, ` +
      `${best.meanCostUsd.toFixed(3)} USD and ${Math.round(best.meanDurationMs / 1000)}s on average).`
    );
  }

  /** Reset learned policy for a context. Exposed in settings as "unlearn". */
  reset(workspaceId: string | null, category?: string): number {
    return category
      ? this.db
          .prepare('DELETE FROM policy_arms WHERE workspace_id IS ? AND category = ?')
          .run(workspaceId, category).changes
      : this.db.prepare('DELETE FROM policy_arms WHERE workspace_id IS ?').run(workspaceId).changes;
  }

  /* ---------------------------------------------------------------------- */

  private ensureArms(workspaceId: string | null, category: string): PolicyArm[] {
    const existing = this.list(workspaceId, category);

    // Membership, not a count. Comparing lengths breaks once the operator has
    // used enough explicit model overrides to create five non-default arms:
    // the check then passes forever and the intended exploration frontier is
    // never created.
    const key = (model: string, effort: string | null): string => `${model}\x00${effort ?? ''}`;
    const present = new Set(existing.map((arm) => key(String(arm.model), arm.effort)));
    const missing = DEFAULT_ARMS.filter((arm) => !present.has(key(String(arm.model), arm.effort)));
    if (missing.length === 0) return existing;

    tx(this.db, () => {
      for (const arm of missing) this.findOrCreate(workspaceId, category, arm);
    });
    return this.list(workspaceId, category);
  }

  private findOrCreate(workspaceId: string | null, category: string, arm: Arm): ArmRow {
    const found = this.db
      .prepare<[string | null, string, string, string | null], ArmRow>(
        `SELECT * FROM policy_arms
         WHERE workspace_id IS ? AND category = ? AND model = ? AND effort IS ?`,
      )
      .get(workspaceId, category, String(arm.model), arm.effort);
    if (found) return found;

    const id = newId('policyArm');
    // Not Beta(1,1). "Every arm equally plausible" is a statement nobody
    // believes about a $0.07 arm and a $2.10 one, and acting on it is what made
    // Auto expensive. `armPrior` opens each arm where the reward function says
    // an ordinary success on it would land — see its comment.
    const prior = armPrior(arm);
    this.db
      .prepare(
        `INSERT INTO policy_arms (id, workspace_id, category, model, effort, alpha, beta, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        category,
        String(arm.model),
        arm.effort,
        prior.alpha,
        prior.beta,
        Date.now(),
      );

    return this.db
      .prepare<[string], ArmRow>('SELECT * FROM policy_arms WHERE id = ?')
      .get(id) as ArmRow;
  }
}

/* -------------------------------------------------------------------------- */
/* Reward function                                                             */
/* -------------------------------------------------------------------------- */

export interface RewardInput {
  status: 'succeeded' | 'failed' | 'interrupted';
  usage: RunUsage;
  /** Explicit operator rating in [-1, 1], when given. */
  rating: number | null;
  /** Did the agent have to be stopped, or did it hit a hard limit? */
  hitLimit?: boolean;
  /** Number of tool calls that errored during the run. */
  toolErrors?: number;
}

/**
 * Composite reward in [0, 1].
 *
 * Quality dominates — a cheap wrong answer is worthless — but cost and latency
 * carry enough weight to break ties between arms that succeed equally often.
 * When the operator rates a run explicitly, that rating overrides the inferred
 * quality signal entirely: their judgement is the ground truth we are learning.
 */
export function computeReward(input: RewardInput): number {
  let quality: number;

  if (input.rating !== null) {
    // -1..1 → 0..1
    quality = (input.rating + 1) / 2;
  } else if (input.status === 'failed') {
    quality = 0.05;
  } else if (input.status === 'interrupted') {
    // Interruption is ambiguous: the operator may have simply changed their
    // mind. Score it neutrally rather than punishing the arm.
    quality = 0.4;
  } else {
    quality = 0.8;
    if (input.hitLimit) quality -= 0.25;
    const toolErrors = input.toolErrors ?? 0;
    // Each failed tool call is a small quality penalty, saturating at 0.2.
    quality -= Math.min(0.2, toolErrors * 0.04);
  }
  quality = clamp01(quality);

  // Cost: 1.0 at free, decaying to ~0 by $1.00 per run. Personal usage sits
  // well under that, so this mostly separates "cheap" from "very cheap".
  const cost = Math.exp(-input.usage.costUsd / 0.35);

  // Latency: 1.0 instantly, ~0.5 at two minutes, tailing off after that.
  const latency = 1 / (1 + input.usage.durationMs / 120_000);

  return clamp01(0.72 * quality + 0.16 * cost + 0.12 * latency);
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Draw from Beta(alpha, beta) as the ratio of two Gamma draws:
 *   X ~ Gamma(a,1), Y ~ Gamma(b,1)  ⟹  X/(X+Y) ~ Beta(a,b)
 */
export function sampleBeta(alpha: number, beta: number, random: () => number = Math.random): number {
  const x = sampleGamma(alpha, random);
  const y = sampleGamma(beta, random);
  const total = x + y;
  return total === 0 ? 0.5 : x / total;
}

/**
 * Marsaglia–Tsang gamma sampler (shape ≥ 1), with the standard boost for
 * shape < 1. Fast, exact, and needs only a uniform source.
 */
function sampleGamma(shape: number, random: () => number): number {
  if (shape <= 0) return 0;

  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(shape + 1, random) * Math.pow(random() || Number.EPSILON, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(random);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = random();
    const x2 = x * x;

    // Squeeze test, then the exact acceptance test.
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box–Muller transform. */
function standardNormal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
