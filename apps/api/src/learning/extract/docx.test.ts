import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractDocx } from './docx.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const read = (name = 'bail.docx') =>
  extractDocx({
    name,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: fixture(name),
  });

describe('extractDocx', () => {
  it('turns Word headings into the sections passages are cited under', async () => {
    const { text } = await read();
    expect(text).toContain("# Bail d'habitation — 12 rue des Lilas");
    expect(text).toContain('## Résiliation par le locataire');
    expect(text).toContain('### Liste');
  });

  it('keeps the body prose intact, accents and all', async () => {
    const { text } = await read();
    expect(text).toContain('Le délai de préavis est de trois mois');
    expect(text).toContain('récupérables');
  });

  it('keeps a table as rows rather than as a column of loose words', async () => {
    // `convertToMarkdown` flattens a table into one cell per line, which reads
    // as prose and retrieves as nonsense. Going through HTML keeps the rows.
    const { text } = await read();
    expect(text).toContain('| Poste | Montant |');
    expect(text).toContain('| Loyer | 950 € |');
  });

  it('keeps a list as a list, and bold as bold', async () => {
    const { text } = await read();
    expect(text).toContain('- Premier point');
    expect(text).toContain('**Important :**');
  });

  it('does not escape ordinary punctuation', async () => {
    // Word's markdown converter escapes every full stop as `\.`, which reaches
    // the index as a word nobody will ever search for.
    const { text } = await read();
    expect(text).not.toContain('\\.');
  });

  it('says a docx has no pages, because a docx does not', async () => {
    const out = await read();
    expect(out.pageUnit).toBeNull();
    expect(out.pageBreaks).toEqual([]);
    expect(out.extractor).toMatch(/^docx@/);
  });

  it('refuses a file that is not a docx as corrupt, not as a crash', async () => {
    await expect(
      extractDocx({
        name: 'x.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: Buffer.from('ceci n’est pas un zip'),
      }),
    ).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('refuses a docx whose body is empty rather than storing a blank document', async () => {
    await expect(
      extractDocx({
        name: 'x.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: fixture('empty.docx'),
      }),
    ).rejects.toMatchObject({ code: 'no-text' });
  });
});
