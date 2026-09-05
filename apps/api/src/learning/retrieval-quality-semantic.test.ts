/**
 * Retrieval quality under a semantic embedder — the regime the hashing tests
 * cannot see.
 *
 * `retrieval-quality.test.ts` characterises the wall: on questions sharing no
 * word with their answer, the hashing embedder finds nothing. This file is
 * the other half, with a fake whose only property is the one that matters —
 * words that mean the same thing land close — so what is under test is not
 * a model but the *pipeline around it*: gates and fusion calibrated for
 * hashing measurably destroyed a real model's ranking (6 of 6 right passages
 * first on the dense arm, 5 of 6 after equal-weight fusion; 3 of 6 down to 1
 * with a weaker model). Nothing here may put a right passage lower than the
 * dense arm ranked it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, unpackEmbedding, type Db } from '../db/index.js';
import { ConceptEmbedder } from '../test/embedders.js';
import { cosineSimilarity } from './embeddings.js';
import { evalCorpus, EVAL_QUERIES, SEMANTIC_QUERIES } from './eval-corpus.js';
import { evaluate, type LabelledQuery } from './eval.js';
import { KnowledgeStore } from './knowledge.js';

let db: Db;
let embedder: ConceptEmbedder;
let store: KnowledgeStore;

const flat = (text: string): string => text.replace(/\s+/gu, ' ');

function chunks(): Array<{ id: string; text: string; vector: Float32Array }> {
  return db
    .prepare<[], { id: string; text: string; embedding: Buffer }>('SELECT id, text, embedding FROM document_chunks')
    .all()
    .map((row) => ({ id: row.id, text: row.text, vector: unpackEmbedding(row.embedding)! }));
}

function resolve(needle: string): string {
  const hits = chunks().filter((chunk) => flat(chunk.text).includes(flat(needle)));
  if (hits.length !== 1) throw new Error(`ground truth "${needle}" matched ${hits.length} chunks`);
  return hits[0]!.id;
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  embedder = new ConceptEmbedder();
  store = new KnowledgeStore(db, embedder);
  for (const document of evalCorpus(4)) {
    await store.upsert({ workspaceId: null, title: document.title, content: document.content });
  }
});

afterEach(() => db.close());

describe('under a semantic embedder', () => {
  it('still answers every in-vocabulary question at rank 1', async () => {
    const labelled: LabelledQuery[] = EVAL_QUERIES.map((query) => ({
      query: query.query,
      probes: query.probes,
      relevant: query.answers.map(resolve),
    }));

    const report = await evaluate(
      labelled,
      async (query) => (await store.search(query, { workspaceId: null, limit: 5 })).map((r) => r.chunkId),
      5,
    );

    expect(report.recall, JSON.stringify(report.queries.filter((q) => q.recall < 1), null, 2)).toBe(1);
  });

  /**
   * The regression measured on the real model, as an invariant: whatever the
   * lexical arm says, a passage the dense arm ranked in its top five stays in
   * the top five after fusion and gating.
   */
  it('never ranks a right passage below where the dense arm put it', async () => {
    const all = chunks();
    let found = 0;
    for (const { query, answer } of SEMANTIC_QUERIES) {
      const truth = resolve(answer);
      const queryVector = await embedder.embed(query);
      const denseRank =
        all
          .map((chunk) => ({ id: chunk.id, score: cosineSimilarity(queryVector, chunk.vector) }))
          .sort((a, b) => b.score - a.score)
          .findIndex((entry) => entry.id === truth) + 1;

      const fused = (await store.search(query, { workspaceId: null, limit: 50 })).map((r) => r.chunkId);
      const fusedRank = fused.indexOf(truth) + 1;

      if (denseRank <= 5) {
        expect(fusedRank, `${query}: dense #${denseRank}, fused #${fusedRank || 'absent'}`).toBeGreaterThan(0);
        expect(fusedRank, `${query}: dense #${denseRank}, fused #${fusedRank}`).toBeLessThanOrEqual(denseRank);
      }
      if (fusedRank >= 1 && fusedRank <= 5) found += 1;
    }
    // The fake must be good enough for the invariant above to bite: at least
    // four of the six rephrased questions land in the top five.
    expect(found).toBeGreaterThanOrEqual(4);
  });

  it('does not let a function-word query drag in the corpus', async () => {
    const results = await store.search('le la les de et ou dans sur', { workspaceId: null, limit: 10 });

    expect(results).toEqual([]);
  });
});
