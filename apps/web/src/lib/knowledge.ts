/**
 * What the knowledge screen needs that is not a component.
 *
 * Three small things, each in one place because each was about to be spelled
 * twice: how a location reads in French, how a title search matches, and what
 * a format is called.
 */

import {
  describeLocation,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_MIME_TYPES,
  type KnowledgeLocation,
  type KnowledgeSource,
  type LocationWords,
} from '@metaclaude/shared';

/** What the file picker offers: the types, and the extensions a browser may not type. */
export const KNOWLEDGE_ACCEPT = [
  ...KNOWLEDGE_MIME_TYPES,
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.html',
  '.htm',
  '.json',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
].join(',');

export const KNOWLEDGE_MAX_BYTES = KNOWLEDGE_LIMITS.maxBytes;

/**
 * The words a locator is built from, in the operator's language.
 *
 * Abbreviated on purpose: a card shows the locator beside a title and a score,
 * and « lignes 40–52 » in full crowds a phone. The prompt keeps the long form,
 * where nothing is competing for the space.
 */
export function locationWords(t: (key: string) => string): LocationWords {
  return {
    page: t('p.'),
    pages: t('p.'),
    slide: t('diapo.'),
    slides: t('diapo.'),
    sheet: t('feuille'),
    sheets: t('feuilles'),
    line: t('l.'),
    lines: t('l.'),
  };
}

/** `p. 2 · l. 40–52`, or nothing at all when the passage has no location. */
export function formatLocation(
  location: KnowledgeLocation,
  t: (key: string) => string,
): string {
  return describeLocation(location, locationWords(t)).replace(/, /g, ' · ');
}

/**
 * What a format is called on a badge.
 *
 * An exhaustive `Record` over the accepted types, so a type added to the
 * contract fails the build here rather than showing an empty badge.
 */
const FORMAT_LABEL: Record<(typeof KNOWLEDGE_MIME_TYPES)[number], string> = {
  'text/plain': 'TXT',
  'text/markdown': 'MD',
  'text/csv': 'CSV',
  'text/html': 'HTML',
  'application/json': 'JSON',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
};

/** The badge for a document's format; null for text that was pasted. */
export function formatLabel(source: KnowledgeSource | null): string | null {
  if (!source) return null;
  return FORMAT_LABEL[source.mime as (typeof KNOWLEDGE_MIME_TYPES)[number]] ?? 'FILE';
}

/**
 * Fold a string for searching: case and accents removed.
 *
 * A French library is full of accents, and an operator typing on a phone
 * keyboard does not reach for them. `résiliation` has to be found by typing
 * `resiliation`, or the search box is a search box that punishes you.
 */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Does this document match what was typed — in its title, or in its file's name? */
export function matchesTitle(
  document: { title: string; source: KnowledgeSource | null },
  query: string,
): boolean {
  const needle = fold(query.trim());
  if (needle === '') return true;
  return (
    fold(document.title).includes(needle) ||
    fold(document.source?.name ?? '').includes(needle)
  );
}
