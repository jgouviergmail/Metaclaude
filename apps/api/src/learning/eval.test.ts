import { describe, expect, it } from 'vitest';

import { evaluate, formatReport, ndcgAt, recallAt, reciprocalRank } from './eval.js';

// Every expected value below is computed symbolically in the assertion rather
// than pasted as a decimal: a metric test whose expectation was produced by
// running the code proves only that the code is deterministic.

describe('recall@k', () => {
  it('is the fraction of relevant ids inside the window', () => {
    expect(recallAt(3, ['a', 'b', 'c', 'd'], ['b', 'd'])).toBe(1 / 2);
    expect(recallAt(4, ['a', 'b', 'c', 'd'], ['b', 'd'])).toBe(1);
    expect(recallAt(1, ['a', 'b'], ['b'])).toBe(0);
  });

  it('ignores everything past k, which is the whole point of a window', () => {
    // A passage ranked 20th is a passage the run never sees.
    expect(recallAt(2, ['x', 'y', 'gold'], ['gold'])).toBe(0);
  });

  it('is 0 rather than NaN when a query has no right answer', () => {
    expect(recallAt(5, ['a'], [])).toBe(0);
  });

  it('does not reward duplicates in the retrieved list', () => {
    expect(recallAt(3, ['a', 'a', 'a'], ['a', 'b'])).toBe(1 / 2);
  });
});

describe('reciprocal rank', () => {
  it('rewards the first hit and nothing else', () => {
    expect(reciprocalRank(['a', 'gold', 'b'], ['gold'])).toBe(1 / 2);
    // A second relevant id lower down cannot improve it — MRR is deliberately
    // blind past the first, which is the right blindness for a greedy budget.
    expect(reciprocalRank(['a', 'gold', 'also'], ['gold', 'also'])).toBe(1 / 2);
  });

  it('is 1 for a perfect first place and 0 for a miss', () => {
    expect(reciprocalRank(['gold'], ['gold'])).toBe(1);
    expect(reciprocalRank(['a', 'b'], ['gold'])).toBe(0);
    expect(reciprocalRank([], ['gold'])).toBe(0);
  });
});

describe('nDCG@k', () => {
  it('discounts by log2(rank + 1) and normalises by the ideal ordering', () => {
    // retrieved [a, gold, b], relevant {gold}: DCG = 1/log2(3), ideal = 1/log2(2) = 1.
    expect(ndcgAt(3, ['a', 'gold', 'b'], ['gold'])).toBeCloseTo(1 / Math.log2(3), 12);
  });

  it('is 1 exactly when every relevant id is at the top', () => {
    expect(ndcgAt(3, ['g1', 'g2', 'x'], ['g1', 'g2'])).toBe(1);
    expect(ndcgAt(3, ['g1'], ['g1'])).toBe(1);
  });

  it('caps the ideal at k, so queries with different answer counts compare', () => {
    // Two relevant, window of one: the best possible is one hit at rank 1, so
    // finding it must score 1 — not 1/2, which would punish the query for
    // having more right answers than the window can hold.
    expect(ndcgAt(1, ['g1', 'g2'], ['g1', 'g2'])).toBe(1);
  });

  it('rewards putting the second relevant id higher — where a reranker earns its keep', () => {
    const better = ndcgAt(4, ['g1', 'g2', 'x', 'y'], ['g1', 'g2']);
    const worse = ndcgAt(4, ['g1', 'x', 'y', 'g2'], ['g1', 'g2']);
    expect(better).toBeGreaterThan(worse);
    // …while MRR cannot tell them apart at all. This is why both are reported.
    expect(reciprocalRank(['g1', 'g2', 'x', 'y'], ['g1', 'g2'])).toBe(
      reciprocalRank(['g1', 'x', 'y', 'g2'], ['g1', 'g2']),
    );
  });

  it('is 0 for a complete miss', () => {
    expect(ndcgAt(3, ['a', 'b'], ['gold'])).toBe(0);
  });
});

describe('evaluate', () => {
  const queries = [
    { query: 'first', relevant: ['g1'], probes: 'a hit at rank 1' },
    { query: 'second', relevant: ['g2'], probes: 'a miss' },
  ];

  it('macro-averages, so every query weighs the same', async () => {
    const report = await evaluate(
      queries,
      async (query) => (query === 'first' ? ['g1', 'x'] : ['x', 'y']),
      5,
    );
    expect(report.recall).toBe(1 / 2);
    expect(report.mrr).toBe(1 / 2);
    expect(report.ndcg).toBe(1 / 2);
  });

  it('keeps what came back, so a regression can be read rather than guessed', async () => {
    const report = await evaluate(queries, async () => ['x', 'y'], 5);
    expect(report.queries[0]!.retrieved).toEqual(['x', 'y']);
    expect(report.queries[0]!.probes).toBe('a hit at rank 1');
  });

  it('scores every metric over the same window, so one report cannot contradict itself', async () => {
    // A pool of fifty with a hit at rank 20, reported at k=5. Unbounded MRR
    // would answer 1/20 = 5% beside recall@5 of 0% — a passage the run never
    // receives, credited as if it had been read.
    const pool = Array.from({ length: 50 }, (_, index) => (index === 19 ? 'g1' : `x${index}`));
    const report = await evaluate([{ query: 'q', relevant: ['g1'], probes: 'deep hit' }], async () => pool, 5);
    expect(report.recall).toBe(0);
    expect(report.mrr).toBe(0);
    expect(report.ndcg).toBe(0);
  });

  it('still credits a hit inside the window', async () => {
    // The guard above must bound the window, not blunt the metric.
    const report = await evaluate(
      [{ query: 'q', relevant: ['g1'], probes: 'hit at rank 3' }],
      async () => ['x', 'y', 'g1', 'z'],
      5,
    );
    expect(report.mrr).toBe(1 / 3);
  });

  it('survives an empty suite without dividing by zero', async () => {
    const report = await evaluate([], async () => [], 5);
    expect(report).toMatchObject({ recall: 0, mrr: 0, ndcg: 0 });
  });
});

describe('formatReport', () => {
  it('renders one aligned line a human can compare at a glance', async () => {
    const report = await evaluate(
      [{ query: 'q', relevant: ['g'], probes: 'p' }],
      async () => ['g'],
      5,
    );
    const line = formatReport('baseline', report);
    expect(line).toContain('recall@5 100.0%');
    expect(line).toContain('MRR 100.0%');
  });
});
