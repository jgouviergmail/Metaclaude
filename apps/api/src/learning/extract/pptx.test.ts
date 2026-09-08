import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { describeLocation } from '@metaclaude/shared';

import { extractPptx } from './pptx.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const read = (name = 'deploiement.pptx') =>
  extractPptx({
    name,
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    data: fixture(name),
  });

describe('extractPptx', () => {
  it('gives each slide a section named by its number and its title', async () => {
    const { text } = await read();
    expect(text).toContain('## Slide 1 — Plan de déploiement');
    expect(text).toContain('## Slide 2 — Risques');
  });

  it('names a slide with the word the citation beside it will use', async () => {
    // Both reach the model in one prompt: `describeLocation` renders
    // `(slide 3, lines 4–9)` on the line above a passage whose heading this
    // is. They used to disagree — the heading said `Diapositive 3` while the
    // citation said `slide 3`, two names for one slide, and nothing tied
    // them together. Derived from the locator rather than typed, so the day
    // that vocabulary moves this fails instead of drifting.
    const word = describeLocation({
      pageUnit: 'slide',
      pageStart: 3,
      pageEnd: 3,
      lineStart: null,
      lineEnd: null,
    }).split(' ')[0]!;
    const { text } = await read();
    expect(text).toContain(`## ${word[0]!.toUpperCase()}${word.slice(1)} 3`);
  });

  it('reads the slides in presentation order, not in file order', async () => {
    // The order lives in `presentation.xml`, not in the slide file names: a
    // deck reordered after authoring keeps slide3.xml in position 1.
    const { text } = await read();
    expect(text.indexOf('Slide 1')).toBeLessThan(text.indexOf('Slide 2'));
    expect(text.indexOf('Slide 2')).toBeLessThan(text.indexOf('Slide 3'));
  });

  it('keeps the body bullets of a slide', async () => {
    const { text } = await read();
    expect(text).toContain('migrer la prod avant le 30 septembre');
    expect(text).toContain('dimanche 03h–05h');
  });

  it('keeps a slide table as rows', async () => {
    const { text } = await read();
    expect(text).toContain('| Perte de données | Sauvegarde à froid avant bascule |');
  });

  it("carries the speaker's notes, which are where the reasons live", async () => {
    const { text } = await read();
    expect(text).toContain('Notes: Rappeler que la fenêtre a été validée par le client');
    expect(text).toContain('Notes: Le rollback est testé en préprod chaque semaine.');
  });

  it('does not repeat a title as body text', async () => {
    const { text } = await read();
    expect(text.match(/Plan de déploiement/g)).toHaveLength(1);
  });

  it('counts in slides, one break per slide after the first', async () => {
    const out = await read();
    expect(out.pageUnit).toBe('slide');
    expect(out.pageBreaks).toHaveLength(2);
    expect(out.text.slice(out.pageBreaks[0]!)).toMatch(/^## Slide 2/);
    expect(out.extractor).toMatch(/^pptx@/);
  });

  it('reads a title from a placeholder, and falls back to the first line without one', async () => {
    // Slide 1 of the fixture carries a real title placeholder, the way
    // PowerPoint writes a deck; slides 2 and 3 are plain text boxes, which is
    // how a deck built by dragging boxes around comes out.
    const { text } = await read();
    expect(text).toContain('## Slide 1 — Plan de déploiement');
    expect(text).toContain('## Slide 2 — Risques');
    expect(text).toContain('## Slide 3 — Questions ?');
  });

  // Synchronous on purpose — no I/O — so a refusal is a throw, not a
  // rejection. `rejects` here would pass on any error at all, this one
  // included, which is a test that proves nothing.
  it('refuses something that is not a deck as corrupt', () => {
    expect(() =>
      extractPptx({
        name: 'x.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        data: Buffer.from('pas un zip'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'corrupt' }));
  });

  it('refuses a zip that is not a deck, rather than answering nothing', () => {
    // A .docx renamed .pptx unzips perfectly and has no presentation.xml.
    expect(() =>
      extractPptx({
        name: 'x.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        data: fixture('bail.docx'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'corrupt' }));
  });
});
