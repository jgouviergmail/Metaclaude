import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { evalCorpus, EVAL_QUERIES } from './eval-corpus.js';
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
   * Questions sharing no content word with their answer. A person asks these
   * constantly — "puis-je partir avant la fin ?" for a notice period — and
   * the hashing embedder cannot bridge them, because its "similarity" is
   * character n-gram overlap wearing a cosine's clothes.
   */
  const HARD: Array<{ query: string; answer: string; probes: string }> = [
    {
      query: 'puis-je partir avant la fin sans pénalité ?',
      answer: 'Le délai de préavis est de trois',
      probes: 'no overlap with préavis / congé',
    },
    {
      query: 'quand mon argent me sera-t-il rendu à la sortie ?',
      answer: 'restitué dans un délai de deux mois',
      probes: 'no overlap with dépôt de garantie',
    },
    {
      query: 'on m’a cambriolé, j’ai combien de temps ?',
      answer: 'ramené à deux jours ouvrés en cas de',
      probes: 'cambriolé vs vol / effraction',
    },
    {
      query: 'who pays to replace an old boiler?',
      answer: 'restent à la charge du bailleur',
      probes: 'English question, French answer',
    },
  ];

  it('finds nothing — and this is characterised, not tolerated', async () => {
    await seed(4);
    const labelled: LabelledQuery[] = HARD.map((entry) => ({
      query: entry.query,
      probes: entry.probes,
      relevant: resolve([entry.answer]),
    }));

    const report = await evaluate(labelled, search(5), 5);

    // Measured at 0/0/0. Asserted as an upper bound: the day an embedding
    // provider with actual semantics is enabled, this test fails — and that
    // failure is the good news. Raise the bound then, do not delete the test.
    expect(report.recall).toBeLessThanOrEqual(0.25);
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
