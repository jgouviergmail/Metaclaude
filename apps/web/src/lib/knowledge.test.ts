import { describe, expect, it } from 'vitest';
import type { KnowledgeSource } from '@metaclaude/shared';

import { formatLabel, formatLocation, KNOWLEDGE_ACCEPT, matchesTitle } from './knowledge';

/** The identity translator: what these helpers do to English keys. */
const t = (key: string): string => key;

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  name: 'bail.pdf',
  mime: 'application/pdf',
  bytes: 1024,
  extractor: 'pdf@poppler-22.12.0',
  ...over,
});

describe('formatLocation', () => {
  it('reads as a compact locator, separated for a card', () => {
    expect(
      formatLocation(
        { pageUnit: 'page', pageStart: 2, pageEnd: 2, lineStart: 40, lineEnd: 52 },
        t,
      ),
    ).toBe('p. 2 · l. 40–52');
  });

  it('names a slide as a slide, because a deck has no pages', () => {
    expect(
      formatLocation({ pageUnit: 'slide', pageStart: 3, pageEnd: 4, lineStart: null, lineEnd: null }, t),
    ).toBe('diapo. 3–4');
  });

  it('gives lines alone for a document with no pages', () => {
    expect(
      formatLocation({ pageUnit: null, pageStart: null, pageEnd: null, lineStart: 1, lineEnd: 9 }, t),
    ).toBe('l. 1–9');
  });

  it('says nothing for a passage with no location at all', () => {
    expect(
      formatLocation(
        { pageUnit: null, pageStart: null, pageEnd: null, lineStart: null, lineEnd: null },
        t,
      ),
    ).toBe('');
  });
});

describe('formatLabel', () => {
  it('names the format on a badge', () => {
    expect(formatLabel(source())).toBe('PDF');
    expect(
      formatLabel(
        source({
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    ).toBe('DOCX');
    expect(formatLabel(source({ mime: 'text/markdown' }))).toBe('MD');
  });

  it('has no badge for text that was pasted', () => {
    expect(formatLabel(null)).toBeNull();
  });

  it('falls back rather than showing an empty badge for a type it does not know', () => {
    expect(formatLabel(source({ mime: 'application/x-newthing' }))).toBe('FILE');
  });
});

describe('matchesTitle', () => {
  const document = { title: 'Bail — Résiliation', source: source({ name: 'contrat-2026.pdf' }) };

  it('ignores case and accents, because a phone keyboard does not reach for them', () => {
    expect(matchesTitle(document, 'resiliation')).toBe(true);
    expect(matchesTitle(document, 'RÉSILIATION')).toBe(true);
    expect(matchesTitle(document, 'bail')).toBe(true);
  });

  it('matches the file name too, which is often what an operator remembers', () => {
    expect(matchesTitle(document, 'contrat-2026')).toBe(true);
  });

  it('matches everything when nothing is typed', () => {
    expect(matchesTitle(document, '')).toBe(true);
    expect(matchesTitle(document, '   ')).toBe(true);
  });

  it('does not match what is not there', () => {
    expect(matchesTitle(document, 'assurance')).toBe(false);
  });

  it('handles a pasted document, which has no file name to match', () => {
    expect(matchesTitle({ title: 'Note', source: null }, 'note')).toBe(true);
    expect(matchesTitle({ title: 'Note', source: null }, 'pdf')).toBe(false);
  });
});

describe('KNOWLEDGE_ACCEPT', () => {
  it('offers both the types and the extensions, because a browser may send neither', () => {
    expect(KNOWLEDGE_ACCEPT).toContain('application/pdf');
    expect(KNOWLEDGE_ACCEPT).toContain('.docx');
    expect(KNOWLEDGE_ACCEPT).toContain('.pptx');
    // And nothing the library cannot read.
    expect(KNOWLEDGE_ACCEPT).not.toContain('.zip');
    expect(KNOWLEDGE_ACCEPT).not.toContain('image/');
  });
});
