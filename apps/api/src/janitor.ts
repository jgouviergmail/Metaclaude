/**
 * Background maintenance.
 *
 * Everything here is idempotent and cheap enough to run while the OS is serving
 * traffic. Splitting it out of the request path means a slow sweep can never
 * make the UI feel slow.
 */

import { pruneInsights } from './learning/reflexion.js';
import type { AppContext } from './context.js';

/** Fast sweep: expired sessions, stale replay buffers. */
const FAST_INTERVAL_MS = 10 * 60 * 1000;
/** Slow sweep: memory decay, garbage collection, audit retention. */
const SLOW_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Audit entries older than this are pruned (and the chain re-anchored). */
const AUDIT_RETENTION_DAYS = 365;

/**
 * Triaged insights older than this are dropped. The same window as the audit
 * log, because they answer the same question — what happened, and when.
 * `new` and `accepted` are exempt: they are the operator's review queue.
 */
const INSIGHT_RETENTION_DAYS = 365;

export function startJanitor(context: AppContext): () => void {
  const fast = setInterval(() => {
    try {
      const sessions = context.auth.pruneSessions();
      context.bus.sweep();
      if (sessions > 0) context.log.debug(`janitor: pruned ${sessions} expired auth session(s)`);
    } catch (error) {
      context.log.warn({ err: error }, 'janitor fast sweep failed');
    }
  }, FAST_INTERVAL_MS);
  fast.unref();

  const slow = setInterval(() => {
    try {
      const decayed = context.memory.decay();
      const collected = context.memory.collect();
      const audited = context.audit.prune(AUDIT_RETENTION_DAYS);
      const insights = pruneInsights(context.db, INSIGHT_RETENTION_DAYS);

      if (decayed > 0 || collected > 0 || audited > 0 || insights > 0) {
        context.log.info(
          { decayed, collected, auditPruned: audited, insightsPruned: insights },
          'janitor: memory and audit maintenance',
        );
      }

      // Uploads nobody ever sent: a closed tab leaves them pending forever.
      // Async and self-contained — a failed unlink must not fail the sweep.
      void context.attachments
        .collectOrphans()
        .then((orphans) => {
          if (orphans > 0) context.log.info({ orphans }, 'janitor: reaped unsent attachments');
        })
        .catch((error) => context.log.warn({ err: error }, 'janitor: attachment sweep failed'));

      // Runs past the retention window, with their transcripts and their
      // uploaded files. Async for the same reason as the sweep above — it
      // unlinks — and after it rather than before, so a file that belongs to
      // both a reaped upload and a reaped run is only looked at once.
      void context.runRetention
        .sweep()
        .then((removed) => {
          if (removed > 0) context.log.info({ removed }, 'janitor: pruned runs past retention');
        })
        .catch((error) => context.log.warn({ err: error }, 'janitor: run retention failed'));

      // Reclaim pages freed by deletes so the database file does not only grow.
      context.db.pragma('incremental_vacuum');
      context.db.pragma('wal_checkpoint(PASSIVE)');
    } catch (error) {
      context.log.warn({ err: error }, 'janitor slow sweep failed');
    }
  }, SLOW_INTERVAL_MS);
  slow.unref();

  return () => {
    clearInterval(fast);
    clearInterval(slow);
  };
}
