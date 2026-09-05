/**
 * What every consumer of vectors does while the model is not ready.
 *
 * The rule is one line — nothing is written or compared under a provider
 * that is not ready — and it has four consumers, each with its own failure
 * mode when the rule is missed: a memory stored with a zero vector under a
 * real model id would never be re-indexed; a chunk likewise; an exemplar
 * would vote in kNN with a meaningless similarity; the consolidation sweep
 * would group by noise. Each test flips the provider to ready afterwards and
 * proves `reindex` picks the pending rows up, because "pending" is only a
 * promise if something keeps it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { ConceptEmbedder, pendingEmbedder } from '../test/embedders.js';
import { TaskClassifier } from './classifier.js';
import { Consolidator } from './consolidation.js';
import { PENDING_EMBEDDING_MODEL, SwitchableEmbedder } from './embeddings.js';
import { KnowledgeStore } from './knowledge.js';
import { MemoryStore } from './memory.js';
import { countStale, createRebuildTrigger, reindexStale } from './reindex.js';

let db: Db;
let embedder: ConceptEmbedder;

const row = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  embedder = pendingEmbedder();
});

describe('MemoryStore', () => {
  it('stores a memory pending while the model loads, searches it lexically, and embeds it once ready', async () => {
    const store = new MemoryStore(db, embedder);

    // Two unrelated rows first: bm25's IDF is log((N - n + 0.5) / (n + 0.5)),
    // which is zero for a term in one row of two and clamped to nothing on a
    // one-row corpus — a lexical hit needs at least three rows to exist.
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'The cat', content: 'Sleeps on the windowsill.' });
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'Recipe', content: 'Two eggs and a pinch of salt.' });
    const { memory, merged } = await store.remember({
      workspaceId: null, kind: 'semantic', title: 'Install with pnpm', content: 'Never npm.',
    });

    expect(merged).toBe(false);
    const stored = row<{ embedding: Buffer | null; embedding_model: string | null }>(
      'SELECT embedding, embedding_model FROM memories WHERE id = ?', memory.id,
    );
    expect(stored.embedding).toBeNull();
    expect(stored.embedding_model).toBeNull();
    expect(embedder.embedded).toEqual([]);

    // The lexical arm still answers; the dense arm is simply absent.
    const hits = await store.search('pnpm');
    expect(hits.map((hit) => hit.memory.id)).toEqual([memory.id]);
    expect(embedder.embedded).toEqual([]);

    embedder.ready = true;
    expect(await store.reindex()).toBe(3);
    expect(row<{ embedding_model: string }>('SELECT embedding_model FROM memories WHERE id = ?', memory.id).embedding_model).toBe(embedder.id);
  });

  it('marks an edited memory pending rather than keeping the vector of the old text', async () => {
    const live = new ConceptEmbedder();
    const store = new MemoryStore(db, live);
    const { memory } = await store.remember({ workspaceId: null, kind: 'semantic', title: 'Deploy', content: 'From the app.' });

    live.ready = false;
    await store.update(memory.id, { content: 'From a workflow, actually.' });

    const stored = row<{ embedding_model: string | null }>('SELECT embedding_model FROM memories WHERE id = ?', memory.id);
    expect(stored.embedding_model).toBeNull();
    expect(countStale(db, live.id).memories).toBe(1);
  });

  it('does not deduplicate against anything while the model is not ready', async () => {
    const live = new ConceptEmbedder();
    const store = new MemoryStore(db, live);
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'Install with pnpm', content: 'Never npm.' });

    live.ready = false;
    const { merged } = await store.remember({ workspaceId: null, kind: 'semantic', title: 'Install with pnpm', content: 'Never npm.' });

    // A second row rather than a merge: dedup needs a vector to compare, and a
    // duplicate that consolidation catches later beats a merge decided blind.
    expect(merged).toBe(false);
    expect(row<{ n: number }>('SELECT COUNT(*) AS n FROM memories').n).toBe(2);
  });
});

describe('KnowledgeStore', () => {
  it('stores a document pending, finds its chunks lexically, and embeds them once ready', async () => {
    const store = new KnowledgeStore(db, embedder);

    await store.upsert({ workspaceId: null, title: 'Recipe', content: 'Two eggs and a pinch of salt.' });
    await store.upsert({ workspaceId: null, title: 'Cat', content: 'The cat sleeps on the windowsill.' });
    const document = await store.upsert({ workspaceId: null, title: 'Runbook', content: 'Deploy from the app, never from a workflow.' });

    expect(row<{ embedding_model: string }>('SELECT embedding_model FROM documents WHERE id = ?', document.id).embedding_model).toBe(PENDING_EMBEDDING_MODEL);
    expect(row<{ embedding: Buffer | null }>('SELECT embedding FROM document_chunks WHERE document_id = ?', document.id).embedding).toBeNull();

    const hits = await store.search('workflow');
    expect(hits).toHaveLength(1);

    embedder.ready = true;
    expect(await store.reindex()).toBe(3);
    expect(row<{ embedding_model: string }>('SELECT embedding_model FROM documents WHERE id = ?', document.id).embedding_model).toBe(embedder.id);
    expect(countStale(db, embedder.id).documents).toBe(0);
  });
});

describe('TaskClassifier', () => {
  it('keeps an exemplar pending, votes with none of them, and rebuilds them once ready', async () => {
    const classifier = new TaskClassifier(db, embedder);

    for (let index = 0; index < 14; index += 1) {
      await classifier.learn(`deploy the release ${index}`, 'ops', null);
    }
    expect(row<{ n: number }>('SELECT COUNT(*) AS n FROM task_exemplars WHERE embedding_model = ?', PENDING_EMBEDDING_MODEL).n).toBe(14);
    expect(countStale(db, embedder.id).exemplars).toBe(14);

    // No vector to vote with: the rules decide, whatever the exemplar count.
    const blind = await classifier.classify('deploy the release now', null);
    expect(blind.reason).not.toMatch(/similar past task/);

    embedder.ready = true;
    expect(await classifier.reindex()).toBe(14);
    const sighted = await classifier.classify('deploy the release now', null);
    expect(sighted.category).toBe('ops');
    expect(sighted.reason).toMatch(/similar past task/);
  });

  /**
   * The other direction: exemplars exist under the live id, then the model
   * goes away (a switch back to a provider still loading). The SQL filter no
   * longer protects kNN — the rows match — so only the readiness check keeps
   * `classify` from throwing on the query embedding.
   */
  it('falls back to the rules, without throwing, when the model goes away after learning', async () => {
    const live = new ConceptEmbedder();
    const classifier = new TaskClassifier(db, live);
    for (let index = 0; index < 14; index += 1) {
      await classifier.learn(`deploy the release ${index}`, 'ops', null);
    }

    live.ready = false;
    const blind = await classifier.classify('deploy the release now', null);

    expect(blind.reason).not.toMatch(/similar past task/);
  });
});

