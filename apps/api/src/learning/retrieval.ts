/**
 * The retrieval pieces two stores share.
 *
 * Extracted from `memory.ts` the day the knowledge store arrived, because the
 * constants here are not style — they are **measurements of this exact
 * configuration** (the pluggable embedders, fts5's IDF clamp, `porter
 * unicode61`), and a second store that re-derived them would either copy the
 * numbers without their evidence or drift from them. The full derivations
 * stay with each constant; `memory.ts` re-exports everything so its callers
 * and tests are undisturbed.
 */

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
