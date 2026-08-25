/**
 * Analytics — what the system cost, and what it learned from spending it.
 *
 * The top half is descriptive (runs, cost, latency); the bottom half is the
 * learner's own state, laid open. A bandit that cannot be inspected and reset is
 * indistinguishable from superstition, so the posterior for every arm is shown
 * as a number the operator can argue with.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CalendarRange, ChevronDown, Filter, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import type { PolicyArm } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  Stat,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatCost, formatDuration, formatPercent } from '@/lib/utils';

type Granularity = 'hour' | 'day' | 'week';

const PERIODS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

/**
 * Hourly buckets over a week produce 168 points on a chart a few hundred pixels
 * wide — dense enough to read as noise. Day buckets stay legible up to a month;
 * beyond that, weeks.
 */
function granularityFor(days: number): Granularity {
  return days >= 90 ? 'week' : 'day';
}

/* -------------------------------------------------------------------------- */
/* Chart colours                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Recharts writes stroke/fill straight into SVG attributes and never resolves
 * CSS custom properties, so the design tokens are unusable here. These literals
 * are the closest match to the token palette in each theme, kept in one place so
 * the drift stays visible.
 */
interface ChartColors {
  runs: string;
  cost: string;
  success: string;
  grid: string;
  axis: string;
  surface: string;
  border: string;
  ink: string;
}

const CHART_COLORS: Record<'light' | 'dark', ChartColors> = {
  light: {
    runs: '#5b53d6',
    cost: '#8b5cf6',
    success: '#2f9e63',
    grid: '#e5e5ea',
    axis: '#7a7a86',
    surface: '#ffffff',
    border: '#e0e0e6',
    ink: '#1c1c22',
  },
  dark: {
    runs: '#9aa4fb',
    cost: '#c3aefc',
    success: '#5cd196',
    grid: '#33333c',
    axis: '#8d8d99',
    surface: '#2a2a33',
    border: '#3d3d47',
    ink: '#eeeef2',
  },
};

/**
 * The theme lives as a class on `<html>`, toggled by the settings store and by
 * the OS media listener in `App`. Charts have to re-render with new literals
 * when that flips, so the class is observed rather than read once.
 */
