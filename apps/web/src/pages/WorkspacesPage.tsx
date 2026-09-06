/**
 * Workspace index — create, browse and archive projects.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Page } from '@/components/ui/layout';
import { Archive, FolderGit2, GitBranch, MoreVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { Workspace } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { TOUCH_TARGET_Y } from '@/components/ui/touch-target';
import { cn, colorForName, formatRelative, WORKSPACE_COLORS } from '@/lib/utils';
import { Trans, usePlural, useT } from '@/lib/i18n';

export function WorkspacesPage() {
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Workspace | null>(null);

  // `?new=1` lets the command palette deep-link straight into creation.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setCreating(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const { data, isLoading } = useQuery({
    queryKey: ['workspaces', showArchived],
    queryFn: () => api.workspaces(showArchived),
  });
  // Metaclaude's own workspace. It is listed like the others and opened like
  // the others, but it cannot be archived or deleted — the server answers
  // 409 — so the card offers neither rather than a menu that only refuses.
  const systemWorkspaceId = data?.systemWorkspaceId ?? null;
  // Sessions with a reply nobody has read, by workspace. The card shows the
  // fact, not the number: what to do about it is one click away either way.
  const unread = data?.unread ?? {};

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.updateWorkspace(id, { archived }),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(variables.archived ? t('Workspace archived') : t('Workspace restored'));
    },
  });

  const remove = useMutation({
    mutationFn: ({ id, purge }: { id: string; purge: boolean }) => api.deleteWorkspace(id, purge),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(variables.purge ? t('Workspace and files deleted') : t('Workspace removed'));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not delete the workspace.',
      )),
  });

  const workspaces = data?.workspaces ?? [];

  return (
    <AppShell>
      <ContentHeader
        title={t('Workspaces')}
        subtitle={t('Each workspace is a project directory with its own agent policy and memory.')}
        showSidebarToggle={false}
        actions={
          <>
            {/* The labels fold to their icon below `sm`. This header also
                carries the phone-only status cluster, and in French — where the
                labels run half again as long — the row overflowed and the last
                item went off-screen: the account menu, at [376..408]/390. Each
                button keeps an explicit `aria-label`, because a label in
                `hidden sm:inline` is `display: none` and therefore out of the
                accessible name, exactly on the screen where it disappears. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowArchived((value) => !value)}
              aria-pressed={showArchived}
              aria-label={showArchived ? t('Hide archived') : t('Show archived')}
            >
              <Archive className="size-4" aria-hidden />
              <span className="hidden sm:inline">
                {showArchived ? t('Hide archived') : t('Show archived')}
              </span>
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
              aria-label={t('New workspace')}
            >
              <Plus className="size-4" aria-hidden />
              <span className="hidden sm:inline">{t('New')}</span>
            </Button>
          </>
        }
      />

      <Page width="wide" gap="none">
          {isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-32" />
              ))}
            </div>
          ) : workspaces.length === 0 ? (
            <EmptyState
              icon={<FolderGit2 />}
              title={t('No workspaces')}
              description={t(
                'Create one to give the agent a project directory to work in. You can start empty or clone a git repository.',
              )}
              action={
                <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t('New workspace')}
                </Button>
              }
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {workspaces.map((workspace) => (
                <li key={workspace.id} className="group relative">
                  <Link
                    to={`/w/${workspace.id}`}
                    className="block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className="size-10 shrink-0 rounded-lg"
                        style={{ background: workspace.color }}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                          <span className="min-w-0 truncate">{workspace.name}</span>
                          {/* One dot, whatever the count: the number of unread
                              sessions is not a decision this card is for. */}
                          {(unread[workspace.id] ?? 0) > 0 ? (
                            <span
                              role="img"
                              aria-label={plural(
                                unread[workspace.id] ?? 0,
                                '{n} session with an unread reply',
                                '{n} sessions with an unread reply',
                              )}
                              className="size-1.5 shrink-0 rounded-full bg-accent"
                            />
                          ) : null}
                        </p>
                        <p className="truncate font-mono text-[11.5px] text-subtle">
                          {workspace.slug}
                        </p>
                      </div>
                    </div>

                    {workspace.description ? (
                      <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
                        {workspace.description}
                      </p>
                    ) : null}

                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {workspace.id === systemWorkspaceId ? (
                        <Badge tone="accent">{t('system')}</Badge>
                      ) : null}
                      {workspace.archived ? <Badge tone="warning">{t('archived')}</Badge> : null}
                      {workspace.settings.autoPolicyEnabled ? (
                        <Badge tone="thinking">{t('learning')}</Badge>
                      ) : null}
                      {workspace.settings.defaultPermissionMode === 'bypassPermissions' ? (
                        <Badge tone="danger">{t('bypass')}</Badge>
                      ) : null}
                      <span className="ml-auto text-[11px] text-subtle">
                        {formatRelative(workspace.updatedAt)}
                      </span>
                    </div>
                  </Link>

                  {/* Positioned over the link rather than inside it: nesting a
                      menu trigger in an anchor breaks keyboard activation. */}
                  {workspace.id === systemWorkspaceId ? null : (
                  <div className="absolute right-2 top-2">
                    <Menu
                      side="bottom"
                      align="end"
                      trigger={
                        <button
                          type="button"
                          className="flex size-7 items-center justify-center rounded-md text-subtle opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                          aria-label={t('Actions for {name}', { name: workspace.name })}
                        >
                          <MoreVertical className="size-4" />
                        </button>
                      }
                    >
                      <MenuItem
                        icon={<Archive />}
                        onSelect={() =>
                          archive.mutate({ id: workspace.id, archived: !workspace.archived })
                        }
                      >
                        {workspace.archived ? t('Restore') : t('Archive')}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        icon={<Trash2 />}
                        tone="danger"
                        onSelect={() => setPendingDelete(workspace)}
                      >
                        {t('Delete')}
                      </MenuItem>
                    </Menu>
                  </div>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Page>

      <CreateWorkspaceModal open={creating} onOpenChange={setCreating} />

      <DeleteWorkspaceDialog
        workspace={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={(purge) => {
          if (pendingDelete) remove.mutate({ id: pendingDelete.id, purge });
        }}
      />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function CreateWorkspaceModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
  const [touchedColor, setTouchedColor] = useState(false);

  // Until the user picks a colour, derive one from the name so each new
  // workspace looks distinct without anyone having to choose.
  useEffect(() => {
    if (!touchedColor && name) setColor(colorForName(name));
  }, [name, touchedColor]);

  const create = useMutation({
    mutationFn: () =>
      api.createWorkspace({
        name: name.trim(),
        description: description.trim(),
        color,
        ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(t('Workspace created'));
      onOpenChange(false);
      setName('');
      setDescription('');
      setGitUrl('');
      setTouchedColor(false);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not create the workspace.',
      )),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('New workspace')}
      description={t(
        'A directory the agent can work in, with its own settings, memory and automations.',
      )}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={create.isPending}
            disabled={!name.trim()}
            onClick={() => create.mutate()}
          >
            {t('Create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Label htmlFor="ws-name">
          {t('Name')}
          <Input
            id="ws-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('Payments service')}
            autoFocus
            className="mt-1.5"
          />
        </Label>

        <Label htmlFor="ws-description">
          {t('Description')}
          <Textarea
            id="ws-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('What this project is, in one line.')}
            rows={2}
            className="mt-1.5"
          />
        </Label>

        <Label
          htmlFor="ws-git"
          hint={t(
            'Optional. Leave blank to start from an empty directory with a starter CLAUDE.md.',
          )}
        >
          {t('Clone a repository')}
          <Input
            id="ws-git"
            value={gitUrl}
            onChange={(event) => setGitUrl(event.target.value)}
            placeholder="https://github.com/you/project.git"
            className="mt-1.5 font-mono text-[13px]"
          />
        </Label>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink">{t('Colour')}</legend>
          <div className="flex flex-wrap gap-2">
            {WORKSPACE_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                onClick={() => {
                  setColor(swatch);
                  setTouchedColor(true);
                }}
                aria-label={t('Use colour {swatch}', { swatch: swatch })}
                aria-pressed={color === swatch}
                className={cn(
                  'size-7 rounded-lg ring-offset-2 ring-offset-surface transition-all',
                  'data-[active=true]:ring-2 data-[active=true]:ring-accent',
                  TOUCH_TARGET_Y,
                )}
                data-active={color === swatch}
                style={{ background: swatch }}
              />
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

function DeleteWorkspaceDialog({
  workspace,
  onClose,
  onConfirm,
}: {
  workspace: Workspace | null;
  onClose: () => void;
  onConfirm: (purge: boolean) => void;
}) {
  const t = useT();
  const [purge, setPurge] = useState(false);

  useEffect(() => {
    if (workspace) setPurge(false);
  }, [workspace]);

  return (
    <ConfirmDialog
      open={Boolean(workspace)}
      onOpenChange={(open) => !open && onClose()}
      title={`Delete "${workspace?.name ?? ''}"?`}
      confirmLabel={purge ? t('Delete workspace and files') : t('Delete workspace')}
      danger
      onConfirm={() => onConfirm(purge)}
      description={
        <div className="space-y-3">
          <p>
            {t('Its sessions, transcripts, memories and automations are removed permanently.')}
          </p>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/30 p-3">
            <input
              type="checkbox"
              checked={purge}
              onChange={(event) => setPurge(event.target.checked)}
              className="mt-0.5 size-3.5 accent-[var(--mc-danger)]"
            />
            <span className="text-[12.5px] leading-relaxed">
              <span className="font-medium text-ink">{t('Also delete the files on disk')}</span>
              <br />
              <Trans
                template={t(
                  'Everything under {path} is erased. This cannot be undone. Leave this unchecked to keep the files and only forget the workspace.',
                )}
                values={{
                  path: <code className="font-mono text-[11.5px]">{workspace?.path}</code>,
                }}
              />
            </span>
          </label>
        </div>
      }
    />
  );
}
