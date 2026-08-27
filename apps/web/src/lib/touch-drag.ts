/**
 * Touch drag for the board.
 *
 * The native HTML5 drag API never fires on touch, so pointer events carry
 * the phone path: press a card and hold — a long-press lifts it, because a
 * board you can only scroll by *not* touching cards is unusable — then the
 * ghost follows the finger, columns light up under it, and lifting the
 * finger drops. Moving before the lift cancels: that gesture is a scroll,
 * and stealing it is worse than offering no drag at all. Mouse and keyboard
 * keep their existing paths (native drag, the ⋮ menu).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardTask, TaskStatus } from '@metaclaude/shared';

/** How long a finger holds still before the card lifts. */
export const LIFT_DELAY_MS = 350;
/** Movement beyond this before the lift means "I was scrolling". */
export const CANCEL_DISTANCE_PX = 8;
/** Within this many pixels of the columns' edge, scroll them. */
const EDGE_SCROLL_ZONE_PX = 48;
const EDGE_SCROLL_STEP_PX = 12;

export interface DropTarget {
  kind: 'card' | 'column';
  /** The card's task id, or the column's status. */
  id: string;
}

/**
 * What the finger is over, read from the annotated DOM.
 * A card wins over its column — dropping on a card means "right after it".
 */
export function findDropTarget(element: Element | null): DropTarget | null {
  if (!element) return null;
  const card = element.closest('[data-task-id]');
  if (card) return { kind: 'card', id: card.getAttribute('data-task-id') as string };
  const column = element.closest('[data-column]');
  if (column) return { kind: 'column', id: column.getAttribute('data-column') as string };
  return null;
}

export interface TouchDragState {
  task: BoardTask;
  x: number;
  y: number;
  over: DropTarget | null;
}

export function useBoardTouchDrag(options: {
  /** Drop on a card: place right after it, in its column. */
  onDropAfterCard: (taskId: string, targetCardId: string) => void;
  /** Drop on a column's empty space: append to that column. */
  onDropOnColumn: (taskId: string, status: TaskStatus) => void;
}) {
  const [drag, setDrag] = useState<TouchDragState | null>(null);
  const pending = useRef<{
    task: BoardTask;
    startX: number;
    startY: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const live = useRef<TouchDragState | null>(null);
  const handlers = useRef(options);
  handlers.current = options;

  const clearPending = () => {
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current = null;
    }
  };

  // While a card is lifted, the browser must not also scroll the page under
  // the finger. touch-action cannot change mid-gesture; a non-passive
  // touchmove listener is the one lever that still works.
  useEffect(() => {
    if (!drag) return;
    const prevent = (event: TouchEvent): void => event.preventDefault();
    document.addEventListener('touchmove', prevent, { passive: false });
    return () => document.removeEventListener('touchmove', prevent);
  }, [drag !== null]);

  const update = (state: TouchDragState | null): void => {
    live.current = state;
    setDrag(state);
  };

  const onPointerMove = useCallback((event: PointerEvent) => {
    if (pending.current && !live.current) {
      const dx = event.clientX - pending.current.startX;
      const dy = event.clientY - pending.current.startY;
      if (Math.hypot(dx, dy) > CANCEL_DISTANCE_PX) clearPending();
      return;
    }
    const current = live.current;
    if (!current) return;

    const over = findDropTarget(document.elementFromPoint(event.clientX, event.clientY));
    update({ ...current, x: event.clientX, y: event.clientY, over });

    // Ferry the finger past the edge of the visible columns.
    const scroller = document.querySelector('[data-board-scroller]');
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (event.clientX < bounds.left + EDGE_SCROLL_ZONE_PX) {
        scroller.scrollLeft -= EDGE_SCROLL_STEP_PX;
      } else if (event.clientX > bounds.right - EDGE_SCROLL_ZONE_PX) {
        scroller.scrollLeft += EDGE_SCROLL_STEP_PX;
      }
    }
  }, []);

  const onPointerEnd = useCallback((event: PointerEvent) => {
    clearPending();
    const current = live.current;
    if (!current) return;
    update(null);

    if (event.type !== 'pointerup' || !current.over) return;
    if (current.over.kind === 'card' && current.over.id !== current.task.id) {
      handlers.current.onDropAfterCard(current.task.id, current.over.id);
    } else if (current.over.kind === 'column') {
      handlers.current.onDropOnColumn(current.task.id, current.over.id as TaskStatus);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      clearPending();
    };
  }, [onPointerMove, onPointerEnd]);

  /** Spread on a card's root. Touch and pen only — the mouse has native drag. */
  const bind = useCallback((task: BoardTask) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      clearPending();
      const startX = event.clientX;
      const startY = event.clientY;
      pending.current = {
        task,
        startX,
        startY,
        timer: setTimeout(() => {
          pending.current = null;
          navigator.vibrate?.(10);
          update({ task, x: startX, y: startY, over: null });
        }, LIFT_DELAY_MS),
      };
    },
  }), []);

  return { drag, bind };
}
