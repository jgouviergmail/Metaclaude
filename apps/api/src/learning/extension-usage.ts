/**
 * What a run was given, and what it actually reached for.
 *
 * The registry has always known which skills and subagents a workspace offers
 * and nothing has ever known whether a run *used* one. `skills.use_count` was
 * displayed on two screens and incremented by nobody, so it read zero on every
 * deployment that ever ran — the same family of defect as `rewindPoint`, a
 * surface with no source.
 *
 * That gap is what makes "this description never triggers" unaskable, and it
 * is the first question worth asking: measured on the production deployment on
 * 2026-09-10, five skills and five subagents were enabled and **not one was
 * invoked** across sixty-three runs. A description that never fires is dead
 * weight in every prompt that carries it, and until now nothing could see it.
 *
 * Pure by construction: events and an availability list in, rows out. The
 * repository decides which events, the kernel decides what was available, and
 * the shape of a call on the wire is a *measurement* — see the constants in
 * `packages/shared`, which carry the date and the method.
 */

import type { TranscriptEvent } from '@metaclaude/shared';
import {
  DELEGATION_TOOL_FIELD,
  SKILL_TOOL,
  SKILL_TOOL_FIELD,
  isDelegationTool,
} from '@metaclaude/shared';
import { tx, type Db } from '../db/index.js';

/** The two registries a run can reach into. */
export type ExtensionKind = 'skill' | 'agent';

/** One extension a run was given, as the registry names it. */
export interface AvailableExtension {
  kind: ExtensionKind;
  id: string;
  name: string;
}

/**
 * One extension's story in one run.
 *
 * `available` and `invoked` are separate facts and both are needed: available
 * and never invoked is the signal that pays for this module, while invoked
 * without being available is a plugin's skill or one of the CLI's own subagent
 * types — real work, owned by no row here, and `extensionId` says so by being
 * null rather than by being absent.
 */
export interface ExtensionUsage {
  kind: ExtensionKind;
  /** The registry row, or null for something the registry does not own. */
  extensionId: string | null;
  /** The name the CLI reports, which is what identifies it to the model. */
  name: string;
  available: boolean;
  invoked: number;
  /** Invocations that came back an error or were denied. A subset of `invoked`. */
  failed: number;
}

