/**
 * The board's client-side arithmetic: grouping into columns, and the
 * socket-patch upsert. The upsert is the one with teeth — an archived card
 * arriving as a frame must leave the cache, or the board resurrects it.
 */

import { describe, expect, it } from 'vitest';
import type { BoardTask } from '@metaclaude/shared';
import { boardCounts, filterByAssignee, groupByColumn, isWorkedByAgent, upsertTask } from './board';

const task = (over: Partial<BoardTask>): BoardTask => ({
  id: 'tsk_1',
  workspaceId: 'ws_1',
  parentId: null,
  title: 'A task',
  description: '',
  status: 'todo',
  priority: 'normal',
  assignee: null,
  runId: null,
  dueAt: null,
  orderKey: 'i',
  blockedReason: null,
  createdBy: 'user:jules',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  ...over,
});

describe('groupByColumn', () => {
  it('orders each column by orderKey and includes empty columns', () => {
    const groups = groupByColumn([
      task({ id: 'a', status: 'todo', orderKey: 'r' }),
      task({ id: 'b', status: 'todo', orderKey: 'i' }),
      task({ id: 'c', status: 'done', orderKey: 'i' }),
    ]);

    expect(groups.get('todo')?.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(groups.get('done')?.map((entry) => entry.id)).toEqual(['c']);
    expect(groups.get('backlog')).toEqual([]);
  });
});

describe('upsertTask', () => {
  it('inserts a new card, replaces a known one, and evicts an archived one', () => {
    const initial = [task({ id: 'a' })];

    const added = upsertTask(initial, task({ id: 'b' }));
    expect(added.map((entry) => entry.id)).toEqual(['a', 'b']);

    const replaced = upsertTask(added, task({ id: 'a', title: 'renamed' }));
    expect(replaced.find((entry) => entry.id === 'a')?.title).toBe('renamed');

    const evicted = upsertTask(replaced, task({ id: 'a', archivedAt: 123 }));
    expect(evicted.map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('filterByAssignee', () => {
  it('keeps everything on all, and narrows to one pair of hands otherwise', () => {
    const tasks = [
      task({ id: 'a', assignee: 'user' }),
      task({ id: 'b', assignee: 'agent' }),
      task({ id: 'c', assignee: null }),
    ];
    expect(filterByAssignee(tasks, 'all')).toHaveLength(3);
    expect(filterByAssignee(tasks, 'user').map((entry) => entry.id)).toEqual(['a']);
    expect(filterByAssignee(tasks, 'agent').map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('isWorkedByAgent', () => {
  it('needs a run, in progress, agent hands, and no block — all four', () => {
    const working = task({ id: 'w', runId: 'run_1', status: 'in_progress', assignee: 'agent' });
    expect(isWorkedByAgent(working)).toBe(true);
    expect(isWorkedByAgent({ ...working, runId: null })).toBe(false);
    expect(isWorkedByAgent({ ...working, status: 'review' })).toBe(false);
    expect(isWorkedByAgent({ ...working, assignee: 'user' })).toBe(false);
    expect(isWorkedByAgent({ ...working, blockedReason: 'stuck' })).toBe(false);
  });
});

describe('boardCounts', () => {
  it('counts what needs eyes', () => {
    const counts = boardCounts([
      task({ id: 'a', status: 'review' }),
      task({ id: 'b', blockedReason: 'stuck' }),
      task({ id: 'c', runId: 'run_1', status: 'in_progress', assignee: 'agent' }),
      task({ id: 'd' }),
    ]);
    expect(counts).toEqual({ total: 4, inReview: 1, blocked: 1, working: 1 });
  });
});
