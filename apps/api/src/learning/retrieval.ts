/**
 * The retrieval pieces two stores share, and the profile that chooses them.
 *
 * Extracted from `memory.ts` the day the knowledge store arrived, because the
 * constants here are not style — they are **measurements of this exact
 * configuration** (the pluggable embedders, fts5's IDF clamp, `porter
 * unicode61`), and a second store that re-derived them would either copy the
 * numbers without their evidence or drift from them. The full derivations
 * stay with each constant; `memory.ts` re-exports everything so its callers
 * and tests are undisturbed.
 */

import type { EmbedderFamily } from './embeddings.js';

/**
 * Relevance gate for the dense arm.
 *
 * Without a gate the dense arm contributes *every* embedded row, sorted, and
 * fusion gives them all a positive score — so on a small corpus the caller's
 * `limit` is filled with whatever exists rather than with what is relevant.
 *
 * The gate is **relative to the best match**, not an absolute cosine, because
 * the embedding provider is pluggable and the two providers do not share a
 * scale. Measured: the hashing embedder puts genuine matches at 0.09–0.39 and
 * noise at up to 0.24 — overlapping ranges, so no fixed threshold separates
 * them — while a sentence-transformer runs far higher and would have a fixed
 * threshold admitting everything. "At least half as similar as the best hit"
 * holds under both. `MIN_ABSOLUTE_SIMILARITY` then discards the degenerate
 * case where even the best match is essentially orthogonal.
 */
export const RELATIVE_SIMILARITY_FLOOR = 0.5;
export const MIN_ABSOLUTE_SIMILARITY = 0.05;

/**
 * Relevance gate for the lexical arm.
 *
 * **Absolute, not relative to the best hit**, and both halves of that are
 * measured rather than chosen. fts5 clamps a term's IDF at 1e-6, so a token
 * present in every document contributes essentially nothing: stopword-only
 * matches score between -0.000001 and -0.000003 while genuine ones run from
 * -0.45 to -4.3. Four orders of magnitude, and the gap does not move with
 * corpus size, because it is the clamp that produces it. A ratio to the best
 * hit fails at both ends: when everything is noise the best is ~0 and the
 * whole corpus is admitted; when the best is strong, longer genuine matches
 * are discarded for their length normalisation — and the cut moves when
 * unrelated rows shift the average document length.
 *
 * SQLite's `bm25()` is negated — more negative is a better match — so this is
 * a ceiling on the value rather than a floor on its magnitude.
 */
export const MIN_ABSOLUTE_BM25 = 0.01;

/**
 * Function words the lexical arm must not match on.
 *
 * The BM25 clamp gate assumes a stopword appears in *every* document, which a
 * large corpus guarantees and a small one does not: on a two-chunk corpus,
 * "un" present in one chunk carries real IDF and a query of nothing but
 * French function words came back corroborated at rank −0.0325 — through the
 * ceiling. The list is deliberately small and closed: only words with no
 * conceivable retrieval value in either of this deployment's languages.
 * Content words are never touched, so a real query only gets cleaner.
 */
const STOPWORDS = new Set([
  // français
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'où', 'est',
  'ce', 'ces', 'cet', 'cette', 'il', 'elle', 'on', 'ne', 'pas', 'que', 'qui',
  'quoi', 'dans', 'sur', 'par', 'pour', 'avec', 'sans', 'au', 'aux', 'se',
  'sa', 'son', 'ses', 'mais', 'donc', 'car', 'si', 'en', 'y', 'à',
  // english
  'the', 'a', 'an', 'of', 'and', 'or', 'is', 'are', 'was', 'be', 'to', 'in',
  'on', 'at', 'it', 'its', 'as', 'by', 'for', 'with', 'this', 'that', 'not',
]);

/**
 * Turn free text into a safe FTS5 MATCH expression.
 *
 * Every token is quoted, which neutralises the FTS query operators (`*`, `:`,
 * `NEAR`, `-`) that would otherwise let user text change the query's meaning
 * or raise a syntax error.
 */
export function toFtsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 2 && token.length < 40)
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 24);
  // All function words: the arm abstains rather than matching on grammar.
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * Reciprocal-rank fusion of the two arms' orderings.
 *
 * k=60 is the value from the original RRF paper and needs no per-corpus
 * tuning, which matters for a system that starts empty. Each list contributes
 * 1/(k + rank + 1) per id; ids present in both accumulate.
 */
