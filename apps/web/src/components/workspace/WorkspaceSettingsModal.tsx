/**
 * A workspace's settings, as a dialog.
 *
 * It lived inside `WorkspacePage` as a local function, so the only way to a
 * workspace's settings was through its own screen — and an operator working in
 * a session of that workspace had to leave the session to change the model,
 * the permission mode or the checkpointing that the session runs under. Two
 * callers now: the workspace screen and any session inside it.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { useEffect, useMemo, useState } from 'react';

import { toast } from 'sonner';
import {
  PERMISSION_MODE_INFO,
  PREAPPROVABLE_TOOLS,
  type EffortLevel,
  type PermissionMode,
  WorkspaceSettings,
} from '@metaclaude/shared';
import { AppShell } from '@/components/layout/AppShell';
import { CliSessionList } from '@/components/workspace/CliSessionList';
import { MarketplacePluginToggles } from '@/components/workspace/MarketplacePluginToggles';
import { SessionList } from '@/components/workspace/SessionList';
import { CheckboxField } from '@/components/ui/controls';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { McpToolPicker } from '@/components/registry/McpToolPicker';
import { ColourPicker, IconPicker } from '@/components/workspace/WorkspaceAppearance';
import { Modal } from '@/components/ui/Modal';
import {
  Button,
  Input,
  Label,
  Textarea,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

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

export function WorkspaceSettingsModal({
  open,
  onOpenChange,
  workspaceId,
  settings,
  name,
  description,
  color,
  icon,
  locked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  settings: WorkspaceSettings;
  name: string;
  description: string;
  color: string;
  /** The stored icon name, or '' for the plain coloured square. */
  icon: string;
  /**
   * The system workspace: permission mode and tool lists are fixed by the
   * server, which answers 409 to a change. Shown locked rather than let
   * the operator learn the rule from a failed save.
   */
  locked: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  /*
   * Parsed through the contract rather than trusted as given.
   *
   * The dialog read `settings.defaultPermissionMode` straight into a lookup
   * table, which is safe only while every caller hands over a complete object
   * — true of the workspace screen, whose settings come parsed from the API,
   * and false the moment a second caller appeared: a session mounts this with
   * whatever its own query holds, and a partial object crashed the render on
   * `PERMISSION_MODE_INFO[undefined].label`. `.parse` fills every default the
   * schema declares, so the component now survives any caller — which is what
   * a shared component has to do.
   */
  const complete = useMemo(() => WorkspaceSettings.parse(settings ?? {}), [settings]);
  const [draft, setDraft] = useState<WorkspaceSettings>(complete);
  const [draftName, setDraftName] = useState(name);
  const [draftDescription, setDraftDescription] = useState(description);
  const [draftColor, setDraftColor] = useState(color);
  const [draftIcon, setDraftIcon] = useState(icon);

  // Re-seed whenever the dialog opens, so a cancelled edit does not persist.
  useEffect(() => {
    if (open) {
      setDraft(complete);
      setDraftName(name);
      setDraftDescription(description);
      setDraftColor(color);
      setDraftIcon(icon);
    }
  }, [open, complete, name, description, color, icon]);

  /*
   * The MCP tools this workspace could pre-approve.
   *
   * Asked of the server, which computes *which* servers reach this workspace
   * with the same call the runtime makes when it mounts them. Refetched on
   * open rather than cached across openings: a server can be enabled or
   * disabled from another screen at any moment, and a picker offering a server
   * that is no longer mounted ticks boxes that decide nothing.
   */
  const mcpToolsQuery = useQuery({
    queryKey: ['workspace-mcp-tools', workspaceId],
    queryFn: () => api.workspaceMcpTools(workspaceId),
    enabled: open,
    refetchOnMount: 'always',
  });

  const [describing, setDescribing] = useState<string | null>(null);
  const describe = useMutation({
    mutationFn: (serverId: string) => api.describeMcpServer(serverId),
    onMutate: (serverId: string) => setDescribing(serverId),
    onSettled: () => setDescribing(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspace-mcp-tools', workspaceId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

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
        color: draftColor,
        icon: draftIcon,
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

        <Label
          htmlFor="ws-edit-description"
          hint={t('Read by other workspaces, so their agents know when to consult this one.')}
        >{t('Description')}<Textarea
            id="ws-edit-description"
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            rows={2}
            // The hint is rendered outside the label — text inside one becomes
            // part of the accessible name — so the control points at it, which
            // is what `Label` emits the id for.
            aria-describedby="ws-edit-description-hint"
            className="mt-1.5"
          />
        </Label>

        {/* Appearance, beside the name and description it belongs with. The
            colour was choosable at creation and never again; the icon was a
            stored field no control ever set and no screen ever showed. */}
        <ColourPicker value={draftColor} onChange={setDraftColor} disabled={locked} />
        <IconPicker
          value={draftIcon}
          color={draftColor}
          onChange={setDraftIcon}
          disabled={locked}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-body font-medium text-ink">{t(
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
            <span className="mb-1.5 block text-body font-medium text-ink">{t(
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
            className="rounded-lg border border-line bg-accent-soft px-3 py-2 text-caption leading-relaxed text-ink"
          >
            {t(
              'This is Metaclaude’s own workspace. Its tool lists are fixed: it uses its own tools and never gets a shell. The permission mode is yours — under "Don’t ask" it acts on its pre-approved tools without waiting for you; Bypass is never offered here.',
            )}
          </p>
        ) : null}

        <div>
          <span className="mb-1.5 block text-body font-medium text-ink">{t(
            'Default permission mode',
          )}</span>
          <Menu
            side="bottom"
            trigger={
              <Button variant="secondary" size="sm" className="w-full justify-between">
                {t(PERMISSION_MODE_INFO[draft.defaultPermissionMode].label)}
              </Button>
            }
          >
            <MenuLabel>{t('How much to ask before acting')}</MenuLabel>
            {/* The system workspace never runs with permissions bypassed — the
                server answers 409 — so the entry is not offered rather than
                offered and refused. Every other mode is the operator's. */}
            {(Object.keys(PERMISSION_MODE_INFO) as PermissionMode[])
              .filter((mode) => !(locked && mode === 'bypassPermissions'))
              .map((mode) => (
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
          <legend className="text-body font-semibold text-ink">{t('Pre-approved tools')}</legend>
          <p className="text-caption leading-relaxed text-muted">
            {t(
              'A ticked tool runs without its approval card, in every mode but Plan. This is also the only thing an unattended run can use: under "Don’t ask" — where automations and the MCP gateway land — everything not ticked here is refused outright. Metaclaude’s own board, proposal and memory tools are always allowed where they are mounted, and say so in the transcript rather than raising a card.',
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
                // The tool's exact name, not a word: `Write` and `Edit` are
                // what the CLI calls them and what its documentation says.
                // Rendered as code so nobody translates them, and so the
                // browser sweep stops reporting them as English on a French
                // screen — which is what it is paid to report.
                label={<code className="font-mono">{tool}</code>}
                hint={t(TOOL_HINTS[tool])}
              />
            ))}
          </div>

          {/*
            The same list, for the tools an MCP server offers. Kept in this
            fieldset rather than one of its own because it answers the same
            question — what runs without a card, and what an unattended run may
            use — and a second heading would suggest a second rule.
          */}
          <McpToolPicker
            servers={mcpToolsQuery.data?.servers ?? []}
            selected={draft.allowedTools}
            onChange={(next) => update('allowedTools', next)}
            onDescribe={(serverId) => describe.mutate(serverId)}
            describing={describing}
            disabled={locked}
          />
        </fieldset>

        <MenuSeparator />

        <fieldset className="space-y-3">
          <legend className="text-body font-semibold text-ink">{t('Learning')}</legend>

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
          <legend className="text-body font-semibold text-ink">{t('Autonomy')}</legend>

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
          <legend className="text-body font-semibold text-ink">{t('Other workspaces')}</legend>

          <CheckboxField
            checked={draft.delegable}
            onChange={(value) => update('delegable', value)}
            label={t('Let other workspaces consult this one')}
            hint={t(
              'Two things at once. Another project’s agent can search what this workspace has written down — its notes and its documents — without running anything here; and it can ask this workspace a question, which is a full run under this workspace’s own memory, conventions and permission mode. Turning this off withdraws both. The description above is what tells another agent when to ask: without one this workspace stays reachable but is not listed. Metaclaude’s own steward reaches every workspace whatever this says.',
            )}
          />
        </fieldset>

        <MenuSeparator />

        <fieldset className="space-y-3">
          <legend className="text-body font-semibold text-ink">claude.ai</legend>

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
          <legend className="text-body font-semibold text-ink">{t(
            'Marketplace plugins',
          )}</legend>
          <p className="text-caption text-muted">
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
          <p className="text-body font-medium text-ink">{t('Answer language')}</p>
          <p className="mb-1.5 text-caption leading-relaxed text-muted">
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
            className="mt-1.5 font-mono text-caption"
          />
        </Label>
      </div>
    </Modal>
  );
}
