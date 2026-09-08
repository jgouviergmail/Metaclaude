/**
 * What every extractor hands over, and the three helpers they share.
 *
 * The shape is deliberately small: text, where its pages begin, what a page
 * is called here, and which engine produced it. Everything downstream — the
 * chunker, the line counter, the citation — works off `text` and `pageBreaks`
 * alone, so an extractor has one job and no opinions about retrieval.
 */

import type { KnowledgePageUnit } from '@metaclaude/shared';

export interface ExtractedText {
  /** In normal form: LF, trimmed, never three newlines in a row. */
  text: string;
  /**
   * Offsets into `text` where each page after the first begins. Empty for a
   * format with no pages, and for a one-page one — `pageBreaks.length` is
   * always the page count minus one.
   */
  pageBreaks: number[];
  pageUnit: KnowledgePageUnit | null;
  /** `pdf@poppler-22.12.0`, `docx@1` — what read the file, so a better engine can be re-applied. */
  extractor: string;
}

export interface ExtractInput {
  name: string;
  mime: string;
  data: Buffer;
}

/**
 * The normal form every extractor hands over, and the store insists on.
 *
 * Two rules, both load-bearing. LF only, because a line number has to mean
 * the same thing here and in the stored text. And at most one blank line in a
 * row, because the chunker splits paragraphs on `\n{2,}` and an extractor
 * that emits five newlines would otherwise produce a chunk of nothing.
 */
export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Table rows as pipe lines, each its own paragraph.
 *
 * One paragraph per row is what stops the chunker cutting a row in half —
 * half a row is a passage that states something untrue. Empty rows are
 * dropped, and a literal pipe inside a cell becomes a broken bar so the shape
 * of the row survives.
 */
export function rowsToParagraphs(rows: readonly (readonly string[])[]): string {
  return rows
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map(
      (cells) =>
        `| ${cells
          .map((cell) => cell.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '¦').trim())
          .join(' | ')} |`,
    )
    .join('\n\n');
}

/**
 * Join page texts into one document and say where each page starts.
 *
 * The separator is exactly one blank line, and nothing is re-normalised
 * afterwards: each page already is in normal form, and a second pass would
 * shift every offset this function exists to report.
 *
 * An empty page contributes no text and no width, so the break for the page
 * after it lands on the same offset — the page *numbering* still counts it,
 * which is what a citation needs, since page 7 of a PDF is page 7 whether or
 * not page 6 was blank.
 */
export function joinPages(pages: readonly string[]): { text: string; pageBreaks: number[] } {
  const pageBreaks: number[] = [];
  let text = '';
  pages.forEach((page, index) => {
    const cleaned = normaliseText(page);
    if (index > 0) {
      if (text !== '' && cleaned !== '') text += '\n\n';
      pageBreaks.push(text.length);
    }
    text += cleaned;
  });
  return { text, pageBreaks };
}