export function rrfFuse(rankings: ReadonlyArray<readonly string[]>, k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

/* -------------------------------------------------------------------------- */
/* Profiles — one per family of vector space                                   */
/* -------------------------------------------------------------------------- */

/**
 * Near-duplicate threshold for the hashing family: a write at or above this
 * cosine against an existing row of its scope is merged into it rather than
 * inserted. Deliberately high — the merge is automatic and silent, so a miss
 * (two rows for one fact) is the cheap error and a false merge the expensive
 * one. Measured on a real deployment, the highest cosine between any two of
 * its memories was 0.51 while a third of them said the same thing: this
 * catches the same text written twice, and consolidation catches the rest by
 * asking a model.
 */
export const DUPLICATE_THRESHOLD = 0.92;

/**
 * Floor for a dense-arm result the lexical arm does not corroborate, in the
 * knowledge store, hashing family.
 *
 * The relative gate alone is not enough there, and the reason is French: a
 * stopword query's character n-grams soak a French corpus, so every chunk
 * scores in a flat band and the relative floor admits the lot. Measured on
 * chunk-scale texts with their title prefix: stopword-only queries top out at
 * 0.102 (French) and 0.061 (English), genuine paraphrase starts at 0.446.
 * 0.18 sits in the dead zone with margin on both sides.
 */
export const DENSE_SOLO_FLOOR = 0.18;

/**
 * What the sentence-transformer family was measured at, on bge-m3 (CLS
 * pooling, q8), and what each profile number is held against by
 * `retrieval-profile.test.ts`. Memory-scale texts unless stated.
 *
 *  - a query of nothing but function words scores at most 0.36 against a
 *    corpus of memories, 0.36 against chunks;
 *  - unrelated memories sit between 0.27 and 0.42; unrelated *chunks* run
 *    higher (p95 0.55) because long legal passages share a register — which
 *    is why ranking, not an absolute cut, decides between chunks;
 *  - memories of the same project on different facts: 0.38–0.54;
 *  - the weakest genuine paraphrase seen, query against passage: 0.46;
 *  - a paraphrase of the same fact between two memories: 0.57;
 *  - a contrary claim on the same subject: 0.76;
 *  - the same fact restated in other words: 0.87; identical text 0.99.
 */
export const ST_MEASURED = {
  stopwordQueryMax: 0.361,
  unrelatedMemoryMax: 0.42,
  genuineParaphraseMin: 0.46,
  sameFactParaphrase: 0.569,
  contraryClaim: 0.759,
  nearDuplicate: 0.873,
} as const;

export interface RetrievalProfile {
  family: EmbedderFamily;
  /** The dense gate relative to the best hit. */
  relativeFloor: number;
  /** The dense gate in absolute terms; the larger of the two applies. */
  minAbsoluteSimilarity: number;
  /** Knowledge only: a dense result no lexical hit corroborates must reach this. */
  denseSoloFloor: number;
  /** A write at or above this cosine against an existing row is merged into it. */
  duplicateThreshold: number;
  /** A neighbour at or above this cosine is shortlisted for the consolidation arbiter. */
  consolidationFloor: number;
  /**
   * How the two arms combine. `rrf` treats them as peers, which is right when
   * neither knows meaning. `dense-first` keeps the dense order and lets the
   * lexical arm only append what the dense arm missed — measured on bge-m3,
   * equal-weight fusion demoted right passages the dense arm had ranked
   * first, and on a weaker model took recall@5 from 3/6 to 1/6.
   */
  fusion: 'rrf' | 'dense-first';
}

const HASH_PROFILE: RetrievalProfile = {
  family: 'hash',
  relativeFloor: RELATIVE_SIMILARITY_FLOOR,
  minAbsoluteSimilarity: MIN_ABSOLUTE_SIMILARITY,
  denseSoloFloor: DENSE_SOLO_FLOOR,
  duplicateThreshold: DUPLICATE_THRESHOLD,
  consolidationFloor: 0.25,
  fusion: 'rrf',
};

/**
 * The sentence-transformer profile. Absolute floors sit just above the
 * stopword band — below the weakest genuine paraphrase, with the margin the
 * measurements allow — and the relative floor is loosened, because a real
 * model's best hit is often the right one and half of it would cut nothing
 * useful. Ranking does the rest.
 */
const ST_PROFILE: RetrievalProfile = {
  family: 'st',
  relativeFloor: 0.5,
  minAbsoluteSimilarity: 0.38,
  denseSoloFloor: 0.38,
  duplicateThreshold: 0.85,
  consolidationFloor: 0.5,
  fusion: 'dense-first',
};

export function retrievalProfile(family: EmbedderFamily): RetrievalProfile {
  return family === 'st' ? ST_PROFILE : HASH_PROFILE;
}

/**
 * Combine the two arms as the profile says. The result maps each id to a
 * score that only orders — `rrf` scores for the hashing family, a strictly
 * decreasing rank score for `dense-first`, so a caller re-weighting by priors
 * sees the same shape from both.
 */
export function fuseRankings(
  profile: RetrievalProfile,
  dense: readonly string[],
  lexical: readonly string[],
): Map<string, number> {
  if (profile.fusion === 'rrf') return rrfFuse([dense, lexical]);
  const ordered = [...dense];
  const seen = new Set(dense);
  for (const id of lexical) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return new Map(ordered.map((id, index) => [id, 1 / (60 + index + 1)]));
}
