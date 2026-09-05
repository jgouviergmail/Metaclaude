/**
 * Data access for the core agentic entities.
 *
 * Repositories own the row ⇄ domain-object mapping so no SQL and no snake_case
 * ever escapes this file. Everything above it works in terms of the shared
 * contracts, which is what keeps the API and the web app honest.
 */

import type {
  Run,
  RunPolicy,
  RunStatus,
  Session,
  SessionStatus,
  TranscriptEvent,
  Workspace,
  WorkspaceSettings,
} from '@metaclaude/shared';
import { WorkspaceSettings as WorkspaceSettingsSchema, newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { parseJson, toBool, toInt, tx } from '../db/index.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  path: string;
  color: string;
  icon: string;
  archived: number;
  settings: string;
  created_at: number;
  updated_at: number;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  title: string;
  claude_session_id: string | null;
  status: string;
  model: string;
  effort: string | null;
  permission_mode: string;
  agent_name: string | null;
  pinned: number;
  archived: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  run_count: number;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  last_read_at: number;
}

interface RunRow {
  id: string;
  session_id: string;
  workspace_id: string;
  prompt: string;
  status: string;
  policy: string;
  usage: string;
  category: string | null;
  error: string | null;
  rating: number | null;
  reward: number | null;
  triggered_by: string;
  rewind_point: string | null;
  served_model: string | null;
  started_at: number;
  finished_at: number | null;
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  turns: 0,
};

const DEFAULT_POLICY: RunPolicy = {
  model: 'default',
  effort: null,
  permissionMode: 'default',
  thinking: 'adaptive',
  thinkingBudgetTokens: null,
  agentName: null,
  ultracode: false,
  source: 'workspace',
};

/* -------------------------------------------------------------------------- */
/* Workspaces                                                                  */
/* -------------------------------------------------------------------------- */

