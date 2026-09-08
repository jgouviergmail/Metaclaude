/**
 * Word documents, through HTML.
 *
 * mammoth offers `convertToMarkdown`, and it is the wrong door: it flattens a
 * table into one cell per line — which reads as prose and retrieves as
 * nonsense — and escapes every full stop as `\.`, which reaches the index as a
 * word nobody will ever search for. Its HTML output keeps the structure, and
 * `html.ts` is already the converter this library needs, so the two compose.
 *
 * Measured: a Word heading survives whether its style is `Heading1` (what
 * LibreOffice and this repo's fixture generator write) or `Titre1` with the
 * canonical name `Heading 1` (what a French Word writes), and even with no
 * `styles.xml` at all, where mammoth falls back to the paragraph's style id.
 */

import mammoth from 'mammoth';

import { ExtractError } from './errors.js';
import { htmlToMarkdown } from './html.js';
import type { ExtractedText, ExtractInput } from './types.js';

export const DOCX_EXTRACTOR = 'docx@1';

export async function extractDocx(input: ExtractInput): Promise<ExtractedText> {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: input.data }));
  } catch (error) {
    throw new ExtractError(
      'corrupt',
      `This .docx could not be read (${(error as Error).message}).`,
    );
  }

  const text = htmlToMarkdown(html);
  if (text === '') {
    throw new ExtractError('no-text', 'This .docx has no text in it.');
  }

  // A .docx paginates at display time — the page a paragraph lands on depends
  // on the reader's font and paper size — so there is no page to cite, and
  // claiming one would be inventing it.
  return { text, pageBreaks: [], pageUnit: null, extractor: DOCX_EXTRACTOR };
}
