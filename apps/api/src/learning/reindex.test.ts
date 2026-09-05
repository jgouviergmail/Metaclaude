/**
 * The boot-time rebuild.
 *
 * What is worth testing is the judgement, not the rebuilding: whether a corpus
 * is recognised as stale, whether a healthy one is left alone, and whether a
 * store that throws degrades to a warning rather than taking the boot down.
 * The stores themselves are fakes here; both have their own tests, and a real
 * one would only add an embedder to the fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { countStale, reindexStale, type Reindexable } from './reindex.js';

let db: Db;
const lines: Array<{ level: string; message: string }> = [];
const log = (level: 'info' | 'warn', message: string) => {
  lines.push({ level, message });
};

/** A memory row written by `model`, inserted below the store so it stays stale. */
function memoryRow(id: string, model: string | null): void {
  db.prepare(
    `INSERT INTO memories (id, workspace_id, kind, title, content, confidence,
       embedding_model, created_at, updated_at)
     VALUES (?, NULL, 'semantic', ?, ?, 0.7, ?, 1, 1)`,
  ).run(id, `title ${id}`, `content ${id}`, model);
}

function documentRow(id: string, model: string): void {
  db.prepare(
    `INSERT INTO documents (id, workspace_id, title, content, content_hash,
       enabled, chunk_count, embedding_model, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, 1, 1, ?, 1, 1)`,
  ).run(id, `doc ${id}`, `body of ${id}`, `hash-${id}`, model);
}

const fakeStore = (result: number | Error): Reindexable & { calls: number } => {
  const store = {
    calls: 0,
    async reindex() {
      store.calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return store;
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  lines.length = 0;
});

afterEach(() => db.close());

describe('countStale', () => {
  it('counts rows written by another provider', () => {
    memoryRow('mem_1', 'hash-v1:512');
    memoryRow('mem_2', 'st:Xenova/all-MiniLM-L6-v2');
    documentRow('doc_1', 'hash-v1:512');

    expect(countStale(db, 'hash-v1:512')).toEqual({ memories: 1, documents: 0, exemplars: 0 });
    expect(countStale(db, 'st:Xenova/all-MiniLM-L6-v2')).toEqual({ memories: 1, documents: 1, exemplars: 0 });
  });

  /**
   * `NULL != 'x'` is null in SQL, and SQLite counts null as false — so a plain
   * `!=` reports a row that has no vector at all as being up to date, and the
   * rebuild skips the one row that most needs it.
   */
  it('counts a row with no provider recorded as stale', () => {
    memoryRow('mem_1', null);

    expect(countStale(db, 'hash-v1:512').memories).toBe(1);
  });

  it('answers zero on an empty corpus', () => {
    expect(countStale(db, 'hash-v1:512')).toEqual({ memories: 0, documents: 0, exemplars: 0 });
  });
});

describe('reindexStale', () => {
  it('does nothing, and says nothing, when every vector is current', async () => {
    memoryRow('mem_1', 'hash-v1:512');
    const memory = fakeStore(0);
    const knowledge = fakeStore(0);

    const done = await reindexStale({ db, memory, knowledge, classifier: fakeStore(0), embedder: { id: 'hash-v1:512', ready: true }, log });

    expect(done).toEqual({ memories: 0, documents: 0, exemplars: 0 });
    expect(memory.calls).toBe(0);
    expect(knowledge.calls).toBe(0);
    expect(lines).toEqual([]);
  });

  it('rebuilds both corpora when the provider changed, and reports it', async () => {
    memoryRow('mem_1', 'hash-v1:512');
    documentRow('doc_1', 'hash-v1:512');
    const memory = fakeStore(1);
    const knowledge = fakeStore(1);

    const done = await reindexStale({ db, memory, knowledge, classifier: fakeStore(0), embedder: { id: 'st:new', ready: true }, log });

    expect(done).toEqual({ memories: 1, documents: 1, exemplars: 0 });
    expect(memory.calls).toBe(1);
    expect(knowledge.calls).toBe(1);
    expect(lines.map((line) => line.level)).toEqual(['info', 'info']);
  });

  it('rebuilds knowledge even when memory throws, and never rejects', async () => {
    memoryRow('mem_1', 'hash-v1:512');
    const memory = fakeStore(new Error('the model would not load'));
    const knowledge = fakeStore(4);

    const done = await reindexStale({ db, memory, knowledge, classifier: fakeStore(0), embedder: { id: 'st:new', ready: true }, log });

    expect(done).toEqual({ memories: 0, documents: 4, exemplars: 0 });
    expect(knowledge.calls).toBe(1);
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });

  it('is a no-op on an empty corpus', async () => {
    const memory = fakeStore(0);
    const knowledge = fakeStore(0);

    await reindexStale({ db, memory, knowledge, classifier: fakeStore(0), embedder: { id: 'hash-v1:512', ready: true }, log });

    expect(memory.calls).toBe(0);
  });
});

describe('the store contract', () => {
  /**
   * `Reindexable` exists so this module does not depend on either store, but a
   * structural type that nothing checks against the real thing is a type that
   * drifts. Both real stores are asserted to satisfy it.
   */
  it('is satisfied by both real stores', async () => {
    const { MemoryStore } = await import('./memory.js');
    const { KnowledgeStore } = await import('./knowledge.js');
    const { HashingEmbedder } = await import('./embeddings.js');
    const embedder = new HashingEmbedder();

    const memory: Reindexable = new MemoryStore(db, embedder);
    const knowledge: Reindexable = new KnowledgeStore(db, embedder);

    expect(typeof memory.reindex).toBe('function');
    expect(typeof knowledge.reindex).toBe('function');
    expect(vi.isMockFunction(memory.reindex)).toBe(false);
  });
});
