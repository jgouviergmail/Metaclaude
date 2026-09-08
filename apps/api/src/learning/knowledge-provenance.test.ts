/**
 * A document that came from a file, and where each of its passages sits.
 *
 * Two facts the library gained together, because they depend on each other: a
 * document's text is now often something an *extractor* produced rather than
 * something a person typed, and a passage of it must be citable back to the
 * page and lines it came from. The second is what makes the first usable — a
 * quotation from a forty-page PDF that cannot say where it came from is a
 * quotation nobody can check.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate, openDatabase, type Db } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { KnowledgeStore, KnowledgeStoreError } from './knowledge.js';

let db: Db;
let store: KnowledgeStore;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  // The hashing embedder, like `knowledge.test.ts`: what is under test here is
  // where a passage sits and what file it came from, and a strict relevance
  // gate would turn a provenance assertion into a ranking assertion.
  store = new KnowledgeStore(db, new HashingEmbedder());
});

afterEach(() => db.close());

/** Where every passage of a document sits, in order. */
const locations = (documentId: string): unknown[] =>
  db
    .prepare(
      `SELECT page_start, page_end, line_start, line_end FROM document_chunks
       WHERE document_id = ? ORDER BY seq`,
    )
    .all(documentId);

/** A content of `n` pages and the break offsets that describe it. */
function paged(pages: readonly string[]): { content: string; pageBreaks: number[] } {
  const content = pages.join('\n\n');
  const pageBreaks: number[] = [];
  let at = 0;
  for (const page of pages.slice(0, -1)) {
    at += page.length + 2;
    pageBreaks.push(at);
  }
  return { content, pageBreaks };
}

describe('where each passage sits', () => {
  it('stamps every passage with its lines, even for a pasted document', async () => {
    const content = '# Titre\n\nPremière ligne du corps.\n\nDeuxième paragraphe, plus loin.';
    const document = await store.upsert({ workspaceId: null, title: 'Note', content });

    // One chunk: it starts on line 3 (the heading is line 1, the blank line 2)
    // and ends on line 5.
    expect(locations(document.id)).toEqual([
      { page_start: null, page_end: null, line_start: 3, line_end: 5 },
    ]);
  });

  it('stamps pages too, given a page map', async () => {
    const { content, pageBreaks } = paged([
      'Article 1.\nTout sinistre est déclaré sous cinq jours ouvrés suivant sa constatation.',
      'Article 2.\nUne franchise de 150 euros reste à la charge de l assuré.',
    ]);
    const document = await store.upsert({
      workspaceId: null,
      title: 'Assurance',
      content,
      pageBreaks,
      pageUnit: 'page',
    });

    // Five lines: the two article lines, their bodies, and the blank between.
    expect(locations(document.id)).toEqual([
      { page_start: 1, page_end: 2, line_start: 1, line_end: 5 },
    ]);
    expect(store.get(document.id)!.pageUnit).toBe('page');
  });

  it('gives a passage that spans four pages the span, not the first page', async () => {
    const { content, pageBreaks } = paged([
      'Page une.',
      'Page deux.',
      'Page trois.',
      'Page quatre et sa fin.',
    ]);
    const document = await store.upsert({
      workspaceId: null,
      title: 'Pages',
      content,
      pageBreaks,
      pageUnit: 'slide',
    });

    // Four short pages pack into one passage, and the honest answer is the
    // span: this passage genuinely covers slides 1 to 4.
    expect(locations(document.id)).toEqual([
      { page_start: 1, page_end: 4, line_start: 1, line_end: 7 },
    ]);
    expect(store.get(document.id)!.pageUnit).toBe('slide');
  });

  it('carries the location onto a search hit, ready to be cited', async () => {
    const { content, pageBreaks } = paged([
      'Article 1.\nLe délai de déclaration est de cinq jours ouvrés.',
      'Article 2.\nLa franchise applicable atteint 150 euros par sinistre.',
    ]);
    await store.upsert({
      workspaceId: null,
      title: 'Assurance',
      content,
      pageBreaks,
      pageUnit: 'page',
    });

    const [hit] = await store.search('franchise sinistre', { workspaceId: null });
    expect(hit).toMatchObject({
      documentTitle: 'Assurance',
      sourceName: null,
      pageUnit: 'page',
      pageStart: 1,
      lineStart: 1,
    });
  });

  it('puts a passage that ends at the last character on the page it ends on', async () => {
    // A PDF whose final page carries no text produces exactly this map: a
    // break at the very end of the content. The passage before it is on page
    // 1, and would be on page 2 if the closing page were read off the
    // exclusive end offset rather than off the last character.
    const content = 'Une page de texte et rien après.';
    const document = await store.upsert({
      workspaceId: null,
      title: 'Fin vide',
      content,
      pageBreaks: [content.length],
      pageUnit: 'page',
    });

    expect(locations(document.id)).toEqual([
      { page_start: 1, page_end: 1, line_start: 1, line_end: 1 },
    ]);
  });

  it('leaves a document with no page map unpaged, rather than guessing page 1', async () => {
    const document = await store.upsert({ workspaceId: null, title: 'Note', content: 'Du texte.' });
    expect(store.get(document.id)!.pageUnit).toBeNull();
    expect(locations(document.id)).toEqual([
      { page_start: null, page_end: null, line_start: 1, line_end: 1 },
    ]);
  });

  it('refuses a page map over content that is not already in normal form', async () => {
    // An extractor's offsets do not survive a trim applied after the fact, and
    // a silently shifted line number is worse than a refusal.
    await expect(
      store.upsert({
        workspaceId: null,
        title: 'T',
        content: '  du texte entouré de blancs  ',
        pageBreaks: [],
        pageUnit: 'page',
      }),
    ).rejects.toThrow(/normal form/i);
  });

  it('refuses a page break that falls outside the content', async () => {
    await expect(
      store.upsert({
        workspaceId: null,
        title: 'T',
        content: 'Court.',
        pageBreaks: [999],
        pageUnit: 'page',
      }),
    ).rejects.toThrow(/outside/i);
  });

  it('counts lines across a long document without drifting', async () => {
    // The counter walks the newlines once, in step with the chunks; a
    // per-chunk rescan would be quadratic and an off-by-one would compound.
    const paragraphs = Array.from(
      { length: 60 },
      (_, index) => `Paragraphe ${index} au sujet du thème ${index} et de sa résolution complète.`,
    );
    const content = paragraphs.join('\n\n');
    const document = await store.upsert({ workspaceId: null, title: 'Long', content });

    const rows = db
      .prepare<[string], { line_start: number; line_end: number }>(
        'SELECT line_start, line_end FROM document_chunks WHERE document_id = ? ORDER BY seq',
      )
      .all(document.id);

    expect(rows.length).toBeGreaterThan(2);
    const lines = content.split('\n');
    for (const row of rows) {
      expect(row.line_start).toBeGreaterThanOrEqual(1);
      expect(row.line_end).toBeLessThanOrEqual(lines.length);
      expect(row.line_end).toBeGreaterThanOrEqual(row.line_start);
    }
    // Each chunk begins after the previous one began, and the last reaches the end.
    expect(rows.map((row) => row.line_start)).toEqual([...rows.map((row) => row.line_start)].sort((a, b) => a - b));
    expect(rows.at(-1)!.line_end).toBe(lines.length);
  });
});

