/**
 * The three helpers every extractor shares.
 *
 * `joinPages` is the one that carries weight: every page citation in the
 * product is an offset it produced, so a break landing one character off is a
 * quotation attributed to the wrong page, silently, for ever.
 */

import { describe, expect, it } from 'vitest';

import { joinPages, normaliseText, rowsToParagraphs } from './types.js';

describe('normaliseText', () => {
  it('makes line endings LF, so a line number means one thing', () => {
    expect(normaliseText('Un.\r\nDeux.\rTrois.')).toBe('Un.\nDeux.\nTrois.');
  });

  it('never leaves three newlines in a row', () => {
    // The chunker splits paragraphs on `\n{2,}`; more than that would give it
    // an empty paragraph to pack.
    expect(normaliseText('Un.\n\n\n\n\nDeux.')).toBe('Un.\n\nDeux.');
  });

  it('drops trailing spaces before a newline, and trims the ends', () => {
    expect(normaliseText('  Un.   \n  Deux.  ')).toBe('Un.\n  Deux.');
  });

  it('is idempotent, which the extraction dispatch relies on', () => {
    const messy = '  Un.\r\n\r\n\r\n  Deux.  \n';
    expect(normaliseText(normaliseText(messy))).toBe(normaliseText(messy));
  });

  it('answers empty for whitespace, so a blank file is refused rather than stored', () => {
    expect(normaliseText('   \n\n\t  ')).toBe('');
  });
});

describe('rowsToParagraphs', () => {
  it('gives every row its own paragraph', () => {
    expect(rowsToParagraphs([['a', 'b'], ['c', 'd']])).toBe('| a | b |\n\n| c | d |');
  });

  it('drops a row with nothing in it', () => {
    expect(rowsToParagraphs([['a'], ['', '  '], ['b']])).toBe('| a |\n\n| b |');
  });

  it('flattens a cell that spans lines, so the row stays one line', () => {
    expect(rowsToParagraphs([['un\ndeux', 'trois']])).toBe('| un deux | trois |');
  });

  it('replaces a literal pipe, so the shape of the row survives', () => {
    expect(rowsToParagraphs([['a|b', 'c']])).toBe('| a¦b | c |');
  });

  it('answers empty for no rows at all', () => {
    expect(rowsToParagraphs([])).toBe('');
    expect(rowsToParagraphs([[''], ['  ']])).toBe('');
  });
});

describe('joinPages', () => {
  it('reports one break per page after the first, on the first character of it', () => {
    const { text, pageBreaks } = joinPages(['Page une.', 'Page deux.', 'Page trois.']);
    expect(pageBreaks).toHaveLength(2);
    for (const at of pageBreaks) expect(text.slice(at, at + 4)).toBe('Page');
    expect(text.slice(pageBreaks[0]!)).toBe('Page deux.\n\nPage trois.');
  });

  it('separates pages with exactly one blank line', () => {
    expect(joinPages(['A', 'B']).text).toBe('A\n\nB');
  });

  it('normalises each page, and does not re-normalise the join', () => {
    // A second pass over the joined text would move every break. Note what
    // `normaliseText` does *not* do: it trims the ends and strips spaces
    // before a newline, and leaves an indent inside the page alone.
    const { text, pageBreaks } = joinPages(['  A  \r\n\r\n\r\n  B  ', 'C']);
    expect(text).toBe('A\n\n  B\n\nC');
    expect(text.slice(pageBreaks[0]!)).toBe('C');
  });

  it('counts an empty page in the numbering without giving it width', () => {
    // Page 7 of a PDF is page 7 whether or not page 6 was blank, and a
    // citation that renumbered around empty pages would send a reader to the
    // wrong one. So there are still two breaks for three pages, and the
    // blank one contributes no text.
    const { text, pageBreaks } = joinPages(['A', '', 'C']);
    expect(text).toBe('A\n\nC');
    expect(pageBreaks).toHaveLength(2);
    expect(text.slice(pageBreaks[1]!)).toBe('C');
    // Page 2 begins where page 1 ended and occupies nothing: no passage can
    // be attributed to it, which is right, because it carries nothing.
    expect(pageBreaks[0]).toBe(1);
    expect(text.slice(pageBreaks[0]!, pageBreaks[1]!).trim()).toBe('');
  });

  it('handles a document whose every page is empty', () => {
    const { text, pageBreaks } = joinPages(['', '', '']);
    expect(text).toBe('');
    expect(pageBreaks).toEqual([0, 0]);
  });

  it('handles one page, which has no breaks at all', () => {
    expect(joinPages(['Seule.'])).toEqual({ text: 'Seule.', pageBreaks: [] });
  });

  it('never reports a break outside the text', () => {
    const { text, pageBreaks } = joinPages(['A', 'B', '', 'D']);
    for (const at of pageBreaks) expect(at).toBeLessThanOrEqual(text.length);
    expect([...pageBreaks]).toEqual([...pageBreaks].sort((a, b) => a - b));
  });
});
