/**
 * A CSV read as a table rather than as a wall of text.
 *
 * The header is the whole point. A retrieved row reads
 * `| 2026-03 | 05/03/2026 | 950 |` and means nothing on its own; it means
 * something because the section heading carries the column names, and every
 * chunk is embedded and displayed with its heading. So the header row is
 * lifted out of the body and into the title, once, rather than repeated.
 *
 * The parser is written here rather than taken from a library because what a
 * CSV needs is exactly three rules — a separator, quotes, doubled quotes —
 * and a dependency for three rules is a dependency to keep upgraded.
 */

import { ExtractError } from './errors.js';
import { normaliseText, rowsToParagraphs, type ExtractedText, type ExtractInput } from './types.js';

export const CSV_EXTRACTOR = 'csv@1';

const SEPARATORS = [';', ',', '\t'] as const;

/**
 * Which separator this file uses.
 *
 * Counted on the first non-empty line, outside quotes: a French spreadsheet
 * writes semicolons, an English one commas, and a file whose *data* contains
 * commas inside quoted cells must not be read as comma-separated on that
 * evidence.
 */
function detectSeparator(firstLine: string): string {
  let best = SEPARATORS[0] as string;
  let bestCount = -1;
  for (const candidate of SEPARATORS) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < firstLine.length; index += 1) {
      const char = firstLine[index];
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Rows of cells, quotes resolved, newlines inside quoted cells preserved. */
export function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        // A doubled quote is one literal quote; a lone one closes the cell.
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function extractCsv(input: ExtractInput): ExtractedText {
  // The BOM a spreadsheet writes would otherwise glue itself to the first
  // column's name, where it is invisible and breaks every comparison.
  const text = normaliseText(input.data.toString('utf8').replace(/^﻿/, ''));
  if (text === '') throw new ExtractError('no-text', 'This file has no rows.');

  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const rows = parseCsv(text, detectSeparator(firstLine)).filter((cells) =>
    cells.some((cell) => cell.trim() !== ''),
  );
  if (rows.length === 0) throw new ExtractError('no-text', 'This file has no rows.');

  const name = input.name.replace(/\.[^.]+$/, '');
  const [header, ...body] = rows;
  const heading = `## ${[name, header!.map((cell) => cell.trim()).join(' | ')]
    .filter(Boolean)
    .join(' — ')}`;

  return {
    text: [heading, rowsToParagraphs(body)].filter(Boolean).join('\n\n'),
    pageBreaks: [],
    // A CSV is one sheet: the unit a spreadsheet's reader expects.
    pageUnit: 'sheet',
    extractor: CSV_EXTRACTOR,
  };
}