describe('a document that came from a file', () => {
  const source = {
    name: 'bail.pdf',
    mime: 'application/pdf',
    bytes: 1234,
    extractor: 'pdf@poppler-22.12.0',
    sha256: 'abc123',
  };

  const upload = (title = 'Bail', content = 'Le préavis de résiliation est de trois mois.') =>
    store.upsert({ workspaceId: null, title, content, source });

  it('remembers its file, and is findable by the hash of it', async () => {
    const document = await upload();

    expect(document.source).toEqual({
      name: 'bail.pdf',
      mime: 'application/pdf',
      bytes: 1234,
      extractor: 'pdf@poppler-22.12.0',
    });
    expect(store.findBySourceHash('abc123')?.id).toBe(document.id);
    expect(store.findBySourceHash('nope')).toBeNull();
    expect(store.sourceOf(document.id)).toEqual(source);
    expect(store.sourceOf('doc_missing')).toBeNull();
  });

  it('has no source at all when the text was pasted', async () => {
    const document = await store.upsert({ workspaceId: null, title: 'Note', content: 'Texte.' });
    expect(document.source).toBeNull();
    expect(store.sourceOf(document.id)).toBeNull();
  });

  it('refuses a second upload of the same bytes, naming the document that holds them', async () => {
    const first = await upload('Bail');

    await expect(upload('Bail bis', 'Un autre texte entièrement.')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Bail'),
    });
    expect(store.list({}).map((one) => one.id)).toEqual([first.id]);
  });

  it('answers the same 409 when the index catches what the check let through', async () => {
    // The pre-check reads, then writes, which is not one decision: two
    // uploads of a file racing each other both pass it, and the unique index
    // is what actually stops the second. A single-threaded test cannot stage
    // that race — but the *update* path reaches the same constraint, because
    // it skips the pre-check by design, so that is what is driven here.
    //
    // The loser must be told the same thing as somebody who simply tried
    // twice, not handed a constraint error that a 500 would report as a
    // broken server.
    const first = await upload('Le premier');
    const second = await store.upsert({
      workspaceId: null,
      title: 'Le second',
      content: 'Un autre document, avec son propre fichier.',
      source: { ...source, name: 'autre.pdf', sha256: 'def456' },
    });

    await expect(
      store.upsert({
        id: second.id,
        workspaceId: null,
        title: 'Le second',
        content: 'Un texte réécrit, pour forcer une écriture.',
        // The first document's file: the row is about to claim bytes another
        // row already holds.
        source: { ...source, sha256: 'abc123' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(first.title) });
  });

  it('keeps its text read-only: an edit of the content is refused', async () => {
    // The text is what the extractor produced, and the page and line locations
    // are true of that text alone. Re-extract, do not retype.
    const document = await upload();

    await expect(
      store.upsert({
        id: document.id,
        workspaceId: null,
        title: 'Bail',
        content: 'Un texte réécrit à la main.',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('accepts a save that leaves the text exactly as it was — that is a rename', async () => {
    // The refusal above must be on a *different* value, never on the field
    // being present: a form that round-trips the whole document would
    // otherwise be unable to change its title.
    const document = await upload();
    const renamed = await store.upsert({
      id: document.id,
      workspaceId: null,
      title: 'Bail 2026',
      content: document.content,
    });
    expect(renamed.title).toBe('Bail 2026');
    expect(renamed.source?.name).toBe('bail.pdf');
  });

  it('lets a re-extraction replace the text, because it carries the source', async () => {
    const document = await upload();

    const again = await store.upsert({
      id: document.id,
      workspaceId: null,
      title: 'Bail',
      content: 'Le préavis de résiliation est de trois mois, ramené à un mois en zone tendue.',
      source: { ...source, extractor: 'pdf@poppler-23.0.0' },
    });

    expect(again.source?.extractor).toBe('pdf@poppler-23.0.0');
    expect(again.content).toContain('zone tendue');
  });

  it('records a re-extraction that produced identical text, without re-embedding it', async () => {
    // The common case once an extractor is improved: most documents come out
    // byte for byte the same. The hash short-circuits the pipeline, and the
    // only thing that may still move is which engine read the file — or the
    // operator could never tell an already-upgraded document from a stale one.
    const document = await upload();
    const chunkIds = (): unknown[] =>
      db.prepare('SELECT id FROM document_chunks WHERE document_id = ?').all(document.id);
    const before = chunkIds();

    const again = await store.upsert({
      id: document.id,
      workspaceId: null,
      title: 'Bail',
      content: document.content,
      source: { ...source, extractor: 'pdf@poppler-23.0.0' },
    });

    expect(again.source?.extractor).toBe('pdf@poppler-23.0.0');
    expect(chunkIds()).toEqual(before);
  });

  it('keeps every passage location through a re-index', async () => {
    // Re-embedding writes vectors and nothing else; a pass that rewrote the
    // rows would silently drop the page and line of every passage in the
    // library, and no citation would ever say so.
    const { content, pageBreaks } = paged(['Page une, un texte.', 'Page deux, un autre.']);
    const document = await store.upsert({
      workspaceId: null,
      title: 'Doc',
      content,
      pageBreaks,
      pageUnit: 'page',
    });
    const before = locations(document.id);
    expect(before).not.toEqual([]);

    // A different embedder makes every row stale, which is what `reindex`
    // exists for.
    const other = new KnowledgeStore(db, new HashingEmbedder(64));
    expect(await other.reindex()).toBeGreaterThan(0);

    expect(locations(document.id)).toEqual(before);
  });

  it('patches the title and the pause without touching the text or the chunks', async () => {
    const document = await upload();
    const chunkIds = (): unknown[] =>
      db
        .prepare('SELECT id FROM document_chunks WHERE document_id = ? ORDER BY seq')
        .all(document.id);
    const before = chunkIds();

    expect(store.patch(document.id, { title: 'Bail 2026', enabled: false })).toBe(true);

    const after = store.get(document.id)!;
    expect(after.title).toBe('Bail 2026');
    expect(after.enabled).toBe(false);
    expect(after.content).toBe(document.content);
    expect(chunkIds()).toEqual(before);
  });

  it('answers false for a patch on a document that does not exist', () => {
    expect(store.patch('doc_missing', { title: 'x' })).toBe(false);
    expect(store.patch('doc_missing', {})).toBe(false);
  });

  it('refuses a patch that would leave the document without a title', async () => {
    const document = await upload();
    expect(() => store.patch(document.id, { title: '   ' })).toThrow(KnowledgeStoreError);
  });

  it('a patch naming nothing still says whether the document exists', async () => {
    const document = await upload();
    expect(store.patch(document.id, {})).toBe(true);
  });

  it('reports the highest page any of its passages reaches', async () => {
    const { content, pageBreaks } = paged([
      'Page une, avec du texte.',
      'Page deux.',
      'Page trois et sa conclusion.',
    ]);
    const document = await store.upsert({
      workspaceId: null,
      title: 'Doc',
      content,
      pageBreaks,
      pageUnit: 'page',
      source,
    });

    expect(store.list({}).find((one) => one.id === document.id)).toMatchObject({
      pageCount: 3,
      pageUnit: 'page',
      source: { name: 'bail.pdf', bytes: 1234 },
    });
  });

  it('has no page count when it has no pages', async () => {
    await upload();
    expect(store.list({})[0]).toMatchObject({ pageCount: null, pageUnit: null, source: {} });
  });

  it('names the source file on every passage it retrieves', async () => {
    await upload('Bail', 'Le préavis de résiliation est de trois mois en zone tendue.');
    const [hit] = await store.search('préavis résiliation', { workspaceId: null });
    expect(hit?.sourceName).toBe('bail.pdf');
  });
});