export function defaultWorkspaceSettings(): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse({});
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    path: row.path,
    color: row.color,
    icon: row.icon,
    archived: toBool(row.archived),
    // Parse through the schema so a workspace created by an older version picks
    // up defaults for any field added since.
    settings: WorkspaceSettingsSchema.parse(parseJson<unknown>(row.settings, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceRepo {
  constructor(private readonly db: Db) {}

  create(input: {
    name: string;
    slug: string;
    description: string;
    path: string;
    color: string;
    icon: string;
    settings: WorkspaceSettings;
  }): Workspace {
    const id = newId('workspace');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.slug,
        input.description,
        input.path,
        input.color,
        input.icon,
        JSON.stringify(input.settings),
        now,
        now,
      );
    return this.get(id) as Workspace;
  }

  get(id: string): Workspace | null {
    const row = this.db
      .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?')
      .get(id);
    return row ? toWorkspace(row) : null;
  }

  getBySlug(slug: string): Workspace | null {
    const row = this.db
      .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE slug = ?')
      .get(slug);
    return row ? toWorkspace(row) : null;
  }

  list(includeArchived = false): Workspace[] {
    const sql = includeArchived
      ? 'SELECT * FROM workspaces ORDER BY archived, updated_at DESC'
      : 'SELECT * FROM workspaces WHERE archived = 0 ORDER BY updated_at DESC';
    return this.db.prepare<[], WorkspaceRow>(sql).all().map(toWorkspace);
  }

  update(
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'archived'>> & {
      settings?: Partial<WorkspaceSettings>;
    },
  ): Workspace | null {
    const current = this.get(id);
    if (!current) return null;

    const settings = patch.settings
      ? WorkspaceSettingsSchema.parse({ ...current.settings, ...patch.settings })
      : current.settings;

    this.db
      .prepare(
        `UPDATE workspaces
         SET name = ?, description = ?, color = ?, icon = ?, archived = ?, settings = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.description ?? current.description,
        patch.color ?? current.color,
        patch.icon ?? current.icon,
        toInt(patch.archived ?? current.archived),
        JSON.stringify(settings),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  /**
   * Move a workspace's recorded directory.
   *
   * Deliberately outside `update()`, which is the patch the API exposes: `path`
   * is derived from the slug and the configured root, and no request may set
   * it. The one caller is `relocateWorkspaces`, at boot, when the root itself
   * has moved under a database that already has rows.
   *
   * `updated_at` is left alone on purpose — it orders the workspace list, and a
   * migration nobody asked for must not reshuffle the sidebar.
   */
  relocate(id: string, path: string): boolean {
    return this.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(path, id).changes > 0;
  }

  /** Removes the row and, by cascade, every session, run and transcript event. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0;
  }

  slugExists(slug: string): boolean {
    return (
      this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM workspaces WHERE slug = ?').get(
        slug,
      )?.n !== 0
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    claudeSessionId: row.claude_session_id,
    status: row.status as SessionStatus,
    model: row.model,
    effort: row.effort as Session['effort'],
    permissionMode: row.permission_mode as Session['permissionMode'],
    agentName: row.agent_name,
    pinned: toBool(row.pinned),
    archived: toBool(row.archived),
    totalCostUsd: row.total_cost_usd,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    lastReadAt: row.last_read_at,
  };
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  create(input: {
    workspaceId: string;
    title?: string;
    model: string;
    effort: string | null;
    permissionMode: string;
    agentName?: string | null;
  }): Session {
    const id = newId('session');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, workspace_id, title, model, effort, permission_mode, agent_name,
            created_at, updated_at, last_activity_at, last_read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.title ?? '',
        input.model,
        input.effort,
        input.permissionMode,
        input.agentName ?? null,
        now,
        now,
        now,
        // Read at birth: a session nobody has spoken in yet holds nothing to
        // read, and the first run of one an automation starts will move
        // `last_activity_at` past this on its own.
        now,
      );
    return this.get(id) as Session;
  }

  get(id: string): Session | null {
    const row = this.db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? toSession(row) : null;
  }

  list(workspaceId: string, options: { includeArchived?: boolean; limit?: number } = {}): Session[] {
    const limit = Math.min(options.limit ?? 200, 1000);
    const sql = options.includeArchived
      ? `SELECT * FROM sessions WHERE workspace_id = ?
         ORDER BY pinned DESC, last_activity_at DESC LIMIT ?`
      : `SELECT * FROM sessions WHERE workspace_id = ? AND archived = 0
         ORDER BY pinned DESC, last_activity_at DESC LIMIT ?`;
    return this.db.prepare<[string, number], SessionRow>(sql).all(workspaceId, limit).map(toSession);
  }

  /**
   * Stamp the session as seen, as far as its latest activity.
   *
   * Touches neither `updated_at` nor `last_activity_at` on purpose: reading a
   * session must not reorder the sidebar under the cursor, and `updated_at` is
   * what an edit means. Idempotent, and cheap enough to call whenever a run
   * settles while somebody is watching.
   */
  markRead(id: string, now: number = Date.now()): Session | null {
    if (!this.get(id)) return null;
    this.db.prepare('UPDATE sessions SET last_read_at = ? WHERE id = ?').run(now, id);
    return this.get(id);
  }

  /**
   * Unread sessions per workspace — what puts the dot on a workspace card.
   *
   * Archived sessions are out: hiding a session is a way of being done with
   * it, and a badge that counts what the list does not show cannot be cleared.
   */
  unreadCounts(): Record<string, number> {
    const rows = this.db
      .prepare<[], { workspace_id: string; n: number }>(
        `SELECT workspace_id, COUNT(*) AS n FROM sessions
          WHERE archived = 0 AND last_activity_at > last_read_at
          GROUP BY workspace_id`,
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.workspace_id, row.n]));
  }

  /**
   * The archived sessions of a workspace, newest first.
   *
   * A method of its own rather than a flag on `list`: what the sidebar's fold
   * wants is *only* the archived ones, and `includeArchived` returns both
   * mixed together in the order the live list needs. Pinning is ignored here —
   * an archived session is out of the way, and a pin was about where it sat
   * in a list it has left.
   */
  listArchived(workspaceId: string, limit = 100): Session[] {
    return this.db
      .prepare<[string, number], SessionRow>(
        `SELECT * FROM sessions WHERE workspace_id = ? AND archived = 1
         ORDER BY last_activity_at DESC, rowid DESC LIMIT ?`,
      )
      .all(workspaceId, Math.min(limit, 500))
      .map(toSession);
  }

  /** How many there are, for the fold's label — the list itself loads on demand. */
  countArchived(workspaceId: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND archived = 1',
        )
        .get(workspaceId)?.n ?? 0
    );
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ?, last_activity_at = ? WHERE id = ?')
      .run(status, Date.now(), Date.now(), id);
  }

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?')
      .run(claudeSessionId, Date.now(), id);
  }

  /** claude_session_id → session id for one workspace: the adoption join. */
  claudeSessionIndex(workspaceId: string): Map<string, string> {
    const rows = this.db
      .prepare<[string], { id: string; claude_session_id: string }>(
        'SELECT id, claude_session_id FROM sessions WHERE workspace_id = ? AND claude_session_id IS NOT NULL',
      )
      .all(workspaceId);
    return new Map(rows.map((row) => [row.claude_session_id, row.id]));
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 200), Date.now(), id);
  }

  update(
    id: string,
    patch: Partial<
      Pick<Session, 'model' | 'effort' | 'permissionMode' | 'agentName' | 'pinned' | 'archived' | 'title'>
    >,
  ): Session | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE sessions
         SET title = ?, model = ?, effort = ?, permission_mode = ?, agent_name = ?,
             pinned = ?, archived = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.model ?? current.model,
        patch.effort !== undefined ? patch.effort : current.effort,
        patch.permissionMode ?? current.permissionMode,
        patch.agentName !== undefined ? patch.agentName : current.agentName,
        toInt(patch.pinned ?? current.pinned),
        toInt(patch.archived ?? current.archived),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  /** Fold a finished run's usage into the session's running totals. */
  addUsage(id: string, usage: { costUsd: number; inputTokens: number; outputTokens: number }): void {
    this.db
      .prepare(
        `UPDATE sessions SET
           total_cost_usd      = total_cost_usd + ?,
           total_input_tokens  = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?,
           run_count           = run_count + 1,
           updated_at          = ?,
           last_activity_at    = ?
         WHERE id = ?`,
      )
      .run(usage.costUsd, usage.inputTokens, usage.outputTokens, Date.now(), Date.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Reset sessions left mid-flight by an unclean shutdown. Called once at boot:
   * without it a crashed run leaves a session permanently marked `running`.
   */
  recoverOrphaned(): number {
    return this.db
      .prepare(
        `UPDATE sessions SET status = 'idle', updated_at = ?
         WHERE status IN ('running','waiting_approval')`,
      )
      .run(Date.now()).changes;
  }
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    status: row.status as RunStatus,
    policy: parseJson<RunPolicy>(row.policy, DEFAULT_POLICY),
    usage: parseJson(row.usage, EMPTY_USAGE),
    category: row.category,
    error: row.error,
    rating: row.rating,
    reward: row.reward,
    triggeredBy: row.triggered_by as Run['triggeredBy'],
    rewindPoint: row.rewind_point,
    servedModel: row.served_model,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class RunRepo {
  constructor(private readonly db: Db) {}

  create(input: {
    sessionId: string;
    workspaceId: string;
    prompt: string;
    policy: RunPolicy;
    triggeredBy: Run['triggeredBy'];
    category?: string | null;
  }): Run {
    const id = newId('run');
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, workspace_id, prompt, status, policy, usage, category, triggered_by, started_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.workspaceId,
        input.prompt,
        JSON.stringify(input.policy),
        JSON.stringify(EMPTY_USAGE),
        input.category ?? null,
        input.triggeredBy,
        Date.now(),
      );
    return this.get(id) as Run;
  }

  get(id: string): Run | null {
    const row = this.db.prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  setStatus(id: string, status: RunStatus): void {
    this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  }

  finish(
    id: string,
    input: {
      status: RunStatus;
      usage: Run['usage'];
      error?: string | null;
      /**
       * The uuid this run can be rewound to, captured off the wire mid-run.
       *
       * `COALESCE` rather than a plain assignment: a run that ends without one
       * (checkpointing off, an older CLI, a crash before the acknowledgement)
       * must not erase an anchor an earlier write already recorded.
       */
      rewindPoint?: string | null;
      /** Same COALESCE rationale: a crash before init must not erase it. */
      servedModel?: string | null;
    },
  ): Run | null {
    this.db
      .prepare(
        `UPDATE runs
            SET status = ?, usage = ?, error = ?, finished_at = ?,
                rewind_point = COALESCE(?, rewind_point),
                served_model = COALESCE(?, served_model)
          WHERE id = ?`,
      )
      .run(
        input.status,
        JSON.stringify(input.usage),
        input.error ? input.error.slice(0, 8000) : null,
        Date.now(),
        input.rewindPoint ?? null,
        input.servedModel ?? null,
        id,
      );
    return this.get(id);
  }

  setCategory(id: string, category: string): void {
    this.db.prepare('UPDATE runs SET category = ? WHERE id = ?').run(category, id);
  }

  setReward(id: string, reward: number): void {
    this.db.prepare('UPDATE runs SET reward = ? WHERE id = ?').run(reward, id);
  }

  setRating(id: string, rating: number): void {
    this.db.prepare('UPDATE runs SET rating = ? WHERE id = ?').run(rating, id);
  }

  listBySession(sessionId: string, limit = 200): Run[] {
    return this.db
      .prepare<[string, number], RunRow>(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC LIMIT ?',
      )
      .all(sessionId, limit)
      .map(toRun);
  }

  listRecent(options: { workspaceId?: string; limit?: number; since?: number } = {}): Run[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(options.workspaceId);
    }
    if (options.since !== undefined) {
      clauses.push('started_at >= ?');
      params.push(options.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare<unknown[], RunRow>(
        `SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(options.limit ?? 100, 1000))
      .map(toRun);
  }

  countActive(): number {
    return (
      this.db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM runs WHERE status IN ('running','waiting_approval')`,
        )
        .get()?.n ?? 0
    );
  }

  /** Mark runs abandoned by a crash as interrupted so history stays truthful. */
  recoverOrphaned(): number {
    return this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', error = 'Interrupted by a server restart.', finished_at = ?
         WHERE status IN ('queued','running','waiting_approval')`,
      )
      .run(Date.now()).changes;
  }
}

/* -------------------------------------------------------------------------- */
/* Transcript                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `Omit` applied to a union collapses it to the members' common fields, which
 * would make every kind-specific property on a transcript event unassignable.
 * Distributing over the union preserves each variant.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A transcript event whose sequence number has not been allocated yet. */
export type PendingTranscriptEvent = DistributiveOmit<TranscriptEvent, 'seq'> & { seq?: number };

export class TranscriptRepo {
  constructor(private readonly db: Db) {}

  /**
   * Append an event. `seq` is allocated inside the same transaction as the
   * insert so concurrent writers on the same run cannot collide on the unique
   * (run_id, seq) index.
   */
  /**
   * Close tool calls left `running` by a crash. Boot only.
   *
   * A `tool_call` event is written the moment the block arrives, with
   * `status: 'running'`, and the only thing that closes it is `StreamState`'s
   * `finalise()` — which runs in the supervisor's `finally`, in-process. An
   * OOM-kill mid-`Bash` therefore leaves the row as it was: `recoverOrphaned`
   * marks the run interrupted and the session idle, but reopening that session
   * still shows a card spinning forever, because the UI renders
   * `status: 'running'` as a spinner and nothing on disk ever says otherwise.
   *
   * `resultIsError` is set alongside the status because `learn()` and `rateRun`
   * count it: leaving it `false` on a call that never returned would tell the
   * learner the run went better than it did.
   *
   * Must run before the kernel accepts work, or it stamps live tool calls.
   */
  recoverOrphaned(): number {
    return this.db
      .prepare(
        `UPDATE transcript_events
            SET payload = json_set(
                  payload,
                  '$.status', 'error',
                  '$.resultIsError', json('true'),
                  '$.result', 'The run ended before this tool produced a result.')
          WHERE kind = 'tool_call' AND json_extract(payload, '$.status') = 'running'`,
      )
      .run().changes;
  }

  append(sessionId: string, event: PendingTranscriptEvent): TranscriptEvent {
    return tx(this.db, () => {
      const seq =
        event.seq ??
        ((
          this.db
            .prepare<[string], { max: number | null }>(
              'SELECT MAX(seq) AS max FROM transcript_events WHERE run_id = ?',
            )
            .get(event.runId)?.max ?? -1
        ) + 1);

      const full = { ...event, seq } as TranscriptEvent;
      this.db
        .prepare(
          `INSERT INTO transcript_events (id, run_id, session_id, seq, kind, at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(full.id, full.runId, sessionId, seq, full.kind, full.at, JSON.stringify(full));
      return full;
    });
  }

  /** Replace an event in place. Used to finalise a streamed text block. */
  update(event: TranscriptEvent): void {
    this.db
      .prepare('UPDATE transcript_events SET payload = ?, at = ? WHERE id = ?')
      .run(JSON.stringify(event), event.at, event.id);
  }

  byRun(runId: string): TranscriptEvent[] {
    return this.db
      .prepare<[string], { payload: string }>(
        'SELECT payload FROM transcript_events WHERE run_id = ? ORDER BY seq ASC',
      )
      .all(runId)
      .map((row) => JSON.parse(row.payload) as TranscriptEvent);
  }

  /**
   * Whole-session transcript, oldest first, capped so opening a very long
   * session cannot blow up the response. The UI paginates backwards from here.
   */
  bySession(sessionId: string, limit = 2000): TranscriptEvent[] {
    return this.db
      .prepare<[string, number], { payload: string }>(
        `SELECT payload FROM (
           SELECT payload, at, seq FROM transcript_events
           WHERE session_id = ? ORDER BY at DESC, seq DESC LIMIT ?
         ) ORDER BY at ASC, seq ASC`,
      )
      .all(sessionId, limit)
      .map((row) => JSON.parse(row.payload) as TranscriptEvent);
  }

  countBySession(sessionId: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM transcript_events WHERE session_id = ?',
        )
        .get(sessionId)?.n ?? 0
    );
  }
}
