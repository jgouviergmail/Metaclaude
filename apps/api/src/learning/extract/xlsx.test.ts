import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

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

  it('counts a blank sheet, so the sheet a passage is cited under is the one you open', async () => {
    // A workbook with an empty tab in the middle — a "Notes" nobody filled in
    // — is ordinary, and skipping it renumbered everything after: the third
    // sheet was cited as sheet 2, and the operator opening sheet 2 found a
    // blank page. `joinPages` is written for exactly this ("page 7 of a PDF is
    // page 7 whether or not page 6 was blank"); the skip happened before it
    // could do its job. Built here rather than committed as a fixture: what
    // makes the case is one empty sheet, and a binary hides that.
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Un').addRows([['Colonne'], ['premier']]);
    workbook.addWorksheet('Vide');
    workbook.addWorksheet('Trois').addRows([['Colonne'], ['troisieme']]);
    const data = Buffer.from(await workbook.xlsx.writeBuffer());

    const out = await extractXlsx({ name: 'trous.xlsx', mime: '', data });
    // Two breaks for three sheets, and the second one opens the third sheet.
    expect(out.pageBreaks).toHaveLength(2);
    expect(out.text.slice(out.pageBreaks[1]!)).toMatch(/^## Trois/);
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
