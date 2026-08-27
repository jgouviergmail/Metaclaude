/**
 * The board's client-side arithmetic: grouping into columns, and the
 * socket-patch upsert. The upsert is the one with teeth — an archived card
 * arriving as a frame must leave the cache, or the board resurrects it.
 */

import { describe, expect, it } from 'vitest';
import type { BoardTask } from '@metaclaude/shared';
import { groupByColumn, upsertTask } from './board';

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
