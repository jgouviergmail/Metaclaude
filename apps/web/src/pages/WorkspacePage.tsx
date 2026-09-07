/**
 * Workspace overview — sessions, settings and health for one project.
 *
 * Opening a workspace with no session at all jumps straight into a new one:
 * the operator came here to talk to the agent, not to press "new" first.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Page, Section } from '@/components/ui/layout';
import { GitBranch, Loader2, Plus, Settings2, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { PERMISSION_MODE_INFO } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { WorkspaceSettingsModal } from '@/components/workspace/WorkspaceSettingsModal';
import { CliSessionList } from '@/components/workspace/CliSessionList';
import { MarketplacePluginToggles } from '@/components/workspace/MarketplacePluginToggles';
import { SessionList } from '@/components/workspace/SessionList';

import { Menu } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  EmptyState,
  Spinner,
  Stat,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { useUiStore } from '@/lib/store';
import { formatRelative } from '@/lib/utils';
import { routes } from '@metaclaude/shared';

export function WorkspacePage() {
  const plural = usePlural();
  const t = useT();
  const { workspaceId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setLastWorkspace = useUiStore((state) => state.setLastWorkspace);

  const [showSettings, setShowSettings] = useState(false);
  const [showCliSessions, setShowCliSessions] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api.workspace(workspaceId),
    enabled: Boolean(workspaceId),
  });

  useEffect(() => {
    if (workspaceId) setLastWorkspace(workspaceId);
  }, [workspaceId, setLastWorkspace]);

  const createSession = useMutation({
    mutationFn: () => api.createSession({ workspaceId }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      navigate(routes.session(workspaceId, result.session.id));
    },
    onError: () => toast.error(t('Could not start a session.')),
  });

  const workspace = data?.workspace;
  const sessions = data?.sessions ?? [];

  // The CLI's own transcript store, read only while the import dialog is open.
  const cliSessions = useQuery({
    queryKey: ['claude-cli-sessions', workspaceId],
    queryFn: () => api.claudeCliSessions(workspaceId),
    enabled: showCliSessions && Boolean(workspaceId),
  });

  const adoptSession = useMutation({
    mutationFn: (claudeSessionId: string) => api.adoptCliSession(workspaceId, claudeSessionId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['claude-cli-sessions', workspaceId] });
      setShowCliSessions(false);
      navigate(routes.session(workspaceId, result.session.id));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not adopt that session.')),
  });

  // Land directly in a session when this workspace has none yet.
  const noSessions = Boolean(data) && sessions.length === 0;
  useEffect(() => {
    if (noSessions && !createSession.isPending && !createSession.isSuccess) {
      createSession.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noSessions]);

  const sidebar = (
    <SessionList
      workspaceId={workspaceId}
      activeSessionId=""
      sessions={sessions}
      archivedCount={data?.archivedSessionCount ?? 0}
      onCreate={() => createSession.mutate()}
      creating={createSession.isPending}
    />
  );

  if (isLoading) {
    return (
      <AppShell sidebar={sidebar}>
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      </AppShell>
    );
  }

  if (isError || !workspace) {
    return (
      <AppShell>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-body text-muted">{t('That workspace could not be loaded.')}</p>
          <Button variant="secondary" size="sm" onClick={() => navigate(routes.workspaces())}>{t(
            'All workspaces',
          )}</Button>
        </div>
      </AppShell>
    );
  }

  const git = data?.gitStatus;
  const memoryStats = data?.memoryStats;
  const totalMemories = memoryStats
    ? memoryStats.episodic + memoryStats.semantic + memoryStats.procedural
    : 0;

  return (
    <AppShell sidebar={sidebar}>
      <ContentHeader
        title={workspace.name}
        subtitle={workspace.path}
        icon={
          <span
            className="block size-4 rounded"
            style={{ background: workspace.color }}
            aria-hidden
          />
        }
        actions={
          <>
            <Tooltip content={t('Workspace settings')}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Workspace settings')}
                onClick={() => setShowSettings(true)}
              >
                <Settings2 className="size-4" />
              </Button>
            </Tooltip>
            <Button
              variant="primary"
              size="sm"
              onClick={() => createSession.mutate()}
              loading={createSession.isPending}
            >
              <Plus className="size-4" aria-hidden />{t('New session')}</Button>
          </>
        }
      />

      <Page width="standard">
          {workspace.description ? (
            <p className="text-body leading-relaxed text-muted">{workspace.description}</p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('Sessions')} value={sessions.length} />
            <Stat
              label={t('Memories')}
              value={totalMemories}
              hint={
                memoryStats
                  ? `${plural(memoryStats.semantic, '{n} fact', '{n} facts')} · ${plural(
                      memoryStats.procedural,
                      '{n} procedure',
                      '{n} procedures',
                    )}`
                  : undefined
              }
            />
            <Stat
              label={t('Permission mode')}
              value={
                <span className="text-title">
                  {t(PERMISSION_MODE_INFO[workspace.settings.defaultPermissionMode].label)}
                </span>
              }
              tone={
                workspace.settings.defaultPermissionMode === 'bypassPermissions'
                  ? 'danger'
                  : undefined
              }
            />
            <Stat
              label={t('Branch')}
              value={<span className="text-title">{git?.branch ?? '—'}</span>}
              hint={
                git?.isRepo
                  ? `${plural(
                      git.modified.length,
                      '{n} modified file',
                      '{n} modified files',
                    )} · ${plural(
                      git.untracked.length,
                      '{n} untracked file',
                      '{n} untracked files',
                    )}`
                  : t('Not a git repository')
              }
            />
          </div>

          {git?.isRepo && (git.modified.length > 0 || git.untracked.length > 0) ? (
            <Section
              title={t('Uncommitted changes')}
              icon={<GitBranch className="text-muted" />}
              actions={
                <Badge tone="warning">{git.modified.length + git.untracked.length}</Badge>
              }
            >
              <ul className="max-h-56 overflow-y-auto">
                {[...git.modified.map((p) => ({ path: p, kind: 'modified' as const })),
                  ...git.untracked.map((p) => ({ path: p, kind: 'untracked' as const }))]
                  .slice(0, 40)
                  .map((entry) => (
                    <li key={`${entry.kind}-${entry.path}`} className="flex items-center gap-2 py-1">
                      <Badge tone={entry.kind === 'modified' ? 'warning' : 'neutral'}>
                        {entry.kind === 'modified' ? 'M' : 'U'}
                      </Badge>
                      <code className="min-w-0 truncate font-mono text-caption text-muted">
                        {entry.path}
                      </code>
                    </li>
                  ))}
              </ul>
            </Section>
          ) : null}

          <Section
            title={t('Sessions')}
            actions={
              <>
                <Button variant="ghost" size="sm" onClick={() => setShowCliSessions(true)}>
                  <TerminalSquare className="size-4" aria-hidden />
                  {t('From the CLI')}
                </Button>
                <span className="text-caption text-subtle">{sessions.length}</span>
              </>
            }
          >
            {sessions.length === 0 ? (
              <EmptyState
                icon={<Loader2 className="animate-spin" />}
                title={t('Starting your first session')}
                description={t('One moment.')}
              />
            ) : (
              <ul className="divide-y divide-line">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <Link
                      to={routes.session(workspaceId, session.id)}
                      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-raised"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-medium text-ink">
                          {session.title || t('New session')}
                        </p>
                        <p className="text-caption text-subtle">
                          {plural(session.runCount, '{n} run', '{n} runs')} ·{' '}
                          {formatRelative(session.lastActivityAt)}
                        </p>
                      </div>
                      {session.status === 'running' ? <Badge tone="accent">{t('running')}</Badge> : null}
                      {session.status === 'waiting_approval' ? (
                        <Badge tone="warning">{t('waiting')}</Badge>
                      ) : null}
                      {session.status === 'error' ? <Badge tone="danger">{t('error')}</Badge> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
      </Page>

      <WorkspaceSettingsModal
        open={showSettings}
        onOpenChange={setShowSettings}
        workspaceId={workspaceId}
        settings={workspace.settings}
        name={workspace.name}
        description={workspace.description}
        locked={Boolean(data?.isSystem)}
      />

      <Modal
        open={showCliSessions}
        onOpenChange={setShowCliSessions}
        title={t('Sessions from the Claude CLI')}
        description={t(
          'Conversations the CLI holds for this directory — including ones started in a terminal. Adopting one binds it here, so resuming and steering work as usual.',
        )}
        size="lg"
      >
        {cliSessions.isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : cliSessions.isError ? (
          <p className="py-4 text-body text-muted">{t(
            "The CLI's session store could not be read.",
          )}</p>
        ) : (
          <CliSessionList
            sessions={cliSessions.data?.sessions ?? []}
            adoptingId={adoptSession.isPending ? adoptSession.variables : null}
            onAdopt={(claudeSessionId) => adoptSession.mutate(claudeSessionId)}
            onOpen={(sessionId) => {
              setShowCliSessions(false);
              navigate(routes.session(workspaceId, sessionId));
            }}
          />
        )}
      </Modal>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
