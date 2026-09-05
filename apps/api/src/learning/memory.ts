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
  fuseRankings,
  retrievalProfile,
  DUPLICATE_THRESHOLD,
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

export { DUPLICATE_THRESHOLD } from './retrieval.js';

/**
 * How many rows a duplicate check compares against, newest first.
 *
 * A ceiling rather than a full scan because every candidate costs a cosine on
 * the write path. Reaching it is not an error but it *is* silent — beyond this
 * many memories in one scope, deduplication quietly stops seeing the oldest —
 * so `remember` reports it once the ceiling actually bites.
 */
export const DUPLICATE_SCAN_LIMIT = 2000;

/**
 * Raised when a reconciliation is refused. Carries the status the route should
 * answer with, so the rules live here rather than being restated per caller.
 */
export class MemoryReconcileError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'MemoryReconcileError';
  }
}

export interface ReconcileInput {
  /** The row that survives, and whose kind the result keeps. */
  winnerId: string;
  /** Rows folded into it and then deleted. */
  loserIds?: readonly string[];
  /**
   * `undefined` leaves the tier alone, `null` promotes to global, an id
   * confines to that workspace. Absent and null mean different things here,
   * which is why this is not simply `string | null`.
   */
  scope?: string | null;
  /** Rewrites the surviving text — the consolidation pass supplies both. */
  title?: string;
  content?: string;
  /** Replaces the union of the participants' tags when given. */
  tags?: readonly string[];
  /**
   * Overrides the highest confidence among the participants. `remember` uses
   * it to apply the repeat-observation bump; consolidation leaves it alone.
   */
  confidence?: number;
}

