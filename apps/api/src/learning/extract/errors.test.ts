/**
 * Why a refusal carries a status code.
 *
 * The route has no better way to choose one: only the extractor knows whether
 * a file was the wrong type, too big, or simply a scan. Getting these wrong
 * is not cosmetic — a 500 tells an operator the server is broken about a file
 * that is merely a photograph of a page.
 */

import { describe, expect, it } from 'vitest';

import { ExtractError, type ExtractErrorCode } from './errors.js';

const CASES: Array<[ExtractErrorCode, number]> = [
  ['unsupported', 415],
  ['empty', 400],
  ['corrupt', 400],
  ['encrypted', 422],
  ['no-text', 422],
  ['too-large', 413],
  ['timeout', 422],
];

describe('ExtractError', () => {
  it.each(CASES)('%s answers %i', (code, status) => {
    expect(new ExtractError(code, 'x').statusCode).toBe(status);
  });

  it('never answers 500: every one of these is about the file, not the server', () => {
    for (const [code] of CASES) {
      expect(new ExtractError(code, 'x').statusCode, code).toBeLessThan(500);
    }
  });

  it('keeps the message it was given, which is the half an operator reads', () => {
    const error = new ExtractError('no-text', 'This PDF is a scan.');
    expect(error.message).toBe('This PDF is a scan.');
    expect(error.name).toBe('ExtractError');
    expect(error).toBeInstanceOf(Error);
  });

  it('carries its code, which is what the worker sends across a thread', () => {
    // A structured clone loses the prototype, so the code is the only thing
    // that survives the trip.
    expect(new ExtractError('encrypted', 'x').code).toBe('encrypted');
  });
});
