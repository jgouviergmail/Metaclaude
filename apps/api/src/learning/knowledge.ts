/**
 * The knowledge library — reference documents, chunked and retrieved.
 *
 * This is the other half of retrieval, next to `MemoryStore`, and the split
 * is the point rather than an accident of history:
 *
 *  - a **memory** is something the system distilled — short, scored by
 *    confidence, reinforced when it helps and *forgotten* when it stops
 *    helping;
 *  - a **document** is something the operator handed over — a lease, a spec,
 *    a runbook — that must say tomorrow exactly what it says today. No decay,
 *    no confidence, no reaping. Reference material that quietly faded would
 *    be the worst failure this store could have.
 *
 * What the two share, they share by construction: the embedding provider,
 * the measured relevance floors, the fts5 configuration and the RRF fusion
 * all come from the same modules (`embeddings.ts`, `retrieval.ts`), so a
 * lesson learned once — the IDF clamp, the provider-relative cosine scale —
 * holds in both places. Scoping is the memory rule too: `workspaceId: null`
 * is the global shelf every workspace sees; a concrete id reads that
 * workspace's shelf *plus* the global one.
 *
 * Retrieval returns chunks, not documents: a run wants the two passages
 * about the notice period, not the forty-page lease around them.
 */

import { createHash } from 'node:crypto';

import { newId } from '@metaclaude/shared';
import type {
  ExtensionReach,
  KnowledgeLocation,
  KnowledgePageUnit,
  KnowledgeSource,
} from '@metaclaude/shared';

import type { Db } from '../db/index.js';
import { packEmbedding, toBool, tx, unpackEmbedding } from '../db/index.js';
import { chunkDocument, chunkEmbeddingText, type Chunk } from './chunker.js';
import { cosineSimilarity, type EmbeddingProvider, PENDING_EMBEDDING_MODEL } from './embeddings.js';
import {
  MIN_ABSOLUTE_BM25,
  MIN_ABSOLUTE_SIMILARITY,
  RELATIVE_SIMILARITY_FLOOR,
  rrfFuse,
  toFtsQuery,
  fuseRankings,
  retrievalProfile,
  DENSE_SOLO_FLOOR,
} from './retrieval.js';

/**
 * One document, as stored. `content` is the text as it will be retrieved —
 * the operator's, verbatim, or an extractor's output for an uploaded file.
 */
export interface KnowledgeDocument {
  id: string;
  /** Where it was first filed. The reach is `isGlobal` + `workspaceIds`. */
  workspaceId: string | null;
  title: string;
  content: string;
  enabled: boolean;
  chunkCount: number;
  /** The embedder these chunks were vectorised with; `''` while they wait for one. */
  embeddingModel: string;
  /** Every workspace, including any created later. */
  isGlobal: boolean;
  /** The workspaces it is attached to when it is not global; may be empty. */
  workspaceIds: string[];
  /** The uploaded file its text came from; null for pasted text. */
  source: KnowledgeSource | null;
  pageUnit: KnowledgePageUnit | null;
  createdAt: number;
  updatedAt: number;
}

/** A source with the hash that names its file on disk. */
export interface StoredSource extends KnowledgeSource {
  sha256: string;
}

/** The listing shape: everything but the content, plus its size in bytes —
 * `CAST AS BLOB` in the query, because SQLite's length() on TEXT counts
 * characters and the UI formats this with formatBytes. */
export interface KnowledgeDocumentMeta {
  id: string;
  workspaceId: string | null;
  title: string;
  contentLength: number;
  enabled: boolean;
  chunkCount: number;
  /** The embedder these chunks were vectorised with; `''` while they wait for one. */
  embeddingModel: string;
  isGlobal: boolean;
  workspaceIds: string[];
  source: KnowledgeSource | null;
  pageUnit: KnowledgePageUnit | null;
  /** The highest page any of its passages reaches; null when it has no pages. */
  pageCount: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One retrieved passage, with enough context to be read *and cited* on its own. */
export interface KnowledgeSearchResult extends KnowledgeLocation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  /** The original file's name, when the document came from one. */
  sourceName: string | null;
  workspaceId: string | null;
  heading: string;
  text: string;
  score: number;
}

/**
 * One passage a finished run was shown, as the genesis reads it back.
 *
 * `replaced` is true when the document has been edited or re-extracted since:
 * the citation still names what the run saw, and says the text behind it has
 * moved. A replaced passage keeps no heading and no location, because both
 * lived on the chunk that is gone.
 */
export interface ConsultedPassage extends KnowledgeLocation {
  chunkId: string;
  documentId: string;
  title: string;
  heading: string;
  score: number;
  replaced: boolean;
}

interface ConsultedRow {
  chunk_id: string;
  document_id: string;
  title: string;
  page_unit: KnowledgePageUnit | null;
  heading: string | null;
  page_start: number | null;
  page_end: number | null;
  line_start: number | null;
  line_end: number | null;
  score: number;
  /** SQLite has no boolean: `(c.id IS NULL)` comes back as 0 or 1. */
  replaced: number;
}

