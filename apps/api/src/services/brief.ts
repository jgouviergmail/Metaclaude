/**
 * The morning brief — one page answering "what happened, what needs me".
 *
 * Composed server-side from sources that already exist — analytics, the
 * doctor, the quota cache, the tables — because a digest assembled
 * deterministically costs nothing and is always available; narrative can be
 * layered on top by an automation, but the facts must not depend on a model
 * being reachable. A source that cannot answer costs its section, never the
 * brief: the quota is the usual casualty and arrives as null.
 */

import type { Brief, BriefBoard, BriefFailure, ClaudeUsage, DoctorReport } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import type { AnalyticsService } from './analytics.js';

const DAY_MS = 24 * 3_600_000;

export interface BriefDeps {
  db: Db;
  analytics: AnalyticsService;
  doctor: { run(): Promise<DoctorReport> };
  /** The quota, from the same cache the Analytics screen reads. */
  usage: () => Promise<ClaudeUsage | null>;
  pendingApprovals: () => number;
  now?: () => number;
}

export class BriefService {
  constructor(private readonly deps: BriefDeps) {}

  async generate(): Promise<Brief> {
    const now = this.deps.now ? this.deps.now() : Date.now();
    const since = now - DAY_MS;

    const activity = this.deps.analytics.summary({ since });

    const failures: BriefFailure[] = this.deps.db
      .prepare<
        [number],
        {
          id: string;
          session_id: string;
          workspace_id: string;
          workspace_name: string;
          prompt: string;
          error: string | null;
          started_at: number;
        }
      >(
        `SELECT r.id, r.session_id, r.workspace_id, w.name AS workspace_name,
                r.prompt, r.error, r.started_at
         FROM runs r JOIN workspaces w ON w.id = r.workspace_id
         WHERE r.status = 'failed' AND r.started_at >= ?
         ORDER BY r.started_at DESC
         LIMIT 10`,
      )
      .all(since)
      .map((row) => ({
        runId: row.id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        prompt: row.prompt.replace(/\s+/g, ' ').slice(0, 160),
        error: row.error,
        at: row.started_at,
      }));

    const disabledByGuard = this.deps.db
      .prepare<[], { name: string }>(
        `SELECT name FROM automations
         WHERE enabled = 0 AND consecutive_failures >= max_consecutive_failures`,
      )
      .all()
      .map((row) => row.name);

    const nextRunRow = this.deps.db
      .prepare<[number], { name: string; next_run_at: number }>(
        `SELECT name, next_run_at FROM automations
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at >= ?
         ORDER BY next_run_at ASC LIMIT 1`,
      )
      .get(now);

    const newInsights =
      this.deps.db
        .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM insights WHERE created_at >= ?')
        .get(since)?.n ?? 0;

    // The board's pulse: what waits on the operator, what is stuck, what is
    // being worked this minute, what the calendar is about to call.
    const board: BriefBoard = this.deps.db
      .prepare<[number], BriefBoard>(
        `SELECT
           SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) AS inReview,
           SUM(CASE WHEN t.blocked_reason IS NOT NULL THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN r.status IN ('queued','running','waiting_approval') THEN 1 ELSE 0 END) AS inFlight,
           SUM(CASE WHEN t.due_at IS NOT NULL AND t.due_at <= ? AND t.status != 'done' THEN 1 ELSE 0 END) AS dueSoon
         FROM tasks t LEFT JOIN runs r ON r.id = t.run_id
         WHERE t.archived_at IS NULL`,
      )
      .get(now + 48 * 3_600_000) ?? { inReview: 0, blocked: 0, inFlight: 0, dueSoon: 0 };
    // SUM over zero rows is NULL, not 0 — normalise before anything reads it.
    for (const key of Object.keys(board) as (keyof BriefBoard)[]) {
      board[key] = board[key] ?? 0;
    }

    const doctor = await this.deps.doctor.run();

    let quota: ClaudeUsage | null;
    try {
      quota = await this.deps.usage();
    } catch {
      quota = null;
    }

    const pendingApprovals = this.deps.pendingApprovals();

    return {
      since,
      generatedAt: now,
      headline: this.headline(activity.totalRuns, failures.length, pendingApprovals, doctor, board),
      activity,
      failures,
      pendingApprovals,
      automations: {
        disabledByGuard,
        nextRun: nextRunRow ? { name: nextRunRow.name, at: nextRunRow.next_run_at } : null,
      },
      doctor,
      quota,
      newInsights,
      board,
    };
  }

  /** The one sentence to read when nothing else gets read. */
  private headline(
    runs: number,
    failures: number,
    approvals: number,
    doctor: DoctorReport,
    board: BriefBoard,
  ): string {
    if (runs === 0 && approvals === 0 && doctor.status === 'ok' && board.inReview === 0) {
      return 'A quiet day — no runs in the last 24 hours, and every self-check passes.';
    }

    const parts: string[] = [];
    parts.push(runs === 0 ? 'No runs in the last 24 hours' : `${runs} run${runs === 1 ? '' : 's'} in the last 24 hours`);
    if (failures > 0) parts.push(`${failures} failure${failures === 1 ? '' : 's'} worth a look`);
    if (approvals > 0) parts.push(`${approvals} approval${approvals === 1 ? '' : 's'} waiting on you`);
    if (board.inReview > 0) {
      parts.push(`${board.inReview} card${board.inReview === 1 ? '' : 's'} waiting for review`);
    }
    if (doctor.status !== 'ok') parts.push(`the doctor reports ${doctor.status}`);
    return `${parts.join(', ')}.`;
  }
}
