/**
 * Long-term memory.
 *
 * The retrieval model is deliberately hybrid: dense vectors catch paraphrase,
 * BM25 catches exact identifiers and rare terms, and reciprocal-rank fusion
 * combines them without needing a tuned weight. On top of that sits a
 * confidence/recency prior, so a memory that has repeatedly helped outranks one
 * that was written once and never used.
 *
 * Reinforcement closes the loop: memories retrieved for a run are credited or
 * debited once that run's outcome is known, and unused memories decay until the
 * janitor collects them.
 */

import type { Memory, MemoryKind, MemorySearchResult } from '@metaclaude/shared';
import { newId, normaliseTags } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { packEmbedding, parseJson, toBool, toInt, tx, unpackEmbedding } from '../db/index.js';
import { cosineSimilarity, type EmbeddingProvider } from './embeddings.js';
import {
  MIN_ABSOLUTE_BM25,
  MIN_ABSOLUTE_SIMILARITY,
  RELATIVE_SIMILARITY_FLOOR,
  rrfFuse,
  toFtsQuery,
} from './retrieval.js';

interface MemoryRow {
  id: string;
  workspace_id: string | null;
  kind: string;
  title: string;
  content: string;
  tags: string;
  confidence: number;
  use_count: number;
  success_count: number;
  pinned: number;
  source_run_id: string | null;
  embedding: Buffer | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  last_decayed_at: number | null;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    tags: parseJson<string[]>(row.tags, []),
    confidence: row.confidence,
    useCount: row.use_count,
    successCount: row.success_count,
    pinned: toBool(row.pinned),
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export interface RetrievalOptions {
  workspaceId?: string | null;
  kinds?: MemoryKind[];
  limit?: number;
  /** Fused scores below this are discarded rather than padded into the result. */
  minScore?: number;
  /**
   * Absolute cosine floor for the dense arm. Overrides the relative gate, for
   * callers that know their embedder's scale.
   */
  minSimilarity?: number;
  /** Candidate pool size per retrieval arm before fusion. */
  candidatePool?: number;
}

/** Near-duplicate threshold. Above this cosine, two memories say the same thing. */
export const DUPLICATE_THRESHOLD = 0.92;

// The relevance gates and the fts query builder moved to retrieval.ts when the
// knowledge store arrived — the constants are measurements of this exact
// configuration, and two stores must share one set of measurements. Re-exported
// here so existing callers and tests are undisturbed.
export {
  MIN_ABSOLUTE_BM25,
  MIN_ABSOLUTE_SIMILARITY,
  RELATIVE_SIMILARITY_FLOOR,
  toFtsQuery,
} from './retrieval.js';

/**
 * Confidence floor below which a memory stops being retrieved and becomes
 * eligible for collection.
 */
export const FORGET_THRESHOLD = 0.15;

export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Store a memory, merging into an existing near-duplicate when one exists.
   *
   * Merging rather than inserting is what keeps the corpus from degenerating:
   * the reflexion pass produces overlapping lessons run after run, and without
   * consolidation the same advice would crowd out everything else in retrieval.
   */
  async remember(input: {
    workspaceId: string | null;
    kind: MemoryKind;
    title: string;
    content: string;
    tags?: string[];
    confidence?: number;
    pinned?: boolean;
    sourceRunId?: string | null;
  }): Promise<{ memory: Memory; merged: boolean }> {
    const embedding = await this.embedder.embed(`${input.title}\n\n${input.content}`);

    const duplicate = this.findNearDuplicate(embedding, input.workspaceId, input.kind);
    if (duplicate) {
      // A repeated observation is evidence, so raise confidence — but keep it
      // strictly below 1 so nothing ever becomes unfalsifiable.
      const confidence = Math.min(0.99, duplicate.confidence + 0.08);
      const mergedTags = normaliseTags([...duplicate.tags, ...(input.tags ?? [])]);

      // Keep the longer body: it is usually the more specific of the two.
      const content =
        input.content.length > duplicate.content.length ? input.content : duplicate.content;

      // Re-embed when the stored text actually changes, or the vector would go
      // on indexing text the row no longer contains.
      const merged =
        content === duplicate.content
          ? null
          : await this.embedder.embed(`${duplicate.title}\n\n${content}`);

      this.db
        .prepare(
          `UPDATE memories SET
             content = ?, tags = ?, confidence = ?, updated_at = ?,
             embedding = COALESCE(?, embedding),
             embedding_dim = COALESCE(?, embedding_dim),
             embedding_model = COALESCE(?, embedding_model)
           WHERE id = ?`,
        )
        .run(
          content,
          JSON.stringify(mergedTags),
          confidence,
          Date.now(),
          merged ? packEmbedding(merged) : null,
          merged ? merged.length : null,
          merged ? this.embedder.id : null,
          duplicate.id,
        );
      return { memory: this.get(duplicate.id) as Memory, merged: true };
    }

    const id = newId('memory');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO memories
           (id, workspace_id, kind, title, content, tags, confidence, pinned, source_run_id,
            embedding, embedding_dim, embedding_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.kind,
        input.title.slice(0, 300),
        input.content,
        JSON.stringify(normaliseTags(input.tags ?? [])),
        input.confidence ?? 0.7,
        toInt(input.pinned ?? false),
        input.sourceRunId ?? null,
        packEmbedding(embedding),
        embedding.length,
        this.embedder.id,
        now,
        now,
      );
    return { memory: this.get(id) as Memory, merged: false };
  }

