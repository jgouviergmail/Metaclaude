/**
 * PDFs, through both engines.
 *
 * Poppler is what ships and what production reads with; pdfjs is the fallback
 * for a machine without it. Both are driven through the same cases here,
 * because a fallback nobody tests is a fallback that fails the first time it
 * is needed — and the two differ in exactly one visible way, which the
 * two-column case pins.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractPdf, PdfjsEngine, PopplerEngine, popplerVersion, rejoinHyphens } from './pdf.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const poppler = popplerVersion();

const read = (name: string, engine: PopplerEngine | PdfjsEngine) =>
  extractPdf({ name, mime: 'application/pdf', data: fixture(name) }, engine);

const engines: Array<[string, () => PopplerEngine | PdfjsEngine, boolean]> = [
  ['poppler', () => new PopplerEngine(), poppler === null],
  ['pdfjs (the fallback)', () => new PdfjsEngine(), false],
];

describe.each(engines)('extractPdf through %s', (_label, engine, unavailable) => {
  it.skipIf(unavailable)('reads one page after another and says where each starts', async () => {
    const out = await read('assurance.pdf', engine());

    expect(out.pageUnit).toBe('page');
    expect(out.pageBreaks).toHaveLength(2);
    expect(out.text.slice(out.pageBreaks[0]!, out.pageBreaks[0]! + 19)).toBe('Article 2 - Franchi');
    expect(out.text).toContain('cinq jours ouvrés');
  });

  it.skipIf(unavailable)('keeps the lines of a paragraph rather than running them together', async () => {
    const { text } = await read('assurance.pdf', engine());
    expect(text).toMatch(/déclaré à l'assureur dans les cinq jours ouvrés\n/);
  });

  it.skipIf(unavailable)('refuses a scan, and says it is one', async () => {
    await expect(read('scan.pdf', engine())).rejects.toMatchObject({ code: 'no-text' });
  });

  it.skipIf(unavailable)('refuses a password-protected file by name', async () => {
    await expect(read('encrypted.pdf', engine())).rejects.toMatchObject({ code: 'encrypted' });
  });

  it.skipIf(unavailable)('refuses a file that is not a PDF as corrupt, not as a crash', async () => {
    await expect(
      extractPdf({ name: 'x.pdf', mime: 'application/pdf', data: fixture('bail.docx') }, engine()),
    ).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('rejoinHyphens', () => {
  it('closes a word its typesetter split across two lines', () => {
    // Measured: 165 such words on one real paper, each one a word no lexical
    // query can match. Poppler does this itself; the fallback has to.
    expect(rejoinHyphens('learn-\ning residual')).toBe('learning residual');
    expect(rejoinHyphens('complex-\nity. An ensemble')).toBe('complexity. An ensemble');
    expect(rejoinHyphens('expira-\ntion')).toBe('expiration');
  });

  it('leaves a dash before a capital alone, which is not a split word', () => {
    expect(rejoinHyphens('Paris-\nNice')).toBe('Paris-\nNice');
    expect(rejoinHyphens('2005-\n2022')).toBe('2005-\n2022');
  });

  it('leaves a hyphen that is not at a line end alone', () => {
    expect(rejoinHyphens('porte-manteau')).toBe('porte-manteau');
    expect(rejoinHyphens('child-directed speech')).toBe('child-directed speech');
  });
});

describe('a two-column PDF', () => {
  it.skipIf(poppler === null)('keeps every paragraph whole and the articles in order', async () => {
    // Both engines read two columns in order — reading order is *not* what
    // separates them, and an earlier version of this file said it was. What
    // separates them is hyphenation, pinned by `rejoinHyphens` above and
    // measured in the header of pdf.ts.
    const { text, extractor } = await read('twocol.pdf', new PopplerEngine());
    const at = (needle: string): number => {
      const index = text.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };

    expect(at('Article 1')).toBeLessThan(at('Article 2'));
    expect(at('Article 3')).toBeLessThan(at('Article 4'));
    expect(at('Article 5')).toBeLessThan(at('Article 6'));
    // A sentence that wraps inside the left column is not interrupted by the
    // right one.
    expect(text.replace(/\s+/g, ' ')).toContain(
      'composé de trois pièces principales, d’une cuisine et d’une salle de bains',
    );
    expect(extractor).toMatch(/^pdf@poppler-/);
  });

  it('names the fallback as such, so a document read under it can be found later', async () => {
    // Not a lesser truth quietly told: `extractor` is what the re-extract
    // button and the doctor both read.
    const { extractor } = await read('twocol.pdf', new PdfjsEngine());
    expect(extractor).toBe('pdf@pdfjs');
  });

  if (poppler === null) {
    it('says why the poppler cases did not run', () => {
      console.warn(
        'poppler pdftotext is not on PATH: its cases were skipped. CI installs poppler-utils, and so does the image.',
      );
      expect(poppler).toBeNull();
    });
  }
});

describe('choosing an engine', () => {
  it('reports poppler’s version when it is installed, and null when it is not', () => {
    // The doctor reads exactly this, and a wrong answer there means an
    // operator is told their PDFs are read one way while they are read the
    // other.
    expect(poppler === null || /^\d+\.\d+/.test(poppler)).toBe(true);
  });

  it('names the engine in the extractor id, whichever answered', async () => {
    const out = await extractPdf({
      name: 'assurance.pdf',
      mime: 'application/pdf',
      data: fixture('assurance.pdf'),
    });
    expect(out.extractor).toMatch(poppler === null ? /^pdf@pdfjs$/ : /^pdf@poppler-/);
  });
});
