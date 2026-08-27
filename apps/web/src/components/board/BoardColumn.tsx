/**
 * One column of the board.
 *
 * A drop on the column body appends at the end; a drop on a card lands just
 * after it (TaskCard reports that itself). The column scrolls internally, so
 * the page keeps one stable horizontal band of columns on every screen.
 */

import { Plus } from 'lucide-react';
import { useState, type HTMLAttributes } from 'react';
import type { BoardTask, TaskStatus } from '@metaclaude/shared';
import type { DropTarget } from '@/lib/touch-drag';
import { TaskCard } from './TaskCard';
import { cn } from '@/lib/utils';

export function BoardColumn({
  status,
  label,
  hint,
  tasks,
  onOpen,
  onMove,
  onQuickAdd,
  touchBind,
  touchTarget,
}: {
  status: TaskStatus;
  label: string;
  hint: string;
  tasks: BoardTask[];
  onOpen: (task: BoardTask) => void;
  /** Move a card into `status`, after the named card (null = top, 'end' semantics via last id). */
  onMove: (taskId: string, status: TaskStatus, afterId: string | null) => void;
  onQuickAdd: (status: TaskStatus) => void;
  /** Touch-drag handles from the board's hook; absent in contexts without it. */
  touchBind?: (task: BoardTask) => HTMLAttributes<HTMLDivElement>;
  /** Where a touch drag currently hovers, for the same highlight native drag gets. */
  touchTarget?: DropTarget | null;
}) {
  const [dragOver, setDragOver] = useState(false);
  const touchOver =
    touchTarget != null &&
    (touchTarget.kind === 'column'
      ? touchTarget.id === status
      : tasks.some((candidate) => candidate.id === touchTarget.id));

  return (
    <section
      aria-label={`${label} column`}
      data-column={status}
      className={cn(
        'flex h-full w-[280px] shrink-0 snap-start flex-col rounded-2xl border border-line bg-raised/40 sm:w-[300px]',
        touchOver && 'border-accent bg-accent-soft/30',
      )}
    >
      <header className="flex items-center gap-2 px-3 pb-2 pt-3" title={hint}>
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">{label}</h2>
        <span className="text-[12px] text-subtle">{tasks.length}</span>
        <button
          type="button"
          onClick={() => onQuickAdd(status)}
          aria-label={`Add a task to ${label}`}
          className="ml-auto rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-ink"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </header>

      <div
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-b-2xl px-2.5 pb-2.5 transition-colors',
          dragOver && 'bg-accent-soft/40',
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const dragged = event.dataTransfer.getData('text/task-id');
          if (dragged) onMove(dragged, status, tasks.at(-1)?.id ?? null);
        }}
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            touchBind={touchBind}
            onOpen={onOpen}
            onMove={(moved, to) => onMove(moved.id, to, null)}
            onDropAfter={(draggedId) => onMove(draggedId, status, task.id)}
          />
        ))}
        {tasks.length === 0 ? (
          <p className="px-1 py-3 text-center text-[12px] text-subtle">{hint}</p>
        ) : null}
      </div>
    </section>
  );
}