function useChartColors(): ChartColors {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark ? CHART_COLORS.dark : CHART_COLORS.light;
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export function AnalyticsPage() {
  const queryClient = useQueryClient();

  const [days, setDays] = useState(30);
  /** `all` or a workspace id. */
  const [scope, setScope] = useState<string>('all');
  const [resetting, setResetting] = useState(false);

  const workspaceId = scope === 'all' ? undefined : scope;
  const granularity = granularityFor(days);
  const colors = useChartColors();

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
    staleTime: 60_000,
  });

  const analyticsQuery = useQuery({
    queryKey: ['analytics', workspaceId ?? null, days, granularity],
    queryFn: () => api.analytics({ ...(workspaceId ? { workspaceId } : {}), days, granularity }),
  });

  const policyQuery = useQuery({
    queryKey: ['policy', workspaceId ?? null],
    queryFn: () => api.policy({ ...(workspaceId ? { workspaceId } : {}) }),
  });

  const resetPolicy = useMutation({
    mutationFn: () =>
      api.resetPolicy({ workspaceId: workspaceId ?? null, includeClassifier: true }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['policy'] });
      toast.success('Learning reset', {
        description: `${result.arms} arms and ${result.exemplars} classifier exemplars discarded. The next runs will explore from scratch.`,
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not reset the policy.'),
  });

  const summary = analyticsQuery.data?.summary;
  const series = analyticsQuery.data?.series ?? [];
  const scopeLabel =
    scope === 'all'
      ? 'All workspaces'
      : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');
  const periodLabel = PERIODS.find((p) => p.days === days)?.label ?? `${days} days`;

  const chartData = series.map((point) => ({
    ...point,
    successPercent: point.successRate * 100,
  }));

  return (
    <AppShell>
      <ContentHeader
        title="Analytics"
        subtitle={`${periodLabel} · ${scopeLabel}`}
        showSidebarToggle={false}
        icon={<Activity />}
        actions={
          <>
            <Menu
              side="bottom"
              align="end"
              trigger={
                <Button variant="ghost" size="sm" aria-label={`Period: ${periodLabel}`}>
                  <CalendarRange className="size-4" />
                  <span className="hidden sm:inline">{periodLabel}</span>
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              }
            >
              <MenuLabel>Period</MenuLabel>
              {PERIODS.map((period) => (
                <MenuItem
                  key={period.days}
                  selected={days === period.days}
                  description={`Bucketed by ${granularityFor(period.days)}`}
                  onSelect={() => setDays(period.days)}
                >
                  {period.label}
                </MenuItem>
              ))}
            </Menu>

            <Menu
              side="bottom"
              align="end"
              trigger={
                <Button variant="ghost" size="sm" aria-label={`Scope: ${scopeLabel}`}>
                  <Filter className="size-4" />
                  <span className="hidden md:inline">{scopeLabel}</span>
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              }
            >
              <MenuLabel>Scope</MenuLabel>
              <MenuItem selected={scope === 'all'} onSelect={() => setScope('all')}>
                All workspaces
              </MenuItem>
              {(workspacesQuery.data?.workspaces.length ?? 0) > 0 ? <MenuSeparator /> : null}
              {workspacesQuery.data?.workspaces.map((workspace) => (
                <MenuItem
                  key={workspace.id}
                  selected={scope === workspace.id}
                  onSelect={() => setScope(workspace.id)}
                  icon={
                    <span
                      className="mt-0.5 block size-3 rounded-[4px]"
                      style={{ background: workspace.color }}
                      aria-hidden
                    />
                  }
                >
                  {workspace.name}
                </MenuItem>
              ))}
            </Menu>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-6 px-3 py-4 sm:px-6 sm:py-6">
          {analyticsQuery.isLoading ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-[92px] rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-64 rounded-xl" />
            </div>
          ) : analyticsQuery.isError ? (
            <Card>
              <EmptyState
                icon={<Activity />}
                title="Analytics could not be loaded"
                description={
                  analyticsQuery.error instanceof ApiError
                    ? analyticsQuery.error.message
                    : 'The server did not answer.'
                }
                action={
                  <Button size="sm" variant="secondary" onClick={() => void analyticsQuery.refetch()}>
                    Try again
                  </Button>
                }
              />
            </Card>
          ) : !summary || summary.totalRuns === 0 ? (
            <Card>
              <EmptyState
                icon={<Activity />}
                title="No runs in this period"
                description={`Nothing was executed in ${scopeLabel.toLowerCase()} over the last ${periodLabel}. Widen the period, or start a session.`}
              />
            </Card>
          ) : (
            <>
              {/* ------------------------------ Stats -------------------------- */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <Stat label="Runs" value={summary.totalRuns.toLocaleString()} />
                <Stat
                  label="Success"
                  value={formatPercent(summary.successRate)}
                  tone={
                    summary.successRate >= 0.8
                      ? 'success'
                      : summary.successRate >= 0.5
                        ? 'warning'
                        : 'danger'
                  }
                />
                <Stat label="Cost" value={formatCost(summary.totalCostUsd)} />
                <Stat
                  label="Median"
                  value={formatDuration(summary.medianDurationMs)}
                  hint="Run duration"
                />
                <Stat
                  label="p95"
                  value={formatDuration(summary.p95DurationMs)}
                  hint="Slowest 1 in 20"
                />
                <Stat
                  label="Avg reward"
                  value={summary.averageReward === null ? '—' : summary.averageReward.toFixed(2)}
                  hint="0–1, what the learner optimises"
                />
              </div>

              {/* ------------------------------ Charts ------------------------- */}
              <div className="grid gap-3 xl:grid-cols-2">
                <ChartFrame
                  id="chart-runs"
                  title="Runs over time"
                  description={`Executions per ${granularity}.`}
                >
                  <AreaChart data={chartData} margin={CHART_MARGIN}>
                    <defs>
                      <linearGradient id="mc-runs-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={colors.runs} stopOpacity={0.45} />
                        <stop offset="100%" stopColor={colors.runs} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      tickFormatter={(value) => formatBucket(Number(value), granularity)}
                      {...axisProps(colors.axis)}
                    />
                    <YAxis allowDecimals={false} width={36} {...axisProps(colors.axis)} />
                    <ChartTooltip
                      {...tooltipProps(colors)}
                      labelFormatter={(label) => formatBucket(Number(label), granularity)}
                    />
                    <Area
                      type="monotone"
                      dataKey="runs"
                      name="Runs"
                      stroke={colors.runs}
                      strokeWidth={2}
                      fill="url(#mc-runs-fill)"
                    />
                  </AreaChart>
                </ChartFrame>

                <ChartFrame
                  id="chart-cost"
                  title="Cost over time"
                  description={`US dollars per ${granularity}.`}
                >
                  <BarChart data={chartData} margin={CHART_MARGIN}>
                    <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      tickFormatter={(value) => formatBucket(Number(value), granularity)}
                      {...axisProps(colors.axis)}
                    />
                    <YAxis
                      width={52}
                      tickFormatter={(value) => formatCost(Number(value))}
                      {...axisProps(colors.axis)}
                    />
                    <ChartTooltip
                      {...tooltipProps(colors)}
                      labelFormatter={(label) => formatBucket(Number(label), granularity)}
                      formatter={(value) => formatCost(Number(value))}
                    />
                    <Bar dataKey="costUsd" name="Cost" fill={colors.cost} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartFrame>

                <ChartFrame
                  id="chart-success"
                  title="Success rate over time"
                  description="Share of runs that finished without error."
                  className="xl:col-span-2"
                >
                  <LineChart data={chartData} margin={CHART_MARGIN}>
                    <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      tickFormatter={(value) => formatBucket(Number(value), granularity)}
                      {...axisProps(colors.axis)}
                    />
                    <YAxis
                      domain={[0, 100]}
                      width={40}
                      tickFormatter={(value) => `${Number(value)}%`}
                      {...axisProps(colors.axis)}
                    />
                    <ChartTooltip
                      {...tooltipProps(colors)}
                      labelFormatter={(label) => formatBucket(Number(label), granularity)}
                      formatter={(value) => `${Number(value).toFixed(0)}%`}
                    />
                    <Line
                      type="monotone"
                      dataKey="successPercent"
                      name="Success rate"
                      stroke={colors.success}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ChartFrame>
              </div>

              {/* ---------------------------- Breakdowns ----------------------- */}
              <div className="grid gap-3 lg:grid-cols-2">
                <Card>
                  <CardHeader
                    title="By model"
                    description="Where the spend and the successes actually went."
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[22rem] text-[13px]">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-subtle">
                          <th className="px-4 py-2 font-semibold">Model</th>
                          <th className="px-4 py-2 text-right font-semibold">Runs</th>
                          <th className="px-4 py-2 text-right font-semibold">Cost</th>
                          <th className="px-4 py-2 text-right font-semibold">Success</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.byModel.map((row) => (
                          <tr key={row.model} className="border-t border-line">
                            <td className="px-4 py-2 font-mono text-[12.5px] text-ink">
                              {row.model}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-muted">
                              {row.runs}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-muted">
                              {formatCost(row.costUsd)}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-muted">
                              {formatPercent(row.successRate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                <Card>
                  <CardHeader
                    title="By category"
                    description="The classifier labels every prompt before it runs, and the learner keeps a separate policy per label — so a category with few runs is simply one it has not had much chance to tune."
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[22rem] text-[13px]">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-subtle">
                          <th className="px-4 py-2 font-semibold">Category</th>
                          <th className="px-4 py-2 text-right font-semibold">Runs</th>
                          <th className="px-4 py-2 text-right font-semibold">Avg reward</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.byCategory.map((row) => (
                          <tr key={row.category} className="border-t border-line">
                            <td className="px-4 py-2 text-ink">{row.category}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-muted">
                              {row.runs}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-muted">
                              {row.averageReward === null ? '—' : row.averageReward.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            </>
          )}

          {/* -------------------------- Learned policy ------------------------ */}
          <section className="space-y-3" aria-labelledby="policy-heading">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h2 id="policy-heading" className="text-sm font-semibold text-ink">
                  Learned policy
                </h2>
                <p className="max-w-2xl text-xs leading-relaxed text-muted">
                  One Beta posterior per (category, model, effort) arm. The posterior mean is the
                  learner's current belief that the arm succeeds; it samples from these rather than
                  always taking the leader, which is why a weaker arm still gets occasional trials.
                </p>
              </div>

              <Button variant="outline" size="sm" onClick={() => setResetting(true)}>
                <RotateCcw className="size-4" />
                Reset learning
              </Button>
            </div>

            {policyQuery.isLoading ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : (policyQuery.data?.categories.length ?? 0) === 0 ? (
              <Card>
                <EmptyState
                  icon={<Activity />}
                  title="Nothing learned yet"
                  description="The bandit starts forming a policy once runs finish and produce a reward."
                />
              </Card>
            ) : (
              <div className="space-y-3">
                {policyQuery.data?.categories.map((category) => (
                  <PolicyCard
                    key={category.category}
                    category={category.category}
                    trials={category.trials}
                    explanation={policyQuery.data.explanations[category.category] ?? ''}
                    arms={policyQuery.data.arms.filter(
                      (arm) => arm.category === category.category,
                    )}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset what the system learned?"
        description={
          <>
            Every policy arm and every classifier exemplar for{' '}
            <span className="font-medium text-ink">{scopeLabel.toLowerCase()}</span> is discarded.
            The system forgets which model and effort worked for which kind of task, and starts
            exploring from nothing. Runs, costs and memories are untouched, and this cannot be
            undone.
          </>
        }
        confirmLabel="Discard learning"
        danger
        onConfirm={async () => {
          await resetPolicy.mutateAsync();
        }}
      />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

function PolicyCard({
  category,
  trials,
  explanation,
  arms,
}: {
  category: string;
  trials: number;
  explanation: string;
  arms: PolicyArm[];
}) {
  // Best-first: the operator's question is almost always "what did it settle on".
  const ordered = [...arms].sort((a, b) => posteriorMean(b) - posteriorMean(a));

  return (
    <Card>
      <CardHeader
        title={category}
        description={explanation || 'No explanation recorded for this category yet.'}
        actions={<Badge tone="neutral">{trials} trials</Badge>}
      />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-subtle">
              <th className="px-4 py-2 font-semibold">Model</th>
              <th className="px-4 py-2 font-semibold">Effort</th>
              <th className="px-4 py-2 text-right font-semibold">Trials</th>
              <th className="px-4 py-2 font-semibold">Posterior mean</th>
              <th className="px-4 py-2 text-right font-semibold">Cost</th>
              <th className="px-4 py-2 text-right font-semibold">Duration</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((arm) => {
              const mean = posteriorMean(arm);
              return (
                <tr key={arm.id} className="border-t border-line">
                  <td className="px-4 py-2 font-mono text-[12.5px] text-ink">{String(arm.model)}</td>
                  <td className="px-4 py-2 text-muted">{arm.effort ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{arm.trials}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-sunken"
                        role="img"
                        aria-label={`Posterior mean ${formatPercent(mean)}`}
                      >
                        <div
                          className={cn(
                            'h-full rounded-full',
                            mean >= 0.7 ? 'bg-success' : mean >= 0.4 ? 'bg-warning' : 'bg-danger',
                          )}
                          style={{ width: `${Math.round(mean * 100)}%` }}
                        />
                      </div>
                      <span className="tabular-nums text-[12px] text-muted">
                        {formatPercent(mean)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">
                    {formatCost(arm.meanCostUsd)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">
                    {formatDuration(arm.meanDurationMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Expected value of Beta(α, β) — the arm's current believed success rate. */
function posteriorMean(arm: PolicyArm): number {
  return arm.alpha / (arm.alpha + arm.beta);
}

/* -------------------------------------------------------------------------- */
/* Chart helpers                                                               */
/* -------------------------------------------------------------------------- */

const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const;

function axisProps(color: string) {
  return {
    stroke: color,
    tick: { fill: color, fontSize: 11 },
    tickLine: false,
    axisLine: false,
    minTickGap: 24,
  } as const;
}

function tooltipProps(colors: ChartColors) {
  return {
    cursor: { fill: colors.grid, fillOpacity: 0.35 },
    contentStyle: {
      background: colors.surface,
      border: `1px solid ${colors.border}`,
      borderRadius: 10,
      fontSize: 12,
      color: colors.ink,
    },
    labelStyle: { color: colors.ink, fontWeight: 600 },
    itemStyle: { color: colors.ink },
  } as const;
}

/** Short axis label for an epoch-ms bucket, at the resolution being shown. */
function formatBucket(bucket: number, granularity: Granularity): string {
  const date = new Date(bucket);
  if (granularity === 'hour') {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A titled, described chart. The `<figure>` takes its accessible name from the
 * caption, which is what gives the SVG inside a name at all.
 */
function ChartFrame({
  id,
  title,
  description,
  className,
  children,
}: {
  id: string;
  title: string;
  description: string;
  className?: string;
  children: React.ReactElement;
}) {
  return (
    <Card className={cn('p-4', className)}>
      <figure aria-labelledby={`${id}-title`} className="space-y-3">
        <figcaption className="space-y-0.5">
          <h3 id={`${id}-title`} className="text-sm font-semibold text-ink">
            {title}
          </h3>
          <p className="text-xs text-muted">{description}</p>
        </figcaption>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        </div>
      </figure>
    </Card>
  );
}

export { AnalyticsPage as default };