  get(id: string): Memory | null {
    const row = this.db.prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?').get(id);
    return row ? toMemory(row) : null;
  }

  async update(
    id: string,
    patch: Partial<Pick<Memory, 'title' | 'content' | 'tags' | 'confidence' | 'pinned' | 'kind'>>,
  ): Promise<Memory | null> {
    const current = this.get(id);
    if (!current) return null;

    const title = patch.title ?? current.title;
    const content = patch.content ?? current.content;
    const reembed = title !== current.title || content !== current.content;
    const embedding = reembed ? await this.embedder.embed(`${title}\n\n${content}`) : null;

    this.db
      .prepare(
        `UPDATE memories SET
           kind = ?, title = ?, content = ?, tags = ?, confidence = ?, pinned = ?,
           embedding = COALESCE(?, embedding),
           embedding_dim = COALESCE(?, embedding_dim),
           embedding_model = COALESCE(?, embedding_model),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.kind ?? current.kind,
        title.slice(0, 300),
        content,
        JSON.stringify(normaliseTags(patch.tags ?? current.tags)),
        patch.confidence ?? current.confidence,
        toInt(patch.pinned ?? current.pinned),
        embedding ? packEmbedding(embedding) : null,
        embedding ? embedding.length : null,
        embedding ? this.embedder.id : null,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Retrieval                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Hybrid search: dense similarity ∪ BM25, fused by reciprocal rank, then
   * re-weighted by a confidence and recency prior.
   */
  async search(queryText: string, options: RetrievalOptions = {}): Promise<MemorySearchResult[]> {
    const limit = Math.min(options.limit ?? 8, 100);
    const pool = Math.min(options.candidatePool ?? Math.max(limit * 6, 48), 500);

    const rows = this.candidateRows(options);
    if (rows.length === 0) return [];

    const queryVector = await this.embedder.embed(queryText);

    /* --- Arm 1: dense similarity ---------------------------------------- */
    const scoredAll: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      const vector = unpackEmbedding(row.embedding);
      // Vectors written by a different provider are not comparable; they are
      // skipped here and rebuilt by `reindex`.
      if (!vector || row.embedding_model !== this.embedder.id) continue;
      scoredAll.push({ id: row.id, score: cosineSimilarity(queryVector, vector) });
    }
    scoredAll.sort((a, b) => b.score - a.score);

    const best = scoredAll[0]?.score ?? 0;
    const floor = Math.max(
      options.minSimilarity ?? best * RELATIVE_SIMILARITY_FLOOR,
      MIN_ABSOLUTE_SIMILARITY,
    );
    const denseTop = scoredAll.filter((entry) => entry.score >= floor).slice(0, pool);

    /* --- Arm 2: lexical (BM25 via FTS5) --------------------------------- */
    const lexical = this.lexicalSearch(queryText, options, pool);

    /* --- Fusion ---------------------------------------------------------- */
    const fused = rrfFuse([denseTop.map((entry) => entry.id), lexical]);

    const byId = new Map(rows.map((row) => [row.id, row]));
    const now = Date.now();

    const scored: MemorySearchResult[] = [];
    for (const [id, rrf] of fused) {
      const row = byId.get(id);
      if (!row) continue;

      const memory = toMemory(row);
      // Priors: confidence dominates, recency nudges. Pinned memories get a
      // fixed boost so an explicit instruction always beats a learned one.
      const ageDays = (now - memory.updatedAt) / 86_400_000;
      const recency = 1 / (1 + ageDays / 45);
      const prior = 0.55 * memory.confidence + 0.25 * recency + (memory.pinned ? 0.35 : 0);

      scored.push({ memory, score: rrf * (1 + prior) });
    }

    scored.sort((a, b) => b.score - a.score);

    const minScore = options.minScore ?? 0;
    return scored.filter((entry) => entry.score >= minScore).slice(0, limit);
  }

  private candidateRows(options: RetrievalOptions): MemoryRow[] {
    const clauses = ['confidence >= ?'];
    const params: unknown[] = [FORGET_THRESHOLD];

    // `workspaceId: null` means global-only; a concrete id means that workspace
    // plus global memories, which is how project knowledge inherits defaults.
    if (options.workspaceId === null) {
      clauses.push('workspace_id IS NULL');
    } else if (options.workspaceId !== undefined) {
      clauses.push('(workspace_id = ? OR workspace_id IS NULL)');
      params.push(options.workspaceId);
    }

    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind IN (${options.kinds.map(() => '?').join(',')})`);
      params.push(...options.kinds);
    }

