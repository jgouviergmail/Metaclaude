/**
 * Identifiers.
 *
 * `packages/shared` had no tests at all, which for the module every other
 * package builds its primary keys out of was the wrong place to have none.
 *
 * Two properties here are load-bearing well beyond "it returns a string". Ids
 * are time-sortable, and the audit log, the transcript and every `ORDER BY id`
 * in the schema depend on that ordering matching chronology — with no separate
 * index to fall back on if it does not. And `isId` is used as a validator, so
 * what it *rejects* matters more than what it accepts.
 */

import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, idTimestamp, isId, newId, type IdKind } from './ids.js';

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];

describe('newId', () => {
  it('prefixes by kind', () => {
    expect(newId('run')).toMatch(/^run_/);
    expect(newId('workspace')).toMatch(/^ws_/);
    expect(newId('plugin')).toMatch(/^plg_/);
  });

  it('produces a body of exactly 22 characters for every kind', () => {
    // 10 of time + 12 of randomness. `isId` hard-codes that length, so a kind
    // whose id came out a different size would be rejected by the validator
    // that is supposed to accept it.
    for (const kind of KINDS) {
      const id = newId(kind);
      expect(id.slice(id.indexOf('_') + 1)).toHaveLength(22);
    }
  });

  it('uses only the Crockford alphabet, so an id is never ambiguous to read', () => {
    // No I, L, O or U — an id read off a screen and typed back must not depend
    // on telling 1 from l.
    for (const kind of KINDS) {
      const body = newId(kind).split('_')[1] as string;
      expect(body).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{22}$/);
    }
  });

  it('is URL-safe and shell-safe', () => {
    // Ids end up in paths, in URLs and in audit lines. A character needing
    // escaping in any of those is a bug waiting for the one id that has it.
    for (const kind of KINDS) {
      expect(newId(kind)).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it('does not collide across a large batch', () => {
    // 12 random base32 characters is 60 bits; a collision inside one
    // millisecond would still be a genuine defect in the generator.
    const ids = new Set(Array.from({ length: 20_000 }, () => newId('event', 1_700_000_000_000)));
    expect(ids.size).toBe(20_000);
  });

  it('sorts lexicographically in the order the ids were created', () => {
    // The property the whole scheme exists for. `ORDER BY id` is used instead
    // of a timestamp index, so a later id sorting before an earlier one
    // reorders a transcript.
    const times = [0, 1, 1_000, 1_700_000_000_000, 1_700_000_000_001, 4_000_000_000_000];
    const ids = times.map((t) => newId('event', t));

    expect([...ids].sort()).toEqual(ids);
  });

  it('keeps sorting correctly across a base32 digit rollover', () => {
    // The carry in encodeTime is where an off-by-one would hide: 31 -> 32 is
    // the first place the second-from-last character has to move.
    const before = newId('event', 31);
    const after = newId('event', 32);

    expect(before < after).toBe(true);
  });

  it('treats a negative clock as zero rather than producing NaN', () => {
    // A machine whose clock is before the epoch is absurd, but the arithmetic
    // must not emit `undefined` characters if it happens.
    expect(newId('event', -1)).toMatch(/^ev_0{10}[0-9A-Z]{12}$/);
  });
});

describe('isId', () => {
  it('accepts what newId produces, for every kind', () => {
    for (const kind of KINDS) {
      expect(isId(kind, newId(kind))).toBe(true);
    }
  });

  it('rejects an id of the wrong kind', () => {
    // The point of validating: a run id arriving where a workspace id belongs
    // is exactly the confusion that turns into an IDOR.
    expect(isId('workspace', newId('run'))).toBe(false);
  });

  it('requires the separator, not merely the prefix letters', () => {
    // Constructed so that ONLY the underscore decides it. `wsX` + 22 valid
    // characters is 25 long, so slicing three still leaves a body of exactly
    // the right length made of legal characters: every other check passes and
    // the separator is the one thing left to reject it.
    //
    // The obvious version of this test — take a real id and rewrite `ws_` as
    // `wsx_` — proves nothing, because the extra character makes the body 23
    // long and the *length* check rejects it whether or not the separator is
    // compared. It passed against a deliberately broken `isId`.
    const candidate = `wsX${'A'.repeat(22)}`;

    expect(candidate).toHaveLength(25);
    expect(isId('workspace', candidate)).toBe(false);
  });

  it('rejects a body of the wrong length', () => {
    const id = newId('run');
    expect(isId('run', `${id}A`)).toBe(false);
    expect(isId('run', id.slice(0, -1))).toBe(false);
  });

  it('rejects characters outside the alphabet, including lookalikes', () => {
    const body = 'A'.repeat(21);
    for (const ch of ['I', 'L', 'O', 'U', 'a', '-', '/', '.', ' ', "'"]) {
      expect(isId('run', `run_${body}${ch}`)).toBe(false);
    }
  });

  it('rejects anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isId('run', value)).toBe(false);
    }
  });

  it('rejects an empty body and a bare prefix', () => {
    expect(isId('run', 'run_')).toBe(false);
    expect(isId('run', 'run')).toBe(false);
    expect(isId('run', '')).toBe(false);
  });
});

describe('idTimestamp', () => {
  it('recovers the time an id encodes', () => {
    const now = 1_700_000_000_000;
    expect(idTimestamp(newId('run', now))).toBe(now);
  });

  it('round-trips every kind', () => {
    const now = 1_699_999_999_999;
    for (const kind of KINDS) {
      expect(idTimestamp(newId(kind, now))).toBe(now);
    }
  });

  it('returns null rather than a wrong number for a malformed id', () => {
    // A caller comparing this against a window would silently include or
    // exclude the wrong rows if garbage decoded to a plausible number.
    expect(idTimestamp('run_!!!!!!!!!!AAAAAAAAAAAA')).toBeNull();
    expect(idTimestamp('run_short')).toBeNull();
    expect(idTimestamp('')).toBeNull();
  });

  it('does not accept lowercase, which encodes to a different number', () => {
    const id = newId('run', 1_700_000_000_000);
    expect(idTimestamp(id.toLowerCase())).toBeNull();
  });
});
