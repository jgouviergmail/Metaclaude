/**
 * Automations — the loop engine's control surface.
 *
 * The distinction that matters and is made explicit in the UI: a one-shot
 * automation starts a fresh session each firing, while a *continuous* one
 * continues the same session, so the agent keeps its accumulated context. The
 * second is what turns a schedule into a genuinely long-running agent.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Page } from '@/components/ui/layout';
import {
  AlertTriangle,
  Clock,
  Filter,
  MousePointerClick,
  MoreVertical,
  Pause,
  Play,
  Plus,
  Repeat,
  Timer,
  Trash2,
  Webhook,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AvailabilityFilter, filterByAvailability, type Availability } from '@/components/registry/AvailabilityFilter';
import { BulkActions } from '@/components/registry/BulkActions';
import { FILTER_ROW } from '@/components/ui/layout';
import { ReachBadge } from '@/components/registry/ReachBadge';
import { WorkspaceScopeFilter } from '@/components/registry/WorkspaceScopeFilter';
import { PropagateDialog, propagatableFields } from '@/components/automations/PropagateDialog';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  declaredSources,
  EMITTED_AUTOMATION_EVENTS,
  PERMISSION_MODE_INFO,
  TASK_CATEGORIES,
  watchesAutomations,
  watchPath,
  type Automation,
  type AutomationTrigger,
  type PermissionMode,
  type RunStatus,
} from '@metaclaude/shared';
import { CheckboxField } from '@/components/ui/controls';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { SystemTabs } from '@/components/layout/SystemTabs';
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
  CHIP,
  QUIET_LINK,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { TOUCH_TARGET } from '@/components/ui/touch-target';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
import { usePlural, useT, type TranslateFn } from '@/lib/i18n';
import { effortOptions, modelOptions } from '@/lib/claude-catalogue';
import { routes, type EffortLevel, type ModelSelector } from '@metaclaude/shared';

/** Ready-made schedules, so nobody has to remember cron syntax to get started. */
/**
 * A run's status, named and coloured from one table each.
 *
 * The badge rendered `automation.lastStatus` raw, so a French screen said
 * "succeeded" — found by the browser sweep, which only saw it once a run had
 * actually finished. And the colour was a ternary chain, which `CLAUDE.md`
 * names as the shape that silently gives a new case somebody else's colour:
 * an exhaustive `Record` fails the build the day `RunStatus` gains a member.
 *
 * Copy held as data and translated at the render site, which is the documented
 * pattern for a table evaluated at import time.
 */
const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  waiting_approval: 'waiting for approval',
  succeeded: 'succeeded',
  failed: 'failed',
  interrupted: 'interrupted',
};

const RUN_STATUS_TONE: Record<RunStatus, 'success' | 'danger' | 'warning' | 'info'> = {
  queued: 'info',
  running: 'info',
  waiting_approval: 'warning',
  succeeded: 'success',
  failed: 'danger',
  interrupted: 'warning',
};

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

/**
 * One picture per kind of trigger, and a `Record` so a new kind fails the
 * build rather than inheriting a clock.
 *
 * It used to be "continuous or not", which put a schedule's clock on every
 * manual runbook and, once watchers could name their sources, on a row whose
 * own summary reads "after Tests de nuit succeeds" — the icon contradicting
 * the sentence directly under it. Continuous still wins where it applies: it
 * is the more distinctive fact, and it carries its own colour.
 */
const TRIGGER_ICONS: Record<AutomationTrigger['type'], ReactNode> = {
  cron: <Clock className="size-4" />,
  interval: <Timer className="size-4" />,
  manual: <MousePointerClick className="size-4" />,
  event: <Webhook className="size-4" />,
};

/**
 * The segmented buttons inside the trigger editor — which event, and which
 * population.
 *
 * `text-caption` on `py-2` paints 32px, which clears the probe's floor and is
 * still a poor target for a thumb. The height is raised rather than an inset
 * pseudo-element added, and that is the point worth recording: these sit in a
 * grid with `gap-1.5`, so `TOUCH_TARGET_Y`'s 6px each side would have two
 * stacked buttons overlap by exactly their gap — and the one later in the DOM
 * quietly takes presses meant for the one above. Vertical hit areas are safe
 * beside prose and unsafe between two controls stacked this close.
 *
 * `pointer-coarse` only, so the desktop dialog keeps its density.
 */
