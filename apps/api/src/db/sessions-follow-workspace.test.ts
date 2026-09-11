/**
 * The two migrations that turned a session's copied settings into inherited
 * ones: `sessions_follow_workspace` for the model and the effort,
 * `sessions_inherit_permission_mode` for the mode.
 *
 * Every session row in a deployment before them carries a copy of the
 * workspace's values as they were the day the session was created. Nothing
 * ever wrote those columns afterwards — the composer kept its pickers in
 * local state, the steward's session tool takes title, pinned and archived —
 * so the copy is all a row can hold, and inherited is what each row meant.
 * Driven against rows written the old way rather than asserted on an empty
 * table, or it would prove that `UPDATE` parses; and the mode is read back
 * through `SessionRepo`, because the sentinel the migration writes and the
 * one the repository translates have to be the same string.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './index.js';
import { MIGRATIONS } from './schema.sql.js';
import { SessionRepo } from '../kernel/repositories.js';

const FOLLOW = MIGRATIONS.find((migration) => migration.name === 'sessions_follow_workspace');
const INHERIT = MIGRATIONS.find(
  (migration) => migration.name === 'sessions_inherit_permission_mode',
);

/** Every migration strictly before the named one. */
const before = (target: { version: number } | undefined) =>
  MIGRATIONS.filter((migration) => migration.version < (target?.version ?? 0));

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
});

const workspace = (): void => {
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, path, settings, created_at, updated_at)
     VALUES ('ws', 'ws', 'ws', '/tmp/ws', '{}', 0, 0)`,
  ).run();
};

const session = (id: string, model: string, effort: string | null, mode: string): void => {
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, model, effort, permission_mode, created_at, updated_at, last_activity_at)
     VALUES (?, 'ws', ?, ?, ?, 0, 0, 0)`,
  ).run(id, model, effort, mode);
};

const row = (id: string) =>
  db
    .prepare<[string], { model: string; effort: string | null; permission_mode: string }>(
      'SELECT model, effort, permission_mode FROM sessions WHERE id = ?',
    )
    .get(id);

describe('the sessions_follow_workspace migration', () => {
  it('exists, and everything before it is genuinely every earlier migration', () => {
    expect(FOLLOW).toBeTruthy();
    expect(before(FOLLOW).length).toBe(MIGRATIONS.indexOf(FOLLOW!));
  });

  it('turns every copied model and effort into Auto, and touches nothing else', () => {
    for (const migration of before(FOLLOW)) db.exec(migration.sql);
    workspace();
    session('copied', 'sonnet', 'high', 'acceptEdits');
    session('cheap', 'haiku', null, 'acceptEdits');
    session('already', 'default', null, 'acceptEdits');

    db.exec(FOLLOW!.sql);

    for (const id of ['copied', 'cheap', 'already']) {
      expect(row(id)).toEqual({ model: 'default', effort: null, permission_mode: 'acceptEdits' });
    }
  });
});

describe('the sessions_inherit_permission_mode migration', () => {
  it('comes after sessions_follow_workspace', () => {
    expect(INHERIT).toBeTruthy();
    expect(INHERIT!.version).toBeGreaterThan(FOLLOW!.version);
  });

  it('turns every copied mode into an inherited one the repository reads as null', () => {
    for (const migration of before(INHERIT)) db.exec(migration.sql);
    workspace();
    session('ask', 'default', null, 'default');
    session('auto', 'default', null, 'auto');
    session('edits', 'default', null, 'acceptEdits');

    db.exec(INHERIT!.sql);

    const sessions = new SessionRepo(db);
    for (const id of ['ask', 'auto', 'edits']) {
      expect(sessions.get(id)?.permissionMode).toBeNull();
    }
    // And a row written the new way still reads as what it says.
    const pinned = sessions.create({ workspaceId: 'ws', model: 'default', effort: null, permissionMode: 'dontAsk' });
    expect(sessions.get(pinned.id)?.permissionMode).toBe('dontAsk');
  });
});