export interface KnowledgeRetrievalOptions {
  /** null = global shelf only; a concrete id = that workspace plus global. */
  workspaceId?: string | null;
  /**
   * A set of workspaces' shelves and only those — the global one excluded,
   * because the asking run already has it. What a run reads from its peers
   * without starting a run there. Mutually exclusive with `workspaceId`.
   */
  workspaceIds?: string[];
  /**
   * Whether a `workspaceIds` scope also carries the global shelf. Off by
   * default: the in-run caller already has it. The gateway asks for it, having
   * nothing yet — see `RetrievalOptions.includeGlobal`.
   */
  includeGlobal?: boolean;
  limit?: number;
  candidatePool?: number;
  minSimilarity?: number;
}

export { DENSE_SOLO_FLOOR } from './retrieval.js';

/**
 * At most this many passages of one document in a result list: a query that
 * matches one document hard must not fill the whole budget with slices of it
 * while the second-best document goes unheard. Diversity is part of
 * relevance. A pure function on purpose — in integration the relevance gates
 * usually diversify on their own (three fixtures in a row failed to make the
 * cap bind), so only a direct test can prove the guard exists at all.
 */
export const MAX_PASSAGES_PER_DOCUMENT = 2;

export function capPerDocument(
  results: readonly KnowledgeSearchResult[],
  max: number = MAX_PASSAGES_PER_DOCUMENT,
): KnowledgeSearchResult[] {
  const perDocument = new Map<string, number>();
  return results.filter((entry) => {
    const seen = perDocument.get(entry.documentId) ?? 0;
    if (seen >= max) return false;
    perDocument.set(entry.documentId, seen + 1);
    return true;
  });
}

