/**
 * The board's column vocabulary, shared by every board surface.
 *
 * One place, because a column list restated per component is how a status
 * gains a label in one view and not another.
 */

import type { BoardTask, TaskStatus } from '@metaclaude/shared';

export const TASK_COLUMNS: Array<{ status: TaskStatus; label: string; hint: string }> = [
  { status: 'backlog', label: 'Backlog', hint: 'Captured, not committed' },
  { status: 'todo', label: 'To do', hint: 'Committed, waiting to start' },
  { status: 'in_progress', label: 'In progress', hint: 'Being worked right now' },
  { status: 'review', label: 'Review', hint: 'Done, awaiting your eyes' },
  { status: 'done', label: 'Done', hint: 'Finished and verified' },
];

export function columnLabel(status: TaskStatus): string {
  return TASK_COLUMNS.find((column) => column.status === status)?.label ?? status;
}

/** Group and order a board's tasks the way the columns render them. */
export function groupByColumn(tasks: BoardTask[]): Map<TaskStatus, BoardTask[]> {
  const groups = new Map<TaskStatus, BoardTask[]>(
    TASK_COLUMNS.map((column) => [column.status, []]),
  );
  for (const task of tasks) groups.get(task.status)?.push(task);
  for (const list of groups.values()) list.sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1));
  return groups;
}

export type AssigneeFilter = 'all' | 'user' | 'agent';

/** The board's who-filter. 'all' is the identity, deliberately. */
export function filterByAssignee(tasks: BoardTask[], who: AssigneeFilter): BoardTask[] {
  return who === 'all' ? tasks : tasks.filter((task) => task.assignee === who);
}

/**
 * Whether a card is being worked by the agent right now, read off the card
 * itself: the outcome hook moves or blocks the card the moment its run ends,
 * so this state clears on its own frame.
 */
export function isWorkedByAgent(task: BoardTask): boolean {
  return (
    task.runId !== null &&
    task.status === 'in_progress' &&
    task.assignee === 'agent' &&
    task.blockedReason === null
  );
}

/** The numbers the board states about itself: active cards, and what needs eyes. */
export function boardCounts(tasks: BoardTask[]): {
  total: number;
  inReview: number;
  blocked: number;
  working: number;
} {
  let inReview = 0;
  let blocked = 0;
  let working = 0;
  for (const task of tasks) {
    if (task.status === 'review') inReview += 1;
    if (task.blockedReason !== null) blocked += 1;
    if (isWorkedByAgent(task)) working += 1;
  }
  return { total: tasks.length, inReview, blocked, working };
}

/** Upsert one card into a cached board — the socket's patch operation. */
export function upsertTask(tasks: BoardTask[], task: BoardTask): BoardTask[] {
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (task.archivedAt !== null) return tasks.filter((existing) => existing.id !== task.id);
  if (index < 0) return [...tasks, task];
  const next = [...tasks];
  next[index] = task;
  return next;
}
