/**
 * Dropping runs old enough that nobody will read them again.
 *
 * The database is the one thing here that grows without limit and never
 * shrinks: every message, every tool call and every streamed delta of every
 * run lands in `transcript_events` and stays. The janitor already prunes the
 * audit log and the triaged insights on a one-year window; this is the same
 * idea applied to the largest table, which had no window at all.
 *
 * It is also the only sweep in this system that destroys something the
 * operator wrote, so it is deliberately conservative:
 *
 *  - Two conditions, not one. Age alone would empty a workspace that has been
 *    quiet for a year, and losing the only three runs someone has is a far
 *    worse outcome than keeping a few megabytes. The newest `keepPerWorkspace`
 *    of every workspace survive whatever their age.
 *  - Terminal runs only. A `queued` or `running` row that is old is a stuck
 *    run, not a historical one, and the kernel may still be holding a
 *    reservation against it.
 *  - Sessions are never touched. A session carries the CLI session id that
 *    resumes a conversation, and it is worth keeping long after its transcript
 *    stops being interesting.
 *
 * What follows a deleted run is decided by the schema, and was checked against
 * the production database rather than assumed: `transcript_events`,
 * `memory_usages` and `document_usages` cascade; `insights.run_id` becomes
 * null, so the lesson outlives the run it came from, which is the right way
 * round. One consequence is worth stating rather than discovering: the genesis
 * view of an old memory — which run recalled it — goes with the run.
 */

import type { Db } from '../db/index.js';
import type { AttachmentService } from './attachments.js';

/** Statuses a run can still leave. Nothing in this set is history yet. */
const IN_FLIGHT = ['queued', 'running', 'waiting_approval'] as const;

export interface RunRetentionDeps {
  db: Db;
  /**
   * Needed for one reason, and it is the reason this is a service rather than
   * a `DELETE`: `attachments.run_id` is `ON DELETE CASCADE`, so removing a run
   * takes the attachment *row* and leaves its bytes on the volume forever. The
   * unlink lives in application code, and no SQL cascade reaches it.
   */
  attachments: Pick<AttachmentService, 'byRun' | 'delete'>;
  /** 0 switches the sweep off entirely. */
  retentionDays: number;
  /** Newest runs kept per workspace whatever their age. */
  keepPerWorkspace: number;
  now?: () => number;
}

export class RunRetention {
  constructor(private readonly deps: RunRetentionDeps) {}

  /** Returns how many runs were removed. */
  async sweep(): Promise<number> {
    const { db, retentionDays, keepPerWorkspace } = this.deps;
    if (retentionDays <= 0) return 0;

    const cutoff = (this.deps.now?.() ?? Date.now()) - retentionDays * 86_400_000;

    // Selected in one statement so the floor and the window are applied to the
    // same snapshot. `started_at` rather than `finished_at`: every run has
    // one, including those that ended without ever reporting a finish.
    const doomed = db
      .prepare<[number, ...string[]], { id: string }>(
        `SELECT id FROM runs AS r
          WHERE r.started_at < ?
            AND r.status NOT IN (${IN_FLIGHT.map(() => '?').join(',')})
            AND r.id NOT IN (
              SELECT id FROM runs AS newest
               WHERE newest.workspace_id = r.workspace_id
               ORDER BY newest.started_at DESC
               LIMIT ${Number(keepPerWorkspace)}
            )`,
      )
      .all(cutoff, ...IN_FLIGHT)
      .map((row) => row.id);

    if (doomed.length === 0) return 0;

    // Files first, and outside the transaction: an unlink cannot be rolled
    // back, so doing it after a successful delete would leave the row gone and
    // the file orphaned if the process died in between. This way round the
    // worst case is a file removed for a run that survives — visible, and
    // recoverable by deleting the run again.
    for (const runId of doomed) {
      for (const attachment of this.deps.attachments.byRun(runId)) {
        await this.deps.attachments.delete(attachment.id);
      }
    }

    // Chunked because every id is a bound parameter and SQLite caps them.
    let removed = 0;
    for (let i = 0; i < doomed.length; i += 200) {
      const batch = doomed.slice(i, i + 200);
      removed += db
        .prepare(`DELETE FROM runs WHERE id IN (${batch.map(() => '?').join(',')})`)
        .run(...batch).changes;
    }
    return removed;
  }
}
