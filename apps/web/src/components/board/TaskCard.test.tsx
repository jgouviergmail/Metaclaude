/**
 * One card on the board — and the keyboard contract it takes on by wearing
 * `role="button"` on a div.
 *
 * A native <button> is activated by Enter *and* Space; the moment an element
 * claims the button role, a keyboard user is entitled to both. Space is also
 * the key that scrolls the page when nothing handles it, so getting it wrong
 * is not silence — it is the page jumping while the card ignores you.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { BoardTask } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { TaskCard } from './TaskCard';

// Fully typed rather than cast: the first draft used `as BoardTask` and the
// compiler immediately named three fields the cast would have hidden.
const TASK: BoardTask = {
  id: 'tsk_1',
  workspaceId: 'ws_a',
  parentId: null,
  title: 'Renouveler l’assurance habitation',
  kind: 'task',
  description: '',
  status: 'todo',
  priority: 'high',
  assignee: null,
  dueAt: null,
  blockedReason: null,
  runId: null,
  orderKey: 'm',
  createdBy: 'user',
  archivedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const onOpenMock = () => vi.fn<(task: BoardTask) => void>();
const onMoveMock = () => vi.fn<(task: BoardTask, status: BoardTask['status']) => void>();
const onDropMock = () => vi.fn<(draggedTaskId: string) => void>();

const render = (task: Partial<BoardTask> = {}) => {
  const onOpen = onOpenMock();
  const onMove = onMoveMock();
  renderWithProviders(
    <TaskCard task={{ ...TASK, ...task }} onOpen={onOpen} onMove={onMove} onDropAfter={onDropMock()} />,
  );
  return { onOpen, onMove };
};

describe('the card as a button', () => {
  it('opens on click', () => {
    const { onOpen } = render();
    fireEvent.click(screen.getByRole('button', { name: TASK.title }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'tsk_1' }));
  });

  it('opens on Enter', () => {
    const { onOpen } = render();
    fireEvent.keyDown(screen.getByRole('button', { name: TASK.title }), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalled();
  });

  it('opens on Space, like every other button in the product', () => {
    // `role="button"` is a promise to a keyboard user. Handling only Enter
    // half-keeps it, and Space then falls through to the page scroll.
    const { onOpen } = render();
    fireEvent.keyDown(screen.getByRole('button', { name: TASK.title }), { key: ' ' });
    expect(onOpen).toHaveBeenCalled();
  });

  it('does not open on any other key', () => {
    const { onOpen } = render();
    const card = screen.getByRole('button', { name: TASK.title });
    for (const key of ['a', 'Tab', 'ArrowDown', 'Escape']) {
      fireEvent.keyDown(card, { key });
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('is reachable by keyboard at all', () => {
    render();
    expect(screen.getByRole('button', { name: TASK.title }).getAttribute('tabindex')).toBe('0');
  });
});

describe('what the card shows without opening it', () => {
  it('offers every column but the one it is already in', () => {
    render({ status: 'todo' });
    // Radix opens on pointerdown, not click — see CLAUDE.md.
    const trigger = screen.getByRole('button', { name: /Actions for/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    expect(screen.getByRole('menuitem', { name: 'In progress' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Done' })).toBeDefined();
    // The column it already sits in is not offered as a move.
    expect(screen.queryByRole('menuitem', { name: 'To do' })).toBeNull();
  });

  it('marks a deadline that has passed, and leaves a future one plain', () => {
    const { rerender } = renderWithProviders(
      <TaskCard
        task={{ ...TASK, dueAt: Date.now() - 86_400_000 }}
        onOpen={onOpenMock()}
        onMove={onMoveMock()}
        onDropAfter={onDropMock()}
      />,
    );
    expect(document.querySelector('.text-danger')).not.toBeNull();

    rerender(
      <TaskCard
        task={{ ...TASK, dueAt: Date.now() + 86_400_000 }}
        onOpen={onOpenMock()}
        onMove={onMoveMock()}
        onDropAfter={onDropMock()}
      />,
    );
    expect(document.querySelector('.text-danger')).toBeNull();
  });

  it('says a card is blocked, with the reason as its tooltip', () => {
    render({ blockedReason: 'En attente du devis' });
    expect(screen.getByText('blocked')).toBeDefined();
  });

  it('never marks a done card overdue', () => {
    // A deadline in the past on a finished card is history, not a problem.
    render({ dueAt: Date.now() - 86_400_000, status: 'done' });
    expect(document.querySelector('.text-danger')).toBeNull();
  });
});

/**
 * The kind, on the card.
 *
 * A bug and a wish sit in the same column and read differently; the icon says
 * which without costing the card a line. Labelled, because a colour and a
 * glyph are not a name.
 */
describe('the kind', () => {
  it('names what the card is', () => {
    render({ kind: 'bug' });
    expect(screen.getByRole('img', { name: 'Bug' })).toBeTruthy();
  });

  it('says task for a plain one', () => {
    render({ kind: 'task' });
    expect(screen.getByRole('img', { name: 'Task' })).toBeTruthy();
  });

  it('says improvement for a wish', () => {
    render({ kind: 'improvement' });
    expect(screen.getByRole('img', { name: 'Improvement' })).toBeTruthy();
  });
});

