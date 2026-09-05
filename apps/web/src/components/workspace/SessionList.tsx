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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { isSessionUnread, type Session, type SessionStatus } from '@metaclaude/shared';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Button, EmptyState, Input, Label } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
import { usePlural, useT, type TranslateFn } from '@/lib/i18n';

export function SessionList({
  workspaceId,
  activeSessionId,
  sessions,
  archivedCount = 0,
  onCreate,
  creating,
}: {
  workspaceId: string;
  activeSessionId: string;
  sessions: Session[];
  /** How many archived sessions this workspace holds; the fold's label. */
  archivedCount?: number;
  onCreate: () => void;
  creating: boolean;
}) {
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  // Archived sessions load when the fold is opened, not before: they are asked
  // for rarely, and by someone who has just decided to go looking for one.
  const [showArchived, setShowArchived] = useState(false);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['archived-sessions', workspaceId] });
  };

  const archivedQuery = useQuery({
    queryKey: ['archived-sessions', workspaceId],
    queryFn: () => api.workspaceSessions(workspaceId, { archived: true }),
    enabled: showArchived && Boolean(workspaceId),
  });

  const fail = (error: unknown, fallback: string): void => {
    toast.error(error instanceof ApiError ? error.message : fallback);
  };

  const setPinned = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateSession(id, { pinned }),
    onSuccess: invalidate,
    onError: (error) => fail(error, t('Could not pin the session.')),
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.updateSession(id, { archived: true }),
    onSuccess: (_data, id) => {
      invalidate();
      toast.success(t('Session archived'));
      // Archiving drops the session out of the list; staying on it would leave
      // the transcript pointing at something the sidebar no longer offers.
      if (id === activeSessionId) navigate(`/w/${workspaceId}`);
    },
    onError: (error) => fail(error, t('Could not archive the session.')),
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.updateSession(id, { title }),
    onSuccess: () => {
      invalidate();
      setRenaming(null);
      toast.success(t('Session renamed'));
    },
    onError: (error) => fail(error, t('Could not rename the session.')),
  });

  const unarchive = useMutation({
    mutationFn: (id: string) => api.updateSession(id, { archived: false }),
    onSuccess: () => {
      invalidate();
      toast.success(t('Session restored'));
    },
    onError: (error) => fail(error, t('Could not restore the session.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_data, id) => {
      invalidate();
      toast.success(t('Session deleted'));
      if (id === activeSessionId) navigate(`/w/${workspaceId}`, { replace: true });
    },
    onError: (error) => fail(error, t('Could not delete the session.')),
  });

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => sessionTitle(session, t).toLowerCase().includes(needle));
  }, [sessions, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-line px-3 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{t(
            'Sessions',
          )}</h2>
          <span className="text-[11px] tabular-nums text-subtle">{sessions.length}</span>

          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t('New session')}
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
              placeholder={t('Filter sessions')}
              aria-label={t('Filter sessions')}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        ) : null}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t('Sessions')}>
        {sessions.length === 0 ? (
          <EmptyState
            icon={<MessageSquarePlus />}
            title={t('No sessions yet')}
            description={t('Start one to give Metaclaude something to work on in this workspace.')}
            action={
              <Button variant="primary" size="sm" onClick={onCreate} loading={creating}>
                <Plus className="size-4" />
                {t('New session')}
              </Button>
            }
            className="py-10"
          />
        ) : visible.length === 0 ? (
          <p className="px-3 py-8 text-center text-[13px] text-muted">
            {t('No session matches “{filter}”.', { filter: filter.trim() })}
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
                onRename={() => setRenaming(session)}
                onDelete={() => setPendingDelete(session)}
              />
            ))}
          </ul>
        )}
      </nav>

      {archivedCount > 0 ? (
        <div className="shrink-0 border-t border-line p-2">
          <details
            data-testid="archived-sessions"
            onToggle={(event) => setShowArchived((event.target as HTMLDetailsElement).open)}
            className="rounded-lg bg-sunken/40 px-2.5 py-2"
          >
            <summary className="cursor-pointer text-[11.5px] font-medium text-muted">
              {plural(archivedCount, 'Archived session ({n})', 'Archived sessions ({n})')}
            </summary>
            {archivedQuery.isLoading ? (
              <p className="mt-2 text-[11.5px] text-subtle">{t('Loading')}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {(archivedQuery.data?.sessions ?? []).map((archivedSession) => (
                  <li key={archivedSession.id} className="flex items-center gap-1">
                    <Link
                      to={`/w/${workspaceId}/s/${archivedSession.id}`}
                      className="min-w-0 flex-1 truncate rounded px-1 py-1 text-[12px] text-muted hover:text-ink"
                    >
                      {sessionTitle(archivedSession, t)}
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => unarchive.mutate(archivedSession.id)}
                      aria-label={t('Restore {title}', { title: sessionTitle(archivedSession, t) })}
                    >
                      <ArchiveRestore className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      ) : null}

      <RenameDialog
        session={renaming}
        onClose={() => setRenaming(null)}
        onSave={(title) => renaming && rename.mutate({ id: renaming.id, title })}
        saving={rename.isPending}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('Delete this session?')}
        description={t(
          '“{title}” and its run history are removed permanently. Files in the workspace are untouched.',
          { title: pendingDelete ? sessionTitle(pendingDelete, t) : '' },
        )}
        confirmLabel={t('Delete session')}
        danger
        onConfirm={async () => {
          if (pendingDelete) await remove.mutateAsync(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

/**
 * Rename a session.
 *
 * A dialog rather than an inline field: the row is a navigation target the
 * whole width of, and a text input inside a link is a trap for both the mouse
 * and the keyboard. Titles are usually written by the first prompt, so this is
 * an edit of existing text — the field opens focused with it selected.
 */
function RenameDialog({
  session,
  onClose,
  onSave,
  saving,
}: {
  session: Session | null;
  onClose: () => void;
  onSave: (title: string) => void;
  saving: boolean;
}) {
  const t = useT();
  const [value, setValue] = useState('');

  // Reset on each opening: the dialog outlives the row it was opened from.
  useEffect(() => {
    if (session) setValue(session.title);
  }, [session]);

  const submit = (): void => {
    const title = value.trim();
    if (!title || !session) return;
    onSave(title);
  };

  return (
    <Modal
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('Rename session')}
      description={t('What this session is about, in a few words. It appears in the sidebar and nowhere else.')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()} loading={saving}>
            {t('Rename')}
          </Button>
        </>
      }
    >
      <Label htmlFor="session-title">
        {t('Title')}
        <Input
          id="session-title"
          value={value}
          autoFocus
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className="mt-1.5"
        />
      </Label>
    </Modal>
  );
}

function SessionRow({
  session,
  workspaceId,
  active,
  onTogglePin,
  onArchive,
  onRename,
  onDelete,
}: {
  session: Session;
  workspaceId: string;
  active: boolean;
  onTogglePin: () => void;
  onArchive: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const plural = usePlural();
  const t = useT();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const title = sessionTitle(session, t);
  // Never on the session being looked at: it is marked read on arrival and
  // again whenever a run settles under the operator's eyes, so a dot there
  // would only ever be the half-second before that request lands.
  const unread = !active && isSessionUnread(session);

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
            <Pin className="size-3 shrink-0 text-subtle" aria-label={t('Pinned')} />
          ) : null}
          <StatusDot status={session.status} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-tight',
              active ? 'font-medium text-ink' : unread ? 'font-medium text-ink' : 'text-muted group-hover:text-ink',
            )}
          >
            {title}
          </span>
          {/* The weight carries it for anyone who cannot pick out a 6px dot;
              the dot carries it for everyone scanning the column. */}
          {unread ? (
            <span
              role="img"
              aria-label={t('Unread reply')}
              title={t('Unread reply')}
              className="size-1.5 shrink-0 rounded-full bg-accent"
            />
          ) : null}
        </div>

        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-subtle">
          <span>{formatRelative(session.lastActivityAt)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {plural(session.runCount, '{n} run', '{n} runs')}
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
            aria-label={t('Actions for {title}', { title: title })}
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
        <MenuItem icon={<Pencil />} onSelect={onRename}>
          {t('Rename')}
        </MenuItem>
        <MenuItem
          icon={session.pinned ? <PinOff /> : <Pin />}
          onSelect={onTogglePin}
        >
          {session.pinned ? 'Unpin' : t('Pin to top')}
        </MenuItem>
        <MenuItem icon={<Archive />} onSelect={onArchive}>
          {t('Archive')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
          {t('Delete')}
        </MenuItem>
      </Menu>
    </li>
  );
}

/** Idle sessions get no dot at all — quiet is the common case and needs no ink. */
function StatusDot({ status }: { status: SessionStatus }) {
  const t = useT();
  if (status === 'running') {
    return (
      <span
        role="img"
        aria-label={t('Running')}
        title={t('Running')}
        className="pulse-ring relative size-1.5 shrink-0 rounded-full bg-accent"
      />
    );
  }

  if (status === 'waiting_approval') {
    return (
      <span
        role="img"
        aria-label={t('Waiting for approval')}
        title={t('Waiting for approval')}
        className="size-1.5 shrink-0 rounded-full bg-warning"
      />
    );
  }

  if (status === 'error') {
    return (
      <span
        role="img"
        aria-label={t('Failed')}
        title={t('Failed')}
        className="size-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }

  return null;
}

/** Not a component, so `t` arrives as an argument rather than from a hook. */
function sessionTitle(session: Session, t: TranslateFn): string {
  return session.title || t('New session');
}
