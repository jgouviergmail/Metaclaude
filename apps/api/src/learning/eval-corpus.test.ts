/**
 * The corpus is an instrument, and an instrument that lies is worse than no
 * instrument at all.
 *
 * Every number this lot reports — 100% in-vocabulary, 0% rephrased, 0% at the
 * candidate pool — is computed against ground truth resolved *by content*:
 * `resolve('franchise de 150 euros')` finds the one passage that answers the
 * query and calls every other retrieval a miss. If a distractor ever contains
 * that phrase too, the harness is measuring something nobody named, and the
 * measurement still prints a confident percentage.
 *
 * The harness catches a *chunk*-level collision at runtime (it throws when a
 * label matches ≠ 1 chunk), but only when someone runs it, and only at the
 * scale they happen to run it at. `replicate` shifts numbers by the copy
 * index, so a collision that is absent at four copies can appear at fifty.
 * These tests are the cheap check across scales, before any store exists.
 *
 * Sabotaging the corpus to prove they bite also showed which collisions are
 * actually possible: pasting `franchise de 150 euros` into a distractor does
 * *not* collide, because the shift turns it into 151, 152… The exposed class
 * is a phrase whose distinctive part carries no digits — `restent à la charge
 * du bailleur` duplicates verbatim — which is why the check matches whole
 * labelled strings rather than looking for repeated numbers.
 */

import { describe, expect, it } from 'vitest';

import type { EvalDocument } from './eval-corpus.js';
import {
  EVAL_DOCUMENTS,
  EVAL_QUERIES,
  evalCorpus,
  replicate,
  SEMANTIC_QUERIES,
} from './eval-corpus.js';

/** Every labelled answer in the module, whichever set it belongs to. */
const ALL_ANSWERS: readonly { query: string; probes: string; answers: readonly string[] }[] = [
  ...EVAL_QUERIES,
  ...SEMANTIC_QUERIES.map((q) => ({ query: q.query, probes: q.probes, answers: [q.answer] })),
];

/** The chunker preserves intra-paragraph newlines; ground truth is matched flat. */
const flat = (text: string) => text.replace(/\s+/gu, ' ');

/** The documents a needle appears in, named by id so a failure says which. */
const containing = (corpus: readonly EvalDocument[], needle: string) =>
  corpus.filter((document) => flat(document.content).includes(flat(needle))).map((d) => d.id);

describe('the ground truth', () => {
  it('resolves each labelled answer to exactly one document, at every scale', () => {
    // Four is what the test suite runs; fifty is well past what the bench is
    // ever asked for. A shift-induced collision would land somewhere between.
    for (const copies of [0, 1, 4, 12, 50]) {
      const corpus = evalCorpus(copies);
      for (const query of ALL_ANSWERS) {
        for (const answer of query.answers) {
          expect(
            containing(corpus, answer),
            `"${answer}" at ${copies} copies — ground truth must be unique`,
          ).toHaveLength(1);
        }
      }
    }
  });

  it('names what every query probes', () => {
    // A metric that moves without a probe explaining why is a metric nobody
    // can act on; an empty probe is how that happens quietly.
    for (const query of ALL_ANSWERS) {
      expect(query.probes.trim().length, query.query).toBeGreaterThan(0);
      expect(query.answers.length, query.query).toBeGreaterThan(0);
    }
  });

  it('places every labelled answer in a real document, not only in the noise', () => {
    // Searching the five real documents alone: exactly one hit means the
    // answer is where the query claims it is. Zero would mean the label
    // survives only because a distractor happens to carry the phrase.
    for (const query of ALL_ANSWERS) {
      for (const answer of query.answers) {
        expect(
          containing(EVAL_DOCUMENTS, answer),
          `"${answer}" must live in exactly one of the five real documents`,
        ).toHaveLength(1);
      }
    }
  });
});

describe('the rephrased questions', () => {
  it('really do share no content word with the passage that answers them', () => {
    // The set only measures a semantic wall if it is actually semantic. A
    // question that leaks a distinctive word from its answer would be found
    // by the lexical arm, quietly turning a "0%" into evidence of nothing.
    const STOP = new Set([
      'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'est', 'en',
      'à', 'a', 'dans', 'sur', 'par', 'pour', 'avec', 'sans', 'au', 'aux', 'ce',
      'si', 'je', 'me', 'ma', 'mon', 'il', 'on', 'que', 'qui', 'ne', 'pas', 'y',
      'the', 'a', 'an', 'of', 'and', 'or', 'is', 'to', 'in', 'at', 'it', 'for',
    ]);
    const words = (text: string) =>
      new Set(
        text
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => word.length >= 3 && !STOP.has(word)),
      );

    for (const { query, answer } of SEMANTIC_QUERIES) {
      const shared = [...words(query)].filter((word) => words(answer).has(word));
      expect(shared, `"${query}" shares ${shared.join(', ')} with its answer`).toHaveLength(0);
    }
  });
});

describe('replicate', () => {
  it('varies the facts while preserving the register', () => {
    // Same shape — heading, sentence, unit — with another number, so the copy
    // adds retrieval pressure without adding a second plausible answer.
    expect(replicate([{ id: 's', title: 'T', content: '# H\n\nUn délai de 15 jours.' }], 1)).toEqual([
      { id: 's-0', title: 'T (dossier 100)', content: '# H\n\nUn délai de 16 jours.' },
    ]);
  });

  it('shifts by the copy index, so no two copies state the same fact', () => {
    const copies = replicate([{ id: 's', title: 'T', content: 'plafond de 200 euros' }], 3);
    expect(copies.map((document) => document.content)).toEqual([
      'plafond de 201 euros',
      'plafond de 202 euros',
      'plafond de 203 euros',
    ]);
    expect(new Set(copies.map((document) => document.id)).size).toBe(3);
  });

  it('is deterministic, because the test and the bench must agree', () => {
    // They build the corpus independently; a corpus that differed between
    // them would make every before/after comparison meaningless.
    expect(replicate(EVAL_DOCUMENTS, 2)).toEqual(replicate(EVAL_DOCUMENTS, 2));
  });

  it('produces nothing for zero copies', () => {
    expect(replicate(EVAL_DOCUMENTS, 0)).toEqual([]);
  });
});

describe('the corpus', () => {
  it('is the real documents plus the requested noise, with unique ids', () => {
    const corpus = evalCorpus(4);
    expect(corpus.slice(0, EVAL_DOCUMENTS.length)).toEqual(EVAL_DOCUMENTS);
    expect(new Set(corpus.map((document) => document.id)).size).toBe(corpus.length);
    // Eight seeds, four copies each, on top of the five real documents.
    expect(corpus).toHaveLength(EVAL_DOCUMENTS.length + 8 * 4);
  });

  it('defaults to a corpus large enough to be a filter', () => {
    // The first measurement returned 100% on seventeen chunks, which said
    // nothing about retrieval. The default exists so nobody repeats that.
    expect(evalCorpus().length).toBeGreaterThan(EVAL_DOCUMENTS.length * 5);
  });
});
