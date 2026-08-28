/**
 * Retrieval evaluation — the instrument, not the experiment.
 *
 * This module exists because the next change to retrieval must be *decided*
 * rather than believed. Adding a reranking stage, swapping an embedder,
 * moving a relevance floor: each is a plausible improvement, and plausible is
 * exactly the standard that produces slow, confident regressions. What breaks
 * that cycle is a number computed the same way before and after.
 *
 * Three metrics, because each answers a different question and they disagree
 * usefully:
 *
 *  - **recall@k** — did the right passage make it into the window at all?
 *    This is the one that matters most here: a passage the run never sees
 *    cannot help it, and nothing downstream can recover from its absence.
 *  - **MRR** — how far down did the reader have to look? Sensitive to the
 *    *first* hit only, which is the right sensitivity for a context budget
 *    that is filled greedily from the top.
 *  - **nDCG@k** — the graded view: rewards putting *all* the relevant
 *    passages high, not just one. This is the metric a reranker should move,
 *    because reordering a fixed candidate set cannot change recall at the
 *    pool size and can only change *where* things sit.
 *
 * That last point is the reason all three are here. A reranker that improves
 * MRR and nDCG while leaving recall flat is working exactly as intended; one
 * that improves recall is doing something suspicious, because it cannot add
 * candidates it was not given.
 *
 * Everything is binary-relevance: a passage either answers the query or does
 * not. Graded judgements would be more expressive and less honest — nobody
 * here is going to maintain a 0–3 scale consistently.
 */

/** One labelled question: what was asked, and which chunk ids answer it. */
export interface LabelledQuery {
  /** What a person would actually type. */
  query: string;
  /** Ids that count as a correct answer. At least one. */
  relevant: readonly string[];
  /** Free-text note explaining what this query is probing. */
  probes: string;
}

export interface QueryScore {
  query: string;
  probes: string;
  recall: number;
  reciprocalRank: number;
  ndcg: number;
  /** What came back, best first — kept so a failure can be read, not guessed. */
  retrieved: readonly string[];
}

export interface EvalReport {
  k: number;
  queries: QueryScore[];
  /** Means across queries. Macro-averaged: every query counts the same. */
  recall: number;
  mrr: number;
  ndcg: number;
}

/**
 * Fraction of the relevant ids that appear in the top `k`.
 *
 * Macro-averaged per query later, so a query with three right answers does
 * not outvote one with a single right answer.
 */
export function recallAt(k: number, retrieved: readonly string[], relevant: readonly string[]): number {
  if (relevant.length === 0) return 0;
  const window = new Set(retrieved.slice(0, k));
  const found = relevant.filter((id) => window.has(id)).length;
  return found / relevant.length;
}

/**
 * 1 / (1-based rank of the first relevant id), or 0 when none is retrieved.
 *
 * Deliberately unbounded — this is the textbook definition, over the whole
 * ranking. `evaluate` narrows it to the report's `k` before averaging; see
 * the note there for why a report may not mix windows.
 */
export function reciprocalRank(retrieved: readonly string[], relevant: readonly string[]): number {
  const wanted = new Set(relevant);
  const index = retrieved.findIndex((id) => wanted.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * nDCG@k with binary relevance.
 *
 * DCG discounts by log2(rank + 1); the ideal ordering puts every relevant id
 * first, capped at k — which is what makes the result comparable between
 * queries that have different numbers of right answers.
 */
export function ndcgAt(k: number, retrieved: readonly string[], relevant: readonly string[]): number {
  const wanted = new Set(relevant);
  let dcg = 0;
  retrieved.slice(0, k).forEach((id, index) => {
    if (wanted.has(id)) dcg += 1 / Math.log2(index + 2);
  });

  let ideal = 0;
  for (let index = 0; index < Math.min(k, relevant.length); index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }
  return ideal === 0 ? 0 : dcg / ideal;
}

/**
 * Run every labelled query through `search` and report.
 *
 * `search` returns ids best-first — whatever produces them (a store, a
 * pipeline with a reranker bolted on, a deliberately broken variant) is the
 * experiment; this function is only the ruler.
 */
export async function evaluate(
  queries: readonly LabelledQuery[],
  search: (query: string) => Promise<readonly string[]>,
  k = 5,
): Promise<EvalReport> {
  const scores: QueryScore[] = [];
  for (const labelled of queries) {
    const retrieved = await search(labelled.query);
    scores.push({
      query: labelled.query,
      probes: labelled.probes,
      recall: recallAt(k, retrieved, labelled.relevant),
      // Every figure in one report answers for the same window. Left
      // unbounded, MRR would score hits the run never sees: a search handing
      // back fifty candidates with k=5 reports "recall@5 0%, MRR 5%", which
      // reads as a reranker earning its keep and is really a hit at rank 20.
      reciprocalRank: reciprocalRank(retrieved.slice(0, k), labelled.relevant),
      ndcg: ndcgAt(k, retrieved, labelled.relevant),
      retrieved,
    });
  }

  const mean = (pick: (score: QueryScore) => number): number =>
    scores.length === 0 ? 0 : scores.reduce((total, score) => total + pick(score), 0) / scores.length;

  return {
    k,
    queries: scores,
    recall: mean((score) => score.recall),
    mrr: mean((score) => score.reciprocalRank),
    ndcg: mean((score) => score.ndcg),
  };
}

/** A one-line summary, for a script's stdout or a failing test's message. */
export function formatReport(label: string, report: EvalReport): string {
  const pct = (value: number) => (value * 100).toFixed(1).padStart(5);
  return `${label.padEnd(24)} recall@${report.k} ${pct(report.recall)}%  MRR ${pct(report.mrr)}%  nDCG ${pct(report.ndcg)}%`;
}
