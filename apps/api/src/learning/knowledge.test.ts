import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { capPerDocument, KnowledgeStore, KnowledgeStoreError, MAX_DOCUMENT_BYTES } from './knowledge.js';

let db: Db;
let store: KnowledgeStore;
let clock = 1_700_000_000_000;

const LEASE = `# Bail — 12 rue des Lilas

## Loyer
Le loyer mensuel est de 950 euros, charges comprises, payable le 5 du mois.

## Résiliation
Le locataire peut résilier à tout moment. Le préavis de résiliation est de 45 jours
en zone tendue, adressé par lettre recommandée avec accusé de réception.

## Dépôt de garantie
Le dépôt de garantie est d'un mois de loyer hors charges, restitué sous deux mois.`;

const RUNBOOK = `# Déploiement

## Bases de données
La migration s'exécute automatiquement au démarrage du conteneur applicatif.

## Retour arrière
Un déploiement qui ne passe pas la sonde de santé est annulé par le systemd unit.`;

function seedWorkspace(id: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, path, color, icon, archived, settings, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, '#6366f1', 'folder', 0, '{}', 0, 0)`,
  ).run(id, id, id, `/tmp/${id}`);
}

function seedRun(id: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at) VALUES ('ses_x', ?, 0, 0, 0)
     ON CONFLICT(id) DO NOTHING`,
  ).run(workspaceId);
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
     VALUES (?, 'ses_x', ?, 'p', 'succeeded', 0)`,
  ).run(id, workspaceId);
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  store = new KnowledgeStore(db, new HashingEmbedder(), () => clock);
  seedWorkspace('ws_a');
  seedWorkspace('ws_b');
});

afterEach(() => db.close());

describe('storing a document', () => {
  it('chunks, embeds and counts on the way in', async () => {
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });

    expect(doc.chunkCount).toBeGreaterThanOrEqual(1);
    expect(doc.enabled).toBe(true);
    const chunks = db
      .prepare<[], { heading: string; embedding: Buffer | null }>(
        'SELECT heading, embedding FROM document_chunks',
      )
      .all();
    expect(chunks.length).toBe(doc.chunkCount);
    for (const chunk of chunks) expect(chunk.embedding).not.toBeNull();
  });

  it('refuses the degenerate documents rather than storing dead rows', async () => {
    await expect(store.upsert({ workspaceId: null, title: '  ', content: 'x' })).rejects.toThrow(
      /title/i,
    );
    await expect(store.upsert({ workspaceId: null, title: 'T', content: '   ' })).rejects.toThrow(
      /content/i,
    );
    await expect(
      store.upsert({ workspaceId: null, title: 'T', content: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) }),
    ).rejects.toThrow(/capped/i);
  });

  it('re-saving identical content skips the re-embed entirely', async () => {
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    const before = db
      .prepare<[], { id: string }>('SELECT id FROM document_chunks ORDER BY id')
      .all();

    clock += 1000;
    const renamed = await store.upsert({
      id: doc.id,
      workspaceId: null,
      title: 'Bail — 12 rue des Lilas',
      content: LEASE,
    });

    // Same chunk rows, byte for byte: the hash decided, nothing was rebuilt.
    const after = db.prepare<[], { id: string }>('SELECT id FROM document_chunks ORDER BY id').all();
    expect(after).toEqual(before);
    expect(renamed.title).toBe('Bail — 12 rue des Lilas');
    expect(renamed.updatedAt).toBe(clock);
  });

  it('editing content replaces the chunks wholesale', async () => {
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    const edited = await store.upsert({
      id: doc.id,
      workspaceId: null,
      title: 'Bail',
      content: `${LEASE}\n\n## Annexe\nLe garage est inclus dans la location.`,
    });

    expect(edited.chunkCount).toBeGreaterThanOrEqual(doc.chunkCount);
    const results = await store.search('garage inclus location', { workspaceId: null });
    expect(results.some((r) => r.text.includes('garage'))).toBe(true);
  });

  it('404s an update naming a document that does not exist', async () => {
    await expect(
      store.upsert({ id: 'doc_missing', workspaceId: null, title: 'T', content: 'x' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deleting a document takes its chunks and its fts rows with it', async () => {
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    expect(store.delete(doc.id)).toBe(true);

    expect(db.prepare('SELECT COUNT(*) AS n FROM document_chunks').get()).toMatchObject({ n: 0 });
    // The fts index must follow, or a deleted document keeps matching.
    const results = await store.search('préavis résiliation', { workspaceId: null });
    expect(results).toEqual([]);
  });
});

describe('searching', () => {
  it('finds the passage, not the document: the notice period comes back as its own chunk', async () => {
    await store.upsert({ workspaceId: null, title: 'Bail — 12 rue des Lilas', content: LEASE });
    await store.upsert({ workspaceId: null, title: 'Déploiement', content: RUNBOOK });

    const results = await store.search('quel est le préavis de résiliation du bail ?', {
      workspaceId: null,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.text).toContain('45 jours');
    expect(results[0]!.documentTitle).toBe('Bail — 12 rue des Lilas');
    // The chunk carries its section, so the passage can be cited.
    expect(results[0]!.heading).toBe('Résiliation');
  });

  it('reads the workspace shelf plus the global one, and nothing of a sibling', async () => {
    await store.upsert({ workspaceId: null, title: 'Global', content: 'La règle globale des congés payés.' });
    await store.upsert({ workspaceId: 'ws_a', title: 'A', content: 'Le secret du projet alpha uniquement.' });
    await store.upsert({ workspaceId: 'ws_b', title: 'B', content: 'Le secret du projet beta uniquement.' });

    const fromA = await store.search('le secret du projet', { workspaceId: 'ws_a' });
    expect(fromA.some((r) => r.text.includes('alpha'))).toBe(true);
    // A workspace must never surface a sibling's documents: scoping is an
    // isolation promise, not a ranking preference.
    expect(fromA.some((r) => r.text.includes('beta'))).toBe(false);

    const globalOnly = await store.search('congés payés', { workspaceId: null });
    expect(globalOnly.some((r) => r.text.includes('globale'))).toBe(true);
    expect(globalOnly.some((r) => r.text.includes('alpha'))).toBe(false);
  });

  it('returns nothing for an irrelevant query rather than padding with the corpus', async () => {
    await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    // Stopwords only: both measured gates must hold the door.
    const results = await store.search('le la de et un', { workspaceId: null });
    expect(results).toEqual([]);
  });

  it('a disabled document vanishes from retrieval but stays stored', async () => {
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    expect(store.setEnabled(doc.id, false)).toBe(true);

    expect(await store.search('préavis résiliation bail', { workspaceId: null })).toEqual([]);
    expect(store.get(doc.id)?.content).toContain('45 jours');

    store.setEnabled(doc.id, true);
    expect((await store.search('préavis résiliation bail', { workspaceId: null })).length).toBeGreaterThan(0);
  });

  it('caps a result list at two passages per document, order preserved', () => {
    // Direct, because three integration fixtures in a row could not make the
    // cap bind — the relevance gates diversified first every time. A guard
    // that only fires in narrow ranking regimes still has to be provably
    // present.
    const entry = (documentId: string, chunkId: string, score: number) =>
      ({ chunkId, documentId, documentTitle: documentId, workspaceId: null, heading: '', text: 'x', score }) as const;
    const capped = capPerDocument([
      entry('doc_a', 'c1', 0.9),
      entry('doc_a', 'c2', 0.8),
      entry('doc_a', 'c3', 0.7),
      entry('doc_b', 'c4', 0.6),
      entry('doc_a', 'c5', 0.5),
      entry('doc_b', 'c6', 0.4),
    ]);
    expect(capped.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c4', 'c6']);
  });

  it('holds the per-document invariant end to end', async () => {
    // A document engineered so four separate chunks each rank *well* on the
    // query — short, focused sections, distinct wording. Two earlier drafts
    // of this test could not fail: one had too few matching chunks, the other
    // buried its matches in repeated filler, which both diluted the cosine
    // below the relative floor and clamped the IDF (the term sat in every
    // chunk). Ranking dynamics decide what a diversity test can even see.
    const repetitive = [
      '# Logement vide',
      'Résilier le bail demande un préavis de trois mois, réduit en zone tendue.',
      '# Logement meublé',
      'Le préavis de résiliation du bail meublé est d’un mois, toute l’année.',
      '# Zone tendue',
      'En zone tendue, le préavis du bail tombe à un mois après notification.',
      '# Cas du propriétaire',
      'Le propriétaire qui résilie le bail respecte un préavis de six mois.',
    ].join('\n\n');
    await store.upsert({ workspaceId: null, title: 'Recueil', content: repetitive });
    await store.upsert({
      workspaceId: null,
      title: 'Avenant',
      content: '## Résiliation anticipée\nLa résiliation anticipée du bail exige un préavis réduit de 30 jours.',
    });

    const results = await store.search('préavis résiliation bail', { workspaceId: null, limit: 6 });
    const perDoc = new Map<string, number>();
    for (const r of results) perDoc.set(r.documentId, (perDoc.get(r.documentId) ?? 0) + 1);
    for (const [, count] of perDoc) expect(count).toBeLessThanOrEqual(2);
    // The second document is actually heard, not merely possible.
    expect(results.some((r) => r.documentTitle === 'Avenant')).toBe(true);
  });

  it('finds an exact identifier through the lexical arm alone', async () => {
    await store.upsert({
      workspaceId: null,
      title: 'Runbook',
      content: 'Le service écoute sur le port interne METACLAUDE_PORT_8787 exclusivement.',
    });
    await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    const results = await store.search('METACLAUDE_PORT_8787', { workspaceId: null });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.documentTitle).toBe('Runbook');
  });

  it('survives a query of fts operators without failing the search', async () => {
    await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    const results = await store.search('préavis* NEAR "résiliation" -bail :', {
      workspaceId: null,
    });
    // Degrades, never throws — the words still match.
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('crediting what a run saw', () => {
  it('records usage and reads it back for the genesis, best first', async () => {
    await store.upsert({ workspaceId: 'ws_a', title: 'Bail', content: LEASE });
    seedRun('run_1', 'ws_a');

    const results = await store.search('préavis résiliation', { workspaceId: 'ws_a' });
    store.recordUsage('run_1', results);

    const consulted = store.consultedFor('run_1');
    expect(consulted.length).toBe(results.length);
    expect(consulted[0]!.title).toBe('Bail');
    expect(consulted[0]!.heading).toBe('Résiliation');
    const scores = consulted.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('recording nothing writes nothing', () => {
    store.recordUsage('run_1', []);
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_usages').get()).toMatchObject({ n: 0 });
  });
});

describe('changing the embedding provider', () => {
  it('reindex re-embeds stale chunks so the dense arm comes back', async () => {
    await store.upsert({ workspaceId: null, title: 'Bail', content: LEASE });
    // Simulate an older provider: stamp the document with a different model id.
    db.prepare(`UPDATE documents SET embedding_model = 'hash-v0:64'`).run();

    const affected = await store.reindex();
    expect(affected).toBeGreaterThan(0);
    expect(await store.reindex()).toBe(0);

    const results = await store.search('préavis résiliation bail', { workspaceId: null });
    expect(results.length).toBeGreaterThan(0);
  });

  it('the lexical arm still answers while vectors are stale', async () => {
    await store.upsert({
      workspaceId: null,
      title: 'Runbook',
      content: 'Le service écoute sur METACLAUDE_PORT_8787.',
    });
    // A second document matters: BM25's IDF clamps on a corpus where a term
    // appears in every chunk, so a one-chunk corpus scores its own identifier
    // like a stopword — measured at -0.000001, exactly the clamp. Contrast is
    // what gives the lexical arm its signal.
    await store.upsert({ workspaceId: null, title: 'Autre', content: LEASE });
    db.prepare(`UPDATE documents SET embedding_model = 'hash-v0:64'`).run();

    // Dense arm skips incomparable vectors; the identifier is still found.
    const results = await store.search('METACLAUDE_PORT_8787', { workspaceId: null });
    expect(results.length).toBe(1);
    expect(results[0]!.documentTitle).toBe('Runbook');
  });
});

void KnowledgeStoreError;
