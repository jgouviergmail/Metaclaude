/**
 * The dispatch: which extractor reads what, and what a refusal says.
 *
 * The case this file exists for is the first one — every MIME the contract
 * accepts has an extractor behind it. A type accepted at the edge and
 * unroutable underneath is a 500 dressed as a feature, and it is exactly the
 * failure a closed list invites: the list and the table drift apart, and
 * nothing notices until someone drops that kind of file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_MIME_TYPES } from '@metaclaude/shared';

import { migrate, openDatabase } from '../../db/index.js';
import { chunkDocument } from '../chunker.js';
import { HashingEmbedder } from '../embeddings.js';
import { KnowledgeStore, MAX_DOCUMENT_BYTES } from '../knowledge.js';
import { extractInProcess, KNOWLEDGE_EXTENSIONS, resolveKnowledgeMime } from './index.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe('resolveKnowledgeMime', () => {
  it('trusts a listed type', () => {
    expect(resolveKnowledgeMime('x.bin', 'application/pdf')).toBe('application/pdf');
  });

  it('infers from the extension when the browser sent nothing', () => {
    // Measured in the attachments: several platforms hand over an empty type
    // for a drag-dropped .md, and refusing it there would be a bug nobody
    // could explain.
    expect(resolveKnowledgeMime('notes.md', '')).toBe('text/markdown');
    expect(resolveKnowledgeMime('notes.markdown', '')).toBe('text/markdown');
    expect(resolveKnowledgeMime('BAIL.PDF', '')).toBe('application/pdf');
  });

  it('infers from the extension when the browser sent something useless', () => {
    expect(resolveKnowledgeMime('deck.pptx', 'application/octet-stream')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('refuses what the library cannot read, however it is labelled', () => {
    expect(resolveKnowledgeMime('archive.zip', 'application/zip')).toBeNull();
    expect(resolveKnowledgeMime('legacy.doc', '')).toBeNull();
    expect(resolveKnowledgeMime('photo.png', 'image/png')).toBeNull();
    expect(resolveKnowledgeMime('nameless', '')).toBeNull();
  });
});

describe('every accepted type has an extractor', () => {
  it.each(KNOWLEDGE_MIME_TYPES)('%s is routable', async (mime) => {
    // Drives the real dispatch with one byte, and requires the failure — a
    // byte is not a spreadsheet — to be about the *content*, never about the
    // type. Awaited: an unawaited rejection is an unhandled error that vitest
    // reports beside a green suite, and a test that proves nothing.
    const outcome = await extractInProcess({ name: 'x', mime, data: Buffer.from('x') }).then(
      () => null,
      (error: { code?: string }) => error.code,
    );
    expect(outcome, mime).not.toBe('unsupported');
  });

  it('every extension the picker offers resolves to an accepted type', () => {
    for (const extension of KNOWLEDGE_EXTENSIONS) {
      expect(resolveKnowledgeMime(`file.${extension}`, ''), extension).not.toBeNull();
    }
  });
});

describe('extractInProcess', () => {
  it('routes each fixture to the extractor that reads it', async () => {
    const cases: Array<[string, RegExp]> = [
      ['bail.docx', /^docx@/],
      ['loyers.xlsx', /^xlsx@/],
      ['deploiement.pptx', /^pptx@/],
      ['assurance.pdf', /^pdf@/],
      ['sample.csv', /^csv@/],
      ['sample.html', /^text@|^html@/],
      ['sample.md', /^text@/],
    ];
    for (const [name, extractor] of cases) {
      // No MIME at all: the extension has to carry it, which is the case a
      // real browser produces often enough to be the default here.
      const out = await extractInProcess({ name, mime: '', data: fixture(name) });
      expect(out.text.length, name).toBeGreaterThan(20);
      expect(out.extractor, name).toMatch(extractor);
    }
  });

  it('gives every ordinary fixture a text the chunker can make passages out of', async () => {
    // `text.length > 20` above is not the same promise: a heading is text and
    // makes no passage, so a document can extract to something and still be
    // unstorable. This is the half of the contract the fixtures can hold.
    for (const name of ['bail.docx', 'loyers.xlsx', 'deploiement.pptx', 'sample.csv', 'sample.html', 'sample.md']) {
      const out = await extractInProcess({ name, mime: '', data: fixture(name) });
      expect(chunkDocument(out.text).length, name).toBeGreaterThan(0);
    }
  });

  it('answers a file that is all headings with a sentence naming that', async () => {
    // The other half, and it is only meaningful end to end: extraction and
    // the store each refuse things, and the operator sees whichever spoke
    // first. Every one of these came back as "A document needs content" —
    // about a file whose text is visible on screen, which reads as the upload
    // having silently lost it. Driven through the real store rather than the
    // chunker, because what is under test is the sentence a person gets.
    const db = openDatabase({ path: ':memory:' });
    migrate(db);
    const store = new KnowledgeStore(db, new HashingEmbedder());
    const cases: Array<[string, string, RegExp]> = [
      ['export.csv', 'mois;montant;statut', /header row/i],
      ['plan.md', '# Titre\n\n## Sous-titre', /headings/i],
      ['page.html', '<h1>Titre</h1>', /headings/i],
    ];
    for (const [name, body, expected] of cases) {
      const outcome = await extractInProcess({ name, mime: '', data: Buffer.from(body) })
        .then(
          (out) => store.upsert({ workspaceId: null, title: 'T', content: out.text }).then(() => 'stored'),
          (error: Error) => error.message,
        )
        .catch((error: Error) => error.message);
      expect(outcome, name).toMatch(expected);
    }
    db.close();
  });

  it('reads an .html into markdown rather than into tag soup', async () => {
    const out = await extractInProcess({ name: 'sample.html', mime: '', data: fixture('sample.html') });
    expect(out.text).toContain('# Runbook & conventions');
    expect(out.text).not.toContain('<h1>');
  });

  it('refuses an unsupported type, naming what is accepted', async () => {
    await expect(
      extractInProcess({ name: 'a.zip', mime: 'application/zip', data: Buffer.from('x') }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('.pdf'),
    });
  });

  it('refuses an empty file before deciding anything else about it', async () => {
    await expect(
      extractInProcess({ name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: 'empty' });
  });

  it('refuses text that would not fit a document, and says by how much', async () => {
    const oversized = Buffer.alloc(MAX_DOCUMENT_BYTES + 1024, 0x61);
    await expect(
      extractInProcess({ name: 'a.txt', mime: 'text/plain', data: oversized }),
    ).rejects.toMatchObject({
      code: 'too-large',
      message: expect.stringContaining('512'),
    });
  });

  it('refuses a file whose text comes out empty', async () => {
    await expect(
      extractInProcess({ name: 'a.txt', mime: 'text/plain', data: Buffer.from('   \n\n  ') }),
    ).rejects.toMatchObject({ code: 'no-text' });
  });

  it('hands over a page map whose offsets index the text it returns', async () => {
    // The invariant the whole provenance rests on. Every break has to land on
    // the first character of a page, in the string the store will write — a
    // normalisation applied after the fact would shift them all silently.
    for (const name of ['assurance.pdf', 'loyers.xlsx', 'deploiement.pptx']) {
      const out = await extractInProcess({ name, mime: '', data: fixture(name) });
      expect(out.pageBreaks.length, name).toBeGreaterThan(0);
      for (const at of out.pageBreaks) {
        expect(at, `${name} @${at}`).toBeGreaterThan(0);
        expect(at, `${name} @${at}`).toBeLessThanOrEqual(out.text.length);
        // Never in the middle of a run of whitespace: a page starts on text.
        expect(/\s/.test(out.text[at] ?? 'x'), `${name} @${at}`).toBe(false);
      }
      expect([...out.pageBreaks], name).toEqual([...out.pageBreaks].sort((a, b) => a - b));
    }
  });

  it('measures the cap in bytes, not in characters', async () => {
    // Half a megabyte of accented text is a megabyte of UTF-8, and a cap that
    // counted characters would accept a document the store then refuses.
    const accented = Buffer.from('é'.repeat(MAX_DOCUMENT_BYTES / 2 + 10), 'utf8');
    await expect(
      extractInProcess({ name: 'a.txt', mime: 'text/plain', data: accented }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });
});
