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
import { useT } from '@/lib/i18n';

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
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const touchOver =
    touchTarget != null &&
    (touchTarget.kind === 'column'
      ? touchTarget.id === status
      : tasks.some((candidate) => candidate.id === touchTarget.id));

  return (
    <section
      aria-label={t('{column} column', { column: t(label) })}
      data-column={status}
      className={cn(
        'flex h-full w-[280px] shrink-0 snap-start flex-col rounded-2xl border border-line bg-raised/40 sm:w-[300px]',
        touchOver && 'border-accent bg-accent-soft/30',
      )}
    >
      {/* The hint is rendered, not hovered.
          It used to be a `title` on this header — text that exists only for a
          mouse. This is a board, the screen most likely to be read on a phone,
          and the hint is what tells someone what the column *means*: it exists
          nowhere else on the page. One line under the title costs 16px and
          works for everybody. */}
      <header className="px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight text-ink">{t(label)}</h2>
          <span className="text-[12px] text-subtle">{tasks.length}</span>
          <button
            type="button"
            onClick={() => onQuickAdd(status)}
            aria-label={t('Add a task to {column}', { column: t(label) })}
            className="ml-auto rounded-md p-1 text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{t(hint)}</p>
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
        {/* The hint used to live here, so a column only explained itself while
            it was empty — and it is a full column that raises the question.
            It moved to the header; what an empty column needs instead is to
            look like somewhere a card can land. */}
        {tasks.length === 0 ? (
          <p className="px-1 py-3 text-center text-[12px] text-subtle">{t('Drop a card here')}</p>
        ) : null}
      </div>
    </section>
  );
}
