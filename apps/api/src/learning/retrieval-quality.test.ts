import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { migrate, openDatabase, unpackEmbedding } from '../db/index.js';
import { cosineSimilarity, HashingEmbedder } from './embeddings.js';
import { evalCorpus, EVAL_QUERIES, SEMANTIC_QUERIES } from './eval-corpus.js';
import { evaluate, recallAt, type LabelledQuery } from './eval.js';
import { KnowledgeStore } from './knowledge.js';

/**
 * What retrieval actually achieves, measured rather than asserted.
 *
 * This file is the reason the eval harness exists. It pins two facts that
 * were established by measurement, and it exists to make both of them
 * *falsifiable by a future change* rather than remembered:
 *
 *  1. On queries that share vocabulary with their answer — which is how
 *     people phrase most questions to a library they built — retrieval is
 *     perfect at k=5, and stays perfect as the corpus grows to hundreds of
 *     chunks and as near-duplicate documents pile up.
 *
 *  2. On queries that share *no* content word with their answer, retrieval
 *     finds nothing at all — and not merely below k: the right passage is not
 *     in the candidate pool either. That is the honest shape of a system
 *     whose dense arm is a character-n-gram hash: it is a fuzzy lexical
 *     matcher, not a semantic one.
 *
 * The second fact is why this lot ships no reranker. A reranker reorders
 * candidates; `the semantic wall` below proves there are none to reorder, so
 * reranking is not a weak improvement here, it is arithmetically incapable of
 * being one. The lever is the embedding provider — see docs/LEARNING.md.
 */

let db: Db;
let store: KnowledgeStore;

const flat = (text: string): string => text.replace(/\s+/gu, ' ');

/**
 * Resolve a labelled answer to the chunk that contains it.
 *
 * By content, not by index: the ground truth is "the passage stating this",
 * whatever boundaries the chunker chose. Whitespace is normalised because a
 * paragraph's internal line wrapping is presentation, not content — the first
 * run of this harness failed on exactly that. An answer that matches zero or
 * several chunks throws, so an ambiguous corpus is a loud failure rather than
 * a quietly meaningless measurement.
 */
function resolve(needles: readonly string[]): string[] {
  const chunks = db
    .prepare<[], { id: string; text: string }>('SELECT id, text FROM document_chunks')
    .all();
  return needles.map((needle) => {
    const hits = chunks.filter((chunk) => flat(chunk.text).includes(flat(needle)));
    if (hits.length !== 1) {
      throw new Error(`ground truth "${needle}" matched ${hits.length} chunks, expected exactly 1`);
    }
    return hits[0]!.id;
  });
}

async function seed(distractorCopies: number): Promise<void> {
  for (const document of evalCorpus(distractorCopies)) {
    await store.upsert({
      workspaceId: null,
      title: document.title,
      content: document.content,
    });
  }
}

const search =
  (limit: number) =>
  async (query: string): Promise<string[]> => {
    const results = await store.search(query, { workspaceId: null, limit });
    return results.map((result) => result.chunkId);
  };

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  store = new KnowledgeStore(db, new HashingEmbedder());
});

afterEach(() => db.close());

describe('retrieval quality on questions phrased in the corpus’ own words', () => {
  it('answers every labelled query at rank 1, and says so in numbers', async () => {
    await seed(4);
    const labelled: LabelledQuery[] = EVAL_QUERIES.map((query) => ({
      query: query.query,
      probes: query.probes,
      relevant: resolve(query.answers),
    }));

    const report = await evaluate(labelled, search(5), 5);

    // Measured at 100/100/100 across 113 chunks. Pinned as a floor rather
    // than an equality: a change that improves ranking should not be a
    // failing test, but any regression must be.
    expect(report.recall, JSON.stringify(report.queries.filter((q) => q.recall < 1), null, 2)).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.ndcg).toBe(1);
  });

  it('holds at rank 1 as the corpus grows an order of magnitude', async () => {
    // The first measurement of this harness returned a perfect score on
    // seventeen chunks, which proved nothing: a window of five over
    // seventeen is barely a filter. Three hundred chunks is a real one.
    await seed(12);
    const chunks = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM document_chunks').get()!;
    expect(chunks.n).toBeGreaterThan(250);

    const labelled: LabelledQuery[] = EVAL_QUERIES.map((query) => ({
      query: query.query,
      probes: query.probes,
      relevant: resolve(query.answers),
    }));
    const report = await evaluate(labelled, search(5), 5);
    expect(report.recall).toBe(1);
    expect(report.mrr).toBe(1);
  });

  it('discriminates between documents that differ only by their title', async () => {
    // The hardest realistic case: several leases, near-identical prose,
    // different values, and the only discriminator is an address that lives
    // in the title rather than in the answering passage. This works because
    // each chunk is embedded and indexed with its document title prefixed —
    // remove that and this test is what notices.
    await seed(4);
    const leases: Array<[string, string]> = [
      ['Bail — 3 impasse du Verger', 'quatre mois'],
      ['Bail — 88 avenue Carnot', 'six mois'],
      ['Bail — 5 place Gambetta', 'deux semaines'],
    ];
    for (const [title, notice] of leases) {
      await store.upsert({
        workspaceId: null,
        title,
        content: `# Bail\n\n## Résiliation par le locataire\nLe locataire peut donner congé à tout moment. Le délai de préavis est de ${notice} pour ce logement.`,
      });
    }

    const labelled: LabelledQuery[] = [
      {
        query: 'quel est le préavis pour le bail de la place Gambetta ?',
        relevant: resolve(['est de deux semaines']),
        probes: 'title discriminates; the answer lives in another sentence',
      },
      {
        query: 'préavis du logement avenue Carnot',
        relevant: resolve(['est de six mois']),
        probes: 'title discriminates',
      },
      {
        query: 'délai de préavis impasse du Verger',
        relevant: resolve(['est de quatre mois']),
        probes: 'title discriminates',
      },
    ];

    const report = await evaluate(labelled, search(5), 5);
    expect(report.mrr).toBe(1);
  });
});

