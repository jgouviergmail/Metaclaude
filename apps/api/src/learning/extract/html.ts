/**
 * HTML into the Markdown the chunker sections on.
 *
 * Two callers: a `.html` an operator drops, and every `.docx`, which mammoth
 * converts to HTML on the way in. So this is not a courtesy converter — it is
 * where a Word document's Heading 2 becomes a `##`, and therefore where a
 * passage of it gets a section to be cited under.
 *
 * Regexes rather than a parser, deliberately. What is needed is a *lossy*
 * conversion of six tag families, over input that is frequently not
 * well-formed; a DOM parser would add a dependency, a failure mode on
 * malformed markup, and no accuracy where it matters. The order below is the
 * whole design: tables first, because their cells may contain anything else;
 * then block structure; then inline marks; then whatever tags are left.
 */

import { normaliseText, rowsToParagraphs } from './types.js';

/**
 * The named entities a real page actually uses.
 *
 * A closed list rather than a full table: everything else arrives as a
 * numeric reference, which is handled generically below, and an entity nobody
 * writes is an entity not worth carrying.
 */
const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  ugrave: 'ù',
  ucirc: 'û',
  icirc: 'î',
  ocirc: 'ô',
  euro: '€',
  copy: '©',
  deg: '°',
  middot: '·',
  times: '×',
  amp: '&',
};

/**
 * Decode character references.
 *
 * `&amp;` is decoded **last**, and that is not a detail: decoding it first
 * turns `&amp;lt;` — which is how a page writes a literal `&lt;` — into `<`.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      const decoded = ENTITIES[name.toLowerCase()];
      return decoded !== undefined && name.toLowerCase() !== 'amp' ? decoded : whole;
    })
    .replace(/&amp;/g, '&');
}

/** Everything inside a cell, flattened to one line. */
const cellText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function htmlToMarkdown(html: string): string {
  let text = html
    // Comments first: a commented-out `<script>` must not survive as prose.
    .replace(/<!--[\s\S]*?-->/g, '')
    // A page's furniture, and everything that is not content at all.
    .replace(
      /<(script|style|noscript|svg|head|nav|footer|template|iframe|object)\b[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<(script|style)\b[^>]*\/>/gi, '')
    // The same two, never closed — a truncated save, or a page cut short by
    // whatever fetched it. They are HTML's raw-text elements: their content
    // runs to the closing tag, so with none the rest of the input *is* the
    // script, which is why stripping to the end is what a parser does rather
    // than a guess. Without this the JavaScript was indexed as prose and could
    // be quoted back as a passage. Only these two: an ordinary unclosed block
    // auto-closes in a real parser, and eating the page would be worse than
    // the stray `Accueil` it leaves behind.
    .replace(/<(?:script|style)\b[\s\S]*$/i, '');

  // Tables before anything else: a cell may hold paragraphs, lists, emphasis,
  // and flattening it here is what keeps a row on one line.
  text = text.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cellText(cell[1]!)),
    );
    const rendered = rowsToParagraphs(rows);
    return rendered ? `\n\n${rendered}\n\n` : '\n\n';
  });

  text = text
    // Headings become the sections passages are cited under.
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${cellText(body)}\n\n`,
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, body: string) => `\n- ${cellText(body)}`)
    .replace(/<\/(?:ul|ol)>/gi, '\n\n')
    .replace(/<(?:ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Both ends of a block: an unclosed `<p>` is the common case in the wild,
    // and closing tags alone would run three paragraphs together.
    .replace(
      /<\/?(?:p|div|section|article|blockquote|pre|dd|dt|figcaption|header|main|aside|tr)\b[^>]*>/gi,
      '\n\n',
    )
    .replace(
      /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_, __, body: string) => (cellText(body) ? `**${cellText(body)}**` : ''),
    )
    .replace(
      /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_, __, body: string) => (cellText(body) ? `*${cellText(body)}*` : ''),
    )
    // A link keeps its text, and its address only when following it means
    // something to a reader: an http(s) URL, never a javascript: one.
    .replace(
      /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, body: string) => {
        const label = cellText(body);
        return /^https?:\/\//i.test(href.trim()) ? `${label} (${href.trim()})` : label;
      },
    )
    // Whatever is left, including tags this file has no opinion about.
    .replace(/<[^>]*>/g, '');

  return normaliseText(
    decodeEntities(text)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n'),
  );
}
