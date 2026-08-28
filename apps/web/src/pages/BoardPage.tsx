/**
 * The board — five columns, every workspace, live.
 *
 * One horizontal band of columns on every screen: a phone swipes between
 * them (scroll snap), a desktop sees them side by side, and each column
 * scrolls its own cards, so the page never scrolls two axes at once.
 * Updates arrive as socket frames and patch the query cache in place —
 * an agent moving a card (the delegation lot) appears under your cursor
 * without a refetch.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Play, SquareKanban } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { workspaceTopic, type BoardTask, type TaskPriority, type TaskStatus } from '@metaclaude/shared';
import { toast } from 'sonner';
import { BoardColumn } from '@/components/board/BoardColumn';
import { TaskDrawer } from '@/components/board/TaskDrawer';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { Button, EmptyState, Input, Label, Spinner, Textarea } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import {
  boardCounts,
  filterByAssignee,
  groupByColumn,
  TASK_COLUMNS,
  upsertTask,
  type AssigneeFilter,
} from '@/lib/board';
import { socket } from '@/lib/socket';
import { useBoardTouchDrag } from '@/lib/touch-drag';
import { cn } from '@/lib/utils';

const WHO_FILTERS: Array<{ value: AssigneeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'Yours' },
  { value: 'agent', label: 'Agent' },
];

export function BoardPage() {
  const plural = usePlural();
  const t = useT();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => api.workspaces() });
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const workspaceId = searchParams.get('w') ?? workspaces[0]?.id ?? null;
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);

  const boardQuery = useQuery({
    queryKey: ['board', workspaceId],
    queryFn: () => api.board(workspaceId as string),
    enabled: workspaceId !== null,
  });

  /* -- Live updates ------------------------------------------------------- */

  useEffect(() => {
    if (!workspaceId) return;
    const release = socket.subscribe(workspaceTopic(workspaceId));
    const detach = socket.onFrame((frame) => {
      if (frame.type === 'board_task' && frame.task.workspaceId === workspaceId) {
        queryClient.setQueryData<{ tasks: BoardTask[] }>(['board', workspaceId], (cached) =>
          cached ? { tasks: upsertTask(cached.tasks, frame.task) } : cached,
        );
        void queryClient.invalidateQueries({ queryKey: ['task', frame.task.id] });
      }
      if (frame.type === 'board_task_removed') {
        queryClient.setQueryData<{ tasks: BoardTask[] }>(['board', workspaceId], (cached) =>
          cached ? { tasks: cached.tasks.filter((task) => task.id !== frame.taskId) } : cached,
        );
      }
      if (frame.type === 'board_comment') {
        void queryClient.invalidateQueries({ queryKey: ['task', frame.comment.taskId] });
      }
    });
    return () => {
      release();
      detach();
    };
  }, [workspaceId, queryClient]);

  /* -- Mutations ---------------------------------------------------------- */

  const onError = (error: unknown): void => {
    toast.error(error instanceof ApiError ? error.message : t('The board did not accept that.'));
    void queryClient.invalidateQueries({ queryKey: ['board', workspaceId] });
  };

  const move = useMutation({
    mutationFn: ({ taskId, status, afterId }: { taskId: string; status: TaskStatus; afterId: string | null }) =>
      api.moveTask(taskId, { status, afterId }),
    onError,
  });

  const workBoard = useMutation({
    mutationFn: () => api.workBoard(workspaceId as string),
    onSuccess: (outcome) => {
      if (outcome.started) toast.success(t(
        'Started "{title}".',
        { title: outcome.started.title },
      ));
      else if (outcome.reason === 'busy') toast.info(t(
        'A card is already being worked — one at a time.',
      ));
      else toast.info(t('Nothing unblocked in To do.'));
    },
    onError,
  });

  const [drawerTask, setDrawerTask] = useState<string | null>(null);
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('normal');

  const create = useMutation({
    mutationFn: () =>
      api.createTask(workspaceId as string, {
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        status: creating ?? 'todo',
        priority: newPriority,
      }),
    onSuccess: () => {
      setCreating(null);
      setNewTitle('');
      setNewDescription('');
      setNewPriority('normal');
    },
    onError,
  });

  const [who, setWho] = useState<AssigneeFilter>('all');
  const tasks = boardQuery.data?.tasks ?? [];
  const counts = useMemo(() => boardCounts(tasks), [tasks]);
  const columns = useMemo(() => groupByColumn(filterByAssignee(tasks, who)), [tasks, who]);

  // The phone's drag path. A drop on a card lands after it in that card's
  // column; a drop on a column's open space appends, exactly like the native
  // mouse drag above.
  const touch = useBoardTouchDrag({
    onDropAfterCard: (taskId, targetCardId) => {
      const target = tasks.find((candidate) => candidate.id === targetCardId);
      if (!target || taskId === targetCardId) return;
      move.mutate({ taskId, status: target.status, afterId: targetCardId });
    },
    onDropOnColumn: (taskId, status) => {
      const afterId = (columns.get(status) ?? []).at(-1)?.id ?? null;
      move.mutate({ taskId, status, afterId: afterId === taskId ? null : afterId });
    },
  });

  return (
    <AppShell>
    <div className="flex h-full min-h-0 flex-col">
      <ContentHeader
        title={t('Board')}
        subtitle={t('What is captured, moving, and done — for you and the agents alike.')}
        actions={
          <div className="flex items-center gap-2">
            <Menu
              trigger={
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-ink hover:border-accent"
                >
                  {workspace?.name ?? t('Workspace')}
                  <ChevronDown className="size-3.5" aria-hidden />
                </button>
              }
            >
              {workspaces.map((candidate) => (
                <MenuItem
                  key={candidate.id}
                  selected={candidate.id === workspaceId}
                  onSelect={() => setSearchParams({ w: candidate.id })}
                >
                  {candidate.name}
                </MenuItem>
              ))}
            </Menu>
            <Button
              variant="secondary"
              size="sm"
              disabled={!workspaceId}
              loading={workBoard.isPending}
              onClick={() => workBoard.mutate()}
            >
              <Play className="size-3.5" aria-hidden />
              {t('Work the board')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreating('todo')} disabled={!workspaceId}>
              {t('New task')}
            </Button>
          </div>
        }
      />

      {workspacesQuery.isLoading || boardQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : !workspaceId ? (
        <EmptyState
          icon={<SquareKanban />}
          title={t('No workspace yet')}
          description={t('Create a workspace first — its board comes with it.')}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2 sm:px-6">
            <div className="flex gap-1.5" role="group" aria-label={t('Filter by assignee')}>
              {WHO_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={who === filter.value}
                  onClick={() => setWho(filter.value)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-[12.5px]',
                    who === filter.value
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'border border-line text-muted hover:text-ink',
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <p className="ml-auto text-[12px] text-muted">
              {plural(counts.total, '{n} card', '{n} cards')}
              {counts.working > 0 ? (
                <span className="text-accent"> · {t(
                  '{n} being worked',
                  { n: counts.working },
                )}</span>
              ) : null}
              {counts.inReview > 0 ? (
                <span> · {t('{n} in review', { n: counts.inReview })}</span>
              ) : null}
              {counts.blocked > 0 ? (
                <span className="text-warning">
                  {' · '}
                  {plural(counts.blocked, '{n} card blocked', '{n} cards blocked')}
                </span>
              ) : null}
            </p>
          </div>
          <div
            data-board-scroller
            className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-4 sm:snap-none sm:p-6"
          >
          {TASK_COLUMNS.map((column) => (
            <BoardColumn
              key={column.status}
              status={column.status}
              label={column.label}
              hint={column.hint}
              tasks={columns.get(column.status) ?? []}
              onOpen={(task) => setDrawerTask(task.id)}
              onMove={(taskId, status, afterId) => move.mutate({ taskId, status, afterId })}
              onQuickAdd={(status) => setCreating(status)}
              touchBind={touch.bind}
              touchTarget={touch.drag?.over ?? null}
            />
          ))}
          </div>
        </>
      )}

      {touch.drag ? (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-xl border border-accent bg-surface px-3 py-2 text-[13px] font-medium text-ink shadow-[var(--mc-shadow-lg)]"
          style={{ left: touch.drag.x, top: touch.drag.y - 8 }}
          aria-hidden
        >
          {touch.drag.task.title}
        </div>
      ) : null}

      <TaskDrawer taskId={drawerTask} onClose={() => setDrawerTask(null)} />

      <Modal
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
        title={t('New task')}
        description={creating ? t(
          'Lands in {column}.',
          { column: t(TASK_COLUMNS.find((column) => column.status === creating)?.label ?? '') },
        ) : undefined}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(null)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!newTitle.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {t('Create')}
            </Button>
          </div>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (newTitle.trim()) create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-task-title">{t('Title')}</Label>
            <Input
              id="new-task-title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              maxLength={300}
              autoFocus
              placeholder={t('What needs doing?')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-task-description">{t('Description (optional)')}</Label>
            <Textarea
              id="new-task-description"
              rows={3}
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              placeholder={t('What done looks like, constraints, links…')}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('Priority')}</Label>
            <div className="flex gap-1.5">
              {(['low', 'normal', 'high', 'urgent'] as TaskPriority[]).map((priority) => (
                <button
                  key={priority}
                  type="button"
                  aria-pressed={newPriority === priority}
                  onClick={() => setNewPriority(priority)}
                  className={
                    newPriority === priority
                      ? 'rounded-lg bg-accent-soft px-2.5 py-1 text-[12.5px] font-medium text-accent'
                      : 'rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-muted hover:text-ink'
                  }
                >
                  {t(priority)}
                </button>
              ))}
            </div>
          </div>
        </form>
      </Modal>
    </div>
    </AppShell>
  );
}
