/**
 * Workspace overview — sessions, settings and health for one project.
 *
 * Opening a workspace with no session at all jumps straight into a new one:
 * the operator came here to talk to the agent, not to press "new" first.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Loader2, Plus, Settings2, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  PERMISSION_MODE_INFO,
  PREAPPROVABLE_TOOLS,
  type EffortLevel,
  type PermissionMode,
  type WorkspaceSettings,
} from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { CliSessionList } from '@/components/workspace/CliSessionList';
import { MarketplacePluginToggles } from '@/components/workspace/MarketplacePluginToggles';
import { SessionList } from '@/components/workspace/SessionList';
import { CheckboxField } from '@/components/ui/controls';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Spinner,
  Stat,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { useUiStore } from '@/lib/store';
import { formatRelative } from '@/lib/utils';

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
      navigate(`/w/${workspaceId}/s/${result.session.id}`);
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
      navigate(`/w/${workspaceId}/s/${result.session.id}`);
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
          <p className="text-sm text-muted">{t('That workspace could not be loaded.')}</p>
          <Button variant="secondary" size="sm" onClick={() => navigate('/workspaces')}>{t(
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

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
          {workspace.description ? (
            <p className="text-[13.5px] leading-relaxed text-muted">{workspace.description}</p>
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
                <span className="text-base">
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
              value={<span className="text-base">{git?.branch ?? '—'}</span>}
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
            <Card>
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <GitBranch className="size-4 shrink-0 text-muted" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">{t('Uncommitted changes')}</h2>
                <Badge tone="warning" className="ml-auto">
                  {git.modified.length + git.untracked.length}
                </Badge>
              </div>
              <ul className="max-h-56 overflow-y-auto px-4 py-2">
                {[...git.modified.map((p) => ({ path: p, kind: 'modified' as const })),
                  ...git.untracked.map((p) => ({ path: p, kind: 'untracked' as const }))]
                  .slice(0, 40)
                  .map((entry) => (
                    <li key={`${entry.kind}-${entry.path}`} className="flex items-center gap-2 py-1">
                      <Badge tone={entry.kind === 'modified' ? 'warning' : 'neutral'}>
                        {entry.kind === 'modified' ? 'M' : 'U'}
                      </Badge>
                      <code className="min-w-0 truncate font-mono text-[12px] text-muted">
                        {entry.path}
                      </code>
                    </li>
                  ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold text-ink">{t('Sessions')}</h2>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowCliSessions(true)}>
                  <TerminalSquare className="size-4" aria-hidden />{t('From the CLI')}</Button>
                <span className="text-[12px] text-subtle">{sessions.length}</span>
              </div>
            </div>

            {sessions.length === 0 ? (
              <EmptyState
                icon={<Loader2 className="animate-spin" />}
                title={t('Starting your first session')}
                description={t('One moment.')}
              />
            ) : (
              <ul className="divide-y divide-[var(--mc-border)]">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <Link
                      to={`/w/${workspaceId}/s/${session.id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-raised"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium text-ink">
                          {session.title || t('New session')}
                        </p>
                        <p className="text-[11.5px] text-subtle">
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
          </Card>
        </div>
      </div>

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
          <p className="py-4 text-[13px] text-muted">{t(
            "The CLI's session store could not be read.",
          )}</p>
        ) : (
          <CliSessionList
            sessions={cliSessions.data?.sessions ?? []}
            adoptingId={adoptSession.isPending ? adoptSession.variables : null}
            onAdopt={(claudeSessionId) => adoptSession.mutate(claudeSessionId)}
            onOpen={(sessionId) => {
              setShowCliSessions(false);
              navigate(`/w/${workspaceId}/s/${sessionId}`);
            }}
          />
        )}
      </Modal>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

const MODELS = ['default', 'opus', 'sonnet', 'haiku', 'opusplan'];
const EFFORTS: Array<EffortLevel | null> = [null, 'low', 'medium', 'high', 'xhigh', 'max'];

/** `auto` is first because it is the default, and because it costs nothing. */
const LANGUAGE_INFO: Record<
  WorkspaceSettings['language'],
  { label: string; description: string }
