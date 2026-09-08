/**
 * Spreadsheets, one section per sheet.
 *
 * A row retrieved on its own — `| 2026-03 | 05/03/2026 | 950 |` — says
 * nothing. What makes it mean something is the header, and the header travels
 * with every passage because it is part of the section heading, which
 * `chunkEmbeddingText` prepends to each chunk. So the first non-empty row is
 * lifted into the heading rather than left in the body.
 *
 * The cell conversions are all the same decision: store what the person
 * looking at the sheet sees. A date is a serial number underneath and nobody
 * searches for 46037; a formula has a cached result and nobody searches for
 * `C2+D2`.
 */

import ExcelJS from 'exceljs';
import type { KnowledgePageUnit } from '@metaclaude/shared';

import { ExtractError } from './errors.js';
import { joinPages, rowsToParagraphs, type ExtractedText, type ExtractInput } from './types.js';

export const XLSX_EXTRACTOR = 'xlsx@1';
const SHEET: KnowledgePageUnit = 'sheet';

/**
 * The bytes as their own ArrayBuffer.
 *
 * exceljs declares `load(buffer: Buffer)` against a `Buffer` type that
 * `@types/node` 22 no longer considers assignable from `Buffer<ArrayBuffer>`.
 * Handing it the underlying bytes is both accepted and honest — and `slice`
 * rather than `.buffer` because a Buffer is frequently a window into a larger
 * pooled allocation.
 */
const bytesOf = (data: Buffer): ArrayBuffer =>
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

/**
 * What a person reading the sheet sees in this cell.
 *
 * Narrowed through the union exceljs declares rather than cast: each branch
 * is a shape the library documents, and a member added by a future version
 * fails to compile here instead of stringifying as `[object Object]`.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);

  // A formula: the cached result is what the sheet displays.
  if ('result' in value) return cellText(value.result ?? '');
  if ('richText' in value) return value.richText.map((run) => run.text).join('');
  if ('error' in value) return String(value.error);
  // A hyperlink shows its text, not its address.
  if ('text' in value) return String(value.text);
  return '';
}

export async function extractXlsx(input: ExtractInput): Promise<ExtractedText> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytesOf(input.data));
  } catch (error) {
    throw new ExtractError(
      'corrupt',
      `This spreadsheet could not be read (${(error as Error).message}).`,
    );
  }

  const sections: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell.value)));
      rows.push(cells);
    });

    const filled = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
    if (filled.length === 0) return;

    const [header, ...body] = filled;
    const heading = `## ${[sheet.name.trim(), header!.map((cell) => cell.trim()).join(' | ')]
      .filter(Boolean)
      .join(' — ')}`;
    sections.push([heading, rowsToParagraphs(body)].filter(Boolean).join('\n\n'));
  });

  if (sections.length === 0) {
    throw new ExtractError('no-text', 'This spreadsheet has no rows in it.');
  }

  // One page per sheet, so a retrieved row can be cited as "sheet 2".
  return { ...joinPages(sections), pageUnit: SHEET, extractor: XLSX_EXTRACTOR };
}