    return this.db
      .prepare<unknown[], MemoryRow>(
        `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 5000`,
      )
      .all(...params);
  }

  /** BM25-ranked ids from the FTS index, best first. */
  private lexicalSearch(queryText: string, options: RetrievalOptions, limit: number): string[] {
    const match = toFtsQuery(queryText);
    if (!match) return [];

    const clauses: string[] = ['memories_fts MATCH ?'];
    const params: unknown[] = [match];

    if (options.workspaceId === null) {
      clauses.push('m.workspace_id IS NULL');
    } else if (options.workspaceId !== undefined) {
      clauses.push('(m.workspace_id = ? OR m.workspace_id IS NULL)');
      params.push(options.workspaceId);
    }
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`m.kind IN (${options.kinds.map(() => '?').join(',')})`);
      params.push(...options.kinds);
    }
    clauses.push('m.confidence >= ?');
    params.push(FORGET_THRESHOLD);

    try {
      const rows = this.db
        .prepare<unknown[], { id: string; rank: number }>(
          `SELECT m.id, bm25(memories_fts) AS rank FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE ${clauses.join(' AND ')}
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(...params, limit);

      return rows.filter((row) => row.rank <= -MIN_ABSOLUTE_BM25).map((row) => row.id);
    } catch {
      // A malformed MATCH expression must degrade to dense-only retrieval, not
      // fail the request.
      return [];
    }
  }

  private findNearDuplicate(
    embedding: Float32Array,
    workspaceId: string | null,
    kind: MemoryKind,
  ): Memory | null {
    const rows = this.db
      .prepare<[string | null, string], MemoryRow>(
        `SELECT * FROM memories
         WHERE workspace_id IS ? AND kind = ?
         ORDER BY updated_at DESC LIMIT 2000`,
      )
      .all(workspaceId, kind);

    let best: { row: MemoryRow; score: number } | null = null;
    for (const row of rows) {
      if (row.embedding_model !== this.embedder.id) continue;
      const vector = unpackEmbedding(row.embedding);
      if (!vector) continue;
      const score = cosineSimilarity(embedding, vector);
      if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) best = { row, score };
    }
    return best ? toMemory(best.row) : null;
  }

  /* ---------------------------------------------------------------------- */
  /* Reinforcement                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Record which memories were injected into a run, for later crediting.
   *
   * The stored score is **rank-normalised within this retrieval**, not the raw
   * fused score. Fused RRF values live in a narrow band around 0.03, so using
   * them directly made the attribution term in `reinforce` clamp to its floor
   * every time — the top hit and a marginal one were credited identically, and
   * the effective learning rate was five times smaller than intended.
   */
  /**
   * What was recalled into one run, best-first — the transcript's "why did
   * it answer this way" reads from here. Titles and kinds are joined live so
   * an edited memory shows its current name, and a deleted one simply drops
   * out (the usage row cascades away with it).
   */
  recalledFor(runId: string): Array<{
    id: string;
    title: string;
    kind: MemoryKind;
    confidence: number;
    score: number;
  }> {
    return this.db
      .prepare<[string], { id: string; title: string; kind: string; confidence: number; score: number }>(
        `SELECT m.id, m.title, m.kind, m.confidence, u.score
         FROM memory_usages u JOIN memories m ON m.id = u.memory_id
         WHERE u.run_id = ? ORDER BY u.score DESC`,
      )
      .all(runId)
      .map((row) => ({ ...row, kind: row.kind as MemoryKind }));
  }

  recordUsage(runId: string, results: MemorySearchResult[]): void {
    if (results.length === 0) return;
    const best = Math.max(...results.map((result) => result.score), Number.EPSILON);

    tx(this.db, () => {
      const link = this.db.prepare(
        'INSERT OR REPLACE INTO memory_usages (run_id, memory_id, score) VALUES (?, ?, ?)',
      );
      const touch = this.db.prepare(
        'UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
      );
      const now = Date.now();
      for (const result of results) {
        link.run(runId, result.memory.id, Math.min(1, result.score / best));
        touch.run(now, result.memory.id);
      }
    });
  }

  /**
   * Credit or debit the memories used by a run once its reward is known.
   *
   * The update is a bounded exponential move toward the observed outcome, which
   * is stable under noise: a single bad run cannot destroy a memory that has
   * been right fifty times, and a single good run cannot canonise a guess.
   */
  reinforce(runId: string, reward: number, previousReward: number | null = null): void {
    const usages = this.db
      .prepare<[string], { memory_id: string; score: number }>(
        'SELECT memory_id, score FROM memory_usages WHERE run_id = ?',
      )
      .all(runId);
    if (usages.length === 0) return;

    tx(this.db, () => {
      const select = this.db.prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?');
      const update = this.db.prepare(
        'UPDATE memories SET confidence = ?, success_count = ?, updated_at = ? WHERE id = ?',
      );
      const now = Date.now();

      for (const usage of usages) {
        const row = select.get(usage.memory_id);
        if (!row || toBool(row.pinned)) continue;

        // Attribute proportionally to how strongly the memory was retrieved:
        // a marginal hit should not be blamed for the whole run. `score` is
        // rank-normalised to [0,1] by `recordUsage`, with a floor so even the
        // weakest retrieved memory moves a little.
        const attribution = Math.min(1, Math.max(0.25, usage.score));
        const learningRate = 0.12 * attribution;

        // A first observation moves confidence toward the reward. A re-rating
        // supersedes the previous one, so it moves by the *change* in reward
        // and nothing else.
        //
        // Written as the delta rather than as "undo the old step, apply the new
        // one". That inverse — `(c' - lr·rp)/(1 - lr)` — is only exact if
        // nothing touched the memory in between, and things do: six other runs
        // reinforcing it left a re-rating landing at 0.2656 where the true
        // counterfactual is 0.3170, over-correcting toward the forget
        // threshold. Worse, `clamp01` on that intermediate value erased history
        // outright: below roughly `lr·rp` it pinned to 0 and the result became
        // `lr·r ≤ 0.12`, so a *downgrade* could raise a memory from 0.09 to
        // 0.114 and any low-confidence memory was rewritten from scratch.
        //
        // The two forms agree exactly whenever nothing clamps, which is what
        // the idempotence test below pins; they differ only where the old one
        // was wrong. The correction is bounded by `lr` — at most 0.12 — so a
        // re-rating cannot swing a memory across the forget threshold on its
        // own, and the case where the forward step never happened at all (a
        // memory pinned during the run and unpinned before the rating) costs
        // that much rather than the whole history.
        const confidence = clamp01(
          previousReward === null
            ? row.confidence + learningRate * (reward - row.confidence)
            : row.confidence + learningRate * (reward - previousReward),
        );

        const successDelta =
          (reward >= 0.6 ? 1 : 0) -
          (previousReward !== null && previousReward >= 0.6 ? 1 : 0);

        update.run(
          confidence,
          Math.max(0, row.success_count + successDelta),
          now,
          usage.memory_id,
        );
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Maintenance                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Apply time decay to memories that have not been used recently.
   *
   * This is a forgetting curve, not a cliff: something genuinely useful is
   * retrieved often enough that reinforcement outpaces decay, while a one-off
   * observation fades below the retrieval floor over a few months.
   *
   * The decay is **incremental**, measured from the last time this ran rather
   * than from the last use. That distinction is the whole correctness of the
   * function: the janitor calls it every six hours, so applying a factor
   * derived from *total* idle time to an *already-decayed* value compounds
   * quadratically. A memory intended to reach the 0.15 floor after ~200 idle
   * days reached it after ~25 — and since a sub-floor memory is excluded from
   * retrieval, it could never be used again, so `collect()` then deleted it
   * permanently. That is silent, unrecoverable loss of exactly the data this
   * subsystem exists to accumulate.
   */
  decay(options: { halfLifeDays?: number; now?: number } = {}): number {
    const halfLife = options.halfLifeDays ?? 90;
    const now = options.now ?? Date.now();
    /** Idle grace period: nothing decays until it has been unused this long. */
    const graceDays = halfLife / 4;

    const rows = this.db.prepare<[], MemoryRow>('SELECT * FROM memories WHERE pinned = 0').all();

    let updated = 0;
    tx(this.db, () => {
      const update = this.db.prepare(
        'UPDATE memories SET confidence = ?, last_decayed_at = ? WHERE id = ?',
      );

      for (const row of rows) {
        const lastUse = row.last_used_at ?? row.created_at;
        const idleDays = (now - lastUse) / 86_400_000;
        if (idleDays <= graceDays) continue;

        // Decay only the interval not yet accounted for. On the first sweep
        // that is the whole idle period (so the closed form
        // `0.5^(idleDays / halfLife)` still holds exactly); afterwards it is
        // just the time since the last sweep. The grace period only delays when
        // decay starts being applied — it does not move the origin, or a
        // memory idle for one half-life would end up above half.
        const since = Math.max(row.last_decayed_at ?? lastUse, lastUse);
        const elapsedDays = (now - since) / 86_400_000;
        if (elapsedDays <= 0) continue;

        const decayed = row.confidence * 0.5 ** (elapsedDays / halfLife);
        if (Math.abs(decayed - row.confidence) < 0.0005) continue;

        update.run(decayed, now, row.id);
        updated += 1;
      }
    });
    return updated;
  }

  /** Delete memories that decayed below the floor and were never useful. */
  collect(): number {
    return this.db
      .prepare(
        `DELETE FROM memories
         WHERE pinned = 0 AND confidence < ? AND success_count = 0`,
      )
      .run(FORGET_THRESHOLD).changes;
  }

  /**
   * Re-embed every memory with the current provider.
   * Needed after switching between the hashing and local embedders, since their
   * vector spaces are unrelated.
   */
  async reindex(batchSize = 64): Promise<number> {
    const rows = this.db
      .prepare<[string], MemoryRow>(
        'SELECT * FROM memories WHERE embedding_model IS NOT ? OR embedding IS NULL',
      )
      .all(this.embedder.id);

    let count = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const vectors = await this.embedder.embedBatch(
        batch.map((row) => `${row.title}\n\n${row.content}`),
      );
      tx(this.db, () => {
        const update = this.db.prepare(
          'UPDATE memories SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?',
        );
        batch.forEach((row, index) => {
          const vector = vectors[index];
          if (!vector) return;
          update.run(packEmbedding(vector), vector.length, this.embedder.id, row.id);
          count += 1;
        });
      });
    }
    return count;
  }

  /* ---------------------------------------------------------------------- */
  /* Listing                                                                 */
  /* ---------------------------------------------------------------------- */

  list(
    options: {
      workspaceId?: string | null;
      kind?: MemoryKind;
      limit?: number;
      offset?: number;
      search?: string;
    } = {},
  ): Memory[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.workspaceId === null) {
      clauses.push('workspace_id IS NULL');
    } else if (options.workspaceId !== undefined) {
      clauses.push('(workspace_id = ? OR workspace_id IS NULL)');
      params.push(options.workspaceId);
    }
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options.search?.trim()) {
      clauses.push('(title LIKE ? OR content LIKE ?)');
      const like = `%${options.search.trim()}%`;
      params.push(like, like);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare<unknown[], MemoryRow>(
        `SELECT * FROM memories ${where}
         ORDER BY pinned DESC, confidence DESC, updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(options.limit ?? 50, 500), options.offset ?? 0)
      .map(toMemory);
  }

  /**
   * Count in the same scope `list` uses: a workspace id means that workspace
   * *plus* globals. Counting with an exact match while listing with the union
   * made the Memory page render more rows than the total beside them.
   */
  count(workspaceId?: string | null): number {
    if (workspaceId === undefined) {
      return this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0;
    }
    if (workspaceId === null) {
      return (
        this.db
          .prepare<[], { n: number }>(
            'SELECT COUNT(*) AS n FROM memories WHERE workspace_id IS NULL',
          )
          .get()?.n ?? 0
      );
    }
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM memories WHERE workspace_id = ? OR workspace_id IS NULL',
        )
        .get(workspaceId)?.n ?? 0
    );
  }

  stats(workspaceId?: string | null): Record<MemoryKind, number> {
    const rows =
      workspaceId === undefined
        ? this.db
            .prepare<[], { kind: string; n: number }>(
              'SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind',
            )
            .all()
        : workspaceId === null
          ? this.db
              .prepare<[], { kind: string; n: number }>(
                'SELECT kind, COUNT(*) AS n FROM memories WHERE workspace_id IS NULL GROUP BY kind',
              )
              .all()
          : this.db
              .prepare<[string], { kind: string; n: number }>(
                `SELECT kind, COUNT(*) AS n FROM memories
                 WHERE workspace_id = ? OR workspace_id IS NULL GROUP BY kind`,
              )
              .all(workspaceId);

    const result: Record<MemoryKind, number> = { episodic: 0, semantic: 0, procedural: 0 };
    for (const row of rows) {
      if (row.kind in result) result[row.kind as MemoryKind] = row.n;
    }
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