describe('Consolidator', () => {
  it('compares nothing while the model is not ready', async () => {
    const live = new ConceptEmbedder();
    const store = new MemoryStore(db, live);
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'Install with pnpm', content: 'Never npm.' });
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'Use pnpm to install', content: 'npm is refused.' });
    let asked = 0;
    const consolidator = new Consolidator({
      db,
      memory: store,
      embedder: live,
      arbiter: async () => {
        asked += 1;
        return { groups: [] };
      },
      log: () => {},
    } as never);

    live.ready = false;
    const result = await consolidator.sweep();

    expect(result.groups).toBe(0);
    expect(asked).toBe(0);
  });
});

describe('reindexStale', () => {
  it('rebuilds memories, documents and exemplars together once the switch lands', async () => {
    const hash = new ConceptEmbedder({ id: 'st:old' });
    const switchable = new SwitchableEmbedder(hash);
    const memory = new MemoryStore(db, switchable);
    const knowledge = new KnowledgeStore(db, switchable);
    const classifier = new TaskClassifier(db, switchable);
    await memory.remember({ workspaceId: null, kind: 'semantic', title: 'A', content: 'deploy' });
    await knowledge.upsert({ workspaceId: null, title: 'B', content: 'deploy from the app' });
    await classifier.learn('deploy it', 'ops', null);

    switchable.use(new ConceptEmbedder({ id: 'st:new' }));
    expect(countStale(db, switchable.id)).toEqual({ memories: 1, documents: 1, exemplars: 1 });

    const done = await reindexStale({ db, memory, knowledge, classifier, embedder: switchable, log: () => {} });

    expect(done).toEqual({ memories: 1, documents: 1, exemplars: 1 });
    expect(countStale(db, switchable.id)).toEqual({ memories: 0, documents: 0, exemplars: 0 });
  });

  it('waits rather than rebuilding while the provider is not ready, and says so once', async () => {
    const memory = new MemoryStore(db, embedder);
    const knowledge = new KnowledgeStore(db, embedder);
    const classifier = new TaskClassifier(db, embedder);
    await memory.remember({ workspaceId: null, kind: 'semantic', title: 'A', content: 'deploy' });
    const logged: string[] = [];

    const done = await reindexStale({ db, memory, knowledge, classifier, embedder, log: (_level, message) => logged.push(message) });

    expect(done).toEqual({ memories: 0, documents: 0, exemplars: 0 });
    expect(countStale(db, embedder.id).memories).toBe(1);
    // One line naming the wait — not the "rebuilding" line, which would claim
    // work that did not happen, and not silence, which hides a stuck model.
    expect(logged).toEqual(['vectors are waiting for the embedding model']);
  });
});

describe('createRebuildTrigger', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('runs once for a burst, once more for whatever arrived while running, then rests', async () => {
    let finish: () => void = () => {};
    let runs = 0;
    const rebuild = createRebuildTrigger(
      () =>
        new Promise<void>((resolve) => {
          runs += 1;
          finish = resolve;
        }),
    );

    rebuild.trigger();
    rebuild.trigger();
    rebuild.trigger();
    expect(runs).toBe(1);
    expect(rebuild.inFlight()).toBe(true);

    finish();
    await tick();
    // The two asks that arrived mid-pass collapsed into one more pass.
    expect(runs).toBe(2);
    expect(rebuild.inFlight()).toBe(true);

    finish();
    await tick();
    expect(runs).toBe(2);
    expect(rebuild.inFlight()).toBe(false);
  });

  it('keeps working after a pass that threw', async () => {
    let runs = 0;
    const rebuild = createRebuildTrigger(async () => {
      runs += 1;
      if (runs === 1) throw new Error('model hiccup');
    });

    rebuild.trigger();
    await tick();
    rebuild.trigger();
    await tick();

    expect(runs).toBe(2);
    expect(rebuild.inFlight()).toBe(false);
  });
});
