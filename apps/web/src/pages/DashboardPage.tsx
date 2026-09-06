/**
 * Dashboard — the answer to "what is my agent OS doing right now?".
 *
 * Ordered by urgency rather than by category: anything waiting on a human comes
 * first, then work in flight, then the state of the system, then history.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Grid, Page } from '@/components/ui/layout';
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Coins,
  Cpu,
  FolderGit2,
  Plus,
  ShieldQuestion,
  Timer,
  Zap,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Run } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { BriefView } from '@/components/analytics/BriefView';
import { AdvisorCard } from '@/components/dashboard/AdvisorCard';
import { MetaclaudeCard } from '@/components/dashboard/MetaclaudeCard';
import { ResourceMeters } from '@/components/system/ResourceMeters';
import { SystemPulse } from '@/components/dashboard/SystemPulse';
import { GettingStartedCard } from '@/components/dashboard/GettingStartedCard';
import { Badge, Button, Card, EmptyState, Spinner, Stat, Tooltip } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { INSIGHT_TONE, isLearned } from '@/lib/insights';
import { describeRetrieval } from '@/lib/retrieval';
import { usePlural, useT } from '@/lib/i18n';
import { decideApproval } from '@/lib/approvals';
import { socket } from '@/lib/socket';
import { useAuthStore } from '@/lib/store';
import { cn, formatCost, formatDuration, formatRelative, formatPercent } from '@/lib/utils';

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

  const createWorkspace = useMutation({
    mutationFn: () => api.createWorkspace({ name: t('New workspace') }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      navigate(`/w/${data.workspace.id}`);
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
        showSidebarToggle={false}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => createWorkspace.mutate()}
            loading={createWorkspace.isPending}
          >
            <Plus className="size-4" aria-hidden />
            {t('New workspace')}
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

          {/* The operator's second: a composer that opens a run of the system
              workspace. Before the warnings and the metrics, because when there
              is no time this is the one control that stands in for the rest. */}
          <MetaclaudeCard />

          {/* Credential warning: without this the first run just fails opaquely. */}
          {system && !system.claudeCli.authenticated ? (
            <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft/40 p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 space-y-1 text-[13px] leading-relaxed">
                <p className="font-medium text-ink">{t('Claude is not authenticated.')}</p>
                <p className="text-muted">
                  {t('Pair it from')}{' '}
                  <Link to="/settings" className="font-medium text-accent underline-offset-2 hover:underline">
                    {t('Settings → System')}
                  </Link>
                  {t(
                    ': sign in with your Pro or Max plan, paste back one code, done — no shell, no restart. A token from',
                  )}{' '}
                  <code className="rounded bg-raised px-1 font-mono text-[12px]">{t(
                    'claude setup-token',
                  )}</code>{' '}
                  {t('can be pasted there too.')}
                </p>
              </div>
            </div>
          ) : null}

          {/* The brief: what happened, what needs a human. Owner-only, since
              it embeds the doctor. */}
          {briefQuery.data ? (
            <Card>
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">{t('The brief')}</h2>
                <span className="text-[11.5px] text-subtle">{t('last 24 hours')}</span>
              </div>
              <div className="px-4 py-3">
                <BriefView brief={briefQuery.data} />
              </div>
            </Card>
          ) : null}

          {/* Pending approvals — the only thing that blocks an agent. */}
          {approvals.length > 0 ? (
            <Card className="border-warning/40 bg-warning-soft/25">
              <div className="flex items-center gap-2 border-b border-warning/25 px-4 py-3">
                <ShieldQuestion className="size-4 shrink-0 text-warning" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">
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
                    <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                      {approval.summary}
                    </code>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        variant="ghost"
                        size="xs"
                        // Not `void`: `decideApproval` awaits the HTTP fallback
                        // and throws on any non-2xx, so an unhandled rejection
                        // would leave the operator with a tap that did nothing
                        // and no way to know. The card in the session view
                        // reports failure by re-enabling its buttons; this row
                        // has none to re-enable, so it says so.
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
                          navigate(`/w/${approval.workspaceId}/s/${approval.sessionId}`)
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

          {/* Metrics */}
          {/* The advisor's inbox — proposals waiting on a decision, and the
              button that asks for a fresh analysis. */}
          <AdvisorCard />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={t('Active runs')}
              value={system?.activeRuns ?? 0}
              hint={system?.queuedRuns ? t(
                '{n} queued',
                { n: system.queuedRuns },
              ) : t('Nothing queued')}
              icon={<Cpu />}
              tone={system && system.activeRuns > 0 ? 'success' : undefined}
            />
            <Stat
              label={t('Cost, 7 days')}
              value={formatCost(summary?.totalCostUsd ?? 0)}
              hint={t('{n} runs', { n: summary?.totalRuns ?? 0 })}
              icon={<Coins />}
            />
            <Stat
              label={t('Success rate')}
              value={summary ? formatPercent(summary.successRate) : '—'}
              hint={
                summary?.medianDurationMs
                  ? t('median {d}', { d: formatDuration(summary.medianDurationMs) })
                  : undefined
              }
              icon={<CheckCircle2 />}
              tone={
                summary && summary.totalRuns > 0
                  ? summary.successRate >= 0.8
                    ? 'success'
                    : summary.successRate >= 0.5
                      ? 'warning'
                      : 'danger'
                  : undefined
              }
            />
            <Stat
              label={t('Memories')}
              value={system?.memoryCount ?? 0}
              hint={t(describeRetrieval(system?.retrieval).label)}
              icon={<Brain />}
            />
          </div>

          {/* The machine itself. Below the work it is doing, because the
              question "what is running?" comes before "can the box take it?"
              — and above the history, because it is the only part of this
              screen that can turn into an incident. */}
          <ResourceMeters resources={system?.resources} />

          {/* In-flight work */}
          {activeRuns.length > 0 ? (
            <Card>
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <Activity className="size-4 shrink-0 text-accent" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">{t('In flight')}</h2>
              </div>
              <ul className="divide-y divide-line">
                {activeRuns.map((run) => (
                  <RunRow key={run.id} run={run} live />
                ))}
              </ul>
            </Card>
          ) : null}

          <Grid cols={3} from="lg">
            {/* Workspaces */}
            <Card className="lg:col-span-2">
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-4 shrink-0 text-muted" aria-hidden />
                  <h2 className="text-sm font-semibold text-ink">{t('Workspaces')}</h2>
                </div>
                <Link to="/workspaces" className="text-[12.5px] text-accent hover:underline">
                  {t('View all')}
                </Link>
              </div>

              {workspacesQuery.isLoading ? (
                <div className="flex justify-center py-10">
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
                        to={`/w/${workspace.id}`}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-raised"
                      >
                        <span
                          className="size-8 shrink-0 rounded-lg"
                          style={{ background: workspace.color }}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium text-ink">
                            {workspace.name}
                          </p>
                          <p className="truncate text-[12px] text-muted">
                            {workspace.description || workspace.slug}
                          </p>
                        </div>
                        <span className="shrink-0 text-[11.5px] text-subtle">
                          {formatRelative(workspace.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* What it has been learning */}
            <Card>
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <Zap className="size-4 shrink-0 text-thinking" aria-hidden />
                  <h2 className="text-sm font-semibold text-ink">{t('Recently learned')}</h2>
                </div>
                <Link to="/memory" className="text-[12.5px] text-accent hover:underline">
                  {t('Review')}
                </Link>
              </div>

              {learned.length === 0 ? (
                <EmptyState
                  title={t('Nothing new')}
                  description={t(
                    'After each run, Metaclaude reflects on what happened and records anything worth remembering.',
                  )}
                  className="py-8"
                />
              ) : (
                <ul className="divide-y divide-line">
                  {learned.map((insight) => (
                    <li key={insight.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <Badge tone={INSIGHT_TONE[insight.kind]}>
                          {insight.kind.replace('_', ' ')}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-[13px] leading-snug text-ink">{insight.title}</p>
                      <p className="mt-0.5 text-[11.5px] text-subtle">
                        {formatRelative(insight.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Grid>

          {/* History */}
          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <Timer className="size-4 shrink-0 text-muted" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">{t('Recent runs')}</h2>
              </div>
              <Link to="/analytics" className="text-[12.5px] text-accent hover:underline">
                {t('Analytics')}
              </Link>
            </div>

            {runs.length === 0 ? (
              <EmptyState title={t(
                'No runs yet',
              )} description={t('Start a session to see history here.')} />
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
          </Card>
      </Page>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

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
        to={`/w/${run.workspaceId}/s/${run.sessionId}`}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised"
      >
        <span className={cn('relative shrink-0', live && 'pulse-ring rounded-full')}>
          <Badge tone={tone}>{run.status}</Badge>
        </span>

        <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
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
          <span className="hidden shrink-0 text-[11.5px] tabular-nums text-subtle sm:block">
            {formatCost(run.usage.costUsd)}
          </span>
        ) : null}

        <span className="shrink-0 text-[11.5px] text-subtle">{formatRelative(run.startedAt)}</span>
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