/** Documents are bounded like notes are: a corpus, not a filesystem. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const MAX_TITLE_LENGTH = 300;

export class KnowledgeStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'KnowledgeStoreError';
  }
}

interface DocumentRow {
  id: string;
  workspace_id: string | null;
  title: string;
  content: string;
  content_hash: string;
  enabled: number;
  chunk_count: number;
  embedding_model: string;
  is_global: number;
  source_name: string | null;
  source_mime: string | null;
  source_bytes: number | null;
  source_sha256: string | null;
  extractor: string | null;
  page_unit: KnowledgePageUnit | null;
  created_at: number;
  updated_at: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  heading: string;
  text: string;
  embedding: Buffer | null;
  page_start: number | null;
  page_end: number | null;
  line_start: number | null;
  line_end: number | null;
}

/** The four source columns as one value, or null when the text was pasted. */
function sourceOfRow(row: DocumentRow): KnowledgeSource | null {
  if (row.source_sha256 === null) return null;
  return {
    name: row.source_name ?? '',
    mime: row.source_mime ?? '',
    bytes: row.source_bytes ?? 0,
    extractor: row.extractor ?? '',
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * What a workspace reaches, spelled once.
 *
 * The listing and retrieval must agree exactly, or a document is visible in a
 * list and invisible to the runs of the same workspace — or the reverse,
 * which is worse. Both build their WHERE from these two constants, with
 * `documents` aliased `d`.
 */
const REACH_OF_WORKSPACE =
  '(d.is_global = 1 OR d.id IN (SELECT document_id FROM document_workspaces WHERE workspace_id = ?))';
const GLOBAL_ONLY = 'd.is_global = 1';

/**
 * The scope half of a query: `undefined` is every document — the whole
 * library, including any attached to nothing, which is what a management view
 * needs — `null` is the global shelf alone, an id is that workspace plus the
 * global shelf. The same three-way convention the registry uses.
 *
 * A *set* of ids is the fourth, and it is not the others repeated: it reads
 * those workspaces' shelves and deliberately **not** the global one, because
 * the caller is a run that already receives the global shelf and would be paid
 * twice for it. `IN (...)` inside the subquery rather than a join, so a
 * document reaching two of them comes back once — a join multiplies it by its
 * links, and a passage quoted twice is budget spent saying one thing. An empty
 * set is `0 = 1`: "no peers to ask" must never read as "no filter".
 */
function reachClause(
  workspaceId: string | null | undefined,
  workspaceIds?: readonly string[],
  includeGlobal = false,
): { sql: string; params: string[] } {
  if (workspaceIds) {
    if (workspaceIds.length === 0) {
      return includeGlobal ? { sql: GLOBAL_ONLY, params: [] } : { sql: '0 = 1', params: [] };
    }
    const list = `d.id IN (SELECT document_id FROM document_workspaces WHERE workspace_id IN (${workspaceIds
      .map(() => '?')
      .join(',')}))`;
    return {
      sql: includeGlobal ? `(${GLOBAL_ONLY} OR ${list})` : list,
      params: [...workspaceIds],
    };
  }
  if (workspaceId === undefined) return { sql: '', params: [] };
  if (workspaceId === null) return { sql: GLOBAL_ONLY, params: [] };
  return { sql: REACH_OF_WORKSPACE, params: [workspaceId] };
}

/**
 * The 1-based line of an offset.
 *
 * A closure over a moving cursor rather than a `slice().split()` per chunk:
 * offsets arrive in increasing order, so one walk over the newlines answers
 * every chunk of a document, where the obvious version is quadratic in a
 * corpus whose documents run to half a megabyte.
 */
function lineCounter(content: string): (offset: number) => number {
  let line = 1;
  let cursor = 0;
  return (offset) => {
    const bounded = Math.max(0, Math.min(offset, content.length));
    while (cursor < bounded) {
      if (content.charCodeAt(cursor) === 10) line += 1;
      cursor += 1;
    }
    return line;
  };
}

/** The 1-based page of an offset: page `i + 2` starts at `breaks[i]`. */
function pageCounter(breaks: readonly number[]): (offset: number) => number {
  return (offset) => {
    let page = 1;
    for (const at of breaks) {
      if (offset < at) break;
      page += 1;
    }
    return page;
  };
}

/**
 * Up to this many chunks a document is embedded inside the request that
 * saves it. Measured on bge-m3: about 0.1 s per chunk here, three times that
 * on the server, so eight chunks hold a save under three seconds there. A
 * larger document is written at once and vectorised by the background
 * rebuild — the same path every pending row travels after a change of model.
 */
export const INLINE_EMBED_CEILING = 8;

export interface KnowledgeStoreOptions {
  /**
   * Asked to run the background rebuild for a document written pending.
   * Absent — a bench, a script, a test — every document is embedded inline,
   * which is the old contract and still the right one where nobody would
   * come back for the vectors.
   */
  embedLater?: (documentId: string) => void;
}

export class KnowledgeStore {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly now: () => number = () => Date.now(),
    private readonly options: KnowledgeStoreOptions = {},
  ) {}

  /**
   * Create or update a document, re-chunking and re-embedding as needed.
   *
   * Identical content under the same embedder skips the whole pipeline — the
   * hash decides, so re-saving a document to fix its title costs a metadata
   * write, not an embedding pass.
   *
   * `pageBreaks` and `pageUnit` come from an extractor and describe *this*
   * exact text; `source` names the file it was extracted from. `reach` is
   * optional and means two different things on purpose: absent on an update
   * leaves the reach alone (a form saving a title must not narrow a reach it
   * never showed), absent on a creation derives it from `workspaceId`, which
   * is the contract every caller written before the reach existed still
   * speaks.
   */
  async upsert(input: {
    id?: string;
    workspaceId: string | null;
    title: string;
    content: string;
    enabled?: boolean;
    reach?: ExtensionReach;
    /** Offsets into `content` where each page after the first begins. */
    pageBreaks?: readonly number[];
    pageUnit?: KnowledgePageUnit | null;
    /** The file this text was extracted from, hash included. */
    source?: StoredSource | null;
  }): Promise<KnowledgeDocument> {
    const title = input.title.trim();
    const content = input.content.replace(/\r\n?/g, '\n').trim();
    if (!title) throw new KnowledgeStoreError('A document needs a title.');
    if (title.length > MAX_TITLE_LENGTH) throw new KnowledgeStoreError('That title is an essay.');
    if (!content) throw new KnowledgeStoreError('A document needs content.');
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new KnowledgeStoreError(
        `A document is capped at ${MAX_DOCUMENT_BYTES / 1024} KiB of text. Split it, or keep the part the agent actually needs.`,
      );
    }

    // A page map describes the text an extractor produced, character for
    // character. Normalising underneath it would shift every offset by the
    // length of whatever was trimmed, and a quietly wrong line number is
    // worse than a refusal — so the caller hands over normal form or nothing.
    if (input.pageBreaks) {
      if (content !== input.content) {
        throw new KnowledgeStoreError(
          'A page map needs content already in normal form; the offsets would not survive normalising it.',
          500,
        );
      }
      for (const at of input.pageBreaks) {
        if (!Number.isInteger(at) || at < 0 || at > content.length) {
          throw new KnowledgeStoreError(`A page break at ${at} falls outside the content.`, 500);
        }
      }
    }

    const existing = input.id ? this.rowById(input.id) : null;
    if (input.id && !existing) throw new KnowledgeStoreError('Document not found.', 404);

    const hash = sha256(content);
    const at = this.now();
    const id = existing?.id ?? newId('document');
    const enabled = input.enabled ?? (existing ? toBool(existing.enabled) : true);

    // A file's text is what its extractor produced, and the page and line
    // locations are true of that text alone. Refused on a *different* value,
    // never on the field being present: a form that round-trips the whole
    // document must still be able to change its title.
    if (existing?.source_sha256 && !input.source && existing.content_hash !== hash) {
      throw new KnowledgeStoreError(
        'This document comes from a file. Re-extract it rather than editing its text.',
        409,
      );
    }

    // One document per file, checked here so the message can name the one that
    // already holds those bytes — the unique index alone would say "constraint
    // failed", which a 500 would then report as a broken server.
    //
    // The check is not the guarantee: two uploads of one file racing through
    // this line both pass it, and the index is what actually stops the second.
    // `duplicateOf` below turns that constraint back into this same answer,
    // so the loser of the race is told the same thing as somebody who simply
    // tried twice.
    if (input.source && !existing) {
      const duplicate = this.findBySourceHash(input.source.sha256);
      if (duplicate) throw this.duplicateOf(duplicate.title);
    }

    // Null on a creation only when the caller gave neither: `attachOnCreate`,
    // the registry's rule, so nothing written before the reach existed breaks.
    const reach: ExtensionReach | null =
      input.reach ??
      (existing
        ? null
        : input.workspaceId === null
          ? { global: true, workspaceIds: [] }
          : { global: false, workspaceIds: [input.workspaceId] });

    const source = input.source ?? null;

    const unchanged =
      existing !== null &&
      existing.content_hash === hash &&
      existing.embedding_model === this.embedder.id;

    if (unchanged) {
      tx(this.db, () => {
        this.db
          .prepare(
            // `workspace_id` is absent on purpose: it records where a document
            // was *first filed* and nothing resolves with it, so a save
            // carrying the form's default must not rewrite it.
            //
            // The source columns are here because both branches have to answer
            // the same question the same way: a caller handing over a source
            // is saying this document came from a file, and the short path
            // used to keep the engine's name and drop the file itself.
            `UPDATE documents SET title = ?, enabled = ?, updated_at = ?,
               source_name = COALESCE(?, source_name), source_mime = COALESCE(?, source_mime),
               source_bytes = COALESCE(?, source_bytes), source_sha256 = COALESCE(?, source_sha256),
               extractor = COALESCE(?, extractor)
             WHERE id = ?`,
          )
          .run(
            title,
            enabled ? 1 : 0,
            at,
            source?.name ?? null,
            source?.mime ?? null,
            source?.bytes ?? null,
            source?.sha256 ?? null,
            source?.extractor ?? null,
            id,
          );
        if (reach) this.writeReach(id, reach);
      });
      return this.toDocument(this.rowById(id)!);
    }

    // Chunk and embed *outside* the transaction: embedding is async and slow,
    // and better-sqlite3 transactions are synchronous — holding one across an
    // await is not even expressible. The transaction below is the whole write.
    const chunks = chunkDocument(content);
    // Not the same emptiness as the one refused above, and it used to say so
    // in the same words. There *is* text here — the chunker simply makes no
    // passage out of it, which happens for exactly one shape: a document that
    // is only headings. A stub note, an outline, a spreadsheet export whose
    // header row has nothing under it. Told "a document needs content" about
    // a file whose text is on screen, an operator reads it as the upload
    // having lost their document.
    if (chunks.length === 0) {
      throw new KnowledgeStoreError(
        'This document is only headings, with no text under them to index.',
      );
    }
    // Text now, vectors when the model is ready: the fts index makes the
    // document findable at once, the document is marked pending and
    // `reindex` embeds its chunks later. `unchanged` above compares the
    // model id, so a pending document re-saved unchanged is re-processed.
    const inline =
      this.embedder.ready && (!this.options.embedLater || chunks.length <= INLINE_EMBED_CEILING);
    const vectors = inline
      ? await this.embedder.embedBatch(chunks.map((chunk) => chunkEmbeddingText(title, chunk)))
      : null;
    const model = vectors ? this.embedder.id : PENDING_EMBEDDING_MODEL;

    // Locations: one walk over the newlines for the whole document, and a
    // page lookup that is a no-op without a map. Computed here, beside the
    // chunks they describe, rather than in the transaction below.
    const lineAt = lineCounter(content);
    const pageAt = input.pageBreaks ? pageCounter(input.pageBreaks) : null;
    const located = chunks.map((chunk) => {
      // `end` is exclusive; the last *character* is what decides the closing
      // line and page, or a chunk ending exactly on a newline would claim the
      // line after it.
      const last = Math.max(chunk.start, chunk.end - 1);
      return {
        chunk,
        lineStart: lineAt(chunk.start),
        lineEnd: lineAt(last),
        pageStart: pageAt ? pageAt(chunk.start) : null,
        pageEnd: pageAt ? pageAt(last) : null,
      };
    });

    try {
      this.write({ id, existing, input, title, content, hash, enabled, at, model, chunks: located, vectors, reach, source });
    } catch (error) {
      // The other end of the race above: whoever lost it gets the same
      // sentence, not a constraint message dressed as a server fault.
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' && input.source) {
        const holder = this.findBySourceHash(input.source.sha256);
        throw this.duplicateOf(holder?.title ?? '');
      }
      throw error;
    }
    // Written, findable, and waiting: hand the vectors to the rebuild.
    if (!vectors) this.options.embedLater?.(id);

    return this.toDocument(this.rowById(id)!);
  }

  /** One 409, whichever guard reached it. */
  private duplicateOf(title: string): KnowledgeStoreError {
    return new KnowledgeStoreError(
      title
        ? `This file is already in the library as “${title}”.`
        : 'This file is already in the library.',
      409,
    );
  }

  /** The whole write, in one transaction. Extracted so `upsert` can catch it. */
  private write(args: {
    id: string;
    existing: DocumentRow | null;
    input: { workspaceId: string | null; pageUnit?: KnowledgePageUnit | null };
    title: string;
    content: string;
    hash: string;
    enabled: boolean;
    at: number;
    model: string;
    chunks: Array<{
      chunk: Chunk;
      lineStart: number;
      lineEnd: number;
      pageStart: number | null;
      pageEnd: number | null;
    }>;
    vectors: Float32Array[] | null;
    reach: ExtensionReach | null;
    source: StoredSource | null;
  }): void {
    const { id, existing, input, title, content, hash, enabled, at, model, vectors, reach, source } =
      args;
    const located = args.chunks;
    tx(this.db, () => {
      if (existing) {
        // Chunks are replaced wholesale: diffing chunk boundaries against an
        // edit is complexity with no payoff at this corpus size, and the fts
        // triggers keep the index true either way.
        this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id);
        this.db
          .prepare(
            // No `workspace_id`: see the unchanged branch above — it is the
            // record of where this document was first filed, not a reach.
            `UPDATE documents SET title = ?, content = ?, content_hash = ?,
               enabled = ?, chunk_count = ?, embedding_model = ?, updated_at = ?,
               page_unit = ?,
               -- COALESCE, so an ordinary edit keeps the file it came from and
               -- only a re-extraction (which carries a source) replaces it.
               source_name = COALESCE(?, source_name), source_mime = COALESCE(?, source_mime),
               source_bytes = COALESCE(?, source_bytes), source_sha256 = COALESCE(?, source_sha256),
               extractor = COALESCE(?, extractor)
             WHERE id = ?`,
          )
          .run(
            title,
            content,
            hash,
            enabled ? 1 : 0,
            located.length,
            model,
            at,
            input.pageUnit ?? null,
            source?.name ?? null,
            source?.mime ?? null,
            source?.bytes ?? null,
            source?.sha256 ?? null,
            source?.extractor ?? null,
            id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO documents
               (id, workspace_id, title, content, content_hash, enabled, chunk_count,
                embedding_model, created_at, updated_at, page_unit,
                source_name, source_mime, source_bytes, source_sha256, extractor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.workspaceId,
            title,
            content,
            hash,
            enabled ? 1 : 0,
            located.length,
            model,
            at,
            at,
            input.pageUnit ?? null,
            source?.name ?? null,
            source?.mime ?? null,
            source?.bytes ?? null,
            source?.sha256 ?? null,
            source?.extractor ?? null,
          );
      }

      if (reach) this.writeReach(id, reach);

      const insert = this.db.prepare(
        `INSERT INTO document_chunks
           (id, document_id, seq, heading, text, embedding, page_start, page_end, line_start, line_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      located.forEach((entry, index) => {
        insert.run(
          newId('chunk'),
          id,
          entry.chunk.seq,
          entry.chunk.heading,
          entry.chunk.text,
          vectors ? packEmbedding(vectors[index]!) : null,
          entry.pageStart,
          entry.pageEnd,
          entry.lineStart,
          entry.lineEnd,
        );
      });
    });
  }

  get(id: string): KnowledgeDocument | null {
    const row = this.rowById(id);
    return row ? this.toDocument(row) : null;
  }

  /** The document holding these exact bytes, if one already does. */
  findBySourceHash(sha256Hex: string): KnowledgeDocument | null {
    const row = this.db
      .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE source_sha256 = ?')
      .get(sha256Hex);
    return row ? this.toDocument(row) : null;
  }

  /** The file a document was extracted from, hash included; null for pasted text. */
  sourceOf(id: string): StoredSource | null {
    const row = this.rowById(id);
    const source = row ? sourceOfRow(row) : null;
    return source && row?.source_sha256 ? { ...source, sha256: row.source_sha256 } : null;
  }

  /**
   * Change what may change without touching the text.
   *
   * The alternative was the editor's read-then-save, which re-sent the whole
   * document to flip one boolean — and cannot work at all for a file-backed
   * document, whose text is refused on the way back in.
   */
  patch(id: string, fields: { title?: string; enabled?: boolean }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.title !== undefined) {
      const title = fields.title.trim();
      if (!title) throw new KnowledgeStoreError('A document needs a title.');
      if (title.length > MAX_TITLE_LENGTH) throw new KnowledgeStoreError('That title is an essay.');
      sets.push('title = ?');
      params.push(title);
    }
    if (fields.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(fields.enabled ? 1 : 0);
    }
    // A patch naming nothing still answers the caller's real question: does
    // this document exist? A route needs that to choose between 200 and 404.
    if (sets.length === 0) return this.rowById(id) !== null;

    sets.push('updated_at = ?');
    params.push(this.now(), id);
    return (
      this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
        .changes > 0
    );
  }

  /**
   * Say which workspaces a document reaches, replacing whatever it reached.
   *
   * Replacing, never adding — the registry's rule, for the registry's reason:
   * an add-only verb leaves an operator believing they narrowed a reach they
   * in fact widened. `global` wins and clears the attachments with it, so
   * there is never a second source of truth for a question already answered.
   * An id naming no workspace is dropped rather than refused: the form was
   * open while somebody else deleted it, and losing the whole edit over a row
   * that is already gone is the worse answer.
   */
  setReach(id: string, reach: ExtensionReach): boolean {
    return tx(this.db, () => {
      if (this.rowById(id) === null) return false;
      this.writeReach(id, reach);
      this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(this.now(), id);
      return true;
    });
  }

  /**
   * List documents. `workspaceId: null` lists the global shelf; a concrete id
   * lists that workspace's shelf plus the global one — what a run would see.
   * Omit to list everything, documents attached to nothing included.
   */
  list(options: { workspaceId?: string | null } = {}): KnowledgeDocumentMeta[] {
    const scope = reachClause(options.workspaceId);
    return this.listing(scope.sql, scope.params);
  }

  /**
   * One document in the listing's shape.
   *
   * Every route that answers with a document answers with *this*, so a screen
   * reading a reach badge and a page count off the list does not lose them the
   * moment the same document comes back from a save. Filtered in SQL rather
   * than by scanning `list()`: that read is a length() and a correlated
   * subquery per row, and paying for the whole library on every write is a
   * cost that only shows up once a library is large enough to matter.
   */
  meta(id: string): KnowledgeDocumentMeta | null {
    return this.listing('d.id = ?', [id])[0] ?? null;
  }

  /** The listing query, shared by both. */
  private listing(clause: string, params: readonly string[]): KnowledgeDocumentMeta[] {
    const where = clause ? `WHERE ${clause}` : '';
    const rows = this.db
      .prepare<unknown[], DocumentRow & { content_length: number; page_count: number | null }>(
        `SELECT d.id, d.workspace_id, d.title, length(CAST(d.content AS BLOB)) AS content_length,
                d.content_hash, d.enabled, d.chunk_count, d.embedding_model, d.is_global,
                d.source_name, d.source_mime, d.source_bytes, d.source_sha256, d.extractor,
                d.page_unit, d.created_at, d.updated_at, '' AS content,
                (SELECT MAX(c.page_end) FROM document_chunks c WHERE c.document_id = d.id) AS page_count
         FROM documents d ${where} ORDER BY d.updated_at DESC, d.id`,
      )
      .all(...params);

    const reach = this.reachOf(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      contentLength: row.content_length,
      enabled: toBool(row.enabled),
      chunkCount: row.chunk_count,
      embeddingModel: row.embedding_model,
      isGlobal: toBool(row.is_global),
      workspaceIds: reach.get(row.id) ?? [],
      source: sourceOfRow(row),
      pageUnit: row.page_unit,
      pageCount: row.page_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  delete(id: string): boolean {
    // Chunks, their fts rows and usages follow by cascade and trigger.
    return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare('UPDATE documents SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, this.now(), id).changes > 0
    );
  }

  /**
   * Hybrid search over chunks: dense ∪ BM25, RRF-fused — the same shape and
   * the same measured floors as memory search, minus memory's priors.
   * Confidence and pinning have no meaning for a reference document, and
   * recency deliberately counts for nothing: last year's lease is not less
   * true than yesterday's note.
   */
  async search(
    queryText: string,
    options: KnowledgeRetrievalOptions = {},
  ): Promise<KnowledgeSearchResult[]> {
    // Refused rather than resolved: the two scopes disagree about the global
    // shelf, so silently preferring one answers a question nobody asked.
    if (options.workspaceIds && options.workspaceId !== undefined) {
      throw new Error('Scope by workspaceId or by workspaceIds, never both.');
    }
    const limit = Math.min(options.limit ?? 6, 50);
    const pool = Math.min(options.candidatePool ?? Math.max(limit * 6, 48), 500);

    const rows = this.candidateChunks(options);
    if (rows.length === 0) return [];

    // Absent, not degraded, while the model is not ready — the memory rule.
    const queryVector = this.embedder.ready ? await this.embedder.embed(queryText) : null;

    const scoredAll: Array<{ id: string; score: number }> = [];
    const modelById = this.documentModels();
    for (const row of queryVector ? rows : []) {
      const vector = unpackEmbedding(row.embedding);
      // Vectors written by a different provider are not comparable; reindex()
      // rebuilds them, and until then the lexical arm still finds the text.
      if (!vector || modelById.get(row.document_id) !== this.embedder.id) continue;
      scoredAll.push({ id: row.id, score: cosineSimilarity(queryVector!, vector) });
    }
    scoredAll.sort((a, b) => b.score - a.score);

    const profile = retrievalProfile(this.embedder.family);
    const best = scoredAll[0]?.score ?? 0;
    const floor = Math.max(
      options.minSimilarity ?? best * profile.relativeFloor,
      profile.minAbsoluteSimilarity,
    );
    const denseTop = scoredAll.filter((entry) => entry.score >= floor).slice(0, pool);

    const lexical = this.lexicalSearch(queryText, options, pool);
    const corroborated = new Set(lexical);
    const denseScore = new Map(denseTop.map((entry) => [entry.id, entry.score]));

    const fused = fuseRankings(profile, denseTop.map((entry) => entry.id), lexical);

    const byId = new Map(rows.map((row) => [row.id, row]));
    const titles = this.documentTitles();

    const results: KnowledgeSearchResult[] = [];
    for (const [id, score] of fused) {
      const row = byId.get(id);
      if (!row) continue;
      // A dense-only match in the noise band is exactly what a stopword query
      // produces; see DENSE_SOLO_FLOOR for the measurements.
      if (!corroborated.has(id) && (denseScore.get(id) ?? 0) < profile.denseSoloFloor) continue;
      const doc = titles.get(row.document_id);
      results.push({
        chunkId: row.id,
        documentId: row.document_id,
        documentTitle: doc?.title ?? '',
        sourceName: doc?.sourceName ?? null,
        workspaceId: doc?.workspaceId ?? null,
        heading: row.heading,
        text: row.text,
        score,
        // Null on a passage indexed before the library recorded offsets; the
        // locator degrades to a shorter sentence rather than a wrong one.
        pageUnit: doc?.pageUnit ?? null,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        lineStart: row.line_start,
        lineEnd: row.line_end,
      });
    }

    results.sort((a, b) => b.score - a.score);

    return capPerDocument(results, MAX_PASSAGES_PER_DOCUMENT).slice(0, limit);
  }

  /**
   * Which passages a run actually saw — the genesis reads this back.
   *
   * The document id is written beside the chunk id on purpose: a passage is
   * replaced wholesale whenever its document is edited or re-extracted, and a
   * citation that cascaded away with it would rewrite the story of a finished
   * run. The document outlives its passages; when it too is deleted, the
   * citations go with it, which is the right answer for a document that no
   * longer exists at all.
   */
  recordUsage(runId: string, results: KnowledgeSearchResult[]): void {
    if (results.length === 0) return;
    tx(this.db, () => {
      const link = this.db.prepare(
        'INSERT OR REPLACE INTO document_usages (run_id, document_id, chunk_id, score) VALUES (?, ?, ?, ?)',
      );
      for (const result of results) {
        link.run(runId, result.documentId, result.chunkId, result.score);
      }
    });
  }

  consultedFor(runId: string): ConsultedPassage[] {
    return this.db
      .prepare<[string], ConsultedRow>(
        // LEFT JOIN on the chunk: it may have been replaced since, and the
        // citation is still true of what the run was shown.
        `SELECT u.chunk_id, u.document_id, d.title, d.page_unit,
                c.heading, c.page_start, c.page_end, c.line_start, c.line_end,
                u.score, (c.id IS NULL) AS replaced
         FROM document_usages u
         JOIN documents d ON d.id = u.document_id
         LEFT JOIN document_chunks c ON c.id = u.chunk_id
         -- The chunk id breaks ties: score alone is not a total order, and a
         -- genesis whose passages swap places between two readings of the
         -- same finished run is a screen nobody can trust.
         WHERE u.run_id = ? ORDER BY u.score DESC, u.chunk_id`,
      )
      .all(runId)
      .map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        heading: row.heading ?? '',
        score: row.score,
        replaced: toBool(row.replaced),
        pageUnit: row.page_unit,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        lineStart: row.line_start,
        lineEnd: row.line_end,
      }));
  }

  /**
   * Re-embed every chunk written by a different provider. Returns how many.
   *
   * Batched, like `MemoryStore.reindex`, so a real sentence-transformer is
   * asked for a bounded number of vectors at a time rather than for the whole
   * library in one call — the difference is invisible under the hashing
   * embedder that ships, and appears the day someone installs the model the
   * doctor recommends.
   *
   * Batched **by document**, though, which memory does not have to care
   * about: staleness is recorded on the document while the vectors live on
   * its chunks, so a document may only be marked once *every* one of its
   * chunks has been rewritten. Marking it halfway would strand the rest
   * permanently — the query below finds stale chunks through their document,
   * so chunks under an already-marked document are invisible to the next run.
   * A document whose chunk count exceeds `batchSize` therefore travels in one
   * oversized batch on purpose.
   */
  async reindex(batchSize = 64): Promise<number> {
    if (!this.embedder.ready) return 0;
    const stale = this.db
      .prepare<[string], { id: string; document_id: string; heading: string; text: string; title: string }>(
        `SELECT c.id, c.document_id, c.heading, c.text, d.title
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.embedding_model != ?
         ORDER BY c.document_id, c.seq`,
      )
      .all(this.embedder.id);
    if (stale.length === 0) return 0;

    const byDocument = new Map<string, typeof stale>();
    for (const row of stale) {
      const rows = byDocument.get(row.document_id);
      if (rows) rows.push(row);
      else byDocument.set(row.document_id, [row]);
    }

    let count = 0;
    let batch: typeof stale = [];
    let documents: string[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const pending = batch;
      const pendingDocuments = documents;
      batch = [];
      documents = [];

      const vectors = await this.embedder.embedBatch(
        pending.map((row) =>
          chunkEmbeddingText(row.title, { heading: row.heading, text: row.text }),
        ),
      );
      // Skipping a chunk here is not an option the way it is in memory, which
      // marks each row as it writes it: a document is marked as a whole, so a
      // short result would strand the unwritten chunks under a document the
      // next run no longer looks at. Refusing leaves the batch untouched and
      // still stale, which is the recoverable direction.
      if (vectors.length !== pending.length) {
        throw new Error(
          `embedder ${this.embedder.id} returned ${vectors.length} vectors for ${pending.length} passages`,
        );
      }

      tx(this.db, () => {
        const update = this.db.prepare('UPDATE document_chunks SET embedding = ? WHERE id = ?');
        const mark = this.db.prepare('UPDATE documents SET embedding_model = ? WHERE id = ?');
        pending.forEach((row, index) => {
          update.run(packEmbedding(vectors[index]!), row.id);
          count += 1;
        });
        for (const documentId of pendingDocuments) mark.run(this.embedder.id, documentId);
      });
    };

    for (const [documentId, rows] of byDocument) {
      batch = [...batch, ...rows];
      documents.push(documentId);
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    return count;
  }

  /* ---------------------------------------------------------------------- */

  private rowById(id: string): DocumentRow | null {
    return (
      this.db.prepare<[string], DocumentRow>('SELECT * FROM documents WHERE id = ?').get(id) ?? null
    );
  }

  /** A row plus its reach — one extra query, so a caller never sees a half-answer. */
  private toDocument(row: DocumentRow): KnowledgeDocument {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      content: row.content,
      enabled: toBool(row.enabled),
      chunkCount: row.chunk_count,
      embeddingModel: row.embedding_model,
      isGlobal: toBool(row.is_global),
      workspaceIds: this.reachOf([row.id]).get(row.id) ?? [],
      source: sourceOfRow(row),
      pageUnit: row.page_unit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Which workspaces each of these documents is attached to, in one query. */
  private reachOf(ids: readonly string[]): Map<string, string[]> {
    const found = new Map<string, string[]>();
    if (ids.length === 0) return found;
    const rows = this.db
      .prepare<string[], { document_id: string; workspace_id: string }>(
        `SELECT document_id, workspace_id FROM document_workspaces
         WHERE document_id IN (${ids.map(() => '?').join(',')})
         -- Ordered, so two reads of one document never disagree about the
         -- order of its badges.
         ORDER BY workspace_id`,
      )
      .all(...ids);
    for (const row of rows) {
      found.set(row.document_id, [...(found.get(row.document_id) ?? []), row.workspace_id]);
    }
    return found;
  }

  /** The write half of `setReach`, without a transaction of its own. */
  private writeReach(id: string, reach: ExtensionReach): void {
    this.db.prepare('UPDATE documents SET is_global = ? WHERE id = ?').run(reach.global ? 1 : 0, id);
    this.db.prepare('DELETE FROM document_workspaces WHERE document_id = ?').run(id);
    if (reach.global) return;
    // `SELECT … FROM workspaces WHERE id = ?` rather than a bare VALUES: an id
    // naming nothing inserts no row instead of failing the foreign key, which
    // would take the whole transaction — and the operator's edit — with it.
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO document_workspaces (document_id, workspace_id)
       SELECT ?, id FROM workspaces WHERE id = ?`,
    );
    for (const workspaceId of new Set(reach.workspaceIds)) insert.run(id, workspaceId);
  }

  private candidateChunks(options: KnowledgeRetrievalOptions): ChunkRow[] {
    const scope = reachClause(options.workspaceId, options.workspaceIds, options.includeGlobal);
    const clauses = ['d.enabled = 1', ...(scope.sql ? [scope.sql] : [])];
    return this.db
      .prepare<unknown[], ChunkRow>(
        `SELECT c.id, c.document_id, c.heading, c.text, c.embedding,
                c.page_start, c.page_end, c.line_start, c.line_end
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
         WHERE ${clauses.join(' AND ')}`,
      )
      .all(...scope.params);
  }

  private lexicalSearch(
    queryText: string,
    options: KnowledgeRetrievalOptions,
    pool: number,
  ): string[] {
    const match = toFtsQuery(queryText);
    if (!match) return [];

    const scope = reachClause(options.workspaceId, options.workspaceIds, options.includeGlobal);
    const clauses: string[] = [
      'document_chunks_fts MATCH ?',
      'd.enabled = 1',
      ...(scope.sql ? [scope.sql] : []),
    ];
    const params: unknown[] = [match, ...scope.params];

    try {
      return this.db
        .prepare<unknown[], { id: string; rank: number }>(
          `SELECT c.id, bm25(document_chunks_fts) AS rank
           FROM document_chunks_fts
           JOIN document_chunks c ON c.rowid = document_chunks_fts.rowid
           JOIN documents d ON d.id = c.document_id
           WHERE ${clauses.join(' AND ')}
           ORDER BY rank LIMIT ?`,
        )
        .all(...params, pool)
        .filter((row) => row.rank <= -MIN_ABSOLUTE_BM25)
        .map((row) => row.id);
    } catch {
      // A pathological MATCH expression must degrade to the dense arm alone,
      // never fail the search.
      return [];
    }
  }

  /** What a hit needs about its document: its name, its shelf, its file, its unit. */
  private documentTitles(): Map<
    string,
    { title: string; workspaceId: string | null; sourceName: string | null; pageUnit: KnowledgePageUnit | null }
  > {
    const rows = this.db
      .prepare<
        [],
        {
          id: string;
          title: string;
          workspace_id: string | null;
          source_name: string | null;
          page_unit: KnowledgePageUnit | null;
        }
      >('SELECT id, title, workspace_id, source_name, page_unit FROM documents')
      .all();
    return new Map(
      rows.map((row) => [
        row.id,
        {
          title: row.title,
          workspaceId: row.workspace_id,
          sourceName: row.source_name,
          pageUnit: row.page_unit,
        },
      ]),
    );
  }

  private documentModels(): Map<string, string> {
    const rows = this.db
      .prepare<[], { id: string; embedding_model: string }>(
        'SELECT id, embedding_model FROM documents',
      )
      .all();
    return new Map(rows.map((row) => [row.id, row.embedding_model]));
  }
}
