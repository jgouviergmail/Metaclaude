/**
 * Session list for the workspace sidebar.
 *
 * Sessions are the unit people actually navigate between, so the row carries
 * everything needed to choose one at a glance — what it is, whether it is doing
 * something right now, and how recently it was touched — and nothing else.
 * The server sends the list already sorted (pinned first, then activity); this
 * component never reorders it, so a pin does not make rows jump before the
 * refetch confirms the change.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, MessageSquarePlus, MoreHorizontal, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Session, SessionStatus } from '@metaclaude/shared';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Button, EmptyState, Input } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';

export function SessionList({
  workspaceId,
  activeSessionId,
  sessions,
  onCreate,
  creating,
}: {
  workspaceId: string;
  activeSessionId: string;
  sessions: Session[];
  onCreate: () => void;
  creating: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
  };

  const fail = (error: unknown, fallback: string): void => {
    toast.error(error instanceof ApiError ? error.message : fallback);
  };

  const setPinned = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateSession(id, { pinned }),
    onSuccess: invalidate,
    onError: (error) => fail(error, 'Could not pin the session.'),
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.updateSession(id, { archived: true }),
    onSuccess: (_data, id) => {
      invalidate();
      toast.success('Session archived');
      // Archiving drops the session out of the list; staying on it would leave
      // the transcript pointing at something the sidebar no longer offers.
      if (id === activeSessionId) navigate(`/w/${workspaceId}`);
    },
    onError: (error) => fail(error, 'Could not archive the session.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_data, id) => {
      invalidate();
      toast.success('Session deleted');
      if (id === activeSessionId) navigate(`/w/${workspaceId}`, { replace: true });
    },
    onError: (error) => fail(error, 'Could not delete the session.'),
  });

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => sessionTitle(session).toLowerCase().includes(needle));
  }, [sessions, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-line px-3 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Sessions</h2>
          <span className="text-[11px] tabular-nums text-subtle">{sessions.length}</span>

          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="New session"
            onClick={onCreate}
            loading={creating}
          >
            {creating ? null : <Plus className="size-4" />}
          </Button>
        </div>

        {/* Only worth the vertical space once there is enough to sift through. */}
        {sessions.length > 5 ? (
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter sessions"
              aria-label="Filter sessions"
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        ) : null}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Sessions">
        {sessions.length === 0 ? (
          <EmptyState
            icon={<MessageSquarePlus />}
            title="No sessions yet"
            description="Start one to give Metaclaude something to work on in this workspace."
            action={
              <Button variant="primary" size="sm" onClick={onCreate} loading={creating}>
                <Plus className="size-4" />
                New session
              </Button>
            }
            className="py-10"
          />
        ) : visible.length === 0 ? (
          <p className="px-3 py-8 text-center text-[13px] text-muted">
            No session matches “{filter.trim()}”.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {visible.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                workspaceId={workspaceId}
                active={session.id === activeSessionId}
                onTogglePin={() =>
                  setPinned.mutate({ id: session.id, pinned: !session.pinned })
                }
                onArchive={() => archive.mutate(session.id)}
                onDelete={() => setPendingDelete(session)}
              />
            ))}
          </ul>
        )}
      </nav>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this session?"
        description={
          <>
            “{pendingDelete ? sessionTitle(pendingDelete) : ''}” and its run history are removed
            permanently. Files in the workspace are untouched.
          </>
        }
        confirmLabel="Delete session"
        danger
        onConfirm={async () => {
          if (pendingDelete) await remove.mutateAsync(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function SessionRow({
  session,
  workspaceId,
  active,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  session: Session;
  workspaceId: string;
  active: boolean;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const title = sessionTitle(session);

  return (
    <li
      className="group relative"
      onContextMenu={(event) => {
        event.preventDefault();
        // Radix opens the menu on pointerdown, not click, so a synthesised
        // click would be ignored — dispatch the event it actually listens for.
        menuTrigger.current?.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
        );
      }}
    >
      <Link
        to={`/w/${workspaceId}/s/${session.id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'block rounded-lg py-2 pl-2.5 pr-9 transition-colors',
          active ? 'bg-accent-soft' : 'hover:bg-raised',
        )}
      >
        <div className="flex items-center gap-1.5">
          {session.pinned ? (
            <Pin className="size-3 shrink-0 text-subtle" aria-label="Pinned" />
          ) : null}
          <StatusDot status={session.status} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-tight',
              active ? 'font-medium text-ink' : 'text-muted group-hover:text-ink',
            )}
          >
            {title}
          </span>
        </div>

        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-subtle">
          <span>{formatRelative(session.lastActivityAt)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {session.runCount} {session.runCount === 1 ? 'run' : 'runs'}
          </span>
        </div>
      </Link>

      <Menu
        side="bottom"
        align="end"
        trigger={
          <button
            ref={menuTrigger}
            type="button"
            aria-label={`Actions for ${title}`}
            className={cn(
              'absolute right-1 top-1.5 flex size-7 items-center justify-center rounded-md',
              'text-subtle transition-colors hover:bg-raised hover:text-ink',
              // Kept mounted for keyboard and touch users; only the paint is hover-gated.
              'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
              'data-[state=open]:opacity-100',
              active && 'opacity-100',
            )}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        }
      >
        <MenuItem
          icon={session.pinned ? <PinOff /> : <Pin />}
          onSelect={onTogglePin}
        >
          {session.pinned ? 'Unpin' : 'Pin to top'}
        </MenuItem>
        <MenuItem icon={<Archive />} onSelect={onArchive}>
          Archive
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
          Delete
        </MenuItem>
      </Menu>
    </li>
  );
}

/** Idle sessions get no dot at all — quiet is the common case and needs no ink. */
function StatusDot({ status }: { status: SessionStatus }) {
  if (status === 'running') {
    return (
      <span
        role="img"
        aria-label="Running"
        title="Running"
        className="pulse-ring relative size-1.5 shrink-0 rounded-full bg-accent"
      />
    );
  }

  if (status === 'waiting_approval') {
    return (
      <span
        role="img"
        aria-label="Waiting for approval"
        title="Waiting for approval"
        className="size-1.5 shrink-0 rounded-full bg-warning"
      />
    );
  }

  if (status === 'error') {
    return (
      <span
        role="img"
        aria-label="Failed"
        title="Failed"
        className="size-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }

  return null;
}

function sessionTitle(session: Session): string {
  return session.title || 'New session';
}
