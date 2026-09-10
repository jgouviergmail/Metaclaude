/**
 * The extension-usage table, and the questions asked of it.
 *
 * Kept apart from `extension-usage.test.ts` for the reason the two modules are
 * apart: one is a pure fold over events with no database in sight, the other is
 * what happens to the answer. The fold's tests would not notice a broken
 * `INSERT`, and these would not notice a misread tool name.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import {
  countExtensionUsage,
  neglectedExtensions,
  recordExtensionUsage,
  usageForRun,
  type ExtensionUsage,
} from './extension-usage.js';

let db: Db;

/** A workspace, a session and a run — the least the foreign keys will accept. */
function seedRun(id: string, options: { workspaceId?: string; at?: number } = {}): string {
  const workspaceId = options.workspaceId ?? 'ws_1';
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, path, color, icon, archived, settings, created_at, updated_at)
     VALUES (?, ?, ?, '/tmp/x', '#000000', 'folder', 0, '{}', 1, 1)`,
  ).run(workspaceId, workspaceId, workspaceId);
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
     VALUES (?, ?, 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
  ).run(`ses_${workspaceId}`, workspaceId);
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at, finished_at)
     VALUES (?, ?, ?, 'p', 'succeeded', ?, ?)`,
  ).run(id, `ses_${workspaceId}`, workspaceId, options.at ?? 1000, options.at ?? 1000);
  return id;
}

function seedSkill(id: string, name: string, enabled = 1): void {
  db.prepare(
    `INSERT INTO skills (id, workspace_id, name, description, body, enabled, auto_generated, use_count, created_at, updated_at)
     VALUES (?, NULL, ?, 'd', 'b', ?, 0, 0, 1, 1)`,
  ).run(id, name, enabled);
}

const row = (over: Partial<ExtensionUsage> = {}): ExtensionUsage => ({
  kind: 'skill',
  extensionId: 'skl_1',
  name: 'review-migrations',
  available: true,
  invoked: 0,
  failed: 0,
  ...over,
});

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
});

