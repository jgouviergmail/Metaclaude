/**
 * Query-parameter coercion.
 *
 * The point of these helpers is that `Number(untrusted)` produces values which
 * silently disable the bounds meant to contain them, so the tests care most
 * about what happens with input that is *not* a number.
 */

import { describe, expect, it } from 'vitest';
import { queryInt, queryIntOr, queryTimestamp, spreadInt, spreadTimestamp } from './query.js';

const BOUNDS = { min: 1, max: 100 };

describe('queryInt', () => {
  it('parses a plain integer', () => {
    expect(queryInt('42', BOUNDS)).toBe(42);
    expect(queryInt(' 42 ', BOUNDS)).toBe(42);
  });

  it('clamps to the bounds', () => {
    expect(queryInt('0', BOUNDS)).toBe(1);
    expect(queryInt('1000', BOUNDS)).toBe(100);
    expect(queryInt('-5', BOUNDS)).toBe(1);
  });

  it('rejects anything that is not a plain integer', () => {
    for (const raw of [
      'abc',
      '',
      '   ',
      '1.5',
      '1e9',
      '0x10',
      '+7',
      'Infinity',
      'NaN',
      '12abc',
      '9'.repeat(30),
    ]) {
      expect(queryInt(raw, BOUNDS), raw).toBeUndefined();
    }
  });

  it('rejects non-string input', () => {
    // Fastify hands back arrays for a repeated parameter, and objects for
    // bracketed ones; neither may be coerced.
    expect(queryInt(undefined, BOUNDS)).toBeUndefined();
    expect(queryInt(null, BOUNDS)).toBeUndefined();
    expect(queryInt(42, BOUNDS)).toBeUndefined();
    expect(queryInt(['1', '2'], BOUNDS)).toBeUndefined();
    expect(queryInt({ toString: () => '5' }, BOUNDS)).toBeUndefined();
  });

  it('never returns NaN, which is what defeats a downstream cap', () => {
    for (const raw of ['abc', '', 'NaN', 'null', '[]']) {
      const value = queryInt(raw, BOUNDS);
      expect(value === undefined || Number.isSafeInteger(value)).toBe(true);
    }
  });
});

describe('queryIntOr', () => {
  it('falls back when the value is unusable', () => {
    expect(queryIntOr('abc', BOUNDS, 30)).toBe(30);
    expect(queryIntOr(undefined, BOUNDS, 30)).toBe(30);
    expect(queryIntOr('7', BOUNDS, 30)).toBe(7);
  });

  it('returns the fallback verbatim, even outside the bounds', () => {
    // The default is the code's own choice, not user input.
    expect(queryIntOr('abc', { min: 1, max: 10 }, 999)).toBe(999);
  });
});

describe('spreadInt', () => {
  it('produces a spreadable object only when the value is usable', () => {
    expect(spreadInt('limit', '25', BOUNDS)).toEqual({ limit: 25 });
    expect(spreadInt('limit', 'abc', BOUNDS)).toEqual({});
    expect(spreadInt('limit', undefined, BOUNDS)).toEqual({});
  });

  it('leaves the service default in place when the value is rejected', () => {
    const options = { limit: 50, ...spreadInt('limit', 'abc', BOUNDS) };
    expect(options.limit).toBe(50);

    const overridden = { limit: 50, ...spreadInt('limit', '5', BOUNDS) };
    expect(overridden.limit).toBe(5);
  });
});

describe('queryTimestamp', () => {
  it('accepts a plausible epoch millisecond value', () => {
    const now = 1_760_000_000_000;
    expect(queryTimestamp(String(now))).toBe(now);
    expect(queryTimestamp('0')).toBe(0);
  });

  it('clamps a far-future cursor and floors a negative one', () => {
    expect(queryTimestamp('99999999999999')).toBe(4_102_444_800_000);
    expect(queryTimestamp('-1')).toBe(0);
  });

  it('rejects junk', () => {
    expect(queryTimestamp('yesterday')).toBeUndefined();
    expect(queryTimestamp('')).toBeUndefined();
    expect(spreadTimestamp('before', 'yesterday')).toEqual({});
    expect(spreadTimestamp('before', '1000')).toEqual({ before: 1000 });
  });
});
