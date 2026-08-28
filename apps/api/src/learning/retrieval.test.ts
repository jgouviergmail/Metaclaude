import { describe, expect, it } from 'vitest';

import {
  MIN_ABSOLUTE_BM25,
  MIN_ABSOLUTE_SIMILARITY,
  RELATIVE_SIMILARITY_FLOOR,
  rrfFuse,
  toFtsQuery,
} from './retrieval.js';

// The behavioural surface of toFtsQuery is pinned in memory.test.ts, beside
// the store that has exercised it since before this module existed. What
// lives here is what belongs to retrieval itself: the fusion's arithmetic,
// the abstention rule, and the constants' mutual sanity.

describe('reciprocal-rank fusion', () => {
  it('scores 1/(k+rank+1) per list and accumulates across lists', () => {
    const fused = rrfFuse([
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(fused.get('a')).toBeCloseTo(1 / 61, 10);
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(fused.get('c')).toBeCloseTo(1 / 62, 10);
  });

  it('an id present in both arms outranks a solo id at the same rank', () => {
    // The whole reason fusion beats either arm alone: corroboration wins.
    const fused = rrfFuse([
      ['solo', 'both'],
      ['both'],
    ]);
    expect(fused.get('both')!).toBeGreaterThan(fused.get('solo')!);
  });

  it('handles empty rankings without inventing entries', () => {
    expect(rrfFuse([[], []]).size).toBe(0);
    expect(rrfFuse([]).size).toBe(0);
  });
});

describe('the abstention rule', () => {
  it('abstains on function words in both of this deployment’s languages', () => {
    // On a small corpus a stopword can carry real IDF straight through the
    // BM25 clamp gate — measured at −0.0325 for "un" present in one chunk of
    // two — so the arm refuses to match on grammar at all.
    expect(toFtsQuery('le la de et un')).toBeNull();
    expect(toFtsQuery('the and of a it')).toBeNull();
    expect(toFtsQuery('')).toBeNull();
  });

  it('keeps every content word, stopwords merely dropping out around them', () => {
    expect(toFtsQuery('le préavis de la résiliation')).toBe('"préavis" OR "résiliation"');
  });

  it('never mistakes a short identifier for grammar', () => {
    // "ci", "db", digits: short is not the same as meaningless.
    expect(toFtsQuery('ci db 42')).toBe('"ci" OR "db" OR "42"');
  });
});

describe('the constants', () => {
  it('keep their measured relationships', () => {
    // The relative floor must be a fraction, the absolute floors positive and
    // small; a refactor that flips a sign or a scale should fail loudly here
    // rather than as silently empty retrievals.
    expect(RELATIVE_SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(RELATIVE_SIMILARITY_FLOOR).toBeLessThan(1);
    expect(MIN_ABSOLUTE_SIMILARITY).toBeGreaterThan(0);
    expect(MIN_ABSOLUTE_SIMILARITY).toBeLessThan(RELATIVE_SIMILARITY_FLOOR);
    expect(MIN_ABSOLUTE_BM25).toBeGreaterThan(0);
    expect(MIN_ABSOLUTE_BM25).toBeLessThan(1);
  });
});