export interface ReconcileResult {
  memory: Memory;
  /** Ids that no longer exist. */
  absorbed: string[];
  /** Whether the tier actually changed — false for a no-op promote. */
  moved: boolean;
}

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
    // No vector while the model is not ready: the row is stored pending and
    // `reindex` embeds it once the model is — and with no vector there is no
    // duplicate check, because a merge decided blind is worse than a
    // duplicate that consolidation catches later.
    const embedding = this.embedder.ready
      ? await this.embedder.embed(`${input.title}\n\n${input.content}`)
      : null;

    const duplicate = embedding ? this.findNearDuplicate(embedding, input.workspaceId) : null;
    if (duplicate) {
      // One write path, not two. `reconcile` already knows how to rewrite a
      // surviving row and re-embed only when the text actually moved; doing it
      // again here is how the two drifted apart before it existed.
      const { memory } = await this.reconcile({
        winnerId: duplicate.id,
        // Keep the longer body: it is usually the more specific of the two.
        content:
          input.content.length > duplicate.content.length ? input.content : duplicate.content,
        tags: [...duplicate.tags, ...(input.tags ?? [])],
        // A repeated observation is evidence, so raise confidence — but keep it
        // strictly below 1 so nothing ever becomes unfalsifiable.
        confidence: Math.min(0.99, duplicate.confidence + 0.08),
      });
      return { memory, merged: true };
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
        embedding ? packEmbedding(embedding) : null,
        embedding ? embedding.length : null,
        embedding ? this.embedder.id : null,
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
    const embedding =
      reembed && this.embedder.ready ? await this.embedder.embed(`${title}\n\n${content}`) : null;

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
    // The text moved and no model was ready to follow it: the old vector
    // describes text that no longer exists. Pending, so reindex rebuilds it.
    if (reembed && !embedding) this.markPending(id);
    return this.get(id);
  }

  /** Strip a row's vector so it reads as stale to search, dedup and reindex alike. */
  private markPending(id: string): void {
    this.db
      .prepare('UPDATE memories SET embedding = NULL, embedding_dim = NULL, embedding_model = NULL WHERE id = ?')
      .run(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Reconciliation                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Fold memories together, move one between tiers, or both at once.
   *
   * Three operator-visible gestures — promote, confine, merge — are one
   * operation underneath, because doing them separately means writing the
   * hard part twice. The hard part is that a memory is not just its text: it
   * carries the runs that used it, the reinforcement those runs earned it, and
   * an operator's pin. Anything that ends a row has to say what becomes of all
   * of that, and "nothing" is the wrong answer.
   *
   * The whole call is one transaction. A caller that names five losers and
   * gets one wrong changes nothing at all, rather than folding four and
   * failing on the fifth.
   */
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const loserIds = [...new Set(input.loserIds ?? [])];
    if (loserIds.includes(input.winnerId)) {
      throw new MemoryReconcileError('A memory cannot absorb itself.');
    }

    const winner = this.get(input.winnerId);
    if (!winner) throw new MemoryReconcileError('That memory no longer exists.', 404);

    const losers = loserIds.map((id) => {
      const memory = this.get(id);
      if (!memory) throw new MemoryReconcileError('That memory no longer exists.', 404);
      return memory;
    });

    // The one rule that cannot be relaxed. Two workspaces are two projects,
    // and folding one's memory into the other's would carry knowledge across
    // the boundary every scope clause in this file exists to enforce. The
    // global tier is exempt in both directions — that is what a tier is for.
    const projects = new Set(
      [winner, ...losers].map((memory) => memory.workspaceId).filter((id): id is string => id !== null),
    );
    if (projects.size > 1) {
      throw new MemoryReconcileError(
        'Memories can only be folded together within the same workspace, or with the global tier.',
      );
    }

    if (input.scope !== undefined && input.scope !== null) {
      // Checked here rather than left to the foreign key: the constraint fires
      // inside the transaction with a message about `memories.workspace_id`,
      // which tells an operator nothing about the workspace they picked.
      const exists = this.db
        .prepare<[string], { one: number }>('SELECT 1 AS one FROM workspaces WHERE id = ?')
        .get(input.scope);
      if (!exists) throw new MemoryReconcileError('No such workspace.', 404);
    }

    const scope = input.scope === undefined ? winner.workspaceId : input.scope;
    const moved = scope !== winner.workspaceId;
    const title = (input.title ?? winner.title).slice(0, 300);
    const content = input.content ?? winner.content;
    const rewritten = title !== winner.title || content !== winner.content;

    // Asked for nothing, so nothing happens — including to `updated_at`.
    // Promoting what is already global is the common way to land here, and it
    // is a no-op rather than an error: the caller's intent is already true.
    if (
      losers.length === 0 &&
      !moved &&
      !rewritten &&
      input.tags === undefined &&
      input.confidence === undefined
    ) {
      return { memory: winner, absorbed: [], moved: false };
    }

    // Embedding is awaited, and better-sqlite3 is synchronous — so this is the
    // one point where another request gets served, and everything read above
    // becomes a snapshot rather than a fact.
    const embedding =
      rewritten && this.embedder.ready ? await this.embedder.embed(`${title}\n\n${content}`) : null;

    tx(this.db, () => {
      // Re-read, and refuse on any drift. The alternative is the read-then-
      // decide-then-write shape that has bitten this codebase before: a memory
      // deleted on that await would have had its use counts folded into the
      // winner from a row that no longer exists, and one *edited* on it would
      // have had the edit overwritten by the copy read beforehand — including
      // when the caller only meant to rename it. Nothing here can repair
      // either case (the embedding is already computed from the old text), so
      // the honest answer is to fail and let the caller ask again.
      const fresh = this.get(winner.id);
      if (!fresh) throw new MemoryReconcileError('That memory no longer exists.', 404);
      if (fresh.title !== winner.title || fresh.content !== winner.content) {
        throw new MemoryReconcileError('That memory changed while this was being prepared.', 409);
      }

      const all = [fresh];
      for (const loser of losers) {
        const current = this.get(loser.id);
        if (!current) throw new MemoryReconcileError('That memory no longer exists.', 404);
        all.push(current);
      }

      const repoint = this.db.prepare(
        `INSERT INTO memory_usages (run_id, memory_id, score)
         SELECT run_id, ?, score FROM memory_usages WHERE memory_id = ?
         ON CONFLICT(run_id, memory_id) DO UPDATE SET score = max(score, excluded.score)`,
      );
      if (rewritten && !embedding) this.markPending(fresh.id);
      // Every repoint before any delete: a run that saw two of the losers must
      // not have its second row cascade away while the first is being moved.
      for (const loser of losers) repoint.run(fresh.id, loser.id);

      this.db
        .prepare(
          `UPDATE memories SET
             workspace_id = ?, title = ?, content = ?, tags = ?,
             confidence = ?, pinned = ?, use_count = ?, success_count = ?,
             source_run_id = ?, created_at = ?, last_used_at = ?, updated_at = ?,
             embedding = COALESCE(?, embedding),
             embedding_dim = COALESCE(?, embedding_dim),
             embedding_model = COALESCE(?, embedding_model)
           WHERE id = ?`,
        )
        .run(
          scope,
          title,
          content,
          // An explicit list is the consolidation pass having decided; absent,
          // the union of what the participants carried — which is what folding
          // two memories together means.
          JSON.stringify(normaliseTags(input.tags ?? all.flatMap((memory) => memory.tags))),
          // The corpus's best estimate of the fact, not an average: a duplicate
          // that was written once and never retrieved must not drag down one
          // that fifty runs have earned.
          clamp01(input.confidence ?? Math.max(...all.map((memory) => memory.confidence))),
          // A pin is an operator's instruction. It survives whichever row it
          // was set on, or a merge would quietly re-enable decay.
          toInt(all.some((memory) => memory.pinned)),
          sum(all.map((memory) => memory.useCount)),
          sum(all.map((memory) => memory.successCount)),
          // Provenance is worth keeping when the winner has none of its own —
          // a consolidated memory still came from somewhere.
          all.map((memory) => memory.sourceRunId).find(Boolean) ?? null,
          Math.min(...all.map((memory) => memory.createdAt)),
          latest(all.map((memory) => memory.lastUsedAt)),
          Date.now(),
          embedding ? packEmbedding(embedding) : null,
          embedding ? embedding.length : null,
          embedding ? this.embedder.id : null,
          fresh.id,
        );

      // Only now. Whatever the cascade takes has already been carried over.
      const drop = this.db.prepare('DELETE FROM memories WHERE id = ?');
      for (const loser of losers) drop.run(loser.id);
    });

    return { memory: this.get(winner.id) as Memory, absorbed: loserIds, moved };
  }

  /** Move a memory to the global tier, where every workspace retrieves it. */
  promote(id: string): Promise<ReconcileResult> {
    return this.reconcile({ winnerId: id, scope: null });
  }

  /** Take a global memory back down to one workspace. */
  confine(id: string, workspaceId: string): Promise<ReconcileResult> {
    return this.reconcile({ winnerId: id, scope: workspaceId });
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

    /* --- Arm 1: dense similarity ---------------------------------------- */
    // Absent, not degraded, while the model is not ready: the lexical arm
    // answers alone and says nothing false.
    const queryVector = this.embedder.ready ? await this.embedder.embed(queryText) : null;
    const scoredAll: Array<{ id: string; score: number }> = [];
    for (const row of queryVector ? rows : []) {
      const vector = unpackEmbedding(row.embedding);
      // Vectors written by a different provider are not comparable; they are
      // skipped here and rebuilt by `reindex`.
      if (!vector || row.embedding_model !== this.embedder.id) continue;
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

    /* --- Arm 2: lexical (BM25 via FTS5) --------------------------------- */
    const lexical = this.lexicalSearch(queryText, options, pool);

    /* --- Fusion, as the family says ------------------------------------- */
    const fused = fuseRankings(profile, denseTop.map((entry) => entry.id), lexical);

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

  /**
   * The stored memory this text would duplicate, or null.
   *
   * Two filters this deliberately does *not* apply, both of which it used to.
   *
   * **Kind.** The classification is a guess the reflector makes from a single
   * run and it is not stable — production held the same observation about the
   * workspace's language as `semantic` on one row and `procedural` on another,
   * so filtering by kind let one fact live once per kind. Duplication is a
   * property of meaning; the winner keeps its own kind.
   *
   * **Tier, in one direction.** A workspace write is compared against the
   * global tier as well, because a fact the global tier already carries is
   * already reachable from here: writing a local copy creates a duplicate that
   * spans two tiers, which `workspace_id IS ?` could never see. The reverse is
   * refused — a global write only ever matches another global — or a fact that
   * belongs everywhere would be quietly demoted into whichever workspace
   * happened to observe it first.
   */
  private findNearDuplicate(embedding: Float32Array, workspaceId: string | null): Memory | null {
    const rows =
      workspaceId === null
        ? this.db
            .prepare<[], MemoryRow>(
              `SELECT * FROM memories WHERE workspace_id IS NULL
               ORDER BY updated_at DESC LIMIT ${DUPLICATE_SCAN_LIMIT}`,
            )
            .all()
        : this.db
            .prepare<[string], MemoryRow>(
              `SELECT * FROM memories WHERE workspace_id = ? OR workspace_id IS NULL
               ORDER BY updated_at DESC LIMIT ${DUPLICATE_SCAN_LIMIT}`,
            )
            .all(workspaceId);

    const threshold = retrievalProfile(this.embedder.family).duplicateThreshold;
    let best: { row: MemoryRow; score: number } | null = null;
    for (const row of rows) {
      if (row.embedding_model !== this.embedder.id) continue;
      const vector = unpackEmbedding(row.embedding);
      if (!vector) continue;
      const score = cosineSimilarity(embedding, vector);
      if (score >= threshold && (!best || score > best.score)) best = { row, score };
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
    if (!this.embedder.ready) return 0;
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

const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0);

/**
 * The most recent of several timestamps, or null when none was ever set.
 *
 * `Math.max` over nullables answers 0 for "never used", and 0 is a real epoch
 * millisecond as far as `decay` is concerned — it would read as used in 1970
 * and start decaying immediately.
 */
function latest(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

