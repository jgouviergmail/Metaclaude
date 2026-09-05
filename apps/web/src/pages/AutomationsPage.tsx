/**
 * Automations — the loop engine's control surface.
 *
 * The distinction that matters and is made explicit in the UI: a one-shot
 * automation starts a fresh session each firing, while a *continuous* one
 * continues the same session, so the agent keeps its accumulated context. The
 * second is what turns a schedule into a genuinely long-running agent.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock,
  MoreVertical,
  Pause,
  Play,
  Plus,
  Repeat,
  Timer,
  Trash2,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  EMITTED_AUTOMATION_EVENTS,
  PERMISSION_MODE_INFO,
  type Automation,
  type AutomationTrigger,
  type PermissionMode,
} from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import { usePlural, useT } from '@/lib/i18n';

/** Ready-made schedules, so nobody has to remember cron syntax to get started. */
const PRESETS: Array<{ label: string; expression: string }> = [
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Every 4 hours', expression: '0 */4 * * *' },
  { label: 'Daily at 09:00', expression: '0 9 * * *' },
  { label: 'Weekdays at 09:00', expression: '0 9 * * 1-5' },
  { label: 'Weekly, Monday 09:00', expression: '0 9 * * 1' },
  { label: 'Monthly, 1st at 09:00', expression: '0 9 1 * *' },
];

/** Copy for the trigger picker, translated at the render site. */
const TRIGGER_LABELS: Record<AutomationTrigger['type'], string> = {
  cron: 'Schedule',
  interval: 'Interval',
  manual: 'Manual',
  event: 'Event',
};

const EVENT_LABELS: Record<(typeof EMITTED_AUTOMATION_EVENTS)[number], string> = {
  run_failed: 'On a failed run',
  run_succeeded: 'On a succeeded run',
};

