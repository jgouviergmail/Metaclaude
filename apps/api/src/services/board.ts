/**
 * The board — tasks the operator and the agents share.
 *
 * Storage and rules only: routes publish the frames and record the audit
 * trail, the kernel (in the delegation lot) drives cards from runs. Every
 * mutation writes an append-only task_event beside it — with a human and an
 * agent editing the same board, "what happened here" must be answerable from
 * the record, not from memory.
 *
 * Ordering is fractional: a card's position is a string key, and moving a
 * card assigns a key strictly between its new neighbours'. No renumbering
 * sweep, no transaction over the whole column, and two clients moving cards
 * concurrently cannot corrupt each other's positions — the worst outcome of
 * a race is two cards adjacent in an order the loser did not expect, with
 * the event trail saying who moved what.
 */

import type { BoardTask, TaskActivity, TaskComment, TaskKind, TaskPriority, TaskStatus } from '@metaclaude/shared';
import { newId, TaskStatus as TaskStatusSchema } from '@metaclaude/shared';
import type { Db } from '../db/index.js';

export class BoardError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}

/* ---------------------------------------------------------------------- */
/* Fractional order keys                                                   */
/* ---------------------------------------------------------------------- */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A key strictly between `a` and `b` (lexicographically), where null means
 * the open end. Digit-by-digit midpoint over base-36: generated keys never
 * end in '0', so every key admits a successor on either side and the only
 * cost of dense inserting is key length growing logarithmically.
 */
export function orderKeyBetween(a: string | null, b: string | null): string {
  const lower = a ?? '';
  if (a !== null && b !== null && a >= b) {
    throw new BoardError(`Cannot order between "${a}" and "${b}".`);
  }

  let upper = b;
  let result = '';
  for (let i = 0; ; i += 1) {
    const ca = i < lower.length ? DIGITS.indexOf(lower[i] as string) : 0;
    const cb = upper !== null && i < upper.length ? DIGITS.indexOf(upper[i] as string) : DIGITS.length;
    if (cb - ca > 1) {
      return result + DIGITS[Math.floor((ca + cb) / 2)];
    }
    // Gap of one or none: copy the lower digit and keep walking. Once the
    // bounds differ by exactly one at this digit, everything after it is
    // bounded only from below.
    result += DIGITS[ca];
    if (cb - ca === 1) upper = null;
  }
}

/* ---------------------------------------------------------------------- */
/* Rows                                                                    */
/* ---------------------------------------------------------------------- */

interface TaskRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: string;
  kind: string;
  priority: string;
  assignee: string | null;
  run_id: string | null;
  due_at: number | null;
  order_key: string;
  blocked_reason: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function toTask(row: TaskRow): BoardTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    kind: row.kind as TaskKind,
    priority: row.priority as TaskPriority,
    assignee: row.assignee as BoardTask['assignee'],
    runId: row.run_id,
    dueAt: row.due_at,
    orderKey: row.order_key,
    blockedReason: row.blocked_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

const MAX_DEPTH = 3;

export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  kind?: TaskKind;
  priority?: TaskPriority;
  parentId?: string | null;
  assignee?: BoardTask['assignee'];
  dueAt?: number | null;
  createdBy: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  assignee?: BoardTask['assignee'];
  dueAt?: number | null;
  blockedReason?: string | null;
}

export class BoardService {
  constructor(private readonly db: Db) {}

  /* ------------------------------ Reads -------------------------------- */

  get(id: string): BoardTask | null {
    const row = this.db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? toTask(row) : null;
  }

  /** The board itself: active cards, in column order. */
  board(workspaceId: string): BoardTask[] {
    return this.db
      .prepare<[string], TaskRow>(
        'SELECT * FROM tasks WHERE workspace_id = ? AND archived_at IS NULL ORDER BY status, order_key',
      )
      .all(workspaceId)
      .map(toTask);
  }