describe('recordExtensionUsage', () => {
  it('writes one row per extension and reads it back', () => {
    seedRun('run_1');

    recordExtensionUsage(db, 'run_1', [row(), row({ kind: 'agent', extensionId: 'agt_1', name: 'code-reviewer', invoked: 2, failed: 1 })], 5000);

    expect(usageForRun(db, 'run_1')).toEqual([
      { kind: 'agent', extensionId: 'agt_1', name: 'code-reviewer', available: true, invoked: 2, failed: 1 },
      { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', available: true, invoked: 0, failed: 0 },
    ]);
  });

  it('writes nothing for an empty list', () => {
    seedRun('run_1');

    recordExtensionUsage(db, 'run_1', []);

    expect(usageForRun(db, 'run_1')).toEqual([]);
  });

  /**
   * The learning loop is out-of-band and a catch-up replays it. Writing twice
   * must leave the same row rather than throwing on the primary key, or one
   * duplicate would take the whole loop down with it.
   */
  it('is idempotent: a second write replaces the first', () => {
    seedRun('run_1');

    recordExtensionUsage(db, 'run_1', [row({ invoked: 1 })]);
    recordExtensionUsage(db, 'run_1', [row({ invoked: 1 })]);

    expect(usageForRun(db, 'run_1')).toHaveLength(1);
    expect(usageForRun(db, 'run_1')[0]).toMatchObject({ invoked: 1 });
  });

  it('keeps a null extension id null rather than turning it into a string', () => {
    seedRun('run_1');

    recordExtensionUsage(db, 'run_1', [row({ extensionId: null, name: 'pdf', available: false, invoked: 1 })]);

    expect(usageForRun(db, 'run_1')[0]).toMatchObject({ extensionId: null, available: false });
  });

  /**
   * The counter behind two screens. It is a lifetime total on the row, not a
   * derived figure: run retention deletes runs, so anything derived from this
   * table would *fall* over time, which is not what a use count means.
   */
  it('adds each invocation to the skill row it names', () => {
    seedRun('run_1');
    seedSkill('skl_1', 'review-migrations');

    recordExtensionUsage(db, 'run_1', [row({ invoked: 3 })]);

    expect(db.prepare('SELECT use_count FROM skills WHERE id = ?').get('skl_1')).toEqual({ use_count: 3 });
  });

  it('leaves the skill counter alone when nothing was invoked', () => {
    seedRun('run_1');
    seedSkill('skl_1', 'review-migrations');

    recordExtensionUsage(db, 'run_1', [row({ invoked: 0 })]);

    expect(db.prepare('SELECT use_count FROM skills WHERE id = ?').get('skl_1')).toEqual({ use_count: 0 });
  });

  it('does not try to count an invocation the registry does not own', () => {
    seedRun('run_1');

    expect(() =>
      recordExtensionUsage(db, 'run_1', [row({ extensionId: null, name: 'pdf', available: false, invoked: 2 })]),
    ).not.toThrow();
  });

  /**
   * A replayed write must not count the same invocations twice. `use_count` is
   * a lifetime total, so the increment is the *difference* from what this run
   * had already been credited with — which is zero on a first write and zero
   * again on an identical replay.
   */
  it('does not double-count the skill counter when a write is replayed', () => {
    seedRun('run_1');
    seedSkill('skl_1', 'review-migrations');

    recordExtensionUsage(db, 'run_1', [row({ invoked: 3 })]);
    recordExtensionUsage(db, 'run_1', [row({ invoked: 3 })]);

    expect(db.prepare('SELECT use_count FROM skills WHERE id = ?').get('skl_1')).toEqual({ use_count: 3 });
  });

  it('credits only the increase when a replay saw more invocations', () => {
    seedRun('run_1');
    seedSkill('skl_1', 'review-migrations');

    recordExtensionUsage(db, 'run_1', [row({ invoked: 1 })]);
    recordExtensionUsage(db, 'run_1', [row({ invoked: 4 })]);

    expect(db.prepare('SELECT use_count FROM skills WHERE id = ?').get('skl_1')).toEqual({ use_count: 4 });
  });

  it('goes away with its run', () => {
    seedRun('run_1');
    recordExtensionUsage(db, 'run_1', [row()]);

    db.prepare('DELETE FROM runs WHERE id = ?').run('run_1');

    expect(usageForRun(db, 'run_1')).toEqual([]);
  });
});

describe('neglectedExtensions', () => {
  /**
   * The question the whole table exists to answer, and the one no code could
   * ask before it: which of the things this workspace offers has its traffic
   * never once reached for.
   */
  it('names an extension offered often and never invoked', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_${index}`, { at: 1000 + index });
      recordExtensionUsage(db, `run_${index}`, [row()], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5 })).toEqual([
      { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', runs: 5 },
    ]);
  });

  it('says nothing below the threshold', () => {
    for (let index = 0; index < 4; index += 1) {
      seedRun(`run_${index}`, { at: 1000 + index });
      recordExtensionUsage(db, `run_${index}`, [row()], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5 })).toEqual([]);
  });

  it('drops an extension the moment it is invoked once', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_${index}`, { at: 1000 + index });
      recordExtensionUsage(db, `run_${index}`, [row({ invoked: index === 4 ? 1 : 0 })], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5 })).toEqual([]);
  });

  /**
   * An invocation the registry does not own has no id to group by, and would
   * otherwise collapse every plugin skill in the deployment into one bucket.
   */
  it('ignores rows with no registry id', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_${index}`, { at: 1000 + index });
      recordExtensionUsage(db, `run_${index}`, [row({ extensionId: null, name: 'pdf', available: false })], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5 })).toEqual([]);
  });

  it('counts only the runs where the extension was actually offered', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_${index}`, { at: 1000 + index });
      recordExtensionUsage(db, `run_${index}`, [row({ available: index < 3 })], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5 })).toEqual([]);
    expect(neglectedExtensions(db, { minRuns: 3 })).toEqual([
      { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', runs: 3 },
    ]);
  });

  it('can be asked about one workspace', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_a_${index}`, { workspaceId: 'ws_a', at: 1000 + index });
      recordExtensionUsage(db, `run_a_${index}`, [row()], 1000 + index);
    }
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_b_${index}`, { workspaceId: 'ws_b', at: 1000 + index });
      recordExtensionUsage(db, `run_b_${index}`, [row({ extensionId: 'skl_2', name: 'other' })], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5, workspaceId: 'ws_a' })).toEqual([
      { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', runs: 5 },
    ]);
  });

  it('can be bounded to a window', () => {
    for (let index = 0; index < 5; index += 1) {
      seedRun(`run_${index}`, { at: 1000 + index });
      recordExtensionUsage(db, `run_${index}`, [row()], 1000 + index);
    }

    expect(neglectedExtensions(db, { minRuns: 5, since: 1003 })).toEqual([]);
    expect(neglectedExtensions(db, { minRuns: 2, since: 1003 })).toHaveLength(1);
  });
});

describe('countExtensionUsage', () => {
  it('adds up one extension across runs', () => {
    seedRun('run_1', { at: 10 });
    seedRun('run_2', { at: 20 });
    recordExtensionUsage(db, 'run_1', [row({ invoked: 1, failed: 1 })], 10);
    recordExtensionUsage(db, 'run_2', [row({ invoked: 2, failed: 0 })], 20);

    expect(countExtensionUsage(db, { kind: 'skill', extensionId: 'skl_1' })).toEqual({
      runs: 2,
      offered: 2,
      invoked: 3,
      failed: 1,
    });
  });

  it('answers zero for an extension nothing has seen', () => {
    expect(countExtensionUsage(db, { kind: 'agent', extensionId: 'agt_nope' })).toEqual({
      runs: 0,
      offered: 0,
      invoked: 0,
      failed: 0,
    });
  });
});
