/**
 * Which extractor reads what, and the two bounds every one of them shares.
 *
 * The table below is the other half of `KNOWLEDGE_MIME_TYPES`: the contract
 * says what may be uploaded, this says what happens to it, and a test walks
 * the list to prove neither drifts from the other. A type accepted at the
 * edge and unroutable here would be a 500 dressed as a feature.
 */

import { KNOWLEDGE_MIME_TYPES } from '@metaclaude/shared';

import { MAX_DOCUMENT_BYTES } from '../knowledge.js';
import { extractCsv } from './csv.js';
import { extractDocx } from './docx.js';
import { ExtractError } from './errors.js';
import { htmlToMarkdown } from './html.js';
import { extractPdf } from './pdf.js';
import { extractPptx } from './pptx.js';
import { extractPlainText } from './text.js';
import { extractXlsx } from './xlsx.js';
import { normaliseText, type ExtractedText, type ExtractInput } from './types.js';

export { ExtractError } from './errors.js';
export type { ExtractedText, ExtractInput } from './types.js';
export { defaultPdfEngine, popplerAvailable, popplerVersion } from './pdf.js';

export const HTML_EXTRACTOR = 'html@1';

/**
 * The extension to fall back on when a browser sends no type — which several
 * of them do for a drag-dropped `.md`, measured in the attachments. Not a
 * loosening: an extension absent from here is still refused.
 */
const EXTENSION_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** What the file picker offers, and what a refusal names. */
export const KNOWLEDGE_EXTENSIONS = Object.keys(EXTENSION_MIME);

const ACCEPTED = new Set<string>(KNOWLEDGE_MIME_TYPES);

/** One entry per accepted MIME; `index.test.ts` walks the contract to check it. */
const EXTRACTORS: Record<string, (input: ExtractInput) => ExtractedText | Promise<ExtractedText>> = {
  'text/plain': extractPlainText,
  'text/markdown': extractPlainText,
  'application/json': extractPlainText,
  'text/csv': extractCsv,
  'text/html': (input) => ({
    text: htmlToMarkdown(input.data.toString('utf8').replace(/^﻿/, '')),
    pageBreaks: [],
    pageUnit: null,
    extractor: HTML_EXTRACTOR,
  }),
  'application/pdf': extractPdf,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractDocx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractXlsx,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': extractPptx,
};

/**
 * The type this file will be read as, or null when nothing reads it.
 *
 * The declared MIME wins when it is one this library knows; otherwise the
 * extension decides, against the same closed list. A browser that says
 * `application/octet-stream` about a `.pptx` is describing its own ignorance,
 * not the file.
 */
export function resolveKnowledgeMime(name: string, mime: string): string | null {
  if (ACCEPTED.has(mime)) return mime;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return extension === name.toLowerCase() ? null : (EXTENSION_MIME[extension] ?? null);
}

/** What a refusal offers instead: `.pdf, .docx, …`. */
const acceptedList = (): string => KNOWLEDGE_EXTENSIONS.map((one) => `.${one}`).join(', ');

/**
 * Read a file into the text a document is made of.
 *
 * The two bounds live here rather than in each extractor: they are properties
 * of the *library* — what a document may weigh — not of any one format, and
 * an extractor that had to remember them is an extractor that will forget.
 *
 * The size is measured in bytes on the extracted UTF-8, because that is what
 * the store enforces: half a megabyte of accented text is a megabyte of
 * UTF-8, and a check counting characters would accept a document the store
 * then refuses, with two different messages for one situation.
 */
export async function extractInProcess(input: ExtractInput): Promise<ExtractedText> {
  if (input.data.length === 0) throw new ExtractError('empty', 'The file is empty.');

  const mime = resolveKnowledgeMime(input.name, input.mime);
  if (!mime) {
    const said = input.mime || input.name.split('.').pop() || 'unknown';
    throw new ExtractError(
      'unsupported',
      `“${said}” is not a type the library reads. Accepted: ${acceptedList()}.`,
    );
  }

  const out = await EXTRACTORS[mime]!({ ...input, mime });

  // Normal form is the extractor's job; this is the check, not the fix.
  //
  // Re-normalising here would be silent corruption where it matters most: a
  // page break is an offset into this exact string, so a single character
  // removed above it shifts every citation of every page after it, with
  // nothing to see. `normaliseText` is idempotent, so this only fires on an
  // extractor that forgot to call it — which is a bug in that extractor and
  // is said so.
  const text = normaliseText(out.text);
  if (text !== out.text && out.pageBreaks.length > 0) {
    throw new ExtractError(
      'corrupt',
      `${out.extractor} produced a page map over text that is not in normal form.`,
    );
  }
  if (text === '') throw new ExtractError('no-text', 'No text came out of this file.');

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new ExtractError(
      'too-large',
      `The extracted text is ${Math.round(bytes / 1024)} KiB; a document is capped at ` +
        `${MAX_DOCUMENT_BYTES / 1024} KiB. Split the file, or keep the part the agent needs.`,
    );
  }

  return { ...out, text };
}
