/**
 * Dashboard — the answer to "what is my agent OS doing right now?".
 *
 * Ordered by urgency rather than by category: anything waiting on a human comes
 * first, then work in flight, then the state of the system, then history.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { Page, Section } from '@/components/ui/layout';
import {
  Activity,
  AlertTriangle,
  Brain,
  FolderGit2,
  Lightbulb,
  Plus,
  ShieldQuestion,
  Timer,
  Zap,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Insight, Run } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { BriefView } from '@/components/analytics/BriefView';
import { ConsolidationCard, readProposal } from '@/components/memory/ConsolidationCard';
import { InsightCard } from '@/components/memory/InsightCard';
import { AdvisorCard } from '@/components/dashboard/AdvisorCard';
import { MetaclaudeCard } from '@/components/dashboard/MetaclaudeCard';
import { ResourceMeters } from '@/components/system/ResourceMeters';
import { SystemPulse } from '@/components/dashboard/SystemPulse';
import { GettingStartedCard } from '@/components/dashboard/GettingStartedCard';
import { Badge, Button, Card, EmptyState, QUIET_LINK, Spinner, StatList, Tooltip } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { INSIGHT_TONE, isLearned, readDecisions } from '@/lib/insights';
import { describeRetrieval } from '@/lib/retrieval';
import { usePlural, useT } from '@/lib/i18n';
import { decideApproval } from '@/lib/approvals';
import { socket } from '@/lib/socket';
import { useAuthStore } from '@/lib/store';
import { cn, formatCost, formatDuration, formatRelative, formatPercent } from '@/lib/utils';
import { routes } from '@metaclaude/shared';

export function DashboardPage() {
  const plural = usePlural();
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);

  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => api.workspaces() });

  const systemQuery = useQuery({
    queryKey: ['system'],
    queryFn: () => api.system(),
    // Polled rather than pushed: none of this arrives over the socket. Ten
    // seconds because CPU and memory do change fast, and a meter that lags a
    // minute behind the run it is meant to explain is worse than no meter.
    //
    // Affordable: the CLI version probe behind this route is cached for a
    // minute, and everything else is a counter or a file read. The first two
    // polls also earn their keep on their own — CPU usage is a rate, so the
    // very first reading has nothing to compare against and reports nothing.
    refetchInterval: 10_000,
  });

  const runsQuery = useQuery({
    queryKey: ['runs', 'dashboard'],
    queryFn: () => api.runs({ limit: 25 }),
  });

  const approvalsQuery = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.approvals(),
    refetchInterval: 30_000,
  });

  const analyticsQuery = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => api.analytics({ days: 7, granularity: 'day' }),
  });

  const insightsQuery = useQuery({
    queryKey: ['insights', 'new'],
    // Asked for more than the five shown: consolidation proposals share this
    // queue and are filtered out below, and taking five from the server would
    // let a sweep's worth of them leave the digest empty.
    queryFn: () => api.insights({ status: 'new', limit: 20 }),
  });

  // The brief embeds the doctor and (cached) quota, both of which cost a
  // subprocess on a cold cache — fetched once and kept for the visit.
  const briefQuery = useQuery({
    queryKey: ['brief'],
    queryFn: () => api.brief(),
    enabled: user?.role === 'owner',
    staleTime: 5 * 60_000,
  });

  /*
   * Deciding an insight from here, with the Memory page's own verbs.
   *
   * The two screens invalidate the same key, so a decision taken on either is
   * reflected on the other the next time it is opened — and the toast is the
   * same sentence, because a decision that reads differently depending on
   * where it was taken is two features wearing one name.
   */
  const setInsightStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Insight['status'] }) =>
      api.setInsightStatus(id, status),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success(variables.status === 'accepted' ? t('Insight accepted') : t('Insight rejected'));
    },
    onError: () => toast.error(t('Could not update that insight.')),
  });

  const applyConsolidation = useMutation({
    mutationFn: ({ id, promote }: { id: string; promote: boolean }) =>
      api.applyConsolidation(id, promote),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
      toast.success(
        plural(result.absorbed.length, '{n} memory folded in', '{n} memories folded in'),
        {
          description: result.moved
            ? t('The survivor is now global — every workspace recalls it.')
            : t('The survivor keeps the history of all of them.'),
        },
      );
    },
    onError: () => toast.error(t('Could not apply that consolidation.')),
  });

  const createWorkspace = useMutation({
    mutationFn: () => api.createWorkspace({ name: t('New workspace') }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      navigate(routes.workspace(data.workspace.id));
    },
    onError: () => toast.error(t('Could not create the workspace.')),
  });

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const approvals = approvalsQuery.data?.approvals ?? [];
  const summary = analyticsQuery.data?.summary;
  const system = systemQuery.data;

  const activeRuns = runs.filter(
    (run) => run.status === 'running' || run.status === 'waiting_approval' || run.status === 'queued',
  );

  const greeting = `${t(
    timeOfDayGreeting(),
  )}, ${user?.displayName || user?.username || t('there')}.`;

  // The digest is about what the system *learned*. A consolidation proposal
  // is filed in the same queue and is a request to delete rows, which is not
  // that — and the Review link below already leads to where it is answered.
  const learned = (insightsQuery.data?.insights ?? []).filter(isLearned).slice(0, 5);

  /*
   * The same queue, with its verbs attached.
   *
   * The digest above says what was learned and offers no way to answer it, so
   * every decision cost a trip to the Memory page — and a queue nobody answers
   * is how a proposal to delete rows sits for weeks. Unlike the digest this
   * keeps consolidations: they wait for review like everything else here, and
   * they are exactly what the digest filters out, so leaving them out of both
   * would mean the Dashboard never shows one at all.
   *
   * Three, not five: each card carries its own text and verbs, and a Dashboard
   * that pushes the run list below three screens of them has stopped being a
   * digest. The rest are a link away.
   */
  const pending = (insightsQuery.data?.insights ?? []).slice(0, 3);

  return (
    <AppShell>
      <ContentHeader
        title={greeting}
        subtitle={
          system?.claudeCli.authenticated
            ? t('Claude CLI {version} · {auth}', {
                version: system.claudeCli.version ?? '',
                auth:
                  system.claudeCli.authMode === 'subscription'
                    ? t('subscription')
                    : t('API key'),
              })
            : t('No Claude credentials configured')
        }
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => createWorkspace.mutate()}
            loading={createWorkspace.isPending}
            aria-label={t('New workspace')}
          >
            <Plus className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t('New workspace')}</span>
          </Button>
        }
      />

      <Page width="wide">
        {/* The opening line: what the OS is doing right now, and its
            24-hour heartbeat — before anything else on the page. */}
        <SystemPulse
          activeRuns={activeRuns.length}
          queuedRuns={system?.queuedRuns ?? 0}
          approvals={approvals.length}
          lastFinishedAt={runs.find((run) => run.finishedAt !== null)?.finishedAt ?? null}
        />

        <GettingStartedCard />

        {/*
          * What is waiting on a person, above the fold and outside the columns.
          *
          * These two keep a card, and a tinted one: a card says "a separate
          * object you can act on", which is what an unauthenticated CLI and a
          * pending approval are. Everything below is a section — spending a
          * border on all eleven blocks spent it on none of them.
          */}
        {system && !system.claudeCli.authenticated ? (
          <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft/40 p-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 space-y-1 text-body leading-relaxed">
              <p className="font-medium text-ink">{t('Claude is not authenticated.')}</p>
              <p className="text-muted">
                {t('Pair it from')}{' '}
                <Link to={routes.server()} className={cn('font-medium underline-offset-2', QUIET_LINK)}>
                  {t('System → Server')}
                </Link>
                {t(
                  ': sign in with your Pro or Max plan, paste back one code, done — no shell, no restart. A token from',
                )}{' '}
                <code className="rounded bg-raised px-1 font-mono text-caption">{t(
                  'claude setup-token',
                )}</code>{' '}
                {t('can be pasted there too.')}
              </p>
            </div>
          </div>
        ) : null}

        {approvals.length > 0 ? (
          <Card className="border-warning/40 bg-warning-soft/25">
            <div className="flex items-center gap-2 border-b border-warning/25 px-4 py-3">
              <ShieldQuestion className="size-4 shrink-0 text-warning" aria-hidden />
              <h2 className="text-title text-ink">
                {plural(
                  approvals.length,
                  '{n} action waiting for you',
                  '{n} actions waiting for you',
                )}
              </h2>
            </div>
            <ul className="divide-y divide-line">
              {approvals.map((approval) => (
                <li key={approval.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge tone={approval.risk === 'high' ? 'danger' : 'warning'}>
                    {approval.risk}
                  </Badge>
                  <code className="min-w-0 flex-1 truncate font-mono text-caption text-ink">
                    {approval.summary}
                  </code>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      // Not `void`: `decideApproval` awaits the HTTP fallback
                      // and throws on any non-2xx, so an unhandled rejection
                      // would leave the operator with a tap that did nothing
                      // and no way to know.
                      onClick={() => {
                        decideApproval(approval.id, false).catch((error: unknown) => {
                          toast.error(
                            error instanceof ApiError
                              ? error.message
                              : t('Could not send that decision.'),
                          );
                        });
                      }}
                    >
                      {t('Deny')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() =>
                        navigate(routes.session(approval.workspaceId, approval.sessionId))
                      }
                    >
                      {t('Review')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/*
          * Two columns on a wide screen, and that is the change.
          *
          * Eleven full-width bands stacked down a 1100px column put the
          * workspaces and the history two screens below the fold, each row
          * carrying 900px of empty space in its middle. What is happening
          * reads on the left; what the system *is* — its figures, its machine,
          * its projects, what it has learnt — sits beside it.
          */}
        <div className="grid gap-section lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 space-y-section">
            {/* The operator's first control: a composer that opens a run of
                the system workspace. A card, because it is an object. */}
            <MetaclaudeCard />

            {briefQuery.data ? (
              <Section
                title={t('The brief')}
                icon={<Activity className="text-accent" />}
                actions={<span className="text-caption text-subtle">{t('last 24 hours')}</span>}
              >
                <BriefView brief={briefQuery.data} />
              </Section>
            ) : null}

            <AdvisorCard />

            {activeRuns.length > 0 ? (
              <Section title={t('In flight')} icon={<Activity className="text-accent" />}>
                <ul className="divide-y divide-line">
                  {activeRuns.map((run) => (
                    <RunRow key={run.id} run={run} live />
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* Above the run list, and in the main column rather than the
                rail: what the system learned yesterday is read before what it
                ran, and in the rail it sat below the fold on every screen. */}
            <Section
              title={t('Recently learned')}
              icon={<Zap className="text-thinking" />}
              actions={
                <Link to={routes.memory()} className={cn('text-caption', QUIET_LINK)}>
                  {t('Review')}
                </Link>
              }
            >
              {learned.length === 0 ? (
                <EmptyState
                  title={t('Nothing new')}
                  description={t(
                    'After each run, Metaclaude reflects on what happened and records anything worth remembering.',
                  )}
                  className="py-6"
                />
              ) : (
                <ul className="divide-y divide-line">
                  {learned.map((insight) => (
                    <li key={insight.id} className="py-2">
                      <Badge tone={INSIGHT_TONE[insight.kind]}>
                        {insight.kind.replace('_', ' ')}
                      </Badge>
                      <p className="mt-1.5 text-body leading-snug text-ink">{insight.title}</p>
                      <p className="mt-0.5 text-caption text-subtle">
                        {formatRelative(insight.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* Below the digest rather than instead of it: what was learned
                reads as a fact, what is waiting reads as a question, and an
                operator wants the first at a glance and the second only when
                they mean to answer it. */}
            <Section
              title={t('Insights awaiting review')}
              icon={<Lightbulb className="text-warning" />}
              actions={
                <Link to={routes.memory()} className={cn('text-caption', QUIET_LINK)}>
                  {t('All of them')}
                </Link>
              }
            >
              {pending.length === 0 ? (
                <EmptyState
                  title={t('Nothing waiting')}
                  description={t('New lessons appear here as runs complete.')}
                  className="py-6"
                />
              ) : (
                <div className="space-y-3">
                  {pending.map((insight) => {
                    // A consolidation is a decision about rows that already
                    // exist rather than an observation to accept or reject, so
                    // it gets its own card with its own verbs — the same branch
                    // the Memory page makes, from the same helper.
                    const proposal =
                      insight.kind === 'consolidation' ? readProposal(insight.payload) : null;
                    if (proposal) {
                      return (
                        <ConsolidationCard
                          key={insight.id}
                          proposal={proposal}
                          workspaces={workspaces}
                          busy={
                            applyConsolidation.isPending &&
                            applyConsolidation.variables?.id === insight.id
                          }
                          onApply={(promote) =>
                            applyConsolidation.mutate({ id: insight.id, promote })
                          }
                          onDismiss={() =>
                            setInsightStatus.mutate({ id: insight.id, status: 'rejected' })
                          }
                        />
                      );
                    }
                    return (
                      <InsightCard
                        key={insight.id}
                        insight={insight}
                        workspaces={workspaces}
                        gate={readDecisions(insight.payload)}
                        busy={{
                          deciding:
                            setInsightStatus.isPending &&
                            setInsightStatus.variables?.id === insight.id
                              ? (setInsightStatus.variables.status as 'accepted' | 'rejected')
                              : null,
                        }}
                        onDecide={(status) => setInsightStatus.mutate({ id: insight.id, status })}
                      />
                    );
                  })}
                </div>
              )}
            </Section>

            <Section
              title={t('Recent runs')}
              icon={<Timer className="text-muted" />}
              actions={
                <Link to={routes.analytics()} className={cn('text-caption', QUIET_LINK)}>
                  {t('Analytics')}
                </Link>
              }
            >
              {runs.length === 0 ? (
                <EmptyState
                  title={t('No runs yet')}
                  description={t('Start a session to see history here.')}
                />
              ) : (
                <ul className="divide-y divide-line">
                  {runs
                    .filter((run) => !activeRuns.includes(run))
                    .slice(0, 12)
                    .map((run) => (
                      <RunRow key={run.id} run={run} />
                    ))}
                </ul>
              )}
            </Section>
          </div>

          <aside className="min-w-0 space-y-section">
            <Section title={t('Activity')}>
              <StatList
                items={[
                  {
                    label: t('Active runs'),
                    value: system?.activeRuns ?? 0,
                    hint: system?.queuedRuns
                      ? t('{n} queued', { n: system.queuedRuns })
                      : undefined,
                    tone: system && system.activeRuns > 0 ? 'success' : undefined,
                  },
                  {
                    label: t('Cost, 7 days'),
                    value: formatCost(summary?.totalCostUsd ?? 0),
                    hint: t('{n} runs', { n: summary?.totalRuns ?? 0 }),
                  },
                  {
                    label: t('Success rate'),
                    value: summary ? formatPercent(summary.successRate) : '—',
                    hint: summary?.medianDurationMs
                      ? t('median {d}', { d: formatDuration(summary.medianDurationMs) })
                      : undefined,
                    tone:
                      summary && summary.totalRuns > 0
                        ? summary.successRate >= 0.8
                          ? 'success'
                          : summary.successRate >= 0.5
                            ? 'warning'
                            : 'danger'
                        : undefined,
                  },
                  {
                    label: t('Memories'),
                    value: system?.memoryCount ?? 0,
                    hint: t(describeRetrieval(system?.retrieval).label),
                  },
                ]}
              />
            </Section>

            {/* The machine itself. Below the work it is doing, because the
                question "what is running?" comes before "can the box take
                it?" */}
            <ResourceMeters resources={system?.resources} />

            <Section
              title={t('Workspaces')}
              icon={<FolderGit2 className="text-muted" />}
              actions={
                <Link to={routes.workspaces()} className={cn('text-caption', QUIET_LINK)}>
                  {t('View all')}
                </Link>
              }
            >
              {workspacesQuery.isLoading ? (
                <div className="flex justify-center py-6">
                  <Spinner />
                </div>
              ) : workspaces.length === 0 ? (
                <EmptyState
                  icon={<FolderGit2 />}
                  title={t('No workspaces yet')}
                  description={t(
                    'A workspace is a project directory plus the agent policy that applies inside it.',
                  )}
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => createWorkspace.mutate()}
                      loading={createWorkspace.isPending}
                    >
                      <Plus className="size-4" aria-hidden />
                      {t('Create the first one')}
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-line">
                  {workspaces.slice(0, 6).map((workspace) => (
                    <li key={workspace.id}>
                      <Link
                        to={routes.workspace(workspace.id)}
                        className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-raised"
                      >
                        <WorkspaceAvatar color={workspace.color} icon={workspace.icon} size="md" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-medium text-ink">
                            {workspace.name}
                          </p>
                          <p className="truncate text-caption text-muted">
                            {workspace.description || workspace.slug}
                          </p>
                        </div>
                        <span className="shrink-0 text-caption text-subtle">
                          {formatRelative(workspace.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </aside>
        </div>
      </Page>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

/** The status dot's colour, by tone. A `Record` so a new tone fails the build. */
const DOT: Record<'success' | 'danger' | 'warning' | 'accent', string> = {
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning',
  accent: 'bg-accent',
};

function RunRow({ run, live = false }: { run: Run; live?: boolean }) {
  const t = useT();
  const tone =
    run.status === 'succeeded'
      ? 'success'
      : run.status === 'failed'
        ? 'danger'
        : run.status === 'interrupted'
          ? 'warning'
          : 'accent';

  return (
    <li>
      <Link
        to={routes.session(run.workspaceId, run.sessionId)}
        className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-raised"
      >
        {/*
          * A dot, not a pill.
          *
          * Twelve rows carried twelve `succeeded` badges — twelve repetitions
          * of the one thing every row has in common, drawn louder than the
          * prompt that distinguishes them. The eye needs the exception, and
          * the exception was the quietest element on the list. Colour carries
          * it now and the word stays in the accessible name, because a colour
          * alone is not a status.
          */}
        <span className={cn('relative shrink-0', live && 'pulse-ring rounded-full')}>
          <span className={cn('block size-2 rounded-full', DOT[tone])} aria-hidden />
          <span className="sr-only">{t(run.status)}</span>
        </span>

        <p className="min-w-0 flex-1 truncate text-body text-ink">
          {run.prompt.split('\n')[0]}
        </p>

        {run.policy.source === 'learned' ? (
          <Tooltip content={t('Model chosen by the learned policy')}>
            <span className="hidden shrink-0 sm:block">
              <Badge tone="thinking">
                <Brain className="size-2.5" aria-hidden />
                {String(run.policy.model)}
              </Badge>
            </span>
          </Tooltip>
        ) : null}

        {run.usage.costUsd > 0 ? (
          <span className="hidden shrink-0 text-caption tabular-nums text-subtle sm:block">
            {formatCost(run.usage.costUsd)}
          </span>
        ) : null}

        <span className="shrink-0 text-caption text-subtle">{formatRelative(run.startedAt)}</span>
      </Link>
    </li>
  );
}

/** English as data — the caller translates. See the note in `lib/i18n.tsx`. */
const GREETINGS = {
  night: 'Still up',
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
};

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return GREETINGS.night;
  if (hour < 12) return GREETINGS.morning;
  if (hour < 18) return GREETINGS.afternoon;
  return GREETINGS.evening;
}