  /** The cross-workspace list — filters, newest first, paginated. */
  list(options: {
    workspaceId?: string;
    status?: TaskStatus;
    assignee?: 'user' | 'agent';
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): BoardTask[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceId) {
      where.push('workspace_id = ?');
      params.push(options.workspaceId);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.assignee) {
      where.push('assignee = ?');
      params.push(options.assignee);
    }
    if (!options.includeArchived) where.push('archived_at IS NULL');

    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(options.limit ?? 100, 500), options.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as TaskRow[]).map(toTask);
  }

  comments(taskId: string): TaskComment[] {
    return this.db
      .prepare<[string], { id: string; task_id: string; author: string; body: string; created_at: number }>(
        'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at',
      )
      .all(taskId)
      .map((row) => ({
        id: row.id,
        taskId: row.task_id,
        author: row.author,
        body: row.body,
        createdAt: row.created_at,
      }));
  }

  activity(taskId: string): TaskActivity[] {
    return this.db
      .prepare<[string], { id: string; task_id: string; actor: string; kind: string; detail: string; at: number }>(
        // rowid, not (at, id): several events land in the same millisecond and
        // ids carry a random suffix — the audit chain taught this the hard way.
        'SELECT * FROM task_events WHERE task_id = ? ORDER BY rowid',
      )
      .all(taskId)
      .map((row) => ({
        id: row.id,
        taskId: row.task_id,
        actor: row.actor,
        kind: row.kind as TaskActivity['kind'],
        detail: row.detail,
        at: row.at,
      }));
  }

  /** The card a run is working, if any. */
  byRun(runId: string): BoardTask | null {
    const row = this.db
      .prepare<[string], TaskRow>('SELECT * FROM tasks WHERE run_id = ? LIMIT 1')
      .get(runId);
    return row ? toTask(row) : null;
  }

  children(taskId: string): BoardTask[] {
    return this.db
      .prepare<[string], TaskRow>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at')
      .all(taskId)
      .map(toTask);
  }

  /* ----------------------------- Mutations ------------------------------ */

  create(input: CreateTaskInput, actor: string): BoardTask {
    const workspace = this.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(input.workspaceId);
    if (!workspace) throw new BoardError('Workspace not found.', 404);

    if (input.parentId) {
      const parent = this.get(input.parentId);
      if (!parent) throw new BoardError('Parent task not found.', 404);
      if (parent.workspaceId !== input.workspaceId) {
        throw new BoardError('A sub-task lives on its parent’s board.', 400);
      }
      if (this.depthOf(input.parentId) >= MAX_DEPTH) {
        throw new BoardError(`Tasks nest at most ${MAX_DEPTH} levels deep.`, 400);
      }
    }

    const status = input.status ?? 'todo';
    const now = Date.now();
    const task: BoardTask = {
      id: newId('task'),
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      title: input.title,
      description: input.description ?? '',
      status,
      kind: input.kind ?? 'task',
      priority: input.priority ?? 'normal',
      assignee: input.assignee ?? null,
      runId: null,
      dueAt: input.dueAt ?? null,
      // New cards land on top of their column, where attention is.
      orderKey: orderKeyBetween(null, this.firstKey(input.workspaceId, status)),
      blockedReason: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, parent_id, title, description, status, kind, priority, assignee,
                            run_id, due_at, order_key, blocked_reason, created_by, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.workspaceId,
        task.parentId,
        task.title,
        task.description,
        task.status,
        task.kind,
        task.priority,
        task.assignee,
        task.runId,
        task.dueAt,
        task.orderKey,
        task.blockedReason,
        task.createdBy,
        task.createdAt,
        task.updatedAt,
        task.archivedAt,
      );
    this.record(task.id, actor, 'created', task.title);
    return task;
  }

  update(id: string, patch: UpdateTaskInput, actor: string): BoardTask {
    const task = this.mustGet(id);

    const changes: string[] = [];
    if (patch.title !== undefined && patch.title !== task.title) changes.push('title');
    if (patch.description !== undefined && patch.description !== task.description) changes.push('description');
    if (patch.kind !== undefined && patch.kind !== task.kind) changes.push(`kind → ${patch.kind}`);
    if (patch.priority !== undefined && patch.priority !== task.priority) changes.push(`priority → ${patch.priority}`);
    if (patch.dueAt !== undefined && patch.dueAt !== task.dueAt) changes.push('due date');
    if (patch.blockedReason !== undefined && patch.blockedReason !== task.blockedReason) {
      changes.push(patch.blockedReason ? `blocked: ${patch.blockedReason}` : 'unblocked');
    }
    const assigneeChanged = patch.assignee !== undefined && patch.assignee !== task.assignee;

    this.db
      .prepare(
        `UPDATE tasks SET
           title = COALESCE(?, title),
           description = COALESCE(?, description),
           kind = COALESCE(?, kind),
           priority = COALESCE(?, priority),
           assignee = CASE WHEN ? THEN ? ELSE assignee END,
           due_at = CASE WHEN ? THEN ? ELSE due_at END,
           blocked_reason = CASE WHEN ? THEN ? ELSE blocked_reason END,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? null,
        patch.description ?? null,
        patch.kind ?? null,
        patch.priority ?? null,
        assigneeChanged ? 1 : 0,
        patch.assignee ?? null,
        patch.dueAt !== undefined ? 1 : 0,
        patch.dueAt ?? null,
        patch.blockedReason !== undefined ? 1 : 0,
        patch.blockedReason ?? null,
        Date.now(),
        id,
      );

    if (assigneeChanged) {
      this.record(id, actor, 'assigned', patch.assignee ?? 'nobody');
    }
    if (changes.length > 0) this.record(id, actor, 'updated', changes.join(', '));
    return this.mustGet(id);
  }

  /**
   * Move a card to a column, placed after `afterId` (null = top). Neighbours
   * are re-read at move time, so a stale drag still lands inside the column
   * it aimed at — at worst next to a card the client had not seen yet.
   * Movement clears a block: the reason described the place it was stuck.
   */
  move(id: string, to: { status: TaskStatus; afterId?: string | null }, actor: string): BoardTask {
    const task = this.mustGet(id);
    if (task.archivedAt !== null) throw new BoardError('An archived card does not move.', 409);
    if (!TaskStatusSchema.options.includes(to.status)) throw new BoardError('Unknown column.', 400);

    const siblings = this.db
      .prepare<[string, string, string], { id: string; order_key: string }>(
        `SELECT id, order_key FROM tasks
         WHERE workspace_id = ? AND status = ? AND archived_at IS NULL AND id != ?
         ORDER BY order_key`,
      )
      .all(task.workspaceId, to.status, id);

    let lower: string | null = null;
    let upper: string | null = siblings[0]?.order_key ?? null;
    if (to.afterId) {
      const at = siblings.findIndex((sibling) => sibling.id === to.afterId);
      if (at < 0) throw new BoardError('The card to place after is not in that column any more.', 409);
      lower = siblings[at]?.order_key ?? null;
      upper = siblings[at + 1]?.order_key ?? null;
    }

    // The review rule: what enters review is the operator's to judge, so the
    // transition itself hands the card to them — from every path at once,
    // since the agent's board tools, the run-outcome hook and a human drag
    // all land here. Strictly the *transition*: reordering inside the column
    // must not clobber a deliberate delegation back to the agent.
    const entersReview = to.status === 'review' && task.status !== 'review';

    const orderKey = orderKeyBetween(lower, upper);
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, order_key = ?, blocked_reason = NULL,
           assignee = CASE WHEN ? THEN 'user' ELSE assignee END,
           updated_at = ? WHERE id = ?`,
      )
      .run(to.status, orderKey, entersReview ? 1 : 0, Date.now(), id);

    if (task.status !== to.status) {
      this.record(id, actor, 'moved', `${task.status} → ${to.status}`);
    }
    if (entersReview && task.assignee !== 'user') {
      this.record(id, actor, 'assigned', 'user');
    }
    return this.mustGet(id);
  }

  archive(id: string, actor: string): BoardTask {
    const task = this.mustGet(id);
    if (task.archivedAt !== null) return task;
    this.db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
    this.record(id, actor, 'archived', '');
    return this.mustGet(id);
  }

  restore(id: string, actor: string): BoardTask {
    const task = this.mustGet(id);
    if (task.archivedAt === null) return task;
    this.db.prepare('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
    this.record(id, actor, 'restored', '');
    return this.mustGet(id);
  }

  /** Hard deletion is for archived cards only — the board never loses work silently. */
  delete(id: string): void {
    const task = this.mustGet(id);
    if (task.archivedAt === null) {
      throw new BoardError('Archive a card before deleting it — deletion is for the archive.', 409);
    }
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  comment(taskId: string, author: string, body: string): TaskComment {
    this.mustGet(taskId);
    const comment: TaskComment = {
      id: newId('taskComment'),
      taskId,
      author,
      body,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(comment.id, comment.taskId, comment.author, comment.body, comment.createdAt);
    this.record(taskId, author, 'commented', body.slice(0, 120));
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now(), taskId);
    return comment;
  }

  /** Link the run that is working this card. Recorded, like every touch. */
  linkRun(id: string, runId: string | null, actor: string): BoardTask {
    this.mustGet(id);
    this.db.prepare('UPDATE tasks SET run_id = ?, updated_at = ? WHERE id = ?').run(runId, Date.now(), id);
    if (runId) this.record(id, actor, 'run_linked', runId);
    return this.mustGet(id);
  }

  /* ------------------------------ Helpers ------------------------------- */

  private mustGet(id: string): BoardTask {
    const task = this.get(id);
    if (!task) throw new BoardError('Task not found.', 404);
    return task;
  }

  private firstKey(workspaceId: string, status: TaskStatus): string | null {
    return (
      this.db
        .prepare<[string, string], { order_key: string }>(
          `SELECT order_key FROM tasks
           WHERE workspace_id = ? AND status = ? AND archived_at IS NULL
           ORDER BY order_key LIMIT 1`,
        )
        .get(workspaceId, status)?.order_key ?? null
    );
  }

  private depthOf(taskId: string): number {
    let depth = 1;
    let current: string | null = taskId;
    while (current && depth <= MAX_DEPTH + 1) {
      const row: { parent_id: string | null } | undefined = this.db
        .prepare<[string], { parent_id: string | null }>('SELECT parent_id FROM tasks WHERE id = ?')
        .get(current);
      current = row?.parent_id ?? null;
      if (current) depth += 1;
    }
    return depth;
  }

  private record(taskId: string, actor: string, kind: TaskActivity['kind'], detail: string): void {
    this.db
      .prepare('INSERT INTO task_events (id, task_id, actor, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('taskEvent'), taskId, actor, kind, detail, Date.now());
  }
}
