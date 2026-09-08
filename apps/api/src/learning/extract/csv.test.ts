/**
 * A CSV read as a table rather than as a wall of text.
 *
 * The point is the header: a retrieved row says "| 2026-03 | 05/03/2026 | 950 |"
 * and means nothing without the column names, which travel with it because the
 * header becomes the section heading and every chunk is embedded with its
 * heading.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractCsv } from './csv.js';

const fixture = readFileSync(new URL('./fixtures/sample.csv', import.meta.url));
const read = (name: string, data: Buffer) => extractCsv({ name, mime: 'text/csv', data });

describe('extractCsv', () => {
  it('names the section after the file and its header row', () => {
    const { text } = read('loyers.csv', fixture);
    expect(text.split('\n')[0]).toBe('## loyers — Mois | Échéance | Loyer');
  });

  it('detects a semicolon separator, which is what a French spreadsheet writes', () => {
    const { text } = read('loyers.csv', fixture);
    expect(text).toContain('| 2026-01 | 05/01/2026 | 950 |');
  });

  it('detects a comma and a tab too', () => {
    expect(read('x.csv', Buffer.from('a,b\n1,2')).text).toContain('| 1 | 2 |');
    expect(read('x.csv', Buffer.from('a\tb\n1\t2')).text).toContain('| 1 | 2 |');
  });

  it('keeps a quoted separator inside its cell', () => {
    const { text } = read('loyers.csv', fixture);
    expect(text).toContain('Le syndic ; gère les parties communes');
  });

  it('understands a doubled quote as one quote', () => {
    expect(read('x.csv', Buffer.from('a\n"il dit ""oui"""')).text).toContain('il dit "oui"');
  });

  it('skips a blank line rather than emitting an empty row', () => {
    const { text } = read('loyers.csv', fixture);
    expect(text).not.toContain('|  |  |  |');
  });

  it('gives every row its own paragraph, so the chunker never cuts one in half', () => {
    const { text } = read('x.csv', Buffer.from('a,b\n1,2\n3,4'));
    expect(text.split('\n\n')).toEqual(['## x — a | b', '| 1 | 2 |', '| 3 | 4 |']);
  });

  it('reports itself as a sheet, with no page breaks', () => {
    const out = read('x.csv', Buffer.from('a,b\n1,2'));
    expect(out.pageUnit).toBe('sheet');
    expect(out.pageBreaks).toEqual([]);
    expect(out.extractor).toMatch(/^csv@/);
  });

  it('refuses a file that is a header row and nothing else', () => {
    // It used to answer the heading alone, and that reads fine from here: a
    // heading is text, the extraction succeeded, the case had a green test.
    // The next layer disagreed — the chunker emits nothing for a document
    // that is only a heading, so the store refused it with "A document needs
    // content", about an export whose header is right there on screen. The
    // refusal belongs where the reason is known.
    expect(() => read('x.csv', Buffer.from('a,b'))).toThrowError(
      expect.objectContaining({ code: 'no-text' }),
    );
    expect(() => read('x.csv', Buffer.from('a,b'))).toThrowError(/no rows|no data/i);
  });

  it('survives ragged rows: a short row is not padded, a long one is not cut', () => {
    const { text } = read('x.csv', Buffer.from('a,b,c\n1,2\n1,2,3,4'));
    expect(text).toContain('| 1 | 2 |');
    expect(text).toContain('| 1 | 2 | 3 | 4 |');
  });

  it('drops a UTF-8 byte order mark instead of gluing it to the first column', () => {
    expect(read('x.csv', Buffer.from('﻿a,b\n1,2')).text).toContain('## x — a | b');
  });

  it('handles CRLF, which is what a Windows spreadsheet writes', () => {
    expect(read('x.csv', Buffer.from('a,b\r\n1,2\r\n')).text).toBe('## x — a | b\n\n| 1 | 2 |');
  });
});
