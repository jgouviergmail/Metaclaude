/**
 * The reach of a document, and the migration that gave it one.
 *
 * A document used to reach exactly one workspace, or every one of them, and
 * the column that said so could express nothing else — so a lease that three
 * projects needed had to be global or written three times. This is migration
 * 26's shape, applied to the library: `is_global` plus a join table with two
 * cascading foreign keys, which makes "a link naming a workspace that no
 * longer exists" inexpressible rather than something to remember to prune.
 *
 * The first case is the one the file exists for: seed the world as an older
 * version wrote it, migrate, and require every workspace to see exactly what
 * the *old* predicate said — computed here, not remembered.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { migrate, openDatabase, type Db } from '../db/index.js';
import { MIGRATIONS } from '../db/schema.sql.js';

const FILES = MIGRATIONS.find((migration) => migration.name === 'knowledge_files');
const BEFORE = MIGRATIONS.filter((migration) => migration !== FILES);

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
});

const workspace = (id: string): void => {
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, path, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', 0, 0)`,
  ).run(id, id, id, `/tmp/${id}`);
};

const document = (id: string, home: string | null): void => {
  db.prepare(
    `INSERT INTO documents (id, workspace_id, title, content, content_hash, enabled,
       chunk_count, embedding_model, created_at, updated_at)
     VALUES (?, ?, ?, 'x', ?, 1, 0, '', 0, 0)`,
  ).run(id, home, id, id);
};

describe('the knowledge_files migration', () => {
  it('is the last one, so BEFORE is genuinely every earlier migration', () => {
    // A guard on this file's own premise. Renamed, `FILES` would be undefined,
    // `BEFORE` would be every migration, and every case below would compare
    // the new world with itself — green, and proving nothing.
    expect(FILES).toBeTruthy();
    expect(BEFORE).toHaveLength(MIGRATIONS.length - 1);
  });

  it('leaves every workspace seeing exactly what it saw before', () => {
    for (const migration of BEFORE) db.exec(migration.sql);
    workspace('alpha');
    workspace('beta');

    const rows: Array<[string, string | null]> = [
      ['everywhere', null],
      ['alpha-only', 'alpha'],
      ['beta-only', 'beta'],
    ];
    for (const [id, home] of rows) document(id, home);

    /** The old rule, computed rather than remembered. */
    const oldReach = (workspaceId: string): string[] =>
      rows
        .filter(([, home]) => home === null || home === workspaceId)
        .map(([id]) => id)
        .sort();

    db.exec(FILES!.sql);

    const newReach = (workspaceId: string): string[] =>
      db
        .prepare<[string], { id: string }>(
          `SELECT d.id FROM documents d
           WHERE d.is_global = 1
              OR d.id IN (SELECT document_id FROM document_workspaces WHERE workspace_id = ?)`,
        )
        .all(workspaceId)
        .map((row) => row.id)
        .sort();

    expect(newReach('alpha'), 'alpha').toEqual(oldReach('alpha'));
    expect(newReach('beta'), 'beta').toEqual(oldReach('beta'));
  });

  it('runs on an empty library', () => {
    for (const migration of BEFORE) db.exec(migration.sql);
    expect(() => db.exec(FILES!.sql)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_workspaces').get()).toEqual({ n: 0 });
  });

  it('keeps what a past run saw, now filed under its document rather than its passage', () => {
    // `document_usages` cascaded off `document_chunks`, so re-extracting a
    // document erased the citations of every run that had quoted it. The
    // rebuilt table names the document, which outlives its passages.
    for (const migration of BEFORE) db.exec(migration.sql);
    workspace('alpha');
    document('bail', null);
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at, last_activity_at)
       VALUES ('sess', 'alpha', 'Bail', 'idle', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
       VALUES ('run_1', 'sess', 'alpha', 'p', 'succeeded', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO document_chunks (id, document_id, seq, heading, text, embedding)
       VALUES ('chunk_1', 'bail', 0, 'Préavis', 'trois mois', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO document_usages (run_id, chunk_id, score) VALUES ('run_1', 'chunk_1', 0.9)`,
    ).run();

    db.exec(FILES!.sql);

    expect(db.prepare('SELECT * FROM document_usages').all()).toEqual([
      { run_id: 'run_1', document_id: 'bail', chunk_id: 'chunk_1', score: 0.9 },
    ]);

    // And the point of the rebuild: the passage may go, the citation stays.
    db.prepare('DELETE FROM document_chunks WHERE id = ?').run('chunk_1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_usages').get()).toEqual({ n: 1 });
  });

  it('keeps the fts index true after the chunk table grew columns', () => {
    migrate(db);
    document('bail', null);
    db.prepare(
      `INSERT INTO document_chunks (id, document_id, seq, heading, text, embedding,
         page_start, page_end, line_start, line_end)
       VALUES ('chunk_1', 'bail', 0, '', 'le délai de préavis', NULL, 2, 2, 40, 52)`,
    ).run();

    expect(
      db
        .prepare(
          `SELECT c.line_start FROM document_chunks_fts f
           JOIN document_chunks c ON c.rowid = f.rowid
           WHERE document_chunks_fts MATCH '"préavis"'`,
        )
        .all(),
    ).toEqual([{ line_start: 40 }]);

    expect(() =>
      db.exec("INSERT INTO document_chunks_fts(document_chunks_fts) VALUES('integrity-check')"),
    ).not.toThrow();
  });

  it('refuses two documents claiming the same file, and lets many claim none', () => {
    migrate(db);
    const withSource = (id: string, sha: string | null) =>
      db
        .prepare(
          `INSERT INTO documents (id, workspace_id, title, content, content_hash, enabled,
             chunk_count, embedding_model, created_at, updated_at, source_sha256)
           VALUES (?, NULL, ?, 'x', ?, 1, 0, '', 0, 0, ?)`,
        )
        .run(id, id, id, sha);

    withSource('a', 'hash-1');
    // A partial index: many documents may have no file at all.
    withSource('b', null);
    withSource('c', null);
    expect(() => withSource('d', 'hash-1')).toThrow(/UNIQUE/);
  });

  it('forgets a deleted workspace by itself, and keeps the document', () => {
    migrate(db);
    workspace('alpha');
    workspace('beta');
    document('shared', null);
    db.prepare(
      `INSERT INTO document_workspaces (document_id, workspace_id) VALUES ('shared', 'alpha'), ('shared', 'beta')`,
    ).run();

    db.prepare('DELETE FROM workspaces WHERE id = ?').run('beta');

    expect(db.prepare('SELECT workspace_id FROM document_workspaces').all()).toEqual([
      { workspace_id: 'alpha' },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
  });

  it('forgets a deleted document by itself, from the other side', () => {
    migrate(db);
    workspace('alpha');
    document('shared', null);
    db.prepare(
      `INSERT INTO document_workspaces (document_id, workspace_id) VALUES ('shared', 'alpha')`,
    ).run();

    db.prepare('DELETE FROM documents WHERE id = ?').run('shared');

    expect(db.prepare('SELECT COUNT(*) AS n FROM document_workspaces').get()).toEqual({ n: 0 });
  });
});
