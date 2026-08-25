import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis, } from 'recharts';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton, Stat, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatCost, formatDuration, formatPercent } from '@/lib/utils';
const PERIODS = [
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
];
/**
 * Hourly buckets over a week produce 168 points on a chart a few hundred pixels
 * wide — dense enough to read as noise. Day buckets stay legible up to a month;
 * beyond that, weeks.
 */
function granularityFor(days) {
    return days >= 90 ? 'week' : 'day';
}
const CHART_COLORS = {
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
function useChartColors() {
    const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
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
    const [scope, setScope] = useState('all');
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
        mutationFn: () => api.resetPolicy({ workspaceId: workspaceId ?? null, includeClassifier: true }),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: ['policy'] });
            toast.success('Learning reset', {
                description: `${result.arms} arms and ${result.exemplars} classifier exemplars discarded. The next runs will explore from scratch.`,
            });
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not reset the policy.'),
    });
    const summary = analyticsQuery.data?.summary;
    const series = analyticsQuery.data?.series ?? [];
    const scopeLabel = scope === 'all'
        ? 'All workspaces'
        : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');
    const periodLabel = PERIODS.find((p) => p.days === days)?.label ?? `${days} days`;
    const chartData = series.map((point) => ({
        ...point,
        successPercent: point.successRate * 100,
    }));
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: "Analytics", subtitle: `${periodLabel} · ${scopeLabel}`, showSidebarToggle: false, icon: _jsx(Activity, {}), actions: _jsxs(_Fragment, { children: [_jsxs(Menu, { side: "bottom", align: "end", trigger: _jsxs(Button, { variant: "ghost", size: "sm", "aria-label": `Period: ${periodLabel}`, children: [_jsx(CalendarRange, { className: "size-4" }), _jsx("span", { className: "hidden sm:inline", children: periodLabel }), _jsx(ChevronDown, { className: "size-3.5", "aria-hidden": true })] }), children: [_jsx(MenuLabel, { children: "Period" }), PERIODS.map((period) => (_jsx(MenuItem, { selected: days === period.days, description: `Bucketed by ${granularityFor(period.days)}`, onSelect: () => setDays(period.days), children: period.label }, period.days)))] }), _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsxs(Button, { variant: "ghost", size: "sm", "aria-label": `Scope: ${scopeLabel}`, children: [_jsx(Filter, { className: "size-4" }), _jsx("span", { className: "hidden md:inline", children: scopeLabel }), _jsx(ChevronDown, { className: "size-3.5", "aria-hidden": true })] }), children: [_jsx(MenuLabel, { children: "Scope" }), _jsx(MenuItem, { selected: scope === 'all', onSelect: () => setScope('all'), children: "All workspaces" }), (workspacesQuery.data?.workspaces.length ?? 0) > 0 ? _jsx(MenuSeparator, {}) : null, workspacesQuery.data?.workspaces.map((workspace) => (_jsx(MenuItem, { selected: scope === workspace.id, onSelect: () => setScope(workspace.id), icon: _jsx("span", { className: "mt-0.5 block size-3 rounded-[4px]", style: { background: workspace.color }, "aria-hidden": true }), children: workspace.name }, workspace.id)))] })] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs("div", { className: "mx-auto w-full max-w-6xl space-y-6 px-3 py-4 sm:px-6 sm:py-6", children: [analyticsQuery.isLoading ? (_jsxs("div", { className: "space-y-6", children: [_jsx("div", { className: "grid grid-cols-2 gap-3 lg:grid-cols-6", children: Array.from({ length: 6 }, (_, index) => (_jsx(Skeleton, { className: "h-[92px] rounded-xl" }, index))) }), _jsx(Skeleton, { className: "h-64 rounded-xl" })] })) : analyticsQuery.isError ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Activity, {}), title: "Analytics could not be loaded", description: analyticsQuery.error instanceof ApiError
                                    ? analyticsQuery.error.message
                                    : 'The server did not answer.', action: _jsx(Button, { size: "sm", variant: "secondary", onClick: () => void analyticsQuery.refetch(), children: "Try again" }) }) })) : !summary || summary.totalRuns === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Activity, {}), title: "No runs in this period", description: `Nothing was executed in ${scopeLabel.toLowerCase()} over the last ${periodLabel}. Widen the period, or start a session.` }) })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-2 gap-3 lg:grid-cols-6", children: [_jsx(Stat, { label: "Runs", value: summary.totalRuns.toLocaleString() }), _jsx(Stat, { label: "Success", value: formatPercent(summary.successRate), tone: summary.successRate >= 0.8
                                                ? 'success'
                                                : summary.successRate >= 0.5
                                                    ? 'warning'
                                                    : 'danger' }), _jsx(Stat, { label: "Cost", value: formatCost(summary.totalCostUsd) }), _jsx(Stat, { label: "Median", value: formatDuration(summary.medianDurationMs), hint: "Run duration" }), _jsx(Stat, { label: "p95", value: formatDuration(summary.p95DurationMs), hint: "Slowest 1 in 20" }), _jsx(Stat, { label: "Avg reward", value: summary.averageReward === null ? '—' : summary.averageReward.toFixed(2), hint: "0\u20131, what the learner optimises" })] }), _jsxs("div", { className: "grid gap-3 xl:grid-cols-2", children: [_jsx(ChartFrame, { id: "chart-runs", title: "Runs over time", description: `Executions per ${granularity}.`, children: _jsxs(AreaChart, { data: chartData, margin: CHART_MARGIN, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "mc-runs-fill", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: colors.runs, stopOpacity: 0.45 }), _jsx("stop", { offset: "100%", stopColor: colors.runs, stopOpacity: 0.02 })] }) }), _jsx(CartesianGrid, { stroke: colors.grid, strokeDasharray: "3 3", vertical: false }), _jsx(XAxis, { dataKey: "bucket", tickFormatter: (value) => formatBucket(Number(value), granularity), ...axisProps(colors.axis) }), _jsx(YAxis, { allowDecimals: false, width: 36, ...axisProps(colors.axis) }), _jsx(ChartTooltip, { ...tooltipProps(colors), labelFormatter: (label) => formatBucket(Number(label), granularity) }), _jsx(Area, { type: "monotone", dataKey: "runs", name: "Runs", stroke: colors.runs, strokeWidth: 2, fill: "url(#mc-runs-fill)" })] }) }), _jsx(ChartFrame, { id: "chart-cost", title: "Cost over time", description: `US dollars per ${granularity}.`, children: _jsxs(BarChart, { data: chartData, margin: CHART_MARGIN, children: [_jsx(CartesianGrid, { stroke: colors.grid, strokeDasharray: "3 3", vertical: false }), _jsx(XAxis, { dataKey: "bucket", tickFormatter: (value) => formatBucket(Number(value), granularity), ...axisProps(colors.axis) }), _jsx(YAxis, { width: 52, tickFormatter: (value) => formatCost(Number(value)), ...axisProps(colors.axis) }), _jsx(ChartTooltip, { ...tooltipProps(colors), labelFormatter: (label) => formatBucket(Number(label), granularity), formatter: (value) => formatCost(Number(value)) }), _jsx(Bar, { dataKey: "costUsd", name: "Cost", fill: colors.cost, radius: [3, 3, 0, 0] })] }) }), _jsx(ChartFrame, { id: "chart-success", title: "Success rate over time", description: "Share of runs that finished without error.", className: "xl:col-span-2", children: _jsxs(LineChart, { data: chartData, margin: CHART_MARGIN, children: [_jsx(CartesianGrid, { stroke: colors.grid, strokeDasharray: "3 3", vertical: false }), _jsx(XAxis, { dataKey: "bucket", tickFormatter: (value) => formatBucket(Number(value), granularity), ...axisProps(colors.axis) }), _jsx(YAxis, { domain: [0, 100], width: 40, tickFormatter: (value) => `${Number(value)}%`, ...axisProps(colors.axis) }), _jsx(ChartTooltip, { ...tooltipProps(colors), labelFormatter: (label) => formatBucket(Number(label), granularity), formatter: (value) => `${Number(value).toFixed(0)}%` }), _jsx(Line, { type: "monotone", dataKey: "successPercent", name: "Success rate", stroke: colors.success, strokeWidth: 2, dot: false })] }) })] }), _jsxs("div", { className: "grid gap-3 lg:grid-cols-2", children: [_jsxs(Card, { children: [_jsx(CardHeader, { title: "By model", description: "Where the spend and the successes actually went." }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[22rem] text-[13px]", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-wide text-subtle", children: [_jsx("th", { className: "px-4 py-2 font-semibold", children: "Model" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Runs" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Cost" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Success" })] }) }), _jsx("tbody", { children: summary.byModel.map((row) => (_jsxs("tr", { className: "border-t border-line", children: [_jsx("td", { className: "px-4 py-2 font-mono text-[12.5px] text-ink", children: row.model }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: row.runs }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: formatCost(row.costUsd) }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: formatPercent(row.successRate) })] }, row.model))) })] }) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { title: "By category", description: "The classifier labels every prompt before it runs, and the learner keeps a separate policy per label \u2014 so a category with few runs is simply one it has not had much chance to tune." }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[22rem] text-[13px]", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-wide text-subtle", children: [_jsx("th", { className: "px-4 py-2 font-semibold", children: "Category" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Runs" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Avg reward" })] }) }), _jsx("tbody", { children: summary.byCategory.map((row) => (_jsxs("tr", { className: "border-t border-line", children: [_jsx("td", { className: "px-4 py-2 text-ink", children: row.category }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: row.runs }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: row.averageReward === null ? '—' : row.averageReward.toFixed(2) })] }, row.category))) })] }) })] })] })] })), _jsxs("section", { className: "space-y-3", "aria-labelledby": "policy-heading", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsxs("div", { className: "min-w-0 space-y-1", children: [_jsx("h2", { id: "policy-heading", className: "text-sm font-semibold text-ink", children: "Learned policy" }), _jsx("p", { className: "max-w-2xl text-xs leading-relaxed text-muted", children: "One Beta posterior per (category, model, effort) arm. The posterior mean is the learner's current belief that the arm succeeds; it samples from these rather than always taking the leader, which is why a weaker arm still gets occasional trials." })] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: () => setResetting(true), children: [_jsx(RotateCcw, { className: "size-4" }), "Reset learning"] })] }), policyQuery.isLoading ? (_jsx(Skeleton, { className: "h-40 rounded-xl" })) : (policyQuery.data?.categories.length ?? 0) === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Activity, {}), title: "Nothing learned yet", description: "The bandit starts forming a policy once runs finish and produce a reward." }) })) : (_jsx("div", { className: "space-y-3", children: policyQuery.data?.categories.map((category) => (_jsx(PolicyCard, { category: category.category, trials: category.trials, explanation: policyQuery.data.explanations[category.category] ?? '', arms: policyQuery.data.arms.filter((arm) => arm.category === category.category) }, category.category))) }))] })] }) }), _jsx(ConfirmDialog, { open: resetting, onOpenChange: setResetting, title: "Reset what the system learned?", description: _jsxs(_Fragment, { children: ["Every policy arm and every classifier exemplar for", ' ', _jsx("span", { className: "font-medium text-ink", children: scopeLabel.toLowerCase() }), " is discarded. The system forgets which model and effort worked for which kind of task, and starts exploring from nothing. Runs, costs and memories are untouched, and this cannot be undone."] }), confirmLabel: "Discard learning", danger: true, onConfirm: async () => {
                    await resetPolicy.mutateAsync();
                } })] }));
}
/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */
function PolicyCard({ category, trials, explanation, arms, }) {
    // Best-first: the operator's question is almost always "what did it settle on".
    const ordered = [...arms].sort((a, b) => posteriorMean(b) - posteriorMean(a));
    return (_jsxs(Card, { children: [_jsx(CardHeader, { title: category, description: explanation || 'No explanation recorded for this category yet.', actions: _jsxs(Badge, { tone: "neutral", children: [trials, " trials"] }) }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[34rem] text-[13px]", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-wide text-subtle", children: [_jsx("th", { className: "px-4 py-2 font-semibold", children: "Model" }), _jsx("th", { className: "px-4 py-2 font-semibold", children: "Effort" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Trials" }), _jsx("th", { className: "px-4 py-2 font-semibold", children: "Posterior mean" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Cost" }), _jsx("th", { className: "px-4 py-2 text-right font-semibold", children: "Duration" })] }) }), _jsx("tbody", { children: ordered.map((arm) => {
                                const mean = posteriorMean(arm);
                                return (_jsxs("tr", { className: "border-t border-line", children: [_jsx("td", { className: "px-4 py-2 font-mono text-[12.5px] text-ink", children: String(arm.model) }), _jsx("td", { className: "px-4 py-2 text-muted", children: arm.effort ?? '—' }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: arm.trials }), _jsx("td", { className: "px-4 py-2", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-sunken", role: "img", "aria-label": `Posterior mean ${formatPercent(mean)}`, children: _jsx("div", { className: cn('h-full rounded-full', mean >= 0.7 ? 'bg-success' : mean >= 0.4 ? 'bg-warning' : 'bg-danger'), style: { width: `${Math.round(mean * 100)}%` } }) }), _jsx("span", { className: "tabular-nums text-[12px] text-muted", children: formatPercent(mean) })] }) }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: formatCost(arm.meanCostUsd) }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-muted", children: formatDuration(arm.meanDurationMs) })] }, arm.id));
                            }) })] }) })] }));
}
/** Expected value of Beta(α, β) — the arm's current believed success rate. */
function posteriorMean(arm) {
    return arm.alpha / (arm.alpha + arm.beta);
}
/* -------------------------------------------------------------------------- */
/* Chart helpers                                                               */
/* -------------------------------------------------------------------------- */
const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };
function axisProps(color) {
    return {
        stroke: color,
        tick: { fill: color, fontSize: 11 },
        tickLine: false,
        axisLine: false,
        minTickGap: 24,
    };
}
function tooltipProps(colors) {
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
    };
}
/** Short axis label for an epoch-ms bucket, at the resolution being shown. */
function formatBucket(bucket, granularity) {
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
function ChartFrame({ id, title, description, className, children, }) {
    return (_jsx(Card, { className: cn('p-4', className), children: _jsxs("figure", { "aria-labelledby": `${id}-title`, className: "space-y-3", children: [_jsxs("figcaption", { className: "space-y-0.5", children: [_jsx("h3", { id: `${id}-title`, className: "text-sm font-semibold text-ink", children: title }), _jsx("p", { className: "text-xs text-muted", children: description })] }), _jsx("div", { className: "h-56 w-full", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: children }) })] }) }));
}
export { AnalyticsPage as default };
//# sourceMappingURL=AnalyticsPage.js.map