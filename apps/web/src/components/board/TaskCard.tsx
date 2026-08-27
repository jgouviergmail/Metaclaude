/**
 * One card on the board.
 *
 * Draggable with the native HTML5 API on pointer devices; the ⋮ menu carries
 * the same moves for touch and keyboard, because a drag-only board is a
 * desktop-only board. The card shows exactly what changes a decision —
 * priority, who works it, a deadline, a block — and nothing that needs a
 * drawer anyway.
 */

import { Bot, CircleAlert, GripVertical, MoreVertical, User as UserIcon } from 'lucide-react';
import { memo } from 'react';
import type { BoardTask, TaskStatus } from '@metaclaude/shared';
import { isWorkedByAgent, TASK_COLUMNS } from '@/lib/board';
import { Menu, MenuItem, MenuLabel } from '@/components/ui/Menu';
import { Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const PRIORITY_TONE: Record<BoardTask['priority'], string> = {
  urgent: 'bg-danger',
  high: 'bg-warning',
  normal: 'bg-accent/50',
  low: 'bg-line',
};

export const TaskCard = memo(function TaskCard({
  task,
  onOpen,
  onMove,
  onDropAfter,
}: {
  task: BoardTask;
  onOpen: (task: BoardTask) => void;
  onMove: (task: BoardTask, status: TaskStatus) => void;
  /** A card was dropped onto this one — place it right after. */
  onDropAfter: (draggedTaskId: string) => void;
}) {
  const overdue = task.dueAt !== null && task.dueAt < Date.now() && task.status !== 'done';
  const working = isWorkedByAgent(task);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/task-id', task.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDrop={(event) => {
        const dragged = event.dataTransfer.getData('text/task-id');
        if (dragged && dragged !== task.id) onDropAfter(dragged);
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOver={(event) => event.preventDefault()}
      className={cn(
        'group cursor-pointer rounded-xl border border-line bg-surface p-3 shadow-sm transition-colors',
        'hover:border-accent/60',
      )}
      onClick={() => onOpen(task)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(task);
      }}
      aria-label={task.title}
    >
      <div className="flex items-start gap-2">
        <GripVertical className="mt-0.5 size-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        <p className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-ink">{task.title}</p>
        <div onClick={(event) => event.stopPropagation()}>
          <Menu
            trigger={
              <button
                type="button"
                aria-label={`Actions for ${task.title}`}
                className="rounded p-1 text-subtle opacity-0 transition-opacity hover:bg-raised hover:text-ink focus:opacity-100 group-hover:opacity-100"
              >
                <MoreVertical className="size-3.5" aria-hidden />
              </button>
            }
          >
            <MenuLabel>Move to</MenuLabel>
            {TASK_COLUMNS.filter((column) => column.status !== task.status).map((column) => (
              <MenuItem key={column.status} onSelect={() => onMove(task, column.status)}>
                {column.label}
              </MenuItem>
            ))}
          </Menu>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 pl-5 text-[11.5px] text-muted">
        <Tooltip content={`Priority: ${task.priority}`}>
          <span className={cn('inline-block size-2 rounded-full', PRIORITY_TONE[task.priority])} aria-label={`Priority ${task.priority}`} />
        </Tooltip>
        {task.assignee ? (
          <Tooltip
            content={
              working
                ? 'The agent is working this card'
                : task.assignee === 'agent'
                  ? 'Assigned to the agent'
                  : 'Assigned to you'
            }
          >
            <span className="inline-flex items-center gap-1">
              {task.assignee === 'agent' ? (
                <Bot
                  className={cn('size-3.5', working && 'text-accent')}
                  aria-label={working ? 'Agent working' : 'Agent'}
                />
              ) : (
                <UserIcon className="size-3.5" aria-label="You" />
              )}
              {working ? (
                <span className="relative flex size-1.5" aria-hidden>
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
                </span>
              ) : null}
            </span>
          </Tooltip>
        ) : null}
        {task.dueAt !== null ? (
          <span className={cn(overdue && 'font-medium text-danger')}>
            {new Date(task.dueAt).toLocaleDateString()}
          </span>
        ) : null}
        {task.blockedReason ? (
          <Tooltip content={task.blockedReason}>
            <span className="inline-flex items-center gap-1 text-warning">
              <CircleAlert className="size-3.5" aria-hidden />
              blocked
            </span>
          </Tooltip>
        ) : null}
        {task.parentId ? <span className="text-subtle">sub-task</span> : null}
      </div>
    </div>
  );
});
