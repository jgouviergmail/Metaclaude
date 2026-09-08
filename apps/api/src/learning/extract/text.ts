/**
 * The plain-text family: txt, md, json.
 *
 * Almost nothing to do, and the "almost" is JSON. A minified object is one
 * line of ten thousand characters — the chunker would slice it at word
 * boundaries into passages that begin and end mid-key, and no line number
 * would mean anything. Pretty-printing it gives the chunker paragraphs to
 * work with and the reader a line to open.
 */

import { normaliseText, type ExtractedText, type ExtractInput } from './types.js';

export const TEXT_EXTRACTOR = 'text@1';

/** Indent JSON so it has lines; leave anything that does not parse alone. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // A `.json` that is not JSON is still text somebody wants to search.
    return text;
  }
}

export function extractPlainText(input: ExtractInput): ExtractedText {
  // The BOM an editor writes is invisible and would sit inside the first word.
  const raw = input.data.toString('utf8').replace(/^﻿/, '');
  const text = input.mime === 'application/json' ? prettyJson(raw) : raw;
  return {
    text: normaliseText(text),
    pageBreaks: [],
    pageUnit: null,
    extractor: TEXT_EXTRACTOR,
  };
}