describe('the semantic wall', () => {
  /**
   * The shared set from `eval-corpus.ts` — the same questions the bench
   * script measures, deliberately not a local copy. A test and a bench that
   * disagree about what they measure produce two numbers nobody can compare,
   * which is the failure this file exists to prevent elsewhere.
   */
  const HARD = SEMANTIC_QUERIES;

  it('finds nothing — and this is characterised, not tolerated', async () => {
    await seed(4);
    const labelled: LabelledQuery[] = HARD.map((entry) => ({
      query: entry.query,
      probes: entry.probes,
      relevant: resolve([entry.answer]),
    }));

    const report = await evaluate(labelled, search(5), 5);

    // Measured at exactly 0/0/0, and asserted as exactly that rather than as
    // a bound. A bound of "≤ 0.25" would let a quarter of these start working
    // without anyone noticing, while docs/LEARNING.md and the changelog go on
    // claiming zero — and the comment that used to sit here said the failure
    // would be the good news, which a bound tolerating improvement prevents.
    // The day an embedder with real semantics is enabled this goes red: read
    // the new number, put it in the docs, and re-pin it.
    expect(report.recall, JSON.stringify(report.queries.filter((q) => q.recall > 0), null, 2)).toBe(0);
    expect(report.mrr).toBe(0);
    expect(report.ndcg).toBe(0);
  });

  it('places the right passage in the bottom half of the embedder’s own ranking', async () => {
    // The sharpest form of the claim, and the one that bounds *every*
    // possible reranker rather than one pool size. Strip the gates, the
    // fusion and the limit: rank all chunks by raw cosine against the query.
    // A reranker can only reorder a prefix of this list, so where the right
    // passage sits here is the ceiling on what any reranker could rescue.
    //
    // Measured: ranks 34–76 of 113, at cosines of -0.009 to 0.089 while the
    // best-scoring (wrong) chunk sits at 0.098-0.204. The answer is not
    // merely ranked low, it is scored like noise — which is what "the
    // embedder cannot bridge these" means concretely.
    await seed(4);
    const embedder = new HashingEmbedder();
    const rows = db
      .prepare<[], { id: string; text: string; embedding: Buffer }>(
        'SELECT id, text, embedding FROM document_chunks',
      )
      .all();

    for (const entry of HARD) {
      const [goldId] = resolve([entry.answer]);
      const queryVector = await embedder.embed(entry.query);
      const ranked = rows
        .map((row) => ({ id: row.id, score: cosineSimilarity(queryVector, unpackEmbedding(row.embedding)!) }))
        .sort((a, b) => b.score - a.score);
      const rank = ranked.findIndex((row) => row.id === goldId) + 1;

      expect(
        rank,
        `"${entry.query}" — the right passage ranks ${rank}/${ranked.length} by raw cosine. ` +
          'If this is now near the top, the embedder gained semantics: reranking becomes worth measuring.',
      ).toBeGreaterThan(ranked.length / 4);
    }
  });

  it('proves a reranker could not help: the answer is not even a candidate', async () => {
    // This is the measurement that decided the lot. A reranker reorders a
    // candidate pool; if the pool never contains the right passage, no
    // ordering of it can produce the right passage. Asking for fifty results
    // takes everything that survives the relevance gates — the largest set
    // any reranking stage could possibly be handed.
    await seed(4);

    for (const entry of HARD) {
      const gold = resolve([entry.answer]);
      const pool = await search(50)(entry.query);
      expect(
        recallAt(50, pool, gold),
        `"${entry.query}" — pool of ${pool.length}, gold present: reranking WOULD be able to help, revisit the decision`,
      ).toBe(0);
    }
  });
});
