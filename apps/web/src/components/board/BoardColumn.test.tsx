/**
 * The column's two drop targets, and the card's badges.
 *
 * Dropping on the column body appends after the last card; dropping on a
 * card lands right after it. Those are the only two placement rules the
 * client has — the server re-reads neighbours anyway — so both are pinned
 * here with a stubbed DataTransfer.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { BoardColumn } from './BoardColumn';

const task = (over: Partial<BoardTask>): BoardTask => ({
  id: 'tsk_1',
  workspaceId: 'ws_1',
  parentId: null,
  title: 'A task',
  kind: 'task',
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

function renderColumn(tasks: BoardTask[]) {
  const onMove = vi.fn();
  const onOpen = vi.fn();
  const onQuickAdd = vi.fn();
  renderWithProviders(
    <BoardColumn
      status="todo"
      label="To do"
      hint="Committed, waiting to start"
      tasks={tasks}
      onOpen={onOpen}
      onMove={onMove}
      onQuickAdd={onQuickAdd}
    />,
  );
  return { onMove, onOpen, onQuickAdd };
}

const dataTransfer = (taskId: string) =>
  ({ getData: (type: string) => (type === 'text/task-id' ? taskId : ''), setData: vi.fn() }) as unknown as DataTransfer;

describe('BoardColumn', () => {
  it('appends a card dropped on the column body after the last card', () => {
    const { onMove } = renderColumn([task({ id: 'a', title: 'first' }), task({ id: 'b', title: 'last' })]);

    fireEvent.drop(screen.getByRole('region', { name: /to do column/i }).querySelector('[class*="overflow-y"]') as Element, {
      dataTransfer: dataTransfer('tsk_dragged'),
    });

    expect(onMove).toHaveBeenCalledWith('tsk_dragged', 'todo', 'b');
  });

  it('drops onto an empty column at the top', () => {
    const { onMove } = renderColumn([]);
    fireEvent.drop(screen.getByText(/drop a card here/i).parentElement as Element, {
      dataTransfer: dataTransfer('tsk_dragged'),
    });
    expect(onMove).toHaveBeenCalledWith('tsk_dragged', 'todo', null);
  });

  it('lands a card dropped on another right after it', () => {
    const { onMove } = renderColumn([task({ id: 'a', title: 'target card' })]);

    fireEvent.drop(screen.getByRole('button', { name: 'target card' }), {
      dataTransfer: dataTransfer('tsk_dragged'),
    });

    expect(onMove).toHaveBeenCalledWith('tsk_dragged', 'todo', 'a');
  });

  it('opens a card on click and surfaces its state badges', () => {
    const { onOpen } = renderColumn([
      task({ id: 'a', title: 'blocked one', blockedReason: 'waiting on the vault', assignee: 'agent' }),
    ]);

    expect(screen.getByText('blocked')).toBeTruthy();
    expect(screen.getByLabelText('Agent')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'blocked one' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('marks a card the agent is working, and only that combination', () => {
    renderColumn([
      task({ id: 'a', title: 'live one', runId: 'run_1', status: 'in_progress', assignee: 'agent' }),
      task({ id: 'b', title: 'idle one', assignee: 'agent' }),
    ]);

    expect(screen.getByLabelText('Agent working')).toBeTruthy();
    expect(screen.getAllByLabelText('Agent')).toHaveLength(1);
  });

  it('offers the quick add with the column preset', () => {
    const { onQuickAdd } = renderColumn([]);
    fireEvent.click(screen.getByRole('button', { name: /add a task to to do/i }));
    expect(onQuickAdd).toHaveBeenCalledWith('todo');
  });
});

/**
 * The hint that explains what a column *means*.
 *
 * It was a `title` on the header — text that exists only for a mouse — plus a
 * copy in the body that showed only while the column was empty. So a board in
 * use, on a phone, explained none of its columns; and it is a full column that
 * raises the question in the first place.
 */
describe('the column hint', () => {
  it('is rendered whether or not the column has cards', () => {
    renderColumn([task({ id: 'tsk_a' })]);
    expect(screen.getByText('Committed, waiting to start')).toBeDefined();
  });

  it('is not hidden in a title attribute', () => {
    renderColumn([task({ id: 'tsk_a' })]);
    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.hasAttribute('title')).toBe(false);
  });

  it('says it once, not twice, when the column is empty', () => {
    renderColumn([]);
    expect(screen.getAllByText('Committed, waiting to start')).toHaveLength(1);
  });
});
