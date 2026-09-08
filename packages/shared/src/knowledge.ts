/**
 * Where a retrieved passage comes from, said once.
 *
 * Four consumers show the same fact — the block injected into a run, the
 * genesis strip, the retrieval rehearsal and the MCP `search_notes` tool —
 * and a locator spelled four times is a locator that drifts. The words are a
 * parameter rather than a constant because the prompt is written in English
 * while the screen speaks the operator's language; the *shape* of the
 * sentence is the same in both, and that shape is what this file owns.
 *
 * A location is deliberately permissive about what is missing. Passages
 * indexed before the library learned to record offsets carry no lines at all,
 * and a format with no pages carries no page: both must degrade to a shorter
 * sentence, never to a wrong one.
 */

import type { KnowledgePageUnit } from './domain.js';

/** Where one passage sits in its document. Every field may be absent. */
export interface KnowledgeLocation {
  /** Null when the document has no pages — pasted text, a docx, a web page. */
  pageUnit: KnowledgePageUnit | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** 1-based, into the document's stored text. */
  lineStart: number | null;
  lineEnd: number | null;
}

/** The eight words a locator is built from, singular and plural. */
export interface LocationWords {
  page: string;
  pages: string;
  slide: string;
  slides: string;
  sheet: string;
  sheets: string;
  line: string;
  lines: string;
}

/** What the prompt says. The screen passes its own translations instead. */
export const LOCATION_WORDS_EN: LocationWords = {
  page: 'page',
  pages: 'pages',
  slide: 'slide',
  slides: 'slides',
  sheet: 'sheet',
  sheets: 'sheets',
  line: 'line',
  lines: 'lines',
};

/**
 * Which pair of words each unit uses.
 *
 * An exhaustive `Record`, not a ternary chain: a fourth `KnowledgePageUnit`
 * would fail the build here, where a chain would quietly call it a "page" and
 * send a reader looking for something that does not exist.
 */
const UNIT_WORDS: Record<KnowledgePageUnit, (words: LocationWords) => [string, string]> = {
  page: (words) => [words.page, words.pages],
  slide: (words) => [words.slide, words.slides],
  sheet: (words) => [words.sheet, words.sheets],
};

/** `2` or `2–3`; an en dash, because this is prose and not a code range. */
const range = (start: number, end: number): string =>
  start === end ? String(start) : `${start}–${end}`;

/** `page 2` / `pages 2–3`, from a start, an end and a pair of words. */
const span = (start: number, end: number | null, [one, many]: [string, string]): string => {
  const last = end ?? start;
  return `${start === last ? one : many} ${range(start, last)}`;
};

/**
 * "page 2, lines 40–52", or as much of it as the passage actually knows.
 *
 * A page number with no unit is dropped rather than guessed: the unit is what
 * makes the number meaningful, and a document that has no pages can still
 * carry a stale page column from a re-extraction that changed format.
 */
export function describeLocation(
  location: KnowledgeLocation,
  words: LocationWords = LOCATION_WORDS_EN,
): string {
  const parts: string[] = [];

  if (location.pageUnit !== null && location.pageStart !== null) {
    parts.push(span(location.pageStart, location.pageEnd, UNIT_WORDS[location.pageUnit](words)));
  }

  if (location.lineStart !== null) {
    parts.push(span(location.lineStart, location.lineEnd, [words.line, words.lines]));
  }

  return parts.join(', ');
}
