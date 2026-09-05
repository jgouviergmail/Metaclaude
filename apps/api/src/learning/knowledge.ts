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

import type { Db } from '../db/index.js';
import { packEmbedding, toBool, tx, unpackEmbedding } from '../db/index.js';
import { chunkDocument, chunkEmbeddingText } from './chunker.js';
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

/** One document, as stored. `content` is the operator's text, verbatim. */
export interface KnowledgeDocument {
  id: string;
  workspaceId: string | null;
  title: string;
  content: string;
  enabled: boolean;
  chunkCount: number;
  /** The embedder these chunks were vectorised with; `''` while they wait for one. */
  embeddingModel: string;
  createdAt: number;
  updatedAt: number;
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
  createdAt: number;
  updatedAt: number;
}

/** One retrieved passage, with enough context to be read on its own. */
export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  workspaceId: string | null;
  heading: string;
  text: string;
  score: number;
}

export interface KnowledgeRetrievalOptions {
  /** null = global shelf only; a concrete id = that workspace plus global. */
  workspaceId?: string | null;
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
  created_at: number;
  updated_at: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  heading: string;
  text: string;
  embedding: Buffer | null;
}

function toDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    content: row.content,
    enabled: toBool(row.enabled),
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

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
   */
  async upsert(input: {
    id?: string;
    workspaceId: string | null;
    title: string;
    content: string;
    enabled?: boolean;
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

    const existing = input.id ? this.rowById(input.id) : null;
    if (input.id && !existing) throw new KnowledgeStoreError('Document not found.', 404);

    const hash = sha256(content);
    const at = this.now();
    const id = existing?.id ?? newId('document');
    const enabled = input.enabled ?? (existing ? toBool(existing.enabled) : true);

    const unchanged =
      existing !== null &&
      existing.content_hash === hash &&
      existing.embedding_model === this.embedder.id;

    if (unchanged) {
      this.db
        .prepare(
          `UPDATE documents SET title = ?, workspace_id = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        )
        .run(title, input.workspaceId, enabled ? 1 : 0, at, id);
      return toDocument(this.rowById(id)!);
    }

    // Chunk and embed *outside* the transaction: embedding is async and slow,
    // and better-sqlite3 transactions are synchronous — holding one across an
    // await is not even expressible. The transaction below is the whole write.
    const chunks = chunkDocument(content);
    if (chunks.length === 0) throw new KnowledgeStoreError('A document needs content.');
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

    tx(this.db, () => {
      if (existing) {
        // Chunks are replaced wholesale: diffing chunk boundaries against an
        // edit is complexity with no payoff at this corpus size, and the fts
        // triggers keep the index true either way.
        this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id);
        this.db
          .prepare(
            `UPDATE documents SET workspace_id = ?, title = ?, content = ?, content_hash = ?,
               enabled = ?, chunk_count = ?, embedding_model = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.workspaceId,
            title,
            content,
            hash,
            enabled ? 1 : 0,
            chunks.length,
            model,
            at,
            id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO documents
               (id, workspace_id, title, content, content_hash, enabled, chunk_count,
                embedding_model, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.workspaceId,
            title,
            content,
            hash,
            enabled ? 1 : 0,
            chunks.length,
            model,
            at,
            at,
          );
      }

      const insert = this.db.prepare(
        `INSERT INTO document_chunks (id, document_id, seq, heading, text, embedding)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      chunks.forEach((chunk, index) => {
        insert.run(
          newId('chunk'),
          id,
          chunk.seq,
          chunk.heading,
          chunk.text,
          vectors ? packEmbedding(vectors[index]!) : null,
        );
      });
    });
    // Written, findable, and waiting: hand the vectors to the rebuild.
    if (!vectors) this.options.embedLater?.(id);

    return toDocument(this.rowById(id)!);
  }

  get(id: string): KnowledgeDocument | null {
    const row = this.rowById(id);
    return row ? toDocument(row) : null;
  }

  /**
   * List documents. `workspaceId: null` lists the global shelf; a concrete id
   * lists that workspace's shelf plus the global one — what a run would see.
   * Omit to list everything.
   */
  list(options: { workspaceId?: string | null } = {}): KnowledgeDocumentMeta[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceId === null) {
      clauses.push('workspace_id IS NULL');
    } else if (options.workspaceId !== undefined) {
      clauses.push('(workspace_id = ? OR workspace_id IS NULL)');
      params.push(options.workspaceId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare<unknown[], DocumentRow & { content_length: number }>(
        `SELECT id, workspace_id, title, length(CAST(content AS BLOB)) AS content_length, content_hash,
                enabled, chunk_count, embedding_model, created_at, updated_at, '' AS content
         FROM documents ${where} ORDER BY updated_at DESC`,
      )
      .all(...params)
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        contentLength: row.content_length,
        enabled: toBool(row.enabled),
        chunkCount: row.chunk_count,
        embeddingModel: row.embedding_model,
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
        workspaceId: doc?.workspaceId ?? null,
        heading: row.heading,
        text: row.text,
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);

    return capPerDocument(results, MAX_PASSAGES_PER_DOCUMENT).slice(0, limit);
  }

  /** Which passages a run actually saw — the genesis reads this back. */
  recordUsage(runId: string, results: KnowledgeSearchResult[]): void {
    if (results.length === 0) return;
    tx(this.db, () => {
      const link = this.db.prepare(
        'INSERT OR REPLACE INTO document_usages (run_id, chunk_id, score) VALUES (?, ?, ?)',
      );
      for (const result of results) link.run(runId, result.chunkId, result.score);
    });
  }

  consultedFor(
    runId: string,
  ): Array<{ chunkId: string; documentId: string; title: string; heading: string; score: number }> {
    return this.db
      .prepare<[string], { chunk_id: string; document_id: string; title: string; heading: string; score: number }>(
        `SELECT u.chunk_id, c.document_id, d.title, c.heading, u.score
         FROM document_usages u
         JOIN document_chunks c ON c.id = u.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE u.run_id = ? ORDER BY u.score DESC`,
      )
      .all(runId)
      .map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        heading: row.heading,
        score: row.score,
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
          chunkEmbeddingText(row.title, { seq: 0, heading: row.heading, text: row.text }),
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

  private candidateChunks(options: KnowledgeRetrievalOptions): ChunkRow[] {
    const clauses = ['d.enabled = 1'];
    const params: unknown[] = [];
    if (options.workspaceId === null) {
      clauses.push('d.workspace_id IS NULL');
    } else if (options.workspaceId !== undefined) {
      clauses.push('(d.workspace_id = ? OR d.workspace_id IS NULL)');
      params.push(options.workspaceId);
    }
    return this.db
      .prepare<unknown[], ChunkRow>(
        `SELECT c.id, c.document_id, c.heading, c.text, c.embedding
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
         WHERE ${clauses.join(' AND ')}`,
      )
      .all(...params);
  }

  private lexicalSearch(
    queryText: string,
    options: KnowledgeRetrievalOptions,
    pool: number,
  ): string[] {
    const match = toFtsQuery(queryText);
    if (!match) return [];

    const clauses: string[] = ['document_chunks_fts MATCH ?', 'd.enabled = 1'];
    const params: unknown[] = [match];
    if (options.workspaceId === null) {
      clauses.push('d.workspace_id IS NULL');
    } else if (options.workspaceId !== undefined) {
      clauses.push('(d.workspace_id = ? OR d.workspace_id IS NULL)');
      params.push(options.workspaceId);
    }

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

  private documentTitles(): Map<string, { title: string; workspaceId: string | null }> {
    const rows = this.db
      .prepare<[], { id: string; title: string; workspace_id: string | null }>(
        'SELECT id, title, workspace_id FROM documents',
      )
      .all();
    return new Map(rows.map((row) => [row.id, { title: row.title, workspaceId: row.workspace_id }]));
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