/** The name a call gives, trimmed, or null when it gives none usable. */
function named(input: unknown, field: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Which extension a tool call reaches, or null when it reaches none.
 *
 * The tool name is compared bare and *unprefixed* on purpose: `Skill` and
 * `Agent` are the CLI's own, and `mcp__somewhere__Skill` is another server's
 * tool that happens to share a name. Crediting the second would report a skill
 * as opened by a run that never opened it.
 */
function target(event: Extract<TranscriptEvent, { kind: 'tool_call' }>):
  | { kind: ExtensionKind; name: string }
  | null {
  if (event.name === SKILL_TOOL) {
    const name = named(event.input, SKILL_TOOL_FIELD);
    return name ? { kind: 'skill', name } : null;
  }
  if (isDelegationTool(event.name)) {
    const name = named(event.input, DELEGATION_TOOL_FIELD);
    return name ? { kind: 'agent', name } : null;
  }
  return null;
}

/** Whether this call did not do what it was asked to. */
function miscarried(event: Extract<TranscriptEvent, { kind: 'tool_call' }>): boolean {
  return event.resultIsError || event.status === 'error' || event.status === 'denied';
}

/**
 * The identity of one row: the kind and the name together.
 *
 * Encoded rather than concatenated with a separator, because half of it is a
 * name the *CLI* reported — an unmatched invocation can carry anything — and a
 * separator that turns up inside a name makes two different extensions one
 * row. It is also how the accident that produced this comment is not
 * repeatable: the first version joined with a byte a shell heredoc had turned
 * into a NUL, which worked perfectly and was caught by `controlBytesInSource`
 * rather than by any test.
 */
function usageKey(kind: ExtensionKind, name: string): string {
  return JSON.stringify([kind, name]);
}

/**
 * Fold a run's events into one row per extension.
 *
 * Keyed by `(kind, name)` rather than by id, because the name is what the CLI
 * reports and what the model chooses between — and because an id does not
 * exist for every invocation. A skill and a subagent may share a name across
 * two registries with two unique indexes, which is why the kind is half of it.
 */
export function collectExtensionUsage(
  available: readonly AvailableExtension[],
  events: readonly TranscriptEvent[],
): ExtensionUsage[] {
  const rows = new Map<string, ExtensionUsage>();

  for (const extension of available) {
    const name = extension.name.trim();
    if (!name) continue;
    rows.set(usageKey(extension.kind, name), {
      kind: extension.kind,
      extensionId: extension.id,
      name,
      available: true,
      invoked: 0,
      failed: 0,
    });
  }

  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    const hit = target(event);
    if (!hit) continue;

    let row = rows.get(usageKey(hit.kind, hit.name));
    if (!row) {
      row = { kind: hit.kind, extensionId: null, name: hit.name, available: false, invoked: 0, failed: 0 };
      rows.set(usageKey(hit.kind, hit.name), row);
    }
    row.invoked += 1;
    if (miscarried(event)) row.failed += 1;
  }

  return [...rows.values()];
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */


interface UsageRow {
  kind: string;
  name: string;
  extension_id: string | null;
  available: number;
  invoked: number;
  failed: number;
}

const toUsage = (row: UsageRow): ExtensionUsage => ({
  kind: row.kind as ExtensionKind,
  extensionId: row.extension_id,
  name: row.name,
  available: row.available === 1,
  invoked: row.invoked,
  failed: row.failed,
});

/**
 * Store what a run did with what it was given, and credit the skills it used.
 *
 * `INSERT OR REPLACE` rather than a plain insert, because the learning loop is
 * out-of-band and a catch-up replays it: a second pass over the same run must
 * leave the same row, not take the loop down on a primary key.
 *
 * The skill counter is a *lifetime* total on the registry row, so it is moved
 * by the difference from what this run had already been credited with. A first
 * write credits everything, an identical replay credits nothing, and a replay
 * that saw more credits only the increase. Deriving the figure from this table
 * instead would have it fall as run retention deletes runs, which is not what
 * a use count means. Subagents have no such column and need none — the table
 * answers for them, and a second stored copy of a derived value is the
 * `workspaces.path` trap.
 */
export function recordExtensionUsage(
  db: Db,
  runId: string,
  usages: readonly ExtensionUsage[],
  now: number = Date.now(),
): void {
  if (usages.length === 0) return;

  tx(db, () => {
    const previous = new Map(
      db
        .prepare<[string], { kind: string; name: string; invoked: number }>(
          'SELECT kind, name, invoked FROM run_extension_usages WHERE run_id = ?',
        )
        .all(runId)
        .map((row) => [usageKey(row.kind as ExtensionKind, row.name), row.invoked]),
    );

    const write = db.prepare(
      `INSERT OR REPLACE INTO run_extension_usages
         (run_id, kind, name, extension_id, available, invoked, failed, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const credit = db.prepare('UPDATE skills SET use_count = use_count + ? WHERE id = ?');

    for (const usage of usages) {
      write.run(
        runId,
        usage.kind,
        usage.name,
        usage.extensionId,
        usage.available ? 1 : 0,
        usage.invoked,
        usage.failed,
        now,
      );
      const delta = usage.invoked - (previous.get(usageKey(usage.kind, usage.name)) ?? 0);
      if (usage.kind === 'skill' && usage.extensionId && delta > 0) {
        credit.run(delta, usage.extensionId);
      }
    }
  });
}

/** What one run was offered and reached for, kind then name. */
export function usageForRun(db: Db, runId: string): ExtensionUsage[] {
  return db
    .prepare<[string], UsageRow>(
      'SELECT kind, name, extension_id, available, invoked, failed FROM run_extension_usages WHERE run_id = ? ORDER BY kind, name',
    )
    .all(runId)
    .map(toUsage);
}

/** One extension, offered and never once reached for. */
export interface NeglectedExtension {
  kind: ExtensionKind;
  extensionId: string;
  name: string;
  /** Runs that were offered it. */
  runs: number;
}

/**
 * Extensions this deployment carries into run after run and never uses.
 *
 * Grouped by the registry id, so an invocation the registry does not own —
 * a plugin's skill, one of the CLI's own subagent types — is out of scope
 * rather than collapsed into a bucket with every other one. Deliberately a
 * blunt count with no notion of *relevance*: it holds under either embedding
 * family, where a question about whether the run was a fit for the extension
 * would only be answerable under a sentence-transformer.
 */
export function neglectedExtensions(
  db: Db,
  options: { minRuns: number; workspaceId?: string | null; since?: number },
): NeglectedExtension[] {
  const clauses = ['u.extension_id IS NOT NULL', 'u.available = 1'];
  const params: unknown[] = [];
  if (options.workspaceId) {
    clauses.push('r.workspace_id = ?');
    params.push(options.workspaceId);
  }
  if (options.since !== undefined) {
    clauses.push('u.at >= ?');
    params.push(options.since);
  }

  return db
    .prepare<unknown[], { kind: string; extension_id: string; name: string; runs: number }>(
      `SELECT u.kind, u.extension_id, MIN(u.name) AS name, COUNT(*) AS runs
         FROM run_extension_usages u
         JOIN runs r ON r.id = u.run_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY u.kind, u.extension_id
       HAVING SUM(u.invoked) = 0 AND COUNT(*) >= ?
        ORDER BY runs DESC, name ASC`,
    )
    .all(...params, options.minRuns)
    .map((row) => ({
      kind: row.kind as ExtensionKind,
      extensionId: row.extension_id,
      name: row.name,
      runs: row.runs,
    }));
}

/** How one extension has fared, over every run that recorded it. */
export function countExtensionUsage(
  db: Db,
  options: { kind: ExtensionKind; extensionId: string; workspaceId?: string | null; since?: number },
): { runs: number; offered: number; invoked: number; failed: number } {
  const clauses = ['u.kind = ?', 'u.extension_id = ?'];
  const params: unknown[] = [options.kind, options.extensionId];
  if (options.workspaceId) {
    clauses.push('r.workspace_id = ?');
    params.push(options.workspaceId);
  }
  if (options.since !== undefined) {
    clauses.push('u.at >= ?');
    params.push(options.since);
  }

  const row = db
    .prepare<unknown[], { runs: number; offered: number; invoked: number; failed: number }>(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(u.available), 0) AS offered,
              COALESCE(SUM(u.invoked), 0) AS invoked,
              COALESCE(SUM(u.failed), 0) AS failed
         FROM run_extension_usages u
         JOIN runs r ON r.id = u.run_id
        WHERE ${clauses.join(' AND ')}`,
    )
    .get(...params);

  return row ?? { runs: 0, offered: 0, invoked: 0, failed: 0 };
}
