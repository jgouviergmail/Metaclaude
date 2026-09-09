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
import type { ExtensionReach } from '@metaclaude/shared';

import { migrate, openDatabase, type Db } from '../db/index.js';
import { MIGRATIONS } from '../db/schema.sql.js';
import { ConceptEmbedder } from '../test/embedders.js';
import { KnowledgeStore } from './knowledge.js';

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

describe('reach in the store', () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    migrate(db);
    workspace('alpha');
    workspace('beta');
    workspace('gamma');
    store = new KnowledgeStore(db, new ConceptEmbedder());
  });

  const save = (title: string, reach: ExtensionReach) =>
    store.upsert({
      workspaceId: null,
      title,
      content: `# ${title}\n\nCe document parle de ${title} et du préavis de résiliation.`,
      reach,
    });

  const GLOBAL: ExtensionReach = { global: true, workspaceIds: [] };

  it('lets one document reach two workspaces and not a third, beside the global shelf', async () => {
    await save('Everywhere', GLOBAL);
    await save('Shared', { global: false, workspaceIds: ['alpha', 'beta'] });
    await save('Nowhere', { global: false, workspaceIds: [] });

    const titles = (options: Parameters<KnowledgeStore['list']>[0]) =>
      store.list(options).map((document) => document.title).sort();

    expect(titles({ workspaceId: 'alpha' })).toEqual(['Everywhere', 'Shared']);
    expect(titles({ workspaceId: 'beta' })).toEqual(['Everywhere', 'Shared']);
    expect(titles({ workspaceId: 'gamma' })).toEqual(['Everywhere']);
    // `null` is the global shelf alone; no option at all is the whole library,
    // documents attached to nothing included — a management view needs it.
    expect(titles({ workspaceId: null })).toEqual(['Everywhere']);
    expect(titles({})).toEqual(['Everywhere', 'Nowhere', 'Shared']);
  });

  /**
   * The set-of-workspaces scope: what a run reads from its peers' shelves
   * without starting a run there.
   *
   * The global shelf is deliberately out, unlike every other scope here: the
   * asking run already receives it, so returning it again spends the answer's
   * budget on what has already been read.
   *
   * Every document says something different, and each query names one of them.
   * A first draft gave them near-identical text and the *unscoped* search
   * answered one title out of four — the relevance gate doing its job — so the
   * test measured ranking rather than reach. The same trap the neighbouring
   * case documents, paid again.
   */
  describe('a set of workspaces', () => {
    const filed = (title: string, subject: string, reach: ExtensionReach) =>
      store.upsert({
        workspaceId: null,
        title,
        content: `# ${subject}

Ce document traite de ${subject} et de rien d’autre.`,
        reach,
      });

    beforeEach(async () => {
      await filed('Everywhere', 'la chaudière', GLOBAL);
      await filed('Alpha only', 'le préavis', { global: false, workspaceIds: ['alpha'] });
      await filed('Shared', 'le dépôt de garantie', { global: false, workspaceIds: ['alpha', 'beta'] });
      await filed('Gamma only', 'les charges locatives', { global: false, workspaceIds: ['gamma'] });
    });

    const hits = async (query: string, workspaceIds: string[]) =>
      (await store.search(query, { workspaceIds, limit: 20 })).map((hit) => hit.documentTitle);

    it('reads those workspaces’ shelves and not the others’', async () => {
      expect(await hits('le préavis', ['alpha'])).toEqual(['Alpha only']);
      expect(await hits('le préavis', ['gamma'])).toEqual([]);
      expect(await hits('les charges locatives', ['gamma'])).toEqual(['Gamma only']);
    });

    it('leaves the global shelf out, because the asking run already has it', async () => {
      // The one behaviour that separates this scope from every other here. A
      // run recalls its own workspace and the globals before it asks anything;
      // handing them back would spend the answer on what it has already read.
      expect(await hits('la chaudière', ['alpha', 'beta', 'gamma'])).toEqual([]);
      expect(await hits('la chaudière', ['alpha'])).toEqual([]);
      // And the same document is still reachable through the ordinary scope.
      expect(
        (await store.search('la chaudière', { workspaceId: 'alpha' })).map((h) => h.documentTitle),
      ).toEqual(['Everywhere']);
    });

    it('returns a document reaching two of them once, not twice', async () => {
      // `d.id IN (SELECT ... WHERE workspace_id IN (...))` rather than a join:
      // a join multiplies a shared document by the number of its links, and a
      // passage quoted twice is budget spent saying one thing.
      expect(await hits('le dépôt de garantie', ['alpha', 'beta'])).toEqual(['Shared']);
    });

    it('answers nothing for an empty set rather than the whole library', async () => {
      expect(await store.search('le préavis', { workspaceIds: [] })).toEqual([]);
    });

    it('refuses a scope that says two contradictory things', async () => {
      await expect(
        store.search('le préavis', { workspaceId: 'alpha', workspaceIds: ['beta'] }),
      ).rejects.toThrow(/workspaceId/i);
    });

    it('never returns a document whose owner switched it off', async () => {
      const alphaOnly = store.list({}).find((document) => document.title === 'Alpha only')!;
      store.setEnabled(alphaOnly.id, false);

      expect(await hits('le préavis', ['alpha'])).toEqual([]);
    });
  });

  it('makes retrieval obey the same predicate as the listing', async () => {
    // Two spellings of one rule is how a document becomes visible in a list
    // and invisible to the runs of the same workspace, or the reverse.
    //
    // The two documents deliberately say *different* things, and each query
    // names one of them: a pair of near-identical documents would make this a
    // test of the relevance gate's ranking, which is not what is under test —
    // and which genuinely drops the runner-up.
    await store.upsert({
      workspaceId: null,
      title: 'Shared',
      content: '# Chaudière\n\nLe remplacement de la chaudière incombe au bailleur.',
      reach: { global: false, workspaceIds: ['alpha'] },
    });
    await store.upsert({
      workspaceId: null,
      title: 'Everywhere',
      content: '# Sauvegarde\n\nLa sauvegarde quotidienne part vers le volume externe.',
      reach: GLOBAL,
    });

    const found = async (query: string, workspaceId: string) =>
      (await store.search(query, { workspaceId, limit: 10 })).map((hit) => hit.documentTitle);

    // The attached workspace reaches it; a sibling does not, for the very
    // query that finds it next door.
    expect(await found('chaudière bailleur', 'alpha')).toContain('Shared');
    expect(await found('chaudière bailleur', 'gamma')).toEqual([]);
    // And the global shelf reaches both.
    expect(await found('sauvegarde volume', 'gamma')).toContain('Everywhere');
    expect(await found('sauvegarde volume', 'alpha')).toContain('Everywhere');
  });

  it('reports the reach it stored, on the document and in the listing', async () => {
    const document = await save('Shared', { global: false, workspaceIds: ['beta', 'alpha'] });
    expect(document.isGlobal).toBe(false);
    // Sorted, so a listing does not reorder between two reads.
    expect(document.workspaceIds).toEqual(['alpha', 'beta']);
    expect(store.list({}).find((one) => one.id === document.id)).toMatchObject({
      isGlobal: false,
      workspaceIds: ['alpha', 'beta'],
    });
  });

  it('replaces the reach rather than adding to it, and global clears the links', async () => {
    const document = await save('Shared', { global: false, workspaceIds: ['alpha', 'beta'] });

    // An id naming no workspace is dropped, not refused: the form was open
    // while somebody else deleted that workspace.
    expect(store.setReach(document.id, { global: false, workspaceIds: ['gamma', 'ghost'] })).toBe(
      true,
    );
    expect(store.get(document.id)!.workspaceIds).toEqual(['gamma']);

    store.setReach(document.id, { global: true, workspaceIds: ['alpha'] });
    expect(store.get(document.id)).toMatchObject({ isGlobal: true, workspaceIds: [] });
  });

  it('answers false for a reach set on a document that does not exist', () => {
    expect(store.setReach('doc_missing', GLOBAL)).toBe(false);
  });

  it('leaves the reach untouched on an update that does not name one', async () => {
    const document = await save('Shared', { global: false, workspaceIds: ['alpha'] });
    await store.upsert({
      id: document.id,
      workspaceId: null,
      title: 'Renamed',
      content: 'Un contenu entièrement différent, sans rapport.',
    });
    expect(store.get(document.id)).toMatchObject({
      title: 'Renamed',
      workspaceIds: ['alpha'],
      isGlobal: false,
    });
  });

  it('derives the reach from workspaceId when a caller gives none', async () => {
    // The contract every caller written before the reach existed still speaks
    // — the eval corpus, the benches, check:e2e — and the registry's own
    // `attachOnCreate` rule: null is everywhere, an id is that one.
    const global = await store.upsert({ workspaceId: null, title: 'G', content: 'Texte global.' });
    const scoped = await store.upsert({ workspaceId: 'alpha', title: 'S', content: 'Texte alpha.' });
    expect(global).toMatchObject({ isGlobal: true, workspaceIds: [] });
    expect(scoped).toMatchObject({ isGlobal: false, workspaceIds: ['alpha'] });
  });

  it('forgets a deleted workspace by itself', async () => {
    const document = await save('Shared', { global: false, workspaceIds: ['alpha', 'beta'] });
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('beta');
    expect(store.get(document.id)!.workspaceIds).toEqual(['alpha']);
  });
});
