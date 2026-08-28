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
import { cosineSimilarity, type EmbeddingProvider } from './embeddings.js';
import {
  MIN_ABSOLUTE_BM25,
  MIN_ABSOLUTE_SIMILARITY,
  RELATIVE_SIMILARITY_FLOOR,
  rrfFuse,
  toFtsQuery,
} from './retrieval.js';

/** One document, as stored. `content` is the operator's text, verbatim. */
export interface KnowledgeDocument {
  id: string;
  workspaceId: string | null;
  title: string;
  content: string;
  enabled: boolean;
  chunkCount: number;
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

/**
 * Floor for a dense-arm result the lexical arm does not corroborate.
 *
 * The relative gate alone is not enough here, and the reason is French: a
 * stopword query's character n-grams soak a French corpus, so every chunk
 * scores in a flat band and the relative floor (half the best) admits the lot.
 * Measured on chunk-scale texts with their title prefix: stopword-only
 * queries top out at 0.102 (French) and 0.061 (English), while genuine
 * paraphrase queries start at 0.446 — a gap the short, unprefixed memory
 * texts never had (memory.ts documents genuine matches down to 0.09, which
 * is why MemoryStore cannot carry this floor). 0.18 sits in the dead zone
 * with margin on both sides, and anything below it that shares a single
 * real word with the corpus is rescued by the lexical arm anyway — the
 * floor only silences matches that NO arm can vouch for.
 */
export const DENSE_SOLO_FLOOR = 0.18;

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export class KnowledgeStore {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly now: () => number = () => Date.now(),
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
    const vectors = await this.embedder.embedBatch(
      chunks.map((chunk) => chunkEmbeddingText(title, chunk)),
    );

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
            this.embedder.id,
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
            this.embedder.id,
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
          packEmbedding(vectors[index]!),
        );
      });
    });

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

    const queryVector = await this.embedder.embed(queryText);

    const scoredAll: Array<{ id: string; score: number }> = [];
    const modelById = this.documentModels();
    for (const row of rows) {
      const vector = unpackEmbedding(row.embedding);
      // Vectors written by a different provider are not comparable; reindex()
      // rebuilds them, and until then the lexical arm still finds the text.
      if (!vector || modelById.get(row.document_id) !== this.embedder.id) continue;
      scoredAll.push({ id: row.id, score: cosineSimilarity(queryVector, vector) });
    }
    scoredAll.sort((a, b) => b.score - a.score);

    const best = scoredAll[0]?.score ?? 0;
    const floor = Math.max(
      options.minSimilarity ?? best * RELATIVE_SIMILARITY_FLOOR,
      MIN_ABSOLUTE_SIMILARITY,
    );
    const denseTop = scoredAll.filter((entry) => entry.score >= floor).slice(0, pool);

    const lexical = this.lexicalSearch(queryText, options, pool);
    const corroborated = new Set(lexical);
    const denseScore = new Map(denseTop.map((entry) => [entry.id, entry.score]));

    const fused = rrfFuse([denseTop.map((entry) => entry.id), lexical]);

    const byId = new Map(rows.map((row) => [row.id, row]));
    const titles = this.documentTitles();

    const results: KnowledgeSearchResult[] = [];
    for (const [id, score] of fused) {
      const row = byId.get(id);
      if (!row) continue;
      // A dense-only match in the noise band is exactly what a stopword query
      // produces; see DENSE_SOLO_FLOOR for the measurements.
      if (!corroborated.has(id) && (denseScore.get(id) ?? 0) < DENSE_SOLO_FLOOR) continue;
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

  /** Re-embed every chunk written by a different provider. Returns how many. */
  async reindex(): Promise<number> {
    const stale = this.db
      .prepare<[string], { id: string; document_id: string; heading: string; text: string; title: string }>(
        `SELECT c.id, c.document_id, c.heading, c.text, d.title
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.embedding_model != ?`,
      )
      .all(this.embedder.id);
    if (stale.length === 0) return 0;

    const vectors = await this.embedder.embedBatch(
      stale.map((row) =>
        chunkEmbeddingText(row.title, { seq: 0, heading: row.heading, text: row.text }),
      ),
    );

    tx(this.db, () => {
      const update = this.db.prepare('UPDATE document_chunks SET embedding = ? WHERE id = ?');
      stale.forEach((row, index) => update.run(packEmbedding(vectors[index]!), row.id));
      this.db
        .prepare('UPDATE documents SET embedding_model = ? WHERE embedding_model != ?')
        .run(this.embedder.id, this.embedder.id);
    });
    return stale.length;
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
