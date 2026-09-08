import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractXlsx } from './xlsx.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const read = (name = 'loyers.xlsx') =>
  extractXlsx({
    name,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data: fixture(name),
  });

describe('extractXlsx', () => {
  it('gives each sheet a section named after it and its header row', async () => {
    // The header is what makes a retrieved row mean something: it travels
    // with every passage of the sheet as its section heading.
    const { text } = await read();
    expect(text).toContain('## Loyers 2026 — Mois | Échéance | Loyer | Charges | Total');
    expect(text).toContain('## Contacts — Rôle | Nom | Téléphone');
  });

  it('writes one row per paragraph, so a row is never cut in half', async () => {
    const { text } = await read();
    expect(text).toContain('| 2026-03 | 2026-03-05 | 950 | 110 | 1060 |');
  });

  it('resolves a date to something searchable rather than a serial number', async () => {
    const { text } = await read();
    expect(text).toContain('2026-01-05');
    expect(text).not.toMatch(/\| 4[0-9]{4} \|/);
  });

  it('resolves a formula to its cached result, which is what the reader sees', async () => {
    const { text } = await read();
    expect(text).toContain('| 1060 |');
    expect(text).not.toContain('C2+D2');
  });

  it('skips a blank row instead of emitting an empty one', async () => {
    const { text } = await read();
    expect(text).not.toMatch(/\|\s*\|\s*\|\s*\|/);
    expect(text).toContain('Le syndic gère les parties communes');
  });

  it('reports one page break per sheet, so a row can be cited by sheet', async () => {
    const out = await read();
    expect(out.pageUnit).toBe('sheet');
    expect(out.pageBreaks).toHaveLength(1);
    expect(out.text.slice(out.pageBreaks[0]!)).toMatch(/^## Contacts/);
    expect(out.extractor).toMatch(/^xlsx@/);
  });

  it('refuses a file that is not a workbook as corrupt', async () => {
    await expect(
      extractXlsx({
        name: 'x.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: Buffer.from('pas un zip du tout'),
      }),
    ).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('refuses a workbook with nothing in it', async () => {
    await expect(
      extractXlsx({
        name: 'x.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: fixture('empty.xlsx'),
      }),
    ).rejects.toMatchObject({ code: 'no-text' });
  });
});
