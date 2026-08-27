/**
 * The touch-drag contract, pinned:
 *
 *   hold lifts, moving first means scrolling, a drop on a card places after
 *   it, a drop on a column appends, a cancelled pointer drops nothing, and
 *   the mouse is never captured — it has the native drag.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '@metaclaude/shared';
import { findDropTarget, LIFT_DELAY_MS, useBoardTouchDrag } from './touch-drag';

const task = (id: string): BoardTask =>
  ({ id, title: `Card ${id}`, workspaceId: 'ws_1' }) as BoardTask;

function Harness({
  onDropAfterCard,
  onDropOnColumn,
}: {
  onDropAfterCard: (taskId: string, target: string) => void;
  onDropOnColumn: (taskId: string, status: string) => void;
}) {
  const { drag, bind } = useBoardTouchDrag({ onDropAfterCard, onDropOnColumn });
  return (
    <div>
      <div data-task-id="tsk_a" {...bind(task('tsk_a'))}>
        card A
      </div>
      <div data-column="review">
        <div data-task-id="tsk_b">card B</div>
      </div>
      {drag ? <div data-testid="ghost">{drag.task.title}</div> : null}
    </div>
  );
}

let onDropAfterCard: ReturnType<typeof vi.fn<(taskId: string, target: string) => void>>;
let onDropOnColumn: ReturnType<typeof vi.fn<(taskId: string, status: string) => void>>;

const press = (x = 10, y = 10) =>
  fireEvent.pointerDown(screen.getByText('card A'), { pointerType: 'touch', clientX: x, clientY: y });

const lift = () => act(() => void vi.advanceTimersByTime(LIFT_DELAY_MS + 10));

beforeEach(() => {
  vi.useFakeTimers();
  onDropAfterCard = vi.fn<(taskId: string, target: string) => void>();
  onDropOnColumn = vi.fn<(taskId: string, status: string) => void>();
  render(<Harness onDropAfterCard={onDropAfterCard} onDropOnColumn={onDropOnColumn} />);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('findDropTarget', () => {
  it('prefers the card, falls back to the column, answers null elsewhere', () => {
    const card = document.querySelector('[data-task-id="tsk_b"]') as Element;
    expect(findDropTarget(card)).toEqual({ kind: 'card', id: 'tsk_b' });
    expect(findDropTarget(card.parentElement)).toEqual({ kind: 'column', id: 'review' });
    expect(findDropTarget(document.body)).toBeNull();
    expect(findDropTarget(null)).toBeNull();
  });
});

describe('useBoardTouchDrag', () => {
  it('lifts the card after a still hold', () => {
    press();
    expect(screen.queryByTestId('ghost')).toBeNull();
    lift();
    expect(screen.getByTestId('ghost').textContent).toBe('Card tsk_a');
  });

  it('treats movement before the lift as a scroll, not a drag', () => {
    press(10, 10);
    fireEvent.pointerMove(document, { clientX: 10, clientY: 40 });
    lift();
    expect(screen.queryByTestId('ghost')).toBeNull();
  });

  it('drops after the card under the finger', () => {
    const cardB = document.querySelector('[data-task-id="tsk_b"]') as Element;
    document.elementFromPoint = vi.fn(() => cardB);

    press();
    lift();
    fireEvent.pointerMove(document, { clientX: 50, clientY: 50 });
    fireEvent.pointerUp(document, { clientX: 50, clientY: 50 });

    expect(onDropAfterCard).toHaveBeenCalledWith('tsk_a', 'tsk_b');
    expect(onDropOnColumn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ghost')).toBeNull();
  });

  it('appends to the column when the finger is over its empty space', () => {
    const column = document.querySelector('[data-column="review"]') as Element;
    document.elementFromPoint = vi.fn(() => column);

    press();
    lift();
    fireEvent.pointerMove(document, { clientX: 50, clientY: 50 });
    fireEvent.pointerUp(document, { clientX: 50, clientY: 50 });

    expect(onDropOnColumn).toHaveBeenCalledWith('tsk_a', 'review');
  });

  it('drops nothing on a cancelled pointer', () => {
    const cardB = document.querySelector('[data-task-id="tsk_b"]') as Element;
    document.elementFromPoint = vi.fn(() => cardB);

    press();
    lift();
    fireEvent.pointerMove(document, { clientX: 50, clientY: 50 });
    fireEvent.pointerCancel(document);

    expect(onDropAfterCard).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ghost')).toBeNull();
  });

  it('leaves the mouse alone — the native drag owns it', () => {
    fireEvent.pointerDown(screen.getByText('card A'), {
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
    });
    lift();
    expect(screen.queryByTestId('ghost')).toBeNull();
  });
});