> = {
  auto: {
    label: 'Follow the request',
    description: 'No instruction at all — the agent answers in the language it was written to.',
  },
  fr: { label: 'Français', description: 'Every answer in French, subagents included.' },
  en: { label: 'English', description: 'Every answer in English, subagents included.' },
};

/**
 * What each pre-approvable tool actually does, in one line.
 *
 * A tool name is not self-explanatory to the person deciding: `WebFetch` and
 * `WebSearch` differ in *where the network call happens*, which is the whole
 * question for a self-hosted deployment, and nothing in the name says so.
 *
 * English kept as data and translated at render, which is the pattern
 * `i18n.tsx` documents: a constant evaluated at import time must never bake a
 * language in.
 */
const TOOL_HINTS: Readonly<Record<(typeof PREAPPROVABLE_TOOLS)[number], string>> = {
  WebFetch: 'Reads a page the agent names. The container fetches it directly.',
  WebSearch: 'Searches the web. The search runs upstream; the container makes no request itself.',
  Bash: 'Runs a shell command. By far the widest of these — it can do anything the others can.',
  Write: 'Creates a file in the workspace.',
  Edit: 'Changes a file that already exists.',
  NotebookEdit: 'Changes a cell in a Jupyter notebook.',
  KillShell: 'Stops a background command it started earlier.',
};

