/**
 * How a document's vectors get made.
 *
 * Measured on bge-m3: a hundred chunks take about eleven seconds here and
 * three times that on the server, inside what used to be one synchronous
 * request. So a document is written *now* — text, chunks, fts index — and
 * only a small one is embedded on the spot. A large one is marked pending
 * and handed to the same background rebuild that serves a change of model,
 * which is the one path every pending row already travels.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { ConceptEmbedder, pendingEmbedder } from '../test/embedders.js';
import { PENDING_EMBEDDING_MODEL } from './embeddings.js';
import { INLINE_EMBED_CEILING, KnowledgeStore } from './knowledge.js';

let db: Db;
let later: string[];

// Each paragraph carries a word of its own, so a lexical query can single one
// out: bm25 weighs a term by how few chunks carry it, and a corpus where every
// chunk says the same thing has no lexical signal at all.
const paragraphs = (count: number): string =>
  Array.from({ length: count }, (_, index) => `## Section ${index}\n\nParagraph ${index} about topic${index} and the release process.`).join('\n\n');

const modelOf = (id: string): string =>
  (db.prepare('SELECT embedding_model FROM documents WHERE id = ?').get(id) as { embedding_model: string }).embedding_model;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  later = [];
});

describe('a small document', () => {
  it('is embedded inline, and the rebuild is not asked for', async () => {
    const embedder = new ConceptEmbedder();
    const store = new KnowledgeStore(db, embedder, undefined, { embedLater: (id) => later.push(id) });

    const document = await store.upsert({ workspaceId: null, title: 'Note', content: paragraphs(2) });

    expect(document.chunkCount).toBeLessThanOrEqual(INLINE_EMBED_CEILING);
    expect(modelOf(document.id)).toBe(embedder.id);
    expect(document.embeddingModel).toBe(embedder.id);
    expect(later).toEqual([]);
  });
});

describe('a large document', () => {
  it('is written pending at once and handed to the rebuild, then embedded by it', async () => {
    const embedder = new ConceptEmbedder();
    const store = new KnowledgeStore(db, embedder, undefined, { embedLater: (id) => later.push(id) });

    const document = await store.upsert({ workspaceId: null, title: 'Lease', content: paragraphs(INLINE_EMBED_CEILING + 5) });

    expect(document.chunkCount).toBeGreaterThan(INLINE_EMBED_CEILING);
    expect(document.embeddingModel).toBe(PENDING_EMBEDDING_MODEL);
    expect(modelOf(document.id)).toBe(PENDING_EMBEDDING_MODEL);
    expect(later).toEqual([document.id]);
    // Nothing went through the model on the request path.
    expect(embedder.embedded).toEqual([]);
    // But the text is already findable.
    expect(await store.search('topic5', { workspaceId: null })).not.toEqual([]);

    expect(await store.reindex()).toBe(document.chunkCount);
    expect(modelOf(document.id)).toBe(embedder.id);
  });

  it('is embedded inline when nobody is there to do it later — a store without the hook keeps the old contract', async () => {
    const embedder = new ConceptEmbedder();
    const store = new KnowledgeStore(db, embedder);

    const document = await store.upsert({ workspaceId: null, title: 'Lease', content: paragraphs(INLINE_EMBED_CEILING + 5) });

    expect(modelOf(document.id)).toBe(embedder.id);
  });
});

describe('with no model ready', () => {
  it('writes even a small document pending and asks for the rebuild, which waits', async () => {
    const embedder = pendingEmbedder();
    const store = new KnowledgeStore(db, embedder, undefined, { embedLater: (id) => later.push(id) });

    const document = await store.upsert({ workspaceId: null, title: 'Note', content: paragraphs(2) });

    expect(modelOf(document.id)).toBe(PENDING_EMBEDDING_MODEL);
    expect(later).toEqual([document.id]);
    expect(await store.reindex()).toBe(0);

    embedder.ready = true;
    expect(await store.reindex()).toBe(document.chunkCount);
  });
});

describe('listing', () => {
  it('says which model each document was embedded with, so a screen can tell pending from current', async () => {
    const embedder = new ConceptEmbedder();
    const store = new KnowledgeStore(db, embedder, undefined, { embedLater: (id) => later.push(id) });
    await store.upsert({ workspaceId: null, title: 'Small', content: paragraphs(1) });
    await store.upsert({ workspaceId: null, title: 'Large', content: paragraphs(INLINE_EMBED_CEILING + 5) });

    // Sorted here: the listing orders by `updated_at`, and two documents saved
    // in the same millisecond have no order to promise.
    const listed = store.list().sort((a, b) => a.title.localeCompare(b.title));

    expect(listed.map((doc) => [doc.title, doc.embeddingModel])).toEqual([
      ['Large', PENDING_EMBEDDING_MODEL],
      ['Small', embedder.id],
    ]);
  });
});
