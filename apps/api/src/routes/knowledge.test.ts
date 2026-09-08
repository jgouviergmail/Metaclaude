/**
 * The knowledge library over HTTP, end to end.
 *
 * A real server, a real database, real files on a real temporary disk — the
 * only stand-in is the extractor, which runs on this thread instead of in a
 * worker because a worker loads a built file and this suite runs from
 * TypeScript. The extraction itself is the real one.
 *
 * The cases below are the ones a unit test cannot reach: what status an
 * operator is given, what the audit log records, whether the file on disk
 * survives its document, and whether the body a browser actually sends is
 * accepted at the edge.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KnowledgeDocumentMeta, KnowledgeSearchHit } from '@metaclaude/shared';

import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let workspaceId: string;

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../learning/extract/fixtures/${name}`, import.meta.url));

const GLOBAL = { global: true, workspaceIds: [] as string[] };

const upload = (name: string, extra: Record<string, unknown> = {}) =>
  server.send('POST', '/api/knowledge/upload', {
    name,
    mime: '',
    data: fixture(name).toString('base64'),
    reach: GLOBAL,
    ...extra,
  });

const listAll = async (): Promise<KnowledgeDocumentMeta[]> =>
  (await server.get<{ documents: KnowledgeDocumentMeta[] }>('/api/knowledge')).documents;

beforeAll(async () => {
  server = await bootTestServer({ name: 'knowledge-routes' });
  const created = await server.send('POST', '/api/workspaces', {
    name: 'Alpha',
    description: '',
  });
  workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
});

afterAll(async () => {
  await server.close();
});

describe('uploading a file', () => {
  it('reads a .docx into a titled document with its sections, source and lines', async () => {
    const response = await upload('bail.docx');
    expect(response.status).toBe(201);

    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document).toMatchObject({
      // The title defaults to the file's name without its extension.
      title: 'bail',
      isGlobal: true,
      workspaceIds: [],
      source: { name: 'bail.docx', extractor: expect.stringMatching(/^docx@/) },
      pageUnit: null,
    });
    expect(document.chunkCount).toBeGreaterThan(0);

    const hits = await server.get<{ results: KnowledgeSearchHit[] }>(
      '/api/knowledge/search?q=préavis résiliation',
    );
    expect(hits.results.length).toBeGreaterThan(0);
    const hit = hits.results[0]!;
    expect(hit.heading).toBe('Résiliation par le locataire');
    expect(hit.lineStart).toBeGreaterThan(0);
    expect(hit.sourceName).toBe('bail.docx');
  });

  it('takes the title the operator typed instead of the file name', async () => {
    const response = await upload('sample.md', { title: 'Nos conventions' });
    expect(response.status).toBe(201);
    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document.title).toBe('Nos conventions');
  });

  it('gives a PDF a page for every passage to be cited by', async () => {
    const response = await upload('assurance.pdf');
    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document).toMatchObject({ pageUnit: 'page', pageCount: 3 });

    const hits = await server.get<{ results: KnowledgeSearchHit[] }>(
      '/api/knowledge/search?q=franchise sinistre',
    );
    const fromPdf = hits.results.find((one) => one.documentId === document.id);
    expect(fromPdf?.pageStart).toBeGreaterThan(0);
  });

  it('answers 409 with the document that already holds those bytes', async () => {
    const first = (await (await upload('loyers.xlsx')).json()) as { document: KnowledgeDocumentMeta };
    const again = await upload('loyers.xlsx', { title: 'Une copie' });

    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: string; document: KnowledgeDocumentMeta };
    expect(body.document.id).toBe(first.document.id);
    expect(body.error).toContain(first.document.title);
    expect((await listAll()).filter((one) => one.source?.name === 'loyers.xlsx')).toHaveLength(1);
  });

  it('keeps the original when the same file arrives twice at once', async () => {
    // The duplicate check is a read, not a lock: two requests hash the same
    // bytes, both ask whether that hash is known, both are told no, and both
    // carry on. The unique index refuses the second row — correctly — and its
    // cleanup then deletes the file *by hash*, which is the file the first
    // document had just been given. What is left is a document whose original
    // is gone: no download, no re-extraction, and nothing on screen to say
    // why. Two tabs, or one impatient double click.
    // Bytes of its own, because the suite shares one server: a fixture an
    // earlier case has already uploaded is caught by the *pre*-check, and
    // both requests would then take the path this one exists to avoid.
    const data = Buffer.from('# Course\n\nDeux requêtes pour un seul fichier.').toString('base64');
    const race = () =>
      server.send('POST', '/api/knowledge/upload', {
        name: 'course.md',
        mime: '',
        data,
        reach: GLOBAL,
      });
    const [a, b] = await Promise.all([race(), race()]);
    const created = [a, b].filter((response) => response.status === 201);
    expect(created).toHaveLength(1);

    const { document } = (await created[0]!.json()) as { document: KnowledgeDocumentMeta };
    const original = await server.send('GET', `/api/knowledge/${document.id}/source`);
    expect(original.status).toBe(200);
    // Drained on purpose: the original is served as a stream, and a body left
    // unread keeps the connection busy and the file handle open, so the
    // server's own close waits on it for its full timeout.
    expect((await original.arrayBuffer()).byteLength).toBeGreaterThan(0);
    // And the one that lost the race is told what happened, not handed a 500.
    const loser = [a, b].find((response) => response.status !== 201)!;
    expect(loser.status).toBe(409);
  });

  it('refuses a type it cannot read with 415, naming what it accepts', async () => {
    const response = await server.send('POST', '/api/knowledge/upload', {
      name: 'archive.zip',
      mime: 'application/zip',
      data: Buffer.from('PK').toString('base64'),
      reach: GLOBAL,
    });
    expect(response.status).toBe(415);
    expect(((await response.json()) as { error: string }).error).toContain('.pdf');
  });

  it('refuses an empty file with 400 and an oversized one with 413', async () => {
    const empty = await server.send('POST', '/api/knowledge/upload', {
      name: 'a.txt',
      mime: 'text/plain',
      data: Buffer.from(' ').toString('base64'),
      reach: GLOBAL,
    });
    expect(empty.status).toBe(422);

    const huge = await server.send('POST', '/api/knowledge/upload', {
      name: 'a.txt',
      mime: 'text/plain',
      data: Buffer.alloc(21 * 1024 * 1024, 0x61).toString('base64'),
      reach: GLOBAL,
    });
    expect(huge.status).toBe(413);
  });

  it('refuses a scan by saying it is one, and writes nothing for it', async () => {
    // The bytes must not reach the disk before the extraction has succeeded:
    // an original no row names is invisible and unbounded. This is the *first*
    // upload of this file, so a leaked copy would show as a new name here —
    // a later attempt would write the same hash and prove nothing.
    const stored = join(server.dataDir, 'data', 'knowledge');
    const before = readdirSync(stored);

    const response = await upload('scan.pdf');

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/scan|OCR/i);
    expect(readdirSync(stored).sort()).toEqual(before.sort());
  });

  it('leaves no file behind when the store refuses what the extractor accepted', async () => {
    // The other half, and the one the `catch` in the route is for: the text
    // came out fine, the file is already written, and the row cannot be made.
    const stored = join(server.dataDir, 'data', 'knowledge');
    const before = readdirSync(stored);

    const response = await server.send('POST', '/api/knowledge/upload', {
      name: 'jamais-vu.txt',
      mime: 'text/plain',
      data: Buffer.from('un texte que rien d’autre ne contient, ici, aujourd’hui').toString('base64'),
      reach: GLOBAL,
      title: '   ',
    });

    expect(response.status).toBe(400);
    expect(readdirSync(stored).sort()).toEqual(before.sort());
  });

  it('stores the file under the data directory, named by its hash', async () => {
    const response = await upload('deploiement.pptx');
    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document.source?.name).toBe('deploiement.pptx');

    const source = await server.send('GET', `/api/knowledge/${document.id}/source`);
    expect(source.status).toBe(200);
    expect(source.headers.get('content-disposition')).toContain('attachment');
    expect(source.headers.get('content-disposition')).toContain('deploiement.pptx');
    expect(source.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await source.arrayBuffer())).toEqual(fixture('deploiement.pptx'));
  });

  it('offers a PDF inline and everything else as a download', async () => {
    // The attachments rule, for the attachments reason: an uploaded .html
    // served inline on this origin would run its scripts with the app's
    // cookies.
    const documents = await listAll();
    const pdf = documents.find((one) => one.source?.mime === 'application/pdf')!;
    const other = documents.find((one) => one.source?.mime === 'text/markdown')!;

    // Each body is drained rather than dropped: the original is served as a
    // stream, and an unread one keeps the connection busy and the file handle
    // open — so whichever test happens to run last leaves `server.close()`
    // waiting for its whole timeout, which reads as a hung suite.
    const disposition = async (id: string): Promise<string> => {
      const response = await server.send('GET', `/api/knowledge/${id}/source`);
      const header = response.headers.get('content-disposition') ?? '';
      await response.arrayBuffer();
      return header;
    };

    expect(await disposition(pdf.id)).toContain('inline');
    expect(await disposition(other.id)).toContain('attachment');
  });

  it('404s the original of a document that never had one', async () => {
    const pasted = await server.send('POST', '/api/knowledge', {
      title: 'Collé',
      content: 'Un texte tapé à la main.',
      reach: GLOBAL,
    });
    const { document } = (await pasted.json()) as { document: KnowledgeDocumentMeta };
    expect(document.source).toBeNull();
    expect((await server.send('GET', `/api/knowledge/${document.id}/source`)).status).toBe(404);
  });

  it('records an audit line naming the file', async () => {
    const entries = await server.get<{ entries: Array<{ action: string; detail: string | null }> }>(
      '/api/audit?limit=200&action=knowledge.upload',
    );
    expect(entries.entries.length).toBeGreaterThan(0);
    expect(entries.entries.some((one) => one.detail?.includes('bail.docx'))).toBe(true);
    // The count of passages is in there too: an operator reading the log can
    // tell an upload that indexed nothing from one that worked.
    expect(entries.entries.some((one) => /\d+ passages/.test(one.detail ?? ''))).toBe(true);
  });
});

describe('changing a document without retyping it', () => {
  let documentId: string;

  beforeAll(async () => {
    const response = await server.send('POST', '/api/knowledge', {
      title: 'À modifier',
      content: '# Titre\n\nUn contenu de départ, à propos du dépôt de garantie.',
      reach: GLOBAL,
    });
    documentId = ((await response.json()) as { document: KnowledgeDocumentMeta }).document.id;
  });

  it('pauses through a patch, without the text making the round trip', async () => {
    const response = await server.send('PATCH', `/api/knowledge/${documentId}`, { enabled: false });
    expect(response.status).toBe(200);
    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document.enabled).toBe(false);
    expect(document.title).toBe('À modifier');
  });

  it('renames and re-aims in one patch', async () => {
    const response = await server.send('PATCH', `/api/knowledge/${documentId}`, {
      title: 'Renommé',
      enabled: true,
      reach: { global: false, workspaceIds: [workspaceId] },
    });
    expect(response.status).toBe(200);
    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document).toMatchObject({
      title: 'Renommé',
      enabled: true,
      isGlobal: false,
      workspaceIds: [workspaceId],
    });
  });

  it('a patch naming nothing changes nothing and still answers', async () => {
    const response = await server.send('PATCH', `/api/knowledge/${documentId}`, {});
    expect(response.status).toBe(200);
    expect(((await response.json()) as { document: KnowledgeDocumentMeta }).document.title).toBe(
      'Renommé',
    );
  });

  it('404s a patch on a document that does not exist', async () => {
    expect((await server.send('PATCH', '/api/knowledge/doc_missing', { enabled: true })).status).toBe(
      404,
    );
  });

  it('refuses a patch that would empty the title', async () => {
    expect((await server.send('PATCH', `/api/knowledge/${documentId}`, { title: '  ' })).status).toBe(
      400,
    );
  });
});

describe('re-extracting from the file that was kept', () => {
  it('reads the original again and reports which engine did it', async () => {
    const uploaded = (await (await upload('sample.csv')).json()) as {
      document: KnowledgeDocumentMeta;
    };

    const response = await server.send('POST', `/api/knowledge/${uploaded.document.id}/extract`);
    expect(response.status).toBe(200);
    const { document } = (await response.json()) as { document: KnowledgeDocumentMeta };
    expect(document.source?.extractor).toMatch(/^csv@/);
    expect(document.chunkCount).toBeGreaterThan(0);
  });

  it('404s a re-extraction of a document that never had a file', async () => {
    const pasted = (await (
      await server.send('POST', '/api/knowledge', {
        title: 'Sans fichier',
        content: 'Rien à ré-extraire ici.',
        reach: GLOBAL,
      })
    ).json()) as { document: KnowledgeDocumentMeta };

    expect((await server.send('POST', `/api/knowledge/${pasted.document.id}/extract`)).status).toBe(404);
  });

  it('refuses an edit of a file-backed document, and says to re-extract instead', async () => {
    const documents = await listAll();
    const fromFile = documents.find((one) => one.source !== null)!;

    const response = await server.send('POST', '/api/knowledge', {
      id: fromFile.id,
      title: fromFile.title,
      content: 'Un texte réécrit à la main.',
      reach: GLOBAL,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/re-extract/i);
  });
});

describe('deleting a document', () => {
  it('takes its original off the disk with it', async () => {
    const created = await upload('sample.html');
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as { document: KnowledgeDocumentMeta };

    // The harness's `dataDir` is the parent; METACLAUDE_DATA_DIR is `data`
    // inside it, and the library's files sit under that.
    const stored = join(server.dataDir, 'data', 'knowledge');
    expect(existsSync(stored)).toBe(true);
    // Establish that the original *is* there before claiming it went — the
    // rehearsal lesson: an assertion on an absence has to know what absence.
    expect((await server.send('GET', `/api/knowledge/${document.id}/source`)).status).toBe(200);

    expect((await server.send('DELETE', `/api/knowledge/${document.id}`)).status).toBe(200);

    expect((await server.send('GET', `/api/knowledge/${document.id}/source`)).status).toBe(404);
    expect((await listAll()).some((one) => one.id === document.id)).toBe(false);
    expect(readdirSync(stored).some((file) => file.endsWith('.html'))).toBe(false);
  });

  it('lets the same file be uploaded again afterwards', async () => {
    // The 409 is about a document that exists, not about a hash that ever
    // did: deleting has to release the name.
    const response = await upload('sample.html');
    expect(response.status).toBe(201);
  });
});

describe('the listing and its scopes', () => {
  it('shows a workspace its own documents and the global shelf, and no more', async () => {
    const own = await server.get<{ documents: KnowledgeDocumentMeta[] }>(
      `/api/knowledge?workspaceId=${workspaceId}`,
    );
    expect(own.documents.some((one) => one.workspaceIds.includes(workspaceId))).toBe(true);
    expect(own.documents.every((one) => one.isGlobal || one.workspaceIds.includes(workspaceId))).toBe(
      true,
    );

    const global = await server.get<{ documents: KnowledgeDocumentMeta[] }>(
      '/api/knowledge?scope=global',
    );
    expect(global.documents.every((one) => one.isGlobal)).toBe(true);
  });

  it('serves the whole library when no scope is asked for', async () => {
    const all = await listAll();
    const global = await server.get<{ documents: KnowledgeDocumentMeta[] }>(
      '/api/knowledge?scope=global',
    );
    expect(all.length).toBeGreaterThan(global.documents.length);
  });
});