function WorkspaceSettingsModal({
  open,
  onOpenChange,
  workspaceId,
  settings,
  name,
  description,
  locked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  settings: WorkspaceSettings;
  name: string;
  description: string;
  /**
   * The system workspace: permission mode and tool lists are fixed by the
   * server, which answers 409 to a change. Shown locked rather than let
   * the operator learn the rule from a failed save.
   */
  locked: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WorkspaceSettings>(settings);
  const [draftName, setDraftName] = useState(name);
  const [draftDescription, setDraftDescription] = useState(description);

  // Re-seed whenever the dialog opens, so a cancelled edit does not persist.
  useEffect(() => {
    if (open) {
      setDraft(settings);
      setDraftName(name);
      setDraftDescription(description);
    }
  }, [open, settings, name, description]);

  // What the enabled marketplaces offer, as plugin@marketplace keys. Only
  // fetched while the dialog is open — this is the one screen that needs it.
  const marketplacesQuery = useQuery({
    queryKey: ['marketplaces'],
    queryFn: () => api.marketplaces.list(),
    enabled: open,
  });
  const enabledMarketplaces = (marketplacesQuery.data?.marketplaces ?? []).filter(
    (marketplace) => marketplace.enabled,
  );
  const catalogueQueries = useQueries({
    queries: enabledMarketplaces.map((marketplace) => ({
      queryKey: ['marketplace-catalogue', marketplace.id],
      queryFn: () => api.marketplaces.catalogue(marketplace.id),
      enabled: open,
    })),
  });
  const availablePlugins = enabledMarketplaces.flatMap((marketplace, index) =>
    (catalogueQueries[index]?.data?.plugins ?? []).map((plugin) => ({
      key: `${plugin.name}@${marketplace.name}`,
      description: plugin.description,
    })),
  );

  const save = useMutation({
    mutationFn: () =>
      api.updateWorkspace(workspaceId, {
        name: draftName.trim(),
        description: draftDescription.trim(),
        settings: draft,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(t('Settings saved'));
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not save the settings.')),
  });

  const update = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('Workspace settings')}
      description={t('Defaults for every session started in this workspace.')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t(
            'Cancel',
          )}</Button>
          <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>{t(
            'Save',
          )}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Label htmlFor="ws-edit-name">{t('Name')}<Input
            id="ws-edit-name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            className="mt-1.5"
          />
        </Label>

        <Label htmlFor="ws-edit-description">{t('Description')}<Textarea
            id="ws-edit-description"
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            rows={2}
            className="mt-1.5"
          />
        </Label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t(
              'Default model',
            )}</span>
            <Menu
              side="bottom"
              trigger={
                <Button variant="secondary" size="sm" className="w-full justify-between">
                  {String(draft.defaultModel)}
                </Button>
              }
            >
              {MODELS.map((model) => (
                <MenuItem
                  key={model}
                  selected={draft.defaultModel === model}
                  onSelect={() => update('defaultModel', model)}
                >
                  {model}
                </MenuItem>
              ))}
            </Menu>
          </div>

          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t(
              'Default effort',
            )}</span>
            <Menu
              side="bottom"
              trigger={
                <Button variant="secondary" size="sm" className="w-full justify-between">
                  {draft.defaultEffort ?? 'auto'}
                </Button>
              }
            >
              {EFFORTS.map((effort) => (
                <MenuItem
                  key={effort ?? 'auto'}
                  selected={draft.defaultEffort === effort}
                  onSelect={() => update('defaultEffort', effort)}
                >
                  {effort ?? 'auto'}
                </MenuItem>
              ))}
            </Menu>
          </div>
        </div>

        {locked ? (
          <p
            role="note"
            className="rounded-lg border border-line bg-accent-soft px-3 py-2 text-[12px] leading-relaxed text-ink"
          >
            {t(
              'This is Metaclaude’s own workspace. Its permission mode and tool lists are fixed: it asks before anything irreversible, uses its own tools and never gets a shell.',
            )}
          </p>
        ) : null}

        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">{t(
            'Default permission mode',
          )}</span>
          <Menu
            side="bottom"
            trigger={
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-between"
                disabled={locked}
              >
                {t(PERMISSION_MODE_INFO[draft.defaultPermissionMode].label)}
              </Button>
            }
          >
            <MenuLabel>{t('How much to ask before acting')}</MenuLabel>
            {(Object.keys(PERMISSION_MODE_INFO) as PermissionMode[]).map((mode) => (
              <MenuItem
                key={mode}
                selected={draft.defaultPermissionMode === mode}
                onSelect={() => update('defaultPermissionMode', mode)}
                description={t(PERMISSION_MODE_INFO[mode].description)}
                tone={PERMISSION_MODE_INFO[mode].risk === 'high' ? 'danger' : undefined}
              >
                {t(PERMISSION_MODE_INFO[mode].label)}
              </MenuItem>
            ))}
          </Menu>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold text-ink">{t('Pre-approved tools')}</legend>
          <p className="text-[12px] leading-relaxed text-muted">
            {t(
              'A ticked tool runs without its approval card, in every mode but Plan. This is also the only thing an unattended run can use: under "Don’t ask" — where automations and the MCP gateway land — everything not ticked here is refused outright.',
            )}
          </p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {PREAPPROVABLE_TOOLS.map((tool) => (
              <CheckboxField
                key={tool}
                disabled={locked}
                checked={draft.allowedTools.includes(tool)}
                onChange={(value) =>
                  update(
                    'allowedTools',
                    value
                      ? [...draft.allowedTools, tool]
                      : draft.allowedTools.filter((name) => name !== tool),
                  )
                }
                label={tool}
                hint={t(TOOL_HINTS[tool])}
              />
            ))}
          </div>
        </fieldset>

        <MenuSeparator />

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold text-ink">{t('Learning')}</legend>

          <CheckboxField
            checked={draft.memoryEnabled}
            onChange={(value) => update('memoryEnabled', value)}
            label={t('Recall long-term memory')}
            hint={t("Inject what Metaclaude learned in earlier sessions into each run's context.")}
          />
          <CheckboxField
            checked={draft.knowledgeEnabled}
            onChange={(value) => update('knowledgeEnabled', value)}
            label={t('Consult the knowledge library')}
            hint={t(
              "Retrieve relevant passages from your reference documents — this workspace's shelf plus the global one.",
            )}
          />
          <CheckboxField
            checked={draft.autoPolicyEnabled}
            onChange={(value) => update('autoPolicyEnabled', value)}
            label={t('Choose the model automatically')}
            hint={t('Pick model and effort from what has performed best on similar tasks here.')}
          />
          <CheckboxField
            checked={draft.reflexionEnabled}
            onChange={(value) => update('reflexionEnabled', value)}
            label={t('Reflect after each run')}
            hint={t(
              'Run a small, tool-less pass that extracts durable lessons from what happened.',
            )}
          />
          <CheckboxField
            checked={draft.checkpointing}
            onChange={(value) => update('checkpointing', value)}
            label={t('File checkpointing')}
            hint={t('Track file changes so a run can be rewound.')}
          />
        </fieldset>

        <MenuSeparator />

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold text-ink">{t('Autonomy')}</legend>

          <CheckboxField
            checked={draft.autoWorkBoard}
            onChange={(value) => update('autoWorkBoard', value)}
            label={t('Work the board by itself')}
            hint={t(
              "When a card run ends, start the top To do card automatically — one card at a time, success lands in Review, and the quota guard pauses automatic starts near the plan's ceiling.",
            )}
          />

          <CheckboxField
            checked={draft.advisorAuto}
            onChange={(value) => update('advisorAuto', value)}
            label={t('Let the advisor study this workspace daily')}
            hint={t(
              'At most once a day, an advisor run reads recent runs, the board and the registry, creates backlog tickets and disabled automations, and leaves anything that would act — skills, agents, vetted MCP servers — in the Dashboard inbox for you to accept. The manual button works either way.',
            )}
          />
        </fieldset>

        <MenuSeparator />

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold text-ink">claude.ai</legend>

          <CheckboxField
            checked={draft.mirrorSessions}
            onChange={(value) => update('mirrorSessions', value)}
            label={t('Mirror sessions to claude.ai')}
            hint={t(
              "Publish view-only copies of this workspace's sessions to your Claude account. Works only while the CLI account sign-in is the live credential — a paired token is inference-only. See the guide's sessions chapter.",
            )}
          />
        </fieldset>

        <MenuSeparator />

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold text-ink">{t(
            'Marketplace plugins',
          )}</legend>
          <p className="text-[12px] text-muted">
            {t(
              'Plugins the CLI installs from the marketplaces added under Plugins. Enabled ones load into every run of this workspace.',
            )}
          </p>
          <MarketplacePluginToggles
            available={availablePlugins}
            enabled={draft.enabledPlugins}
            onChange={(key, on) =>
              update('enabledPlugins', { ...draft.enabledPlugins, [key]: on })
            }
          />
        </fieldset>

        <MenuSeparator />

        <div className="grid gap-4 sm:grid-cols-2">
          <Label htmlFor="ws-max-turns" hint={t(
            'Blank means no limit.',
          )}>{t('Max turns per run')}<Input
              id="ws-max-turns"
              type="number"
              min={1}
              max={1000}
              value={draft.maxTurns ?? ''}
              onChange={(event) =>
                update('maxTurns', event.target.value ? Number(event.target.value) : null)
              }
              className="mt-1.5"
            />
          </Label>

          <Label htmlFor="ws-max-budget" hint={t('Stops a run once it reaches this cost.')}>
            {t('Cost ceiling (USD)')}
            <Input
              id="ws-max-budget"
              type="number"
              min={0}
              step={0.5}
              value={draft.maxBudgetUsd ?? ''}
              onChange={(event) =>
                update('maxBudgetUsd', event.target.value ? Number(event.target.value) : null)
              }
              className="mt-1.5"
            />
          </Label>
        </div>

        <div>
          <p className="text-[13px] font-medium text-ink">{t('Answer language')}</p>
          <p className="mb-1.5 text-xs leading-relaxed text-muted">
            {t(
              'Subagents carry English prompts, so delegated work comes back in English however you wrote the request. Pinning a language settles the whole run, delegations included. Code and command output are never translated.',
            )}
          </p>
          <Menu
            side="bottom"
            trigger={
              <Button variant="secondary" size="sm" className="w-full justify-between">
                {t(LANGUAGE_INFO[draft.language].label)}
              </Button>
            }
          >
            <MenuLabel>{t('What the agent answers in')}</MenuLabel>
            {(Object.keys(LANGUAGE_INFO) as WorkspaceSettings['language'][]).map((value) => (
              <MenuItem
                key={value}
                selected={draft.language === value}
                onSelect={() => update('language', value)}
                description={t(LANGUAGE_INFO[value].description)}
              >
                {t(LANGUAGE_INFO[value].label)}
              </MenuItem>
            ))}
          </Menu>
        </div>

        <Label
          htmlFor="ws-system-prompt"
          hint={t(
            "Appended to Claude Code's own system prompt for every run here. Project conventions, things to avoid, house style.",
          )}
        >{t('Additional instructions')}<Textarea
            id="ws-system-prompt"
            value={draft.systemPromptAppend}
            onChange={(event) => update('systemPromptAppend', event.target.value)}
            rows={5}
            className="mt-1.5 font-mono text-[12.5px]"
          />
        </Label>
      </div>
    </Modal>
  );
}

