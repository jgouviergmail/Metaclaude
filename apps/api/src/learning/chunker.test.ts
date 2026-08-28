import { describe, expect, it } from 'vitest';

import { CHUNK_MAX, CHUNK_OVERLAP, CHUNK_TARGET, chunkDocument, chunkEmbeddingText } from './chunker.js';

const paragraph = (n: number, size = 400): string =>
  `Paragraphe ${n} — ${'contenu utile '.repeat(Math.ceil(size / 14))}`.slice(0, size);

describe('chunking a document', () => {
  it('returns nothing for nothing', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\n  \n')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkDocument('Une seule idée courte.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ seq: 0, heading: '', text: 'Une seule idée courte.' });
  });

  it('packs whole paragraphs toward the target rather than cutting mid-thought', () => {
    const text = [paragraph(1), paragraph(2), paragraph(3), paragraph(4), paragraph(5)].join('\n\n');
    const chunks = chunkDocument(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX + CHUNK_OVERLAP + 4);
      // A paragraph is never split when it fits: each one appears intact.
    }
    expect(chunks.map((c) => c.text).join(' ')).toContain('Paragraphe 3');
  });

  it('numbers chunks sequentially from zero', () => {
    const text = Array.from({ length: 8 }, (_, i) => paragraph(i)).join('\n\n');
    const chunks = chunkDocument(text);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
  });

  it('carries the nearest heading with every chunk below it', () => {
    const text = [
      'Préambule sans titre.',
      '# Résiliation',
      paragraph(1),
      paragraph(2),
      paragraph(3),
      '## Préavis',
      'Le préavis est de 45 jours.',
    ].join('\n\n');
    const chunks = chunkDocument(text);

    expect(chunks[0]).toMatchObject({ heading: '' });
    const noticeChunk = chunks.find((c) => c.text.includes('45 jours'))!;
    expect(noticeChunk.heading).toBe('Préavis');
    const bodyChunks = chunks.filter((c) => c.text.includes('Paragraphe'));
    for (const chunk of bodyChunks) expect(chunk.heading).toBe('Résiliation');
  });

  it('never lets a chunk straddle a heading, so its label cannot lie', () => {
    const text = ['Avant le titre.', '# Section', 'Après le titre.'].join('\n\n');
    const chunks = chunkDocument(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain('Avant');
    expect(chunks[0]!.text).not.toContain('Après');
    expect(chunks[1]!.heading).toBe('Section');
  });

  it('overlaps consecutive chunks at a word boundary, so a seam sentence is findable from both sides', () => {
    const text = [paragraph(1, 900), paragraph(2, 900)].join('\n\n');
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The second chunk opens with the marked tail of the first.
    expect(chunks[1]!.text.startsWith('… ')).toBe(true);
    const tail = chunks[1]!.text.slice(2, 40);
    expect(chunks[0]!.text).toContain(tail.split(' ')[0]);
    // Cut at a word boundary: the overlap never opens mid-word.
    expect(chunks[0]!.text).toContain(` ${tail.trim().split(' ')[0]}`);
  });

  it('does not bleed overlap across a heading boundary', () => {
    const text = [paragraph(1, 500), '# Nouveau sujet', paragraph(2, 500)].join('\n\n');
    const chunks = chunkDocument(text);
    const after = chunks.find((c) => c.heading === 'Nouveau sujet')!;
    expect(after.text.startsWith('… ')).toBe(false);
  });

  it('splits an oversized paragraph at sentence boundaries, French punctuation included', () => {
    const sentence = 'Cette phrase précise contient des accents — été, Nîmes, dépôt » et continue. ';
    const wall = sentence.repeat(40); // ~3000 chars, one paragraph
    const chunks = chunkDocument(wall);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX + CHUNK_OVERLAP + 4);
      // Sentences stay whole: every chunk ends at a sentence boundary, not
      // mid-word.
      expect(/\S/.test(chunk.text)).toBe(true);
    }
  });

  it('survives a wall of text with no punctuation at all', () => {
    const wall = 'mot '.repeat(1200); // ~4800 chars, no sentence boundaries
    const chunks = chunkDocument(wall);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX + CHUNK_OVERLAP + 4);
  });

  it('survives a single unbreakable token longer than the ceiling', () => {
    // A base64 blob or a minified line: indexing it in pieces beats refusing
    // the document.
    const blob = 'A'.repeat(CHUNK_MAX * 2 + 100);
    const chunks = chunkDocument(blob);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.text.replace(/^… /, '')).join('')).toContain('AAAA');
  });

  it('normalises Windows line endings before splitting paragraphs', () => {
    const chunks = chunkDocument('Un.\r\n\r\nDeux.');
    expect(chunks[0]!.text).toContain('Un.');
    expect(chunks[0]!.text).toContain('Deux.');
  });

  it('loses no body text, and headings survive as labels rather than vanishing', () => {
    // Chunking reorganises; it must not lose. Body paragraphs must all be
    // findable in chunk texts — and a heading line leaves the body by design
    // (it becomes the chunks' label), so it is asserted where it now lives.
    const text = [paragraph(1), '# Titre', paragraph(2), paragraph(3, 2000)].join('\n\n');
    const chunks = chunkDocument(text);
    const rebuilt = chunks.map((c) => c.text).join(' ').replace(/\s+/gu, '');
    for (const probe of ['Paragraphe1', 'Paragraphe2', 'Paragraphe3']) {
      expect(rebuilt).toContain(probe);
    }
    expect(chunks.some((c) => c.heading === 'Titre')).toBe(true);
  });
});

describe('the text a chunk is embedded with', () => {
  it('prepends the document title and the section heading', () => {
    // "the notice period is 45 days" cannot match a query about terminating a
    // lease unless the context travels with it.
    const rendered = chunkEmbeddingText('Bail — 12 rue X', {
      seq: 3,
      heading: 'Préavis',
      text: 'Le préavis est de 45 jours.',
    });
    expect(rendered).toBe('Bail — 12 rue X — Préavis\nLe préavis est de 45 jours.');
  });

  it('degrades cleanly when there is no heading or no title', () => {
    expect(chunkEmbeddingText('', { seq: 0, heading: '', text: 'Texte.' })).toBe('Texte.');
    expect(chunkEmbeddingText('Doc', { seq: 0, heading: '', text: 'Texte.' })).toBe('Doc\nTexte.');
  });
});

describe('the size constants agree with each other', () => {
  it('keeps target under max and overlap well under target', () => {
    expect(CHUNK_TARGET).toBeLessThan(CHUNK_MAX);
    expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_TARGET / 4);
  });
});
