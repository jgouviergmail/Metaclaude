/**
 * One profile per family of vector space.
 *
 * Every floor in retrieval is a measurement, and the two families measure
 * differently: hashing puts genuine matches at 0.09–0.39 and noise up to
 * 0.24; bge-m3 puts a stopword query at 0.36 against the corpus, unrelated
 * memories at up to 0.42, genuine paraphrase from 0.46, a contrary claim on
 * the same subject at 0.76 and a near-duplicate at 0.87. A number right for
 * one family is wrong for the other by a factor of two or more — the
 * hashing consolidation floor (0.25) would shortlist an entire bge-m3 corpus,
 * and equal-weight fusion took a model that ranked the right passage first
 * on 6 questions of 6 down to 5, and a weaker one from 3 to 1. So the family
 * chooses the floors and the fusion rule, and these tests pin each number to
 * the band it was measured against rather than to a value.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Consolidator } from './consolidation.js';
import {
  HashingEmbedder,
  l2Normalise,
  type EmbedderFamily,
  type EmbeddingProvider,
} from './embeddings.js';
import { MemoryStore } from './memory.js';
import {
  DENSE_SOLO_FLOOR,
  DUPLICATE_THRESHOLD,
  fuseRankings,
  MIN_ABSOLUTE_SIMILARITY,
  RELATIVE_SIMILARITY_FLOOR,
  retrievalProfile,
  ST_MEASURED,
} from './retrieval.js';

/** An embedder that answers preset vectors, so a cosine can be chosen exactly. */
class VectorEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimension = 4;
  readonly ready = true;
  constructor(
    readonly family: EmbedderFamily,
    private readonly table: Record<string, number[]>,
  ) {
    this.id = `${family}:vectors`;
  }
  async embed(text: string): Promise<Float32Array> {
    const key = Object.keys(this.table).find((needle) => text.includes(needle));
    return l2Normalise(Float32Array.from(key ? this.table[key]! : [0, 0, 0, 1]));
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

/** Two unit vectors at a chosen cosine. */
const pairAt = (cosine: number): [number[], number[]] => [
  [1, 0, 0, 0],
  [cosine, Math.sqrt(1 - cosine * cosine), 0, 0],
];

describe('the profiles', () => {
  it('give the hashing family exactly the numbers its stores were measured with', () => {
    const hash = retrievalProfile('hash');

    expect(hash).toEqual({
      family: 'hash',
      relativeFloor: RELATIVE_SIMILARITY_FLOOR,
      minAbsoluteSimilarity: MIN_ABSOLUTE_SIMILARITY,
      denseSoloFloor: DENSE_SOLO_FLOOR,
      duplicateThreshold: DUPLICATE_THRESHOLD,
      consolidationFloor: 0.25,
      fusion: 'rrf',
    });
  });

  it('place every sentence-transformer floor inside the band it was measured against', () => {
    const st = retrievalProfile('st');

    expect(st.fusion).toBe('dense-first');
    // Above what a query of nothing but function words scores against a
    // corpus, below the weakest genuine paraphrase seen.
    expect(st.minAbsoluteSimilarity).toBeGreaterThan(ST_MEASURED.stopwordQueryMax);
    expect(st.minAbsoluteSimilarity).toBeLessThan(ST_MEASURED.genuineParaphraseMin);
    expect(st.denseSoloFloor).toBeGreaterThan(ST_MEASURED.stopwordQueryMax);
    expect(st.denseSoloFloor).toBeLessThan(ST_MEASURED.genuineParaphraseMin);
    // A merge is automatic and silent, so it must never reach a contrary
    // claim on the same subject — and must reach a restatement of the fact.
    expect(st.duplicateThreshold).toBeGreaterThan(ST_MEASURED.contraryClaim);
    expect(st.duplicateThreshold).toBeLessThan(ST_MEASURED.nearDuplicate);
    // The consolidation shortlist is judged by a model afterwards, so it may
    // reach down to a paraphrase of the same fact — but not into unrelated text.
    expect(st.consolidationFloor).toBeGreaterThan(ST_MEASURED.unrelatedMemoryMax);
    expect(st.consolidationFloor).toBeLessThan(ST_MEASURED.sameFactParaphrase);
  });
});

describe('fusion by profile', () => {
  const dense = ['a', 'b', 'c'];
  const lexical = ['x', 'b', 'y'];

  it('is reciprocal-rank fusion for hashing, where the arms are peers', () => {
    const fused = [...fuseRankings(retrievalProfile('hash'), dense, lexical).entries()].sort((p, q) => q[1] - p[1]);

    // Present in both arms, b outranks everything a single arm produced.
    expect(fused[0]?.[0]).toBe('b');
  });

  /**
   * Measured: with bge-m3 the dense arm alone placed the right passage first
   * on 6 rephrased questions of 6; reciprocal-rank fusion with the lexical
   * arm demoted one, and with a weaker model demoted two of three. Under a
   * semantic embedder the lexical arm can only add candidates the dense arm
   * missed — never reorder what it ranked.
   */
  it('keeps the dense order first for a sentence-transformer, appending what only the lexical arm found', () => {
    const fused = [...fuseRankings(retrievalProfile('st'), dense, lexical).entries()];
    const order = fused.sort((p, q) => q[1] - p[1]).map(([id]) => id);

    expect(order).toEqual(['a', 'b', 'c', 'x', 'y']);
    const scores = fused.map(([, score]) => score);
    expect(scores.every((score, index) => index === 0 || score < scores[index - 1]!)).toBe(true);
  });

  it('answers the lexical arm alone when the dense arm has nothing', () => {
    const order = [...fuseRankings(retrievalProfile('st'), [], lexical).entries()]
      .sort((p, q) => q[1] - p[1])
      .map(([id]) => id);

    expect(order).toEqual(['x', 'b', 'y']);
  });
});

describe('the stores read the profile', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    migrate(db);
  });

  it.each([
    ['hash', 0.88, false],
    ['st', 0.88, true],
    ['st', 0.80, false],
  ] as const)('%s: a restatement at cosine %s is merged on write — %s', async (family, cosine, merged) => {
    const [first, second] = pairAt(cosine);
    const store = new MemoryStore(db, new VectorEmbedder(family, { 'first note': first, 'second note': second }));
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'first note', content: 'x' });

    const result = await store.remember({ workspaceId: null, kind: 'semantic', title: 'second note', content: 'y' });

    expect(result.merged).toBe(merged);
  });

  it.each([
    ['hash', 0.4, 1],
    ['st', 0.4, 0],
    ['st', 0.6, 1],
  ] as const)('%s: two memories at cosine %s form %s consolidation group(s)', async (family, cosine, groups) => {
    const [first, second] = pairAt(cosine);
    const embedder = new VectorEmbedder(family, { 'first note': first, 'second note': second });
    const store = new MemoryStore(db, embedder);
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'first note', content: 'x' });
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'second note', content: 'y' });
    const seen: number[] = [];
    const consolidator = new Consolidator({
      db,
      memory: store,
      embedder,
      language: () => null,
      call: async (groupsIn: unknown[]) => {
        seen.push(groupsIn.length);
        return { groups: [] };
      },
      log: () => {},
    } as never);

    const result = await consolidator.sweep();

    expect(result.groups).toBe(groups);
  });

  it('the hashing embedder still reads the hashing profile after the switch to families', () => {
    expect(retrievalProfile(new HashingEmbedder().family).duplicateThreshold).toBe(DUPLICATE_THRESHOLD);
  });
});
