/**
 * The board's one mutation surface.
 *
 * Every writer — the HTTP routes, the agent's in-process board tools, the
 * kernel's run-outcome hook — goes through here, so a changed card always
 * reaches every open board as a frame. Publication forgotten at one call
 * site is how two views of one board drift; centralising it is the fix that
 * cannot regress.
 */

import type { BoardTask, TaskComment, TaskStatus } from '@metaclaude/shared';
import { workspaceTopic } from '@metaclaude/shared';
import type { Run } from '@metaclaude/shared';
import type { EventBus } from '../kernel/bus.js';
import type { BoardService, CreateTaskInput, UpdateTaskInput } from './board.js';

export class BoardGateway {
  /**
   * Fired when a card sitting in review is assigned to the agent — the
   * board's way of saying "take this back". Set after construction (the
   * autopilot that answers it is built later), and observed *here* because
   * this is the one surface every writer passes through: the HTTP routes
   * and the agent's own board tools alike. The rule it serves: a card in
   * review assigned to the agent must be worked by the agent.
   */
  onReviewDelegated?: (task: BoardTask, actor: string) => void;

  constructor(
    private readonly board: BoardService,
    private readonly bus: EventBus,
  ) {}

  /* Reads pass straight through — they change nothing to publish. */
  get(id: string): BoardTask | null {
    return this.board.get(id);
  }
  list(workspaceId: string): BoardTask[] {
    return this.board.board(workspaceId);
  }
  listAll(options: Parameters<BoardService['list']>[0]): BoardTask[] {
    return this.board.list(options);
  }
  comments(taskId: string): ReturnType<BoardService['comments']> {
    return this.board.comments(taskId);
  }
  activity(taskId: string): ReturnType<BoardService['activity']> {
    return this.board.activity(taskId);
  }
  children(taskId: string): BoardTask[] {
    return this.board.children(taskId);
  }
  byRun(runId: string): BoardTask | null {
    return this.board.byRun(runId);
  }

  private publishTask(task: BoardTask): void {
    const topic = workspaceTopic(task.workspaceId);
    this.bus.publish(topic, { type: 'board_task', topic, task });
  }

  private publishRemoval(workspaceId: string, taskId: string): void {
    const topic = workspaceTopic(workspaceId);
    this.bus.publish(topic, { type: 'board_task_removed', topic, taskId });
  }

  create(input: CreateTaskInput, actor: string): BoardTask {
    const task = this.board.create(input, actor);
    this.publishTask(task);
    return task;
  }

  update(id: string, patch: UpdateTaskInput, actor: string): BoardTask {
    // Read before writing: the delegation trigger is the *transition* to
    // agent-assigned, and only the prior row can say whether this is one.
    const before = this.board.get(id);
    const task = this.board.update(id, patch, actor);
    this.publishTask(task);
    if (
      task.status === 'review' &&
      task.archivedAt === null &&
      task.assignee === 'agent' &&
      before?.assignee !== 'agent'
    ) {
      this.onReviewDelegated?.(task, actor);
    }
    return task;
  }

  move(id: string, to: { status: TaskStatus; afterId?: string | null }, actor: string): BoardTask {
    const task = this.board.move(id, to, actor);
    this.publishTask(task);
    return task;
  }

  archive(id: string, actor: string): BoardTask {
    const task = this.board.archive(id, actor);
    this.publishRemoval(task.workspaceId, task.id);
    return task;
  }

  restore(id: string, actor: string): BoardTask {
    const task = this.board.restore(id, actor);
    this.publishTask(task);
    return task;
  }

  delete(id: string): BoardTask {
    const task = this.board.get(id);
    // Descendants die with the row by ON DELETE CASCADE, so they are collected
    // before the delete and each gets its removal frame — without one per
    // card, every open board keeps the children as ghosts until a refetch.
    const casualties = task ? [task, ...this.descendants(task.id)] : [];
    // The service produces its own 404 and the archive-first 409; a publish
    // only happens once it has actually deleted.
    this.board.delete(id);
    for (const casualty of casualties) {
      this.publishRemoval(casualty.workspaceId, casualty.id);
    }
    return task as BoardTask;
  }

  /** Depth is capped at three by the service, so recursion here is bounded. */
  private descendants(taskId: string): BoardTask[] {
    const children = this.board.children(taskId);
    return children.flatMap((child) => [child, ...this.descendants(child.id)]);
  }

  comment(taskId: string, author: string, body: string): TaskComment {
    const comment = this.board.comment(taskId, author, body);
    const task = this.board.get(taskId);
    if (task) {
      const topic = workspaceTopic(task.workspaceId);
      this.bus.publish(topic, { type: 'board_comment', topic, comment });
      this.publishTask(task);
    }
    return comment;
  }

  linkRun(id: string, runId: string | null, actor: string): BoardTask {
    const task = this.board.linkRun(id, runId, actor);
    this.publishTask(task);
    return task;
  }

  /**
   * Close the loop when a run working a card ends.
   *
   * The agent's own moves win: a card it already pushed to review or done is
   * left where the agent put it. Only a card still sitting in progress is
   * moved — to review on success, never straight to done, because "done" is
   * the operator's word — and a failure blocks the card with the error where
   * the board can read it.
   */
  applyRunOutcome(run: Run): BoardTask | null {
    const task = this.board.byRun(run.id);
    if (!task || task.archivedAt !== null) return null;

    const actor = `agent:${run.id}`;
    if (run.status === 'succeeded') {
      if (task.status !== 'in_progress') return task;
      const moved = this.move(task.id, { status: 'review', afterId: null }, actor);
      this.comment(task.id, actor, 'Run finished — moved to review.');
      return moved;
    }

    const reason =
      run.status === 'interrupted'
        ? 'The run was interrupted.'
        : `The run failed${run.error ? `: ${run.error.slice(0, 300)}` : '.'}`;
    this.comment(task.id, actor, reason);
    // The agent's move wins on failure exactly as on success: only a card
    // still sitting in progress gets the blocked flag — one it already put
    // in review (or that the operator moved) holds its place, with the
    // failure on record beside it.
    if (task.status !== 'in_progress') return this.board.get(task.id);
    return this.update(task.id, { blockedReason: reason }, actor);
  }
}
