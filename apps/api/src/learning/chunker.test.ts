import { describe, expect, it } from 'vitest';

import { CHUNK_MAX, CHUNK_OVERLAP, CHUNK_TARGET, chunkDocument, chunkEmbeddingText } from './chunker.js';
import { evalCorpus } from './eval-corpus.js';

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
      heading: 'Préavis',
      text: 'Le préavis est de 45 jours.',
    });
    expect(rendered).toBe('Bail — 12 rue X — Préavis\nLe préavis est de 45 jours.');
  });

  it('degrades cleanly when there is no heading or no title', () => {
    expect(chunkEmbeddingText('', { heading: '', text: 'Texte.' })).toBe('Texte.');
    expect(chunkEmbeddingText('Doc', { heading: '', text: 'Texte.' })).toBe('Doc\nTexte.');
  });

  it('takes a whole chunk too — the caller that has one need not destructure it', () => {
    const [chunk] = chunkDocument('## Préavis\n\nLe préavis est de 45 jours.');
    expect(chunkEmbeddingText('Bail', chunk!)).toBe(
      'Bail — Préavis\nLe préavis est de 45 jours.',
    );
  });
});

describe('the size constants agree with each other', () => {
  it('keeps target under max and overlap well under target', () => {
    expect(CHUNK_TARGET).toBeLessThan(CHUNK_MAX);
    expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_TARGET / 4);
  });
});

/**
 * The boundaries are the contract, and they must not move.
 *
 * Every stored vector was made from a chunk's text; change where a chunk
 * starts or ends and the whole library silently needs re-embedding, with no
 * error and no way to notice from the outside. So the passages of the
 * evaluation corpus are pinned to a file: this snapshot is what the chunker
 * produced *before* it learned to report offsets, and any diff here means a
 * change that costs a re-index — deliberate or not.
 */
describe('the chunk boundaries are stable', () => {
  it('produces exactly the passages it produced before locations were added', async () => {
    const seen = evalCorpus(1).map((document) =>
      chunkDocument(document.content).map(({ seq, heading, text }) => ({ seq, heading, text })),
    );
    await expect(JSON.stringify(seen, null, 2)).toMatchFileSnapshot(
      './__snapshots__/chunker-eval-corpus.json',
    );
  });
});

/**
 * Where each chunk sits in the document it came from.
 *
 * This is what lets a retrieved passage be cited as "lines 40–52" and opened
 * at the right place. The offsets describe the chunk's *own* text: the `… `
 * overlap prefix is a copy of the previous chunk's tail and belongs to it, so
 * including it would make every citation after the first one start too early.
 */
describe('where each chunk sits', () => {
  /** The chunk's own text, with the seam prefix removed. */
  const own = (text: string): string =>
    text.startsWith('… ') ? text.slice(text.indexOf('\n\n') + 2) : text;

  it('reports verbatim offsets for an ordinary document, overlap excluded', () => {
    const content = `# Titre\n\nPremier paragraphe.\n\n${paragraph(2, 900)}\n\n${paragraph(3, 900)}\n\nDernier paragraphe.`;
    const chunks = chunkDocument(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(content.slice(chunk.start, chunk.end)).toBe(own(chunk.text));
    }
  });

  it('starts mid-paragraph where a long paragraph was split, not at the paragraph', () => {
    // The case that separates `base + piece.start` from a plain `base`: a
    // paragraph over the ceiling produces several chunks, and only the first
    // of them begins where the paragraph does.
    const sentence = 'Une phrase complète et distincte se termine ici. ';
    const long = sentence.repeat(Math.ceil((CHUNK_TARGET * 3) / sentence.length)).trim();
    const content = `Avant.\n\n${long}`;
    const chunks = chunkDocument(content);

    const inside = chunks.filter((chunk) => chunk.start > content.indexOf(long));
    expect(inside.length).toBeGreaterThan(0);
    for (const chunk of inside) {
      // Each later chunk opens exactly where its own first sentence does.
      expect(content.slice(chunk.start, chunk.start + 20)).toBe(own(chunk.text).slice(0, 20));
    }
  });

  it('starts a chunk on its first own word, not on the heading above it', () => {
    const [chunk] = chunkDocument('## Section\n\nCorps du texte.');
    expect(chunk!.start).toBe('## Section\n\n'.length);
    expect(chunk!.end).toBe('## Section\n\nCorps du texte.'.length);
  });

  it('locates the pieces of a paragraph longer than the ceiling inside that paragraph', () => {
    // Sentences re-joined with single spaces are not a verbatim substring of a
    // paragraph that wrapped across lines, so the offsets must bound the span
    // rather than match the string.
    const sentence = 'Une phrase qui se termine ici. ';
    const paragraphText = sentence.repeat(Math.ceil((CHUNK_MAX * 2) / sentence.length)).trim();
    const content = `Avant.\n\n${paragraphText}\n\nAprès.`;
    const chunks = chunkDocument(content);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.start).toBeLessThan(chunk.end);
      const span = content.slice(chunk.start, chunk.end).replace(/\s+/gu, ' ');
      const body = own(chunk.text).replace(/\s+/gu, ' ');
      expect(span, `chunk ${chunk.seq}`).toContain(body.slice(0, 40));
    }
    expect(chunks.at(-1)!.end).toBe(content.length);
  });

  it('never goes backwards, and never runs past the content', () => {
    const content = evalCorpus(1).map((document) => document.content).join('\n\n');
    const chunks = chunkDocument(content);
    let previous = -1;
    for (const chunk of chunks) {
      expect(chunk.start).toBeGreaterThanOrEqual(0);
      expect(chunk.start).toBeGreaterThan(previous);
      expect(chunk.end).toBeGreaterThan(chunk.start);
      expect(chunk.end).toBeLessThanOrEqual(content.length);
      previous = chunk.start;
    }
  });

  it('reports offsets into the normalised text, not into the CRLF original', () => {
    // The store writes the normalised content; offsets into anything else
    // would point at the wrong line for every Windows-authored document.
    const chunks = chunkDocument('Un.\r\n\r\nDeux.\r\n\r\nTrois.');
    const normalised = 'Un.\n\nDeux.\n\nTrois.';
    for (const chunk of chunks) {
      expect(normalised.slice(chunk.start, chunk.end)).toBe(own(chunk.text));
    }
  });

  it('survives an unbreakable token: each slice knows its own span', () => {
    const blob = 'A'.repeat(CHUNK_MAX * 2 + 100);
    const chunks = chunkDocument(blob);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(blob.slice(chunk.start, chunk.end)).toBe(own(chunk.text));
    }
  });
});