const PICKER_BUTTON =
  'rounded-lg border px-3 py-2 text-caption font-medium transition-colors pointer-coarse:min-h-11';

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

  /**
   * Copy an automation into another workspace.
   *
   * It lands **paused**, and that is the one decision worth arguing. An
   * automation fires unattended; a copy that arrives already armed in a
   * workspace whose files and permissions it has never seen, carrying a prompt
   * written for a different project, is exactly the surprise the guard rails on
   * this screen exist to prevent. Pausing costs one click and buys a reading of
   * the prompt before anything runs.
   *
   * Nothing else travels: no session, no run count, no failure counter, no
   * schedule history. The copy starts its own life, which is the honest
   * consequence of it being a copy rather than a second attachment.
   */
  const duplicate = useMutation({
    mutationFn: ({ automation, workspaceId }: { automation: Automation; workspaceId: string }) =>
      api.duplicateAutomation(automation.id, workspaceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(t('Duplicated, and paused — read the prompt before enabling it.'));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not duplicate it.')),
  });

  /**
   * Take one copy out of its family.
   *
   * A copy that has deliberately diverged would otherwise be offered every edit
   * its siblings receive, for ever. Refusing once per save is a chore; saying so
   * once is an answer.
   */
  const detach = useMutation({
    mutationFn: (id: string) => api.detachAutomation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void queryClient.invalidateQueries({ queryKey: ['automation-family'] });
      toast.success(t('Detached — it no longer follows its copies.'));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not detach it.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(t('Automation deleted'));
    },
  });

  /*
   * Two filters and the bulk switch, on a screen that had neither.
   *
   * The scope is `all` or one workspace id — not the registry's three-way
   * convention, because an automation belongs to exactly one workspace by
   * schema and there is no global tier for "global only" to name.
   */
  const [scope, setScope] = useState<string>('all');
  const [availability, setAvailability] = useState<Availability>('all');

  const automations = data?.automations ?? [];
  const workspaces = workspaceData?.workspaces ?? [];
  const workspaceName = (id: string): string =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? t('Unknown workspace');

  /** Every automation by id, so a watcher's summary can name what it watches. */
  const namesById = useMemo(
    () => new Map(automations.map((automation) => [automation.id, automation.name])),
    [automations],
  );
  /**
   * Who waits on whom, inverted once instead of scanned per row.
   *
   * Every row asks this — the tooltip on its Run now button — so scanning the
   * list per row is the whole list squared on a screen whose job is to show
   * the whole list. Paused watchers are in it: deleting a source silences a
   * paused watcher exactly as thoroughly, and its operator finds out when they
   * resume it, which is the worst moment to find out.
   */
  const dependentsById = useMemo(() => {
    const index = new Map<string, Automation[]>();
    for (const automation of automations) {
      for (const sourceId of declaredSources(automation.trigger)) {
        index.set(sourceId, [...(index.get(sourceId) ?? []), automation]);
      }
    }
    return index;
  }, [automations]);
  const dependentsOf = (id: string): Automation[] => dependentsById.get(id) ?? [];

  const inScope =
    scope === 'all'
      ? automations
      : automations.filter((automation) => automation.workspaceId === scope);
  // The counts on the availability chips are of the scoped list, so "Inactive 0"
  // answers the question actually being asked: none *here*.
  const shown = filterByAvailability(inScope, availability);
  const filtering = scope !== 'all' || availability !== 'all';

  return (
    <AppShell>
      <ContentHeader
        tabs={<SystemTabs />}
        title={t('Automations')}
        subtitle={t('Scheduled and continuous agent loops.')}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setEditing('new')}
            disabled={workspaces.length === 0}
            aria-label={t('New automation')}
          >
            <Plus className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t('New automation')}</span>
          </Button>
        }
      />

      <Page width="list">
          {automations.length > 0 ? (
            <div className="mb-4 space-y-3">
              {/*
                Scrolls, never wraps. A wrapping filter bar sits above the list
                and steals a row from it every time it grows — measured at 237px
                of chrome on the board before `FILTER_ROW` existed, and French
                is where it shows, `Toutes · Actives · Inactives` being half
                again the English.
              */}
              <div className={cn(FILTER_ROW, 'gap-2')}>
                <WorkspaceScopeFilter
                  value={scope}
                  onChange={setScope}
                  workspaces={workspaces}
                  // An automation belongs to a workspace by schema, so
                  // there is no global tier to offer here.
                  withGlobal={false}
                />

                <AvailabilityFilter
                  value={availability}
                  onChange={setAvailability}
                  items={inScope}
                  label={t('Automation availability')}
                />
              </div>

              {/* Acts on the rows on screen, never on a scope the server would
                  widen on its own — and it is handed the workspace when one is
                  chosen, so the server checks the reach a second time. */}
              <BulkActions
                kind="automation"
                items={shown}
                {...(scope === 'all' ? {} : { workspaceId: scope })}
                onChanged={() => void queryClient.invalidateQueries({ queryKey: ['automations'] })}
              />
            </div>
          ) : null}

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
                    to={routes.workspaces()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-body font-medium text-ink hover:bg-line"
                  >
                    {t('Go to workspaces')}
                  </Link>
                )
              }
            />
          ) : shown.length === 0 ? (
            /*
             * Which emptiness this is. A filtered list that comes back empty
             * and says only "nothing here" leaves the operator unable to tell
             * "there are none" from "none match" — the gateway answered an
             * empty workspace list the same way once, and its operator was
             * told the deployment had no workspaces.
             */
            <EmptyState
              icon={<Timer />}
              title={t('Nothing matches these filters')}
              description={plural(
                automations.length,
                '{n} automation is hidden by them.',
                '{n} automations are hidden by them.',
              )}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setScope('all');
                    setAvailability('all');
                  }}
                >
                  {t('Clear filters')}
                </Button>
              }
            />
          ) : (
            shown.map((automation) => (
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
                      TRIGGER_ICONS[automation.trigger.type]
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* `h2`, not `h3`: PageHeader renders the page's h1 and
                          nothing sits between it and this list, so an h3 skipped
                          a level on every automation. */}
                      <h2 className="text-body font-semibold text-ink">{automation.name}</h2>
                      {automation.continuous ? (
                        <Tooltip content={t(
                          'Each firing continues the same session, so context accumulates across runs.',
                        )}>
                          <span>
                            <Badge tone="thinking">{t('continuous')}</Badge>
                          </span>
                        </Tooltip>
                      ) : null}
                      {/* Where it lives, as a badge rather than buried in the
                          sentence below. The name was already there and read as
                          prose — under "all workspaces" what an operator scans
                          is a column, and the same badge the registry screens
                          use is what makes that column legible across them. An
                          automation belongs to exactly one workspace by schema,
                          so this is the degenerate case of the same control. */}
                      <ReachBadge
                        global={false}
                        workspaceIds={[automation.workspaceId]}
                        workspaces={workspaces}
                      />
                      {!automation.enabled ? <Badge tone="neutral">{t('paused')}</Badge> : null}
                      {automation.lastStatus ? (
                        <Badge tone={RUN_STATUS_TONE[automation.lastStatus]}>
                          {t(RUN_STATUS_LABEL[automation.lastStatus])}
                        </Badge>
                      ) : null}
                    </div>

                    <p className="mt-1 text-caption text-muted">
                      {describeTrigger(automation.trigger, t, namesById)}
                    </p>

                    {/*
                      * One layer per concern: the box carries the padding, the
                      * paragraph carries the clamp. Both on one element leaks
                      * the next line — `overflow: hidden` clips at the *padding*
                      * box, so the six pixels below the second line showed the
                      * top of the third, cut through the glyphs, outside the
                      * tinted background. Same family as a fixed height and a
                      * safe-area inset fighting over one element.
                      */}
                    <div className="mt-2 rounded-lg bg-sunken px-2.5 py-1.5">
                      <p className="line-clamp-2 font-mono text-caption leading-relaxed text-muted">
                        {automation.prompt}
                      </p>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-subtle">
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
                          to={routes.session(automation.workspaceId, automation.sessionId)}
                          className={QUIET_LINK}
                        >
                          {t('Open session')}
                        </Link>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {/*
                      "Run now" works on every kind, watchers included, and
                      says what it will actually do rather than being taken
                      away. Disabling it on a watcher would make one control
                      mean two things on neighbouring rows — and it earns its
                      place there: testing a prompt without waiting for the
                      event, and re-running the downstream half of a chain.
                      What it owes the operator is the two consequences that
                      are not obvious: there is no triggering run to react to,
                      and whatever waits on this automation will hear it
                      finish, exactly as if the event had happened.
                    */}
                    <Tooltip
                      content={[
                        automation.trigger.type === 'event'
                          ? t('Runs the prompt now, with no triggering run to react to.')
                          : t('Run now'),
                        dependentsOf(automation.id).length > 0
                          ? t('Finishing will also trigger {names}.', {
                              names: dependentsOf(automation.id)
                                .map((dependent) => dependent.name)
                                .join(', '),
                            })
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
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
                          className={cn(
                            'flex size-7 items-center justify-center rounded-md text-subtle',
                            'hover:bg-raised hover:text-ink',
                            TOUCH_TARGET,
                          )}
                          aria-label={t('More actions for {name}', { name: automation.name })}
                        >
                          <MoreVertical className="size-4" />
                        </button>
                      }
                    >
                      <MenuItem onSelect={() => setEditing(automation)}>{t('Edit')}</MenuItem>
                      {/*
                        * A copy, not a second attachment — and the difference is
                        * the schema rather than a shortcut.
                        *
                        * A skill attaches to any number of workspaces because it
                        * is a definition: what gets mounted is identical
                        * everywhere. An automation carries seven fields of
                        * *execution* state — its continuous session, its failure
                        * count, its next firing, whether it is paused — and every
                        * one of them is per workspace. Reaching two workspaces
                        * from one row would mean answering "does failing three
                        * times here pause it there too", which is a child table
                        * and a different subsystem.
                        *
                        * So the copy is honest about being a copy: it drifts, and
                        * an automation's prompt usually should differ per project
                        * anyway. It lands paused, because one that fires
                        * unattended in a workspace it was not written for is the
                        * kind of surprise this whole screen exists to avoid.
                        */}
                      {/*
                        The reason once, not once per destination.
                        A watcher of automations cannot be copied anywhere — a
                        copy lands in another workspace and its sources are in
                        this one — so the destinations are replaced by the
                        explanation rather than listed and greyed with the same
                        sentence repeated under each. Three identical lines was
                        what it looked like on a phone; six workspaces would
                        have been six.
                      */}
                      {watchesAutomations(automation.trigger) &&
                      workspaces.filter((w) => w.id !== automation.workspaceId).length > 0 ? (
                        <>
                          <MenuSeparator />
                          <MenuLabel>{t('Duplicate to')}</MenuLabel>
                          <MenuItem disabled onSelect={() => undefined}>
                            {t('Not while it watches this workspace’s automations.')}
                          </MenuItem>
                        </>
                      ) : null}
                      {!watchesAutomations(automation.trigger) &&
                      workspaces.filter((w) => w.id !== automation.workspaceId).length > 0 ? (
                        <>
                          <MenuSeparator />
                          <MenuLabel>{t('Duplicate to')}</MenuLabel>
                          {workspaces
                            .filter((w) => w.id !== automation.workspaceId)
                            .map((target) => (
                            <MenuItem
                              key={target.id}
                              icon={
                                <WorkspaceAvatar
                                  color={target.color}
                                  icon={target.icon}
                                  className="mt-0.5"
                                />
                              }
                              onSelect={() =>
                                duplicate.mutate({ automation, workspaceId: target.id })
                              }
                            >
                              {target.name}
                            </MenuItem>
                          ))}
                        </>
                      ) : null}
                      {automation.familyId ? (
                        <MenuItem onSelect={() => detach.mutate(automation.id)}>
                          {t('Detach from its copies')}
                        </MenuItem>
                      ) : null}
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
      </Page>

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
        /*
          A template literal, so none of the three i18n measures ever saw it —
          they look for a translated call, not for a template — and this was
          English on a French screen for as long as the dialog has existed.
          Found by looking at the rendered dialog rather than at the source;
          the `templateCopyProps` ratchet now sees it.

          The call form is not spelled out here on purpose: a ratchet that
          greps cannot tell code from prose, and writing it would indict this
          comment. It did, on the first run.
        */
        title={t('Delete “{name}”?', { name: pendingDelete?.name ?? '' })}
        description={
          <>
            <p>
              {t('The schedule is removed. Sessions and transcripts it already produced are kept.')}
            </p>
            {/*
              What else stops working, before the press rather than after.
              Deleting a source silences every automation that waits on it, and
              nothing about the row being deleted says so — the operator's own
              chain becomes a chain of one, in a workspace they may not be
              looking at. The names are what makes it actionable.
            */}
            {pendingDelete && dependentsOf(pendingDelete.id).length > 0 ? (
              <p className="mt-2 text-warning">
                {plural(
                  dependentsOf(pendingDelete.id).length,
                  '{n} automation waits for this one and will watch nothing after this:',
                  '{n} automations wait for this one and will watch nothing after this:',
                )}{' '}
                {dependentsOf(pendingDelete.id)
                  .map((dependent) => dependent.name)
                  .join(', ')}
              </p>
            ) : null}
          </>
        }
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
  /** Carries the colour and icon so the picker reads like the rest of the app. */
  workspaces: Array<{ id: string; name: string; color: string; icon?: string }>;
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
  /**
   * Which automations this one watches, when it watches automations at all.
   *
   * Held whole rather than reconciled against the workspace picker: an
   * operator who changes the workspace and changes back finds their ticks
   * where they left them. What the form actually posts is derived below, from
   * this and from what the chosen workspace contains — the same reason the
   * effort picker derives from the catalogue rather than being reset by it.
   */
  const [eventSources, setEventSources] = useState<string[]>(
    automation ? [...declaredSources(automation.trigger)] : [],
  );
  /**
   * Which population this event trigger watches, held as its own state.
   *
   * Not derived from "are any ticked", and that is the whole point: a watcher
   * whose last source was deleted is stored with an empty list, which means
   * "watches nothing" and is a broken chain the operator must repair. Deriving
   * the mode from the ticks would have opening that automation and pressing
   * Save quietly turn it into a watcher of everybody's runs — a different
   * automation, from a press that meant "I changed nothing".
   */
  const [watchMode, setWatchMode] = useState<'people' | 'automations'>(
    automation && watchesAutomations(automation.trigger) ? 'automations' : 'people',
  );
  const [continuous, setContinuous] = useState(automation?.continuous ?? false);

  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  /** Editing an existing automation and pointing it somewhere else. */
  const moving = Boolean(automation) && workspaceId !== automation?.workspaceId;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    automation?.policy.permissionMode ?? 'default',
  );
  const [notify, setNotify] = useState(automation?.policy.notify ?? false);
  /*
   * The model an unattended run uses.
   *
   * `AutomationPolicy.model` has been in the schema since the feature shipped
   * and no form ever set it, so every automation ran on whatever `'default'`
   * resolves to — including the nightly briefs, where the choice matters most
   * and nobody could make it. Same shape as the composer's picker, and the
   * same catalogue: a model this deployment cannot reach is not offered.
   */
  const [model, setModel] = useState<ModelSelector>(automation?.policy.model ?? 'default');
  const [effort, setEffort] = useState<EffortLevel | null>(automation?.policy.effort ?? null);

  /*
   * The catalogue of the workspace this automation runs in — not a fixed list.
   *
   * What the CLI can reach depends on the credential the workspace uses, so a
   * hard-coded set would offer models a firing cannot run. It follows the
   * workspace picker above: change the workspace, the models change with it.
   */
  const catalogueQuery = useQuery({
    queryKey: ['claude-catalogue', workspaceId],
    queryFn: () => api.claudeCatalogue({ workspaceId }),
    enabled: Boolean(workspaceId),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const models = useMemo(() => modelOptions(catalogueQuery.data), [catalogueQuery.data]);
  const activeModel = models.find((entry) => entry.value === model);

  /*
   * Which efforts this model actually offers.
   *
   * Not a fixed list: a model that does not support effort offers only
   * "default", and under `Auto` the learner picks the model at submit time so
   * nothing can be ruled out. Same function the composer uses, so the two
   * cannot disagree about what a model can do.
   */
  const efforts = useMemo(
    () => effortOptions(catalogueQuery.data, String(model)),
    [catalogueQuery.data, model],
  );
  const activeEffort = efforts.find((entry) => entry.value === effort);

  /*
   * An effort the new model does not offer is dropped, not merely hidden.
   *
   * Changing the model changes the list, and the composer's own picker shows
   * the first entry while leaving the stored value alone — display and payload
   * disagreeing, which is the defect the model button above was fixed for. An
   * automation fires unattended, so it must not carry a setting nobody can see
   * they chose.
   */
  useEffect(() => {
    if (effort !== null && !efforts.some((entry) => entry.value === effort)) setEffort(null);
  }, [efforts, effort]);
  const [maxFailures, setMaxFailures] = useState(automation?.maxConsecutiveFailures ?? 3);
  // The zone the server reads every cron expression in, shown beside the
  // field: eight o'clock on a UTC host is ten in Paris all summer.
  const { data: system } = useQuery({ queryKey: ['system'], queryFn: () => api.system(), staleTime: 60_000 });

  /*
   * Whether the automation moved under this form.
   *
   * The same query the list behind is drawn from — deduplicated, and kept
   * current by the page's own poll — so this costs no request. The form is
   * seeded once and never re-seeds on its own, which is right while somebody
   * is typing and wrong as an account of what is stored: the operator has to
   * be told that what they are reading is no longer it, and given the choice
   * to take the new version.
   */
  const { data: live } = useQuery({ queryKey: ['automations'], queryFn: () => api.automations() });
  const stored = automation ? live?.automations.find((one) => one.id === automation.id) : undefined;
  const movedElsewhere = Boolean(stored && automation && stored.updatedAt !== automation.updatedAt);

  const seed = (from: Automation): void => {
    setName(from.name);
    setDescription(from.description);
    setPrompt(from.prompt);
    setTriggerType(from.trigger.type);
    if (from.trigger.type === 'cron') setExpression(from.trigger.expression);
    if (from.trigger.type === 'interval') setEveryMinutes(Math.round(from.trigger.everyMs / 60_000));
    if (from.trigger.type === 'event') {
      if ((EMITTED_AUTOMATION_EVENTS as readonly string[]).includes(from.trigger.event)) {
        setEventName(from.trigger.event as (typeof EMITTED_AUTOMATION_EVENTS)[number]);
      }
      setEventFilter(from.trigger.filter ?? '');
      setEventSources([...declaredSources(from.trigger)]);
      setWatchMode(watchesAutomations(from.trigger) ? 'automations' : 'people');
    }
    setContinuous(from.continuous);
    setPermissionMode(from.policy.permissionMode);
    setNotify(from.policy.notify);
    setModel(from.policy.model);
    setEffort(from.policy.effort);
    setMaxFailures(from.maxConsecutiveFailures);
  };

  /*
   * What this workspace offers as a source, and what may be ticked.
   *
   * Three exclusions, each of them something the server would refuse: an
   * automation of another workspace (sources are resolved in one), this
   * automation itself, and anything that already leads back here — offering a
   * tick whose only outcome is an error teaches the rule in the worst possible
   * place. The graph walk is the same one `validateTrigger` does, over the
   * list this screen already holds.
   */
  const inWorkspace = useMemo(
    () => (live?.automations ?? []).filter((entry) => entry.workspaceId === workspaceId),
    [live, workspaceId],
  );
  const candidates = useMemo(() => {
    const self = automation?.id;
    if (!self) return inWorkspace;
    const sourcesOf = new Map(
      inWorkspace.map((entry) => [entry.id, declaredSources(entry.trigger)]),
    );
    // The same walk the scheduler refuses with, from `packages/shared`: what
    // this hides is exactly what that would reject, and one definition is what
    // keeps the two from answering differently.
    return inWorkspace.filter(
      (entry) =>
        entry.id !== self && !watchPath((id) => sourcesOf.get(id) ?? [], [entry.id], self),
    );
  }, [inWorkspace, automation?.id]);

  /*
   * The ticks that survive the chosen workspace — what the form posts.
   *
   * Derived rather than reset by an effect: moving an automation elsewhere
   * cannot carry its sources, and the operator is told that below rather than
   * having their ticks disappear from under them.
   */
  const validSources = useMemo(
    () => eventSources.filter((id) => candidates.some((entry) => entry.id === id)),
    [eventSources, candidates],
  );
  const sourcesDropped = eventSources.length > 0 && validSources.length !== eventSources.length;

  const buildTrigger = (): AutomationTrigger => {
    if (triggerType === 'interval') return { type: 'interval', everyMs: everyMinutes * 60_000 };
    if (triggerType === 'manual') return { type: 'manual' };
    if (triggerType === 'event') {
      // Exclusive by construction, because the server refuses the pair: a
      // firing's prompt is the automation's own, so a filter over it would
      // either always match or silently never — a watcher that looks
      // configured and is dead.
      if (watchMode === 'automations') {
        return { type: 'event', event: eventName, automations: validSources };
      }
      const filter = eventFilter.trim();
      return { type: 'event', event: eventName, ...(filter ? { filter } : {}) };
    }
    return { type: 'cron', expression };
  };

  /**
   * What this form actually changed, against the automation it was seeded
   * from — not everything it holds.
   *
   * The form is a snapshot: it is filled when it opens and nothing re-seeds it
   * while somebody types. Sending the whole object back therefore rewrote
   * every field with what was true when the dialog opened, so a change made
   * anywhere else in between — by the steward, from another device, through
   * the API — was silently reverted by an unrelated edit. Measured on
   * `Alerte échec`: its trigger had become `event/run_failed`, the open form
   * still held the cron it was created with, and changing the prompt would
   * have put `0 9 * * *` back. A field nobody touched is a field this form has
   * no opinion about, and the route merges what it is given.
   */
  const changed = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    if (!automation) return patch;
    // Only when it actually moved: sending the same id would be a no-op on the
    // server, but a patch that names the workspace on every save is a patch
    // that says "moved" in the audit log every time somebody fixes a typo.
    if (workspaceId !== automation.workspaceId) patch.workspaceId = workspaceId;
    if (name.trim() !== automation.name) patch.name = name.trim();
    if (description.trim() !== automation.description) patch.description = description.trim();
    if (prompt.trim() !== automation.prompt) patch.prompt = prompt.trim();
    const trigger = buildTrigger();
    if (JSON.stringify(trigger) !== JSON.stringify(automation.trigger)) patch.trigger = trigger;
    if (continuous !== automation.continuous) patch.continuous = continuous;
    if (maxFailures !== automation.maxConsecutiveFailures) patch.maxConsecutiveFailures = maxFailures;
    const policy: Record<string, unknown> = {};
    if (permissionMode !== automation.policy.permissionMode) policy.permissionMode = permissionMode;
    if (notify !== automation.policy.notify) policy.notify = notify;
    if (model !== automation.policy.model) policy.model = model;
    if (effort !== automation.policy.effort) policy.effort = effort;
    if (Object.keys(policy).length > 0) patch.policy = policy;
    return patch;
  };

  /*
   * The copies this automation is linked to, and the question they raise.
   *
   * Only fetched while editing an existing one — a new automation has no family
   * yet — and the dialog only appears when there is something to ask: other
   * members *and* a changed field that means the same thing elsewhere. Every
   * other save goes through untouched, which is most of them.
   */
  const familyQuery = useQuery({
    queryKey: ['automation-family', automation?.id ?? null],
    queryFn: () => api.automationFamily(automation!.id),
    enabled: Boolean(automation),
    staleTime: 30_000,
  });
  const siblings = familyQuery.data?.automations ?? [];
  const [asking, setAsking] = useState<{ patch: Record<string, unknown>; fields: string[] } | null>(
    null,
  );

  const save = useMutation({
    mutationFn: (propagateTo?: string[]) => {
      if (automation) {
        const patch = changed();
        // Nothing to say is not an error, and not a write either.
        if (Object.keys(patch).length === 0) return Promise.resolve({ automation });
        return api.updateAutomation(automation.id, {
          ...patch,
          ...(propagateTo && propagateTo.length > 0 ? { propagateTo } : {}),
        });
      }
      return api.createAutomation({
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        trigger: buildTrigger(),
        continuous,
        maxConsecutiveFailures: maxFailures,
        policy: { permissionMode, notify, model, effort },
        workspaceId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success(automation ? t('Automation updated') : t('Automation created'));
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not save the automation.')),
  });

  /*
   * A watcher of automations with nothing ticked is refused by the server, and
   * saying so here is the difference between a repair and a dead end: it is
   * exactly the state a pruned watcher opens in, so the operator arriving to
   * fix one must be told what is missing rather than handed a 400.
   */
  const needsSource = triggerType === 'event' && watchMode === 'automations' && validSources.length === 0;
  const valid = name.trim() && prompt.trim() && workspaceId && !needsSource;

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
            onClick={() => {
              /*
               * Ask before saving, not after: the dialog decides who the write
               * reaches, so it has to come first. Only when there is something
               * to ask — a family with other members and a changed field that
               * means the same thing elsewhere — so the common save is
               * unchanged and nobody learns to dismiss a box.
               */
              const patch = automation ? changed() : {};
              const fields = propagatableFields(patch);
              if (siblings.length > 0 && fields.length > 0) {
                setAsking({ patch, fields });
                return;
              }
              save.mutate(undefined);
            }}
          >
            {automation ? t('Save') : t('Create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Said, not silently reconciled: re-seeding under someone's hands
            would discard what they are typing, and leaving them to read a
            trigger that is no longer stored is how an unrelated edit came to
            look like it reverted one. Only what is edited here is sent, so
            reading on is safe — but it is not the truth, and the form says so. */}
        {movedElsewhere && stored ? (
          <p className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-caption leading-relaxed text-warning">
            {t('This automation changed elsewhere since this form opened. Only the fields you edit here are sent.')}
            <Button variant="outline" size="sm" onClick={() => seed(stored)}>
              {t('Load the new version')}
            </Button>
          </p>
        ) : null}

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

        {/*
          * Shown when editing too, and changeable.
          *
          * It used to appear only at creation, so an automation's workspace was
          * neither visible nor movable afterwards — while a skill, a subagent
          * and an MCP server all show their reach in their editor and let it be
          * changed. The asymmetry had a real reason underneath (a continuous
          * automation's session lives in its workspace) and the fix was to
          * handle that in the move rather than to forbid the move: an
          * automation written for one project does turn out to suit another,
          * and workspaces are created after the automations that would serve
          * them.
          */}
        <div>
          <span className="mb-1.5 block text-body font-medium text-ink">{t('Workspace')}</span>
          <Menu
            side="bottom"
            trigger={
              <Button variant="secondary" size="sm" className="w-full justify-between">
                <span className="flex items-center gap-2 truncate">
                  {current ? (
                    <WorkspaceAvatar color={current.color} icon={current.icon} />
                  ) : null}
                  {current?.name ?? t('Choose a workspace')}
                </span>
              </Button>
            }
          >
            {workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                selected={workspace.id === workspaceId}
                onSelect={() => setWorkspaceId(workspace.id)}
                icon={
                  <WorkspaceAvatar
                    color={workspace.color}
                    icon={workspace.icon}
                    className="mt-0.5"
                  />
                }
              >
                {workspace.name}
              </MenuItem>
            ))}
          </Menu>
          {/* The consequence, before the save rather than after it. Only a
              continuous automation has a thread to lose, so only it is warned. */}
          {moving && continuous ? (
            <p className="mt-1.5 text-caption text-warning">
              {t(
                'Moving this automation ends its continuous session — the next firing starts a fresh one in the new workspace.',
              )}
            </p>
          ) : null}
        </div>

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
          <span className="mb-1.5 block text-body font-medium text-ink">{t('Trigger')}</span>
          {/* Two by two on a phone, four across from `sm` up. A single flex row
              of four `flex-1` cells cannot shrink below its text, so it
              overflowed the dialog with no wrap and no scroll: on a 360px
              screen in French — Planifié · Intervalle · Manuel · Événement —
              the fourth button was simply off-screen, and an event trigger
              could not be chosen or even seen on a phone. */}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="group" aria-label={t('Trigger')}>
            {(['cron', 'interval', 'manual', 'event'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setTriggerType(type)}
                aria-pressed={triggerType === type}
                className={cn(
                  'rounded-lg border px-3 py-2 text-caption font-medium capitalize transition-colors',
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
                className="font-mono text-body"
              />
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.expression}
                    type="button"
                    onClick={() => setExpression(preset.expression)}
                    className={cn(
                      CHIP,
                      'rounded-full border transition-colors',
                      expression === preset.expression
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-muted hover:bg-raised',
                    )}
                  >
                    {t(preset.label)}
                  </button>
                ))}
              </div>
              <p className="text-caption text-subtle">
                {t("Standard 5-field cron, read in the server's timezone: {zone}.", {
                  zone: system?.timezone ?? '…',
                })}
              </p>
            </div>
          ) : triggerType === 'event' ? (
            /*
              Subordinate, and shown to be.
              An event trigger asks two more questions — which outcome, and
              whose runs — and rendered flush left they read as three
              independent rows of identical buttons, six choices at one level
              where there are two levels. A rule down the left says these
              refine the row above without adding a box the dialog does not
              have room for.
            */
            <div className="mt-2.5 space-y-2 border-l border-line pl-3">
              <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t('Event')}>
                {EMITTED_AUTOMATION_EVENTS.map((event) => (
                  <button
                    key={event}
                    type="button"
                    onClick={() => setEventName(event)}
                    aria-pressed={eventName === event}
                    className={cn(PICKER_BUTTON,
                      eventName === event
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-muted hover:bg-raised',
                    )}
                  >
                    {t(EVENT_LABELS[event])}
                  </button>
                ))}
              </div>
              {/*
                Which population, as a choice rather than a side effect of
                ticking something. Two exclusive modes: the runs people start,
                narrowed by a word, or the end of named automations — a chain.
                A grid, never a bare flex row: `Les runs des personnes` next to
                `D'autres automatisations` overflows a 360px screen, and a flex
                child squeezes into three-line pills before it overflows.
              */}
              <div
                className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
                role="group"
                aria-label={t('What it watches')}
              >
                {(['people', 'automations'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setWatchMode(mode)}
                    aria-pressed={watchMode === mode}
                    className={cn(PICKER_BUTTON,
                      watchMode === mode
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-muted hover:bg-raised',
                    )}
                  >
                    {mode === 'people'
                      ? t('Runs people start')
                      : t('Other automations finishing')}
                  </button>
                ))}
              </div>

              {watchMode === 'people' ? (
                <>
                  <Input
                    value={eventFilter}
                    onChange={(event) => setEventFilter(event.target.value)}
                    placeholder={t('Filter (optional)')}
                    aria-label={t('Filter (optional)')}
                  />
                  <p className="text-caption text-subtle">
                    {t(
                      'Fires when a run you, a token or a delegation started in this workspace ends that way. The filter is optional: one word that must appear in the run’s category or prompt, matched anywhere in it and ignoring case.',
                    )}
                  </p>
                  {/*
                    The categories, named rather than left to be guessed.
                    They are identifiers the classifier assigns, never
                    translated, and asking a French screen to guess an English
                    one is asking for a filter that matches nothing.
                  */}
                  <p className="text-caption text-subtle">
                    {t('Categories a run can have:')}{' '}
                    <span className="font-mono">{TASK_CATEGORIES.join(' · ')}</span>
                  </p>
                </>
              ) : (
                <>
                  {candidates.length > 0 ? (
                    <div
                      className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-line p-2"
                      role="group"
                      aria-label={t('Automations to watch')}
                    >
                      {candidates.map((candidate) => (
                        <CheckboxField
                          key={candidate.id}
                          checked={eventSources.includes(candidate.id)}
                          onChange={(checked) =>
                            setEventSources((sources) =>
                              checked
                                ? [...sources, candidate.id]
                                : sources.filter((id) => id !== candidate.id),
                            )
                          }
                          label={
                            candidate.enabled
                              ? candidate.name
                              : t('{name} (paused)', { name: candidate.name })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-caption text-warning">
                      {t(
                        'This workspace has no other automation to watch — one that already waits on this one is not offered, because that would loop.',
                      )}
                    </p>
                  )}
                  <p className="text-caption text-subtle">
                    {t(
                      'Fires when one of these finishes that way, however it was started — its schedule, "Run now", or a message in its session. It hears nothing else: the runs you start yourself go to the other mode.',
                    )}
                  </p>
                  {needsSource ? (
                    <p className="text-caption text-warning">
                      {t('Tick at least one, or switch to the runs people start.')}
                    </p>
                  ) : null}
                  {/*
                    Two causes, two sentences. Ticks vanish because the
                    workspace changed under them, or because somebody deleted
                    the automation they named while this form was open — and a
                    message that names the wrong one of those sends the
                    operator looking in the wrong place. `moving` already
                    distinguishes them.
                  */}
                  {sourcesDropped ? (
                    <p className="text-caption text-warning">
                      {moving
                        ? t(
                            'Automations are watched inside one workspace, so the ones chosen in the other are not carried over.',
                          )
                        : t('An automation this one watched is no longer there.')}
                    </p>
                  ) : null}
                </>
              )}
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
              <p className="mt-1 text-caption text-subtle">{t(
                'Minutes between runs. Minimum 1.',
              )}</p>
            </div>
          ) : (
            <p className="mt-2.5 text-caption text-subtle">
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
            <span className="block text-body font-medium text-ink">{t('Continuous loop')}</span>
            <span className="block text-caption leading-relaxed text-muted">
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
            <span className="block text-body font-medium text-ink">{t('Notify me when a firing ends')}</span>
            <span className="block text-caption leading-relaxed text-muted">
              {t(
                'Automations are silent by default so the machinery never wakes you. Tick this for the ones whose whole point is to be read — a morning brief computed at eight and read at six has ten hours.',
              )}
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-body font-medium text-ink">{t('Model')}</span>
            <Menu
              side="bottom"
              trigger={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-between"
                  // Both pickers default to the label `Auto`, so that name
                  // alone identifies neither — for a screen reader, for voice
                  // control, or for a test. The visible text stays short; the
                  // name says which setting it is.
                  aria-label={t('Model: {value}', {
                    value: activeModel ? t(activeModel.label) : String(model),
                  })}
                >
                  {/*
                    * Three cases, and the middle one is why this is not a
                    * `??` chain on a label.
                    *
                    * The catalogue follows the workspace picker above, so
                    * changing the workspace can leave `model` holding a value
                    * the new catalogue does not list. Falling back to `Auto`
                    * there would show a choice nobody made while posting a
                    * different one — the interface lying about its own state.
                    * The raw value is shown instead: it is what will be sent,
                    * and the CLI degrades it with a visible message if it
                    * cannot serve it.
                    */}
                  {activeModel ? t(activeModel.label) : model === 'default' ? t('Auto') : model}
                </Button>
              }
            >
              <MenuLabel>{t('What the scheduled run is given')}</MenuLabel>
              {models.map((entry) => (
                <MenuItem
                  key={entry.value}
                  selected={entry.value === model}
                  onSelect={() => setModel(entry.value)}
                  description={entry.hint}
                >
                  {t(entry.label)}
                </MenuItem>
              ))}
            </Menu>
          </div>

          <div>
            <span className="mb-1.5 block text-body font-medium text-ink">{t('Effort')}</span>
            <Menu
              side="bottom"
              trigger={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-between"
                  disabled={efforts.length <= 1}
                  aria-label={t('Effort: {value}', {
                    value: t(activeEffort?.label ?? efforts[0]?.label ?? 'Auto'),
                  })}
                >
                  {t(activeEffort?.label ?? efforts[0]?.label ?? 'Default')}
                </Button>
              }
            >
              <MenuLabel>{t('How hard it thinks before answering')}</MenuLabel>
              {efforts.map((entry) => (
                <MenuItem
                  key={entry.value ?? 'default'}
                  selected={entry.value === effort}
                  onSelect={() => setEffort(entry.value)}
                >
                  {t(entry.label)}
                </MenuItem>
              ))}
            </Menu>
          </div>

          <div>
            <span className="mb-1.5 block text-body font-medium text-ink">{t(
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
          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/30 p-3 text-caption leading-relaxed text-ink">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            {t(
              'In "Ask" mode an unattended run will stall on the first prompt and be declined after ten minutes. For a schedule, prefer "Plan", "Accept edits" or "Auto".',
            )}
          </p>
        ) : null}
      </div>

      {asking ? (
        <PropagateDialog
          fields={asking.fields}
          siblings={siblings}
          workspaces={workspaces}
          busy={save.isPending}
          onDecide={(ids) => {
            setAsking(null);
            save.mutate(ids);
          }}
        />
      ) : null}
    </Modal>
  );
}

/**
 * The one-line summary under an automation's name.
 *
 * Translated through `t` rather than returning English: the strings are
 * lowercase, which is what let them escape all three i18n measures for as long
 * as they did — a lowercase sentence is still copy.
 *
 * `names` maps an automation id to its name, so a watcher can say what it
 * watches. An id that is not in the map is one the caller could not see; it is
 * shown as an id rather than dropped, because a summary that silently lists
 * fewer sources than the trigger holds is worse than an ugly one.
 */
function describeTrigger(
  trigger: AutomationTrigger,
  t: TranslateFn,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  switch (trigger.type) {
    case 'cron':
      return t('cron: {expression}', { expression: trigger.expression });
    case 'interval': {
      const minutes = Math.round(trigger.everyMs / 60_000);
      return minutes % 60 === 0
        ? t('every {count}h', { count: String(minutes / 60) })
        : t('every {count}m', { count: String(minutes) });
    }
    case 'event': {
      if (!watchesAutomations(trigger)) {
        return trigger.event === 'run_failed' ? t('on a failed run') : t('on a succeeded run');
      }
      const sources = declaredSources(trigger);
      // Pruned to nothing when its last source was deleted or moved. Named as
      // its own state: an empty list watches nothing, where no list at all
      // would watch the runs people start — two very different automations.
      if (sources.length === 0) return t('watches nothing since its source went away');
      // Whole sentences rather than an event fragment plus a list: "on a
      // failed run of X" composes in English and not in French, where the
      // event and the subject cannot be glued in that order.
      const list = sources.map((id) => names.get(id) ?? id).join(', ');
      return trigger.event === 'run_failed'
        ? t('after {sources} fails', { sources: list })
        : t('after {sources} succeeds', { sources: list });
    }
    default:
      return t('manual only');
  }
}
