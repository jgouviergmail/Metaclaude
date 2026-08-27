/**
 * One card, opened.
 *
 * Everything a card knows lives here: the editable fields, the comment
 * thread the operator and the agents share, the sub-tasks, and the
 * append-only history — which is what makes a board worked by several hands
 * explicable after the fact. Editing is explicit (a Save button), because
 * autosaving a half-typed description into the agents' view of the task
 * would hand them drafts.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowRight, Bot, History, Trash2, User as UserIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BoardTask, TaskPriority } from '@metaclaude/shared';
import { api, ApiError } from '@/lib/api';
import { columnLabel } from '@/lib/board';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Input, Label, Spinner, Textarea } from '@/components/ui/primitives';
import { toast } from 'sonner';
import { cn, formatRelative } from '@/lib/utils';

const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

/** A run in any of these states is holding the card. */
const ACTIVE_RUN = new Set(['queued', 'running', 'waiting_approval']);

export function TaskDrawer({
  taskId,
  onClose,
}: {
  /** Null renders nothing — the drawer owns its own open state semantics. */
  taskId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.task(taskId as string),
    enabled: taskId !== null,
  });

  const task = detail.data?.task;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [comment, setComment] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
    }
  }, [task?.id, task?.updatedAt]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    if (task) void queryClient.invalidateQueries({ queryKey: ['board', task.workspaceId] });
  };
  const onError = (error: unknown): void => {
    toast.error(error instanceof ApiError ? error.message : 'The board did not accept that.');
  };

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateTask>[1]) =>
      api.updateTask(taskId as string, patch),
    onSuccess: refresh,
    onError,
  });
  const addComment = useMutation({
    mutationFn: () => api.commentTask(taskId as string, comment.trim()),
    onSuccess: () => {
      setComment('');
      refresh();
    },
    onError,
  });
  const [subTask, setSubTask] = useState('');
  const addSubTask = useMutation({
    mutationFn: () =>
      api.createTask((task as BoardTask).workspaceId, {
        title: subTask.trim(),
        parentId: taskId,
        status: task?.status ?? 'todo',
      }),
    onSuccess: () => {
      setSubTask('');
      refresh();
    },
    onError,
  });
  const archive = useMutation({
    mutationFn: () => api.archiveTask(taskId as string),
    onSuccess: refresh,
    onError,
  });
  const restore = useMutation({
    mutationFn: () => api.restoreTask(taskId as string),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTask(taskId as string),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError,
  });
  const runTask = useMutation({
    mutationFn: () => api.runTask(taskId as string),
    onSuccess: () => {
      toast.success('Sent to the agent — the card comes back in review.');
      refresh();
    },
    onError,
  });

  const run = detail.data?.run ?? null;
  const working = run !== null && ACTIVE_RUN.has(run.status);

  const dirty = task !== undefined && (title !== task.title || description !== task.description);

  return (
    <Modal
      open={taskId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={task ? (task.archivedAt ? 'Archived task' : columnLabel(task.status)) : 'Task'}
      size="lg"
      footer={
        task ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            {task.archivedAt === null ? (
              <Button variant="ghost" size="sm" onClick={() => archive.mutate()}>
                <Archive className="size-3.5" aria-hidden />
                Archive
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => restore.mutate()}>
                  <ArchiveRestore className="size-3.5" aria-hidden />
                  Restore
                </Button>
                <Button variant="danger" size="sm" onClick={() => remove.mutate()}>
                  <Trash2 className="size-3.5" aria-hidden />
                  Delete forever
                </Button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!dirty || title.trim().length === 0}
                onClick={() => save.mutate({ title: title.trim(), description })}
              >
                Save
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {detail.isLoading || !task ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What done looks like, constraints, links…"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Menu
              trigger={
                <button type="button" className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-muted hover:border-accent hover:text-ink">
                  Priority: <span className="font-medium text-ink">{task.priority}</span>
                </button>
              }
            >
              {PRIORITIES.map((priority) => (
                <MenuItem
                  key={priority}
                  selected={priority === task.priority}
                  onSelect={() => save.mutate({ priority })}
                >
                  {priority}
                </MenuItem>
              ))}
            </Menu>

            <Menu
              trigger={
                <button type="button" className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-muted hover:border-accent hover:text-ink">
                  {task.assignee === 'agent' ? (
                    <span className="inline-flex items-center gap-1"><Bot className="size-3.5" aria-hidden /> Agent</span>
                  ) : task.assignee === 'user' ? (
                    <span className="inline-flex items-center gap-1"><UserIcon className="size-3.5" aria-hidden /> You</span>
                  ) : (
                    'Unassigned'
                  )}
                </button>
              }
            >
              <MenuItem selected={task.assignee === null} onSelect={() => save.mutate({ assignee: null })}>
                Unassigned
              </MenuItem>
              <MenuItem selected={task.assignee === 'user'} onSelect={() => save.mutate({ assignee: 'user' })}>
                You
              </MenuItem>
              <MenuItem
                selected={task.assignee === 'agent'}
                onSelect={() => save.mutate({ assignee: 'agent' })}
                description="The workspace's agent — it can pick this card up"
              >
                Agent
              </MenuItem>
            </Menu>

            <Input
              type="date"
              aria-label="Due date"
              className="w-auto"
              value={task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : ''}
              onChange={(event) => {
                const value = event.target.value;
                save.mutate({ dueAt: value ? new Date(`${value}T12:00:00`).getTime() : null });
              }}
            />

            {task.blockedReason ? (
              <Badge tone="warning" className="max-w-full">
                <span className="truncate">blocked: {task.blockedReason}</span>
              </Badge>
            ) : null}
          </div>

          {task.archivedAt === null ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-raised/50 px-3 py-2.5">
              {run && working ? (
                <>
                  <span className="inline-flex items-center gap-2 text-[13px] font-medium text-ink">
                    <span className="relative flex size-2" aria-hidden>
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
                      <span className="relative inline-flex size-2 rounded-full bg-accent" />
                    </span>
                    <Bot className="size-4 text-accent" aria-hidden />
                    The agent is working this card
                  </span>
                  <Link
                    to={`/w/${task.workspaceId}/s/${run.sessionId}`}
                    className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline"
                  >
                    Watch the session
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={runTask.isPending}
                    onClick={() => runTask.mutate()}
                  >
                    <Bot className="size-3.5" aria-hidden />
                    {run ? 'Send back to the agent' : 'Send to the agent'}
                  </Button>
                  <span className="text-[12px] text-muted">
                    Runs this card in its own session; done stays your call.
                  </span>
                  {run ? (
                    <Link
                      to={`/w/${task.workspaceId}/s/${run.sessionId}`}
                      className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline"
                    >
                      Last session
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Sub-tasks</h3>
            {detail.data && detail.data.children.length > 0 ? (
              <ul className="space-y-1">
                {detail.data.children.map((child) => (
                  <li key={child.id} className="flex items-center gap-2 text-[13px] text-ink">
                    <span className={cn('size-1.5 rounded-full', child.status === 'done' ? 'bg-success' : 'bg-line')} aria-hidden />
                    <span className={cn('truncate', child.status === 'done' && 'text-muted line-through')}>{child.title}</span>
                    <span className="ml-auto shrink-0 text-[11.5px] text-subtle">{columnLabel(child.status)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (subTask.trim()) addSubTask.mutate();
              }}
            >
              <Input
                value={subTask}
                onChange={(event) => setSubTask(event.target.value)}
                placeholder="Break a piece out…"
                aria-label="New sub-task"
                maxLength={300}
              />
              <Button type="submit" variant="secondary" size="sm" disabled={!subTask.trim()}>
                Add
              </Button>
            </form>
          </div>

          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Comments</h3>
            <ul className="space-y-2">
              {(detail.data?.comments ?? []).map((entry) => (
                <li key={entry.id} className="rounded-lg border border-line bg-raised/50 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                    {entry.author.startsWith('agent:') ? <Bot className="size-3" aria-hidden /> : <UserIcon className="size-3" aria-hidden />}
                    {entry.author.replace(/^(user|agent):/, '')}
                    <span>· {formatRelative(entry.createdAt)}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink">{entry.body}</p>
                </li>
              ))}
            </ul>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (comment.trim()) addComment.mutate();
              }}
            >
              <Input
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Add a comment…"
                aria-label="New comment"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={!comment.trim()}>
                Send
              </Button>
            </form>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowHistory((current) => !current)}
              className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink"
            >
              <History className="size-3.5" aria-hidden />
              {showHistory ? 'Hide history' : `History (${detail.data?.activity.length ?? 0})`}
            </button>
            {showHistory ? (
              <ul className="mt-2 space-y-1 border-l border-line pl-3">
                {(detail.data?.activity ?? []).map((event) => (
                  <li key={event.id} className="text-[12px] text-muted">
                    <span className="text-subtle">{formatRelative(event.at)}</span>{' '}
                    <span className="text-ink">{event.actor.replace(/^(user|agent):/, '')}</span> {event.kind}
                    {event.detail ? <span className="text-subtle"> — {event.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
