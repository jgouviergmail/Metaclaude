/**
 * Usage analytics.
 *
 * Aggregation happens in SQL over the `runs` table rather than in a separate
 * metrics store: the volume is small (a personal deployment produces thousands
 * of runs, not millions) and keeping one source of truth means the dashboard can
 * never disagree with the run history.
 */

import type { UsagePoint } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';

export type Granularity = 'hour' | 'day' | 'week';

const BUCKET_MS: Record<Granularity, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

interface RunAggregateRow {
  started_at: number;
  status: string;
  usage: string;
  policy: string;
  category: string | null;
  reward: number | null;
}

export interface AnalyticsSummary {
  totalRuns: number;
  successRate: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  medianDurationMs: number;
  p95DurationMs: number;
  averageReward: number | null;
  byModel: Array<{ model: string; runs: number; costUsd: number; successRate: number }>;
  byCategory: Array<{ category: string; runs: number; averageReward: number | null }>;
}

export class AnalyticsService {
  constructor(private readonly db: Db) {}

  private fetch(options: { workspaceId?: string; since: number; until: number }): RunAggregateRow[] {
    const clauses = ['started_at >= ?', 'started_at < ?'];
    const params: unknown[] = [options.since, options.until];
    if (options.workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(options.workspaceId);
    }
    // Only finished runs: an in-flight run has no usage yet and would drag every
    // average toward zero.
    clauses.push("status NOT IN ('queued','running','waiting_approval')");

    return this.db
      .prepare<unknown[], RunAggregateRow>(
        `SELECT started_at, status, usage, policy, category, reward FROM runs
         WHERE ${clauses.join(' AND ')} ORDER BY started_at ASC`,
      )
      .all(...params);
  }

  /** Time series bucketed at the requested granularity. */
  series(options: {
    workspaceId?: string;
    since: number;
    until?: number;
    granularity?: Granularity;
  }): UsagePoint[] {
    const until = options.until ?? Date.now();
    const granularity = options.granularity ?? 'day';
    const size = BUCKET_MS[granularity];

    const rows = this.fetch({ ...options, until });
    const buckets = new Map<number, { runs: number; ok: number; cost: number; input: number; output: number; durations: number[] }>();

    for (const row of rows) {
      const bucket = Math.floor(row.started_at / size) * size;
      let entry = buckets.get(bucket);
      if (!entry) {
        entry = { runs: 0, ok: 0, cost: 0, input: 0, output: 0, durations: [] };
        buckets.set(bucket, entry);
      }
      const usage = parseJson<{ costUsd: number; inputTokens: number; outputTokens: number; durationMs: number }>(
        row.usage,
        { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      );

      entry.runs += 1;
      if (row.status === 'succeeded') entry.ok += 1;
      entry.cost += usage.costUsd;
      entry.input += usage.inputTokens;
      entry.output += usage.outputTokens;
      entry.durations.push(usage.durationMs);
    }

    // Emit empty buckets too, so the chart shows gaps as gaps rather than
    // silently compressing the time axis.
    const points: UsagePoint[] = [];
    const start = Math.floor(options.since / size) * size;
    for (let bucket = start; bucket <= until; bucket += size) {
      const entry = buckets.get(bucket);
      points.push({
        bucket,
        runs: entry?.runs ?? 0,
        costUsd: round(entry?.cost ?? 0, 6),
        inputTokens: entry?.input ?? 0,
        outputTokens: entry?.output ?? 0,
        successRate: entry && entry.runs > 0 ? entry.ok / entry.runs : 0,
        medianDurationMs: entry ? percentile(entry.durations, 0.5) : 0,
      });
    }
    return points;
  }

  summary(options: { workspaceId?: string; since: number; until?: number }): AnalyticsSummary {
    const until = options.until ?? Date.now();
    const rows = this.fetch({ ...options, until });

    let cost = 0;
    let input = 0;
    let output = 0;
    let ok = 0;
    const durations: number[] = [];
    const rewards: number[] = [];

    const byModel = new Map<string, { runs: number; cost: number; ok: number }>();
    const byCategory = new Map<string, { runs: number; rewards: number[] }>();

    for (const row of rows) {
      const usage = parseJson<{ costUsd: number; inputTokens: number; outputTokens: number; durationMs: number }>(
        row.usage,
        { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      );
      const policy = parseJson<{ model?: string }>(row.policy, {});
      const succeeded = row.status === 'succeeded';

      cost += usage.costUsd;
      input += usage.inputTokens;
      output += usage.outputTokens;
      if (succeeded) ok += 1;
      durations.push(usage.durationMs);
      if (row.reward !== null) rewards.push(row.reward);

      const model = policy.model ?? 'default';
      const modelEntry = byModel.get(model) ?? { runs: 0, cost: 0, ok: 0 };
      modelEntry.runs += 1;
      modelEntry.cost += usage.costUsd;
      if (succeeded) modelEntry.ok += 1;
      byModel.set(model, modelEntry);

      const category = row.category ?? 'uncategorised';
      const categoryEntry = byCategory.get(category) ?? { runs: 0, rewards: [] };
      categoryEntry.runs += 1;
      if (row.reward !== null) categoryEntry.rewards.push(row.reward);
      byCategory.set(category, categoryEntry);
    }

    return {
      totalRuns: rows.length,
      successRate: rows.length > 0 ? ok / rows.length : 0,
      totalCostUsd: round(cost, 6),
      totalInputTokens: input,
      totalOutputTokens: output,
      medianDurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      averageReward: rewards.length > 0 ? round(mean(rewards), 4) : null,
      byModel: [...byModel]
        .map(([model, entry]) => ({
          model,
          runs: entry.runs,
          costUsd: round(entry.cost, 6),
          successRate: entry.runs > 0 ? entry.ok / entry.runs : 0,
        }))
        .sort((a, b) => b.runs - a.runs),
      byCategory: [...byCategory]
        .map(([category, entry]) => ({
          category,
          runs: entry.runs,
          averageReward: entry.rewards.length > 0 ? round(mean(entry.rewards), 4) : null,
        }))
        .sort((a, b) => b.runs - a.runs),
    };
  }
}

/* -------------------------------------------------------------------------- */

/** Linear-interpolated percentile. Returns 0 for an empty sample. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  const weight = position - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
