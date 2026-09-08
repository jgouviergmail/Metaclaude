import { describe, expect, it } from 'vitest';

import { describeLocation, LOCATION_WORDS_EN } from './knowledge.js';

/**
 * The locator is shown in four places — the block injected into a run, the
 * genesis strip, the retrieval rehearsal and the MCP search tool — so what is
 * pinned here is the *sentence*, once, rather than four spellings of it.
 */
describe('describeLocation', () => {
  it('says nothing for a passage that has no location', () => {
    expect(
      describeLocation({
        pageUnit: null,
        pageStart: null,
        pageEnd: null,
        lineStart: null,
        lineEnd: null,
      }),
    ).toBe('');
  });

  it('names one page and a line range', () => {
    expect(
      describeLocation({
        pageUnit: 'page',
        pageStart: 2,
        pageEnd: 2,
        lineStart: 40,
        lineEnd: 52,
      }),
    ).toBe('page 2, lines 40–52');
  });

  it('names a page span, a single line, and the unit of a slide deck', () => {
    expect(
      describeLocation({
        pageUnit: 'slide',
        pageStart: 2,
        pageEnd: 3,
        lineStart: 7,
        lineEnd: 7,
      }),
    ).toBe('slides 2–3, line 7');
  });

  it('gives lines alone for a pasted document', () => {
    expect(
      describeLocation({
        pageUnit: null,
        pageStart: null,
        pageEnd: null,
        lineStart: 1,
        lineEnd: 9,
      }),
    ).toBe('lines 1–9');
  });

  it('gives the page alone when the lines were never recorded', () => {
    expect(
      describeLocation({
        pageUnit: 'sheet',
        pageStart: 3,
        pageEnd: 3,
        lineStart: null,
        lineEnd: null,
      }),
    ).toBe('sheet 3');
  });

  it('takes the words from the caller, so the screen can say it in French', () => {
    expect(
      describeLocation(
        { pageUnit: 'sheet', pageStart: 1, pageEnd: 1, lineStart: 3, lineEnd: 4 },
        {
          page: 'page',
          pages: 'pages',
          slide: 'diapositive',
          slides: 'diapositives',
          sheet: 'feuille',
          sheets: 'feuilles',
          line: 'l.',
          lines: 'l.',
        },
      ),
    ).toBe('feuille 1, l. 3–4');
  });

  it('treats a missing end as the start, rather than dropping the locator', () => {
    expect(
      describeLocation({
        pageUnit: 'page',
        pageStart: 4,
        pageEnd: null,
        lineStart: 12,
        lineEnd: null,
      }),
    ).toBe('page 4, line 12');
  });

  it('ignores a page number with no unit — a page is only a page in a paged format', () => {
    expect(
      describeLocation({
        pageUnit: null,
        pageStart: 2,
        pageEnd: 2,
        lineStart: 5,
        lineEnd: 5,
      }),
    ).toBe('line 5');
  });

  it('defaults to English, which is what the prompt is written in', () => {
    const location = {
      pageUnit: 'page' as const,
      pageStart: 1,
      pageEnd: 1,
      lineStart: 2,
      lineEnd: 3,
    };
    expect(describeLocation(location)).toBe(describeLocation(location, LOCATION_WORDS_EN));
  });
});