export function AutomationsPage() {
  const plural = usePlural();
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['automations'],
    queryFn: () => api.automations(),
    refetchInterval: 30_000,
  });

  const { data: workspaceData } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateAutomation(id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['automations'] }),
  });

  const fire = useMutation({
    mutationFn: (id: string) => api.fireAutomation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(t('Automation started'));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not run the automation.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(t('Automation deleted'));
    },
  });

  const automations = data?.automations ?? [];
  const workspaces = workspaceData?.workspaces ?? [];
  const workspaceName = (id: string): string =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? t('Unknown workspace');

  return (
    <AppShell>
      <ContentHeader
        title={t('Automations')}
        subtitle={t('Scheduled and continuous agent loops.')}
        showSidebarToggle={false}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setEditing('new')}
            disabled={workspaces.length === 0}
          >
            <Plus className="size-4" aria-hidden />
            {t('New automation')}
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : automations.length === 0 ? (
            <EmptyState
              icon={<Timer />}
              title={t('No automations yet')}
              description={
                workspaces.length === 0
                  ? t('Create a workspace first — an automation always runs inside one.')
                  : t(
                    'Give the agent a prompt and a schedule. It runs with the same permissions, memory and learning as a session you start by hand.',
                  )
              }
              action={
                workspaces.length > 0 ? (
                  <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
                    <Plus className="size-4" aria-hidden />
                    {t('Create one')}
                  </Button>
                ) : (
                  <Link
                    to="/workspaces"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-[13px] font-medium text-ink hover:bg-line"
                  >
                    {t('Go to workspaces')}
                  </Link>
                )
              }
            />
          ) : (
            automations.map((automation) => (
              <Card key={automation.id} className={cn(!automation.enabled && 'opacity-65')}>
                <div className="flex items-start gap-3 p-4">
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                      automation.continuous
                        ? 'bg-thinking-soft text-thinking'
                        : 'bg-accent-soft text-accent',
                    )}
                    aria-hidden
                  >
                    {automation.continuous ? (
                      <Repeat className="size-4" />
                    ) : (
                      <Clock className="size-4" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-ink">{automation.name}</h3>
                      {automation.continuous ? (
                        <Tooltip content={t(
                          'Each firing continues the same session, so context accumulates across runs.',
                        )}>
                          <span>
                            <Badge tone="thinking">{t('continuous')}</Badge>
                          </span>
                        </Tooltip>
                      ) : null}
                      {!automation.enabled ? <Badge tone="neutral">{t('paused')}</Badge> : null}
                      {automation.lastStatus ? (
                        <Badge
                          tone={
                            automation.lastStatus === 'succeeded'
                              ? 'success'
                              : automation.lastStatus === 'failed'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {automation.lastStatus}
                        </Badge>
                      ) : null}
                    </div>

                    <p className="mt-1 text-[12.5px] text-muted">
                      {workspaceName(automation.workspaceId)} · {describeTrigger(automation.trigger)}
                    </p>

                    <p className="mt-2 line-clamp-2 rounded-lg bg-sunken px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-muted">
                      {automation.prompt}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
                      <span>{automation.runCount} {t('runs')}</span>
                      {automation.lastRunAt ? (
                        <span>{t('last')} {formatRelative(automation.lastRunAt)}</span>
                      ) : null}
                      {automation.enabled && automation.nextRunAt ? (
                        <Tooltip content={formatDateTime(automation.nextRunAt)}>
                          <span className="cursor-help underline decoration-dotted underline-offset-2">
                            {t('next')} {formatRelative(automation.nextRunAt)}
                          </span>
                        </Tooltip>
                      ) : null}
                      {automation.consecutiveFailures > 0 ? (
                        <span className="flex items-center gap-1 text-warning">
                          <AlertTriangle className="size-3" aria-hidden />
                          {plural(
                            automation.consecutiveFailures,
                            '{n} consecutive failure',
                            '{n} consecutive failures',
                          )}
                        </span>
                      ) : null}
                      {automation.sessionId ? (
                        <Link
                          to={`/w/${automation.workspaceId}/s/${automation.sessionId}`}
                          className="text-accent hover:underline"
                        >
                          {t('Open session')}
                        </Link>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip content={t('Run now')}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('Run {name} now', { name: automation.name })}
                        onClick={() => fire.mutate(automation.id)}
                      >
                        <Zap className="size-4" />
                      </Button>
                    </Tooltip>

                    <Tooltip content={automation.enabled ? 'Pause' : 'Resume'}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={automation.enabled ? 'Pause' : 'Resume'}
                        onClick={() =>
                          toggle.mutate({ id: automation.id, enabled: !automation.enabled })
                        }
                      >
                        {automation.enabled ? (
                          <Pause className="size-4" />
                        ) : (
                          <Play className="size-4" />
                        )}
                      </Button>
                    </Tooltip>

                    <Menu
                      side="bottom"
                      align="end"
                      trigger={
                        <button
                          type="button"
                          className="flex size-7 items-center justify-center rounded-md text-subtle hover:bg-raised hover:text-ink"
                          aria-label={t('More actions for {name}', { name: automation.name })}
                        >
                          <MoreVertical className="size-4" />
                        </button>
                      }
                    >
                      <MenuItem onSelect={() => setEditing(automation)}>{t('Edit')}</MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        icon={<Trash2 />}
                        tone="danger"
                        onSelect={() => setPendingDelete(automation)}
                      >
                        {t('Delete')}
                      </MenuItem>
                    </Menu>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>

      {editing ? (
        <AutomationEditor
          automation={editing === 'new' ? null : editing}
          workspaces={workspaces}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name ?? ''}"?`}
        description={t(
          'The schedule is removed. Sessions and transcripts it already produced are kept.',
        )}
        confirmLabel={t('Delete')}
        danger
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
        }}
      />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function AutomationEditor({
  automation,
  workspaces,
  onClose,
}: {
  automation: Automation | null;
  workspaces: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();

  const [name, setName] = useState(automation?.name ?? '');
  const [description, setDescription] = useState(automation?.description ?? '');
  const [prompt, setPrompt] = useState(automation?.prompt ?? '');
  const [workspaceId, setWorkspaceId] = useState(
    automation?.workspaceId ?? workspaces[0]?.id ?? '',
  );
  const [triggerType, setTriggerType] = useState<AutomationTrigger['type']>(
    automation?.trigger.type ?? 'cron',
  );
  const [expression, setExpression] = useState(
    automation?.trigger.type === 'cron' ? automation.trigger.expression : '0 9 * * *',
  );
  const [everyMinutes, setEveryMinutes] = useState(
    automation?.trigger.type === 'interval' ? Math.round(automation.trigger.everyMs / 60_000) : 60,
  );
  const [eventName, setEventName] = useState<(typeof EMITTED_AUTOMATION_EVENTS)[number]>(
    automation?.trigger.type === 'event' &&
      (EMITTED_AUTOMATION_EVENTS as readonly string[]).includes(automation.trigger.event)
      ? (automation.trigger.event as (typeof EMITTED_AUTOMATION_EVENTS)[number])
      : 'run_failed',
  );
  const [eventFilter, setEventFilter] = useState(
    automation?.trigger.type === 'event' ? (automation.trigger.filter ?? '') : '',
  );
  const [continuous, setContinuous] = useState(automation?.continuous ?? false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    automation?.policy.permissionMode ?? 'default',
  );
  const [notify, setNotify] = useState(automation?.policy.notify ?? false);
  const [maxFailures, setMaxFailures] = useState(automation?.maxConsecutiveFailures ?? 3);
  // The zone the server reads every cron expression in, shown beside the
  // field: eight o'clock on a UTC host is ten in Paris all summer.
  const { data: system } = useQuery({ queryKey: ['system'], queryFn: () => api.system(), staleTime: 60_000 });

  const buildTrigger = (): AutomationTrigger => {
    if (triggerType === 'interval') return { type: 'interval', everyMs: everyMinutes * 60_000 };
    if (triggerType === 'manual') return { type: 'manual' };
    if (triggerType === 'event') {
      const filter = eventFilter.trim();
      return { type: 'event', event: eventName, ...(filter ? { filter } : {}) };
    }
    return { type: 'cron', expression };
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        trigger: buildTrigger(),
        continuous,
        maxConsecutiveFailures: maxFailures,
        policy: { permissionMode, notify },
      };
      return automation
        ? api.updateAutomation(automation.id, body)
        : api.createAutomation({ ...body, workspaceId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(automation ? t('Automation updated') : t('Automation created'));
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not save the automation.')),
  });

  const valid = name.trim() && prompt.trim() && workspaceId;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={automation ? t('Edit automation') : t('New automation')}
      description={t(
        'A prompt plus a trigger. It runs exactly as a session you start yourself would.',
      )}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            disabled={!valid}
            onClick={() => save.mutate()}
          >
            {automation ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Label htmlFor="auto-name">
          {t('Name')}
          <Input
            id="auto-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('Nightly dependency audit')}
            autoFocus
            className="mt-1.5"
          />
        </Label>

        {!automation ? (
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('Workspace')}</span>
            <Menu
              side="bottom"
              trigger={
                <Button variant="secondary" size="sm" className="w-full justify-between">
                  {workspaces.find((w) => w.id === workspaceId)?.name ?? t('Choose a workspace')}
                </Button>
              }
            >
              {workspaces.map((workspace) => (
                <MenuItem
                  key={workspace.id}
                  selected={workspace.id === workspaceId}
                  onSelect={() => setWorkspaceId(workspace.id)}
                >
                  {workspace.name}
                </MenuItem>
              ))}
            </Menu>
          </div>
        ) : null}

        <Label htmlFor="auto-prompt" hint={t('What the agent should do each time this fires.')}>
          {t('Prompt')}
          <Textarea
            id="auto-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            placeholder={t(
              'Check for outdated dependencies with known advisories and open a summary of what needs attention.',
            )}
            className="mt-1.5"
          />
        </Label>

        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">{t('Trigger')}</span>
          <div className="flex gap-1.5">
            {(['cron', 'interval', 'manual', 'event'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setTriggerType(type)}
                aria-pressed={triggerType === type}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-medium capitalize transition-colors',
                  triggerType === type
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-muted hover:bg-raised',
                )}
              >
                {t(TRIGGER_LABELS[type])}
              </button>
            ))}
          </div>

          {triggerType === 'cron' ? (
            <div className="mt-2.5 space-y-2">
              <Input
                value={expression}
                onChange={(event) => setExpression(event.target.value)}
                placeholder="0 9 * * *"
                aria-label={t('Cron expression')}
                className="font-mono text-[13px]"
              />
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.expression}
                    type="button"
                    onClick={() => setExpression(preset.expression)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                      expression === preset.expression
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-muted hover:bg-raised',
                    )}
                  >
                    {t(preset.label)}
                  </button>
                ))}
              </div>
              <p className="text-[11.5px] text-subtle">
                {t("Standard 5-field cron, read in the server's timezone: {zone}.", {
                  zone: system?.timezone ?? '…',
                })}
              </p>
            </div>
          ) : triggerType === 'event' ? (
            <div className="mt-2.5 space-y-2">
              <div className="flex gap-1.5" role="group" aria-label={t('Event')}>
                {EMITTED_AUTOMATION_EVENTS.map((event) => (
                  <button
                    key={event}
                    type="button"
                    onClick={() => setEventName(event)}
                    aria-pressed={eventName === event}
                    className={cn(
                      'flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors',
                      eventName === event
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-muted hover:bg-raised',
                    )}
                  >
                    {t(EVENT_LABELS[event])}
                  </button>
                ))}
              </div>
              <Input
                value={eventFilter}
                onChange={(event) => setEventFilter(event.target.value)}
                placeholder={t('Filter (optional)')}
                aria-label={t('Filter (optional)')}
              />
              <p className="text-[11.5px] text-subtle">
                {t(
                  'Fires when a run you, a token or a delegation started in this workspace ends that way — never one another automation produced, which would chain. The filter is a word that must appear in the run’s category or prompt.',
                )}
              </p>
            </div>
          ) : triggerType === 'interval' ? (
            <div className="mt-2.5">
              <Input
                type="number"
                min={1}
                value={everyMinutes}
                onChange={(event) => setEveryMinutes(Math.max(1, Number(event.target.value)))}
                aria-label={t('Interval in minutes')}
              />
              <p className="mt-1 text-[11.5px] text-subtle">{t(
                'Minutes between runs. Minimum 1.',
              )}</p>
            </div>
          ) : (
            <p className="mt-2.5 text-[11.5px] text-subtle">
              {t('Runs only when you press "Run now".')}
            </p>
          )}
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
          <input
            type="checkbox"
            checked={continuous}
            onChange={(event) => setContinuous(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)]"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">{t('Continuous loop')}</span>
            <span className="block text-[12px] leading-relaxed text-muted">
              {t(
                'Continue the same session on every firing instead of starting fresh. The agent keeps everything it has already learned in this loop, which is what makes long-running, self-directed work possible — and what makes its context grow over time.',
              )}
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
          <input
            type="checkbox"
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)]"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">{t('Notify me when a firing ends')}</span>
            <span className="block text-[12px] leading-relaxed text-muted">
              {t(
                'Automations are silent by default so the machinery never wakes you. Tick this for the ones whose whole point is to be read — a morning brief computed at eight and read at six has ten hours.',
              )}
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink">{t(
              'Permission mode',
            )}</span>
            <Menu
              side="bottom"
              trigger={
                <Button variant="secondary" size="sm" className="w-full justify-between">
                  {t(PERMISSION_MODE_INFO[permissionMode].label)}
                </Button>
              }
            >
              <MenuLabel>{t('Unattended runs cannot answer prompts')}</MenuLabel>
              {(['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'] as PermissionMode[]).map(
                (mode) => (
                  <MenuItem
                    key={mode}
                    selected={permissionMode === mode}
                    onSelect={() => setPermissionMode(mode)}
                    description={t(PERMISSION_MODE_INFO[mode].description)}
                  >
                    {t(PERMISSION_MODE_INFO[mode].label)}
                  </MenuItem>
                ),
              )}
            </Menu>
          </div>

          <Label htmlFor="auto-failures" hint={t('0 disables the guard.')}>
            {t('Stop after N failures')}
            <Input
              id="auto-failures"
              type="number"
              min={0}
              max={100}
              value={maxFailures}
              onChange={(event) => setMaxFailures(Number(event.target.value))}
              className="mt-1.5"
            />
          </Label>
        </div>

        {permissionMode === 'default' ? (
          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/30 p-3 text-[12px] leading-relaxed text-ink">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            {t(
              'In "Ask" mode an unattended run will stall on the first prompt and be declined after ten minutes. For a schedule, prefer "Plan", "Accept edits" or "Auto".',
            )}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function describeTrigger(trigger: AutomationTrigger): string {
  switch (trigger.type) {
    case 'cron':
      return `cron: ${trigger.expression}`;
    case 'interval': {
      const minutes = Math.round(trigger.everyMs / 60_000);
      return minutes % 60 === 0
        ? `every ${minutes / 60}h`
        : `every ${minutes}m`;
    }
    case 'event':
      return `on ${trigger.event}`;
    default:
      return 'manual only';
  }
}
