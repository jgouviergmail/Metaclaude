import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Dashboard — the answer to "what is my agent OS doing right now?".
 *
 * Ordered by urgency rather than by category: anything waiting on a human comes
 * first, then work in flight, then the state of the system, then history.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Brain, CheckCircle2, Coins, Cpu, FolderGit2, Plus, ShieldQuestion, Timer, Zap, } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Badge, Button, Card, EmptyState, Spinner, Stat, Tooltip } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useAuthStore } from '@/lib/store';
import { cn, formatCost, formatDuration, formatRelative, formatPercent } from '@/lib/utils';
export function DashboardPage() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const user = useAuthStore((state) => state.user);
    const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => api.workspaces() });
    const systemQuery = useQuery({
        queryKey: ['system'],
        queryFn: () => api.system(),
        // Uptime and disk are not pushed over the socket, so this one polls — but
        // slowly, since none of it changes fast.
        refetchInterval: 60_000,
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
        queryFn: () => api.insights({ status: 'new', limit: 5 }),
    });
    const createWorkspace = useMutation({
        mutationFn: () => api.createWorkspace({ name: 'New workspace' }),
        onSuccess: (data) => {
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            navigate(`/w/${data.workspace.id}`);
        },
        onError: () => toast.error('Could not create the workspace.'),
    });
    const workspaces = workspacesQuery.data?.workspaces ?? [];
    const runs = runsQuery.data?.runs ?? [];
    const approvals = approvalsQuery.data?.approvals ?? [];
    const summary = analyticsQuery.data?.summary;
    const system = systemQuery.data;
    const activeRuns = runs.filter((run) => run.status === 'running' || run.status === 'waiting_approval' || run.status === 'queued');
    const greeting = `${timeOfDayGreeting()}, ${user?.displayName || user?.username || 'there'}.`;
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: greeting, subtitle: system?.claudeCli.authenticated
                    ? `Claude CLI ${system.claudeCli.version ?? ''} · ${system.claudeCli.authMode === 'subscription' ? 'subscription' : 'API key'}`
                    : 'No Claude credentials configured', showSidebarToggle: false, actions: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => createWorkspace.mutate(), loading: createWorkspace.isPending, children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "New workspace"] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs("div", { className: "mx-auto max-w-6xl space-y-6 p-4 sm:p-6", children: [system && !system.claudeCli.authenticated ? (_jsxs("div", { className: "flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft/40 p-4", children: [_jsx(AlertTriangle, { className: "mt-0.5 size-5 shrink-0 text-warning", "aria-hidden": true }), _jsxs("div", { className: "min-w-0 space-y-1 text-[13px] leading-relaxed", children: [_jsx("p", { className: "font-medium text-ink", children: "Claude is not authenticated." }), _jsxs("p", { className: "text-muted", children: ["Run ", _jsx("code", { className: "rounded bg-raised px-1 font-mono text-[12px]", children: "claude setup-token" }), ' ', "on a machine where you are signed in with your Pro or Max plan, then set", ' ', _jsx("code", { className: "rounded bg-raised px-1 font-mono text-[12px]", children: "CLAUDE_CODE_OAUTH_TOKEN" }), ' ', "in ", _jsx("code", { className: "rounded bg-raised px-1 font-mono text-[12px]", children: ".env" }), " and restart."] })] })] })) : null, approvals.length > 0 ? (_jsxs(Card, { className: "border-warning/40 bg-warning-soft/25", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-warning/25 px-4 py-3", children: [_jsx(ShieldQuestion, { className: "size-4 shrink-0 text-warning", "aria-hidden": true }), _jsxs("h2", { className: "text-sm font-semibold text-ink", children: [approvals.length, " action", approvals.length === 1 ? '' : 's', " waiting for you"] })] }), _jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: approvals.map((approval) => (_jsxs("li", { className: "flex items-center gap-3 px-4 py-2.5", children: [_jsx(Badge, { tone: approval.risk === 'high' ? 'danger' : 'warning', children: approval.risk }), _jsx("code", { className: "min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink", children: approval.summary }), _jsxs("div", { className: "flex shrink-0 gap-1.5", children: [_jsx(Button, { variant: "ghost", size: "xs", onClick: () => socket.approve(approval.id, false), children: "Deny" }), _jsx(Button, { variant: "secondary", size: "xs", onClick: () => navigate(`/w/${approval.workspaceId}/s/${approval.sessionId}`), children: "Review" })] })] }, approval.id))) })] })) : null, _jsxs("div", { className: "grid grid-cols-2 gap-3 lg:grid-cols-4", children: [_jsx(Stat, { label: "Active runs", value: system?.activeRuns ?? 0, hint: system?.queuedRuns ? `${system.queuedRuns} queued` : 'Nothing queued', icon: _jsx(Cpu, {}), tone: system && system.activeRuns > 0 ? 'success' : undefined }), _jsx(Stat, { label: "Cost, 7 days", value: formatCost(summary?.totalCostUsd ?? 0), hint: `${summary?.totalRuns ?? 0} runs`, icon: _jsx(Coins, {}) }), _jsx(Stat, { label: "Success rate", value: summary ? formatPercent(summary.successRate) : '—', hint: summary?.medianDurationMs
                                        ? `median ${formatDuration(summary.medianDurationMs)}`
                                        : undefined, icon: _jsx(CheckCircle2, {}), tone: summary && summary.totalRuns > 0
                                        ? summary.successRate >= 0.8
                                            ? 'success'
                                            : summary.successRate >= 0.5
                                                ? 'warning'
                                                : 'danger'
                                        : undefined }), _jsx(Stat, { label: "Memories", value: system?.memoryCount ?? 0, hint: system?.embeddingProvider, icon: _jsx(Brain, {}) })] }), activeRuns.length > 0 ? (_jsxs(Card, { children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-line px-4 py-3", children: [_jsx(Activity, { className: "size-4 shrink-0 text-accent", "aria-hidden": true }), _jsx("h2", { className: "text-sm font-semibold text-ink", children: "In flight" })] }), _jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: activeRuns.map((run) => (_jsx(RunRow, { run: run, live: true }, run.id))) })] })) : null, _jsxs("div", { className: "grid gap-4 lg:grid-cols-3", children: [_jsxs(Card, { className: "lg:col-span-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-2 border-b border-line px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(FolderGit2, { className: "size-4 shrink-0 text-muted", "aria-hidden": true }), _jsx("h2", { className: "text-sm font-semibold text-ink", children: "Workspaces" })] }), _jsx(Link, { to: "/workspaces", className: "text-[12.5px] text-accent hover:underline", children: "View all" })] }), workspacesQuery.isLoading ? (_jsx("div", { className: "flex justify-center py-10", children: _jsx(Spinner, {}) })) : workspaces.length === 0 ? (_jsx(EmptyState, { icon: _jsx(FolderGit2, {}), title: "No workspaces yet", description: "A workspace is a project directory plus the agent policy that applies inside it.", action: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => createWorkspace.mutate(), loading: createWorkspace.isPending, children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "Create the first one"] }) })) : (_jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: workspaces.slice(0, 6).map((workspace) => (_jsx("li", { children: _jsxs(Link, { to: `/w/${workspace.id}`, className: "flex items-center gap-3 px-4 py-3 hover:bg-raised", children: [_jsx("span", { className: "size-8 shrink-0 rounded-lg", style: { background: workspace.color }, "aria-hidden": true }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "truncate text-[13.5px] font-medium text-ink", children: workspace.name }), _jsx("p", { className: "truncate text-[12px] text-muted", children: workspace.description || workspace.slug })] }), _jsx("span", { className: "shrink-0 text-[11.5px] text-subtle", children: formatRelative(workspace.updatedAt) })] }) }, workspace.id))) }))] }), _jsxs(Card, { children: [_jsxs("div", { className: "flex items-center justify-between gap-2 border-b border-line px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Zap, { className: "size-4 shrink-0 text-thinking", "aria-hidden": true }), _jsx("h2", { className: "text-sm font-semibold text-ink", children: "Recently learned" })] }), _jsx(Link, { to: "/memory", className: "text-[12.5px] text-accent hover:underline", children: "Review" })] }), (insightsQuery.data?.insights ?? []).length === 0 ? (_jsx(EmptyState, { title: "Nothing new", description: "After each run, Metaclaude reflects on what happened and records anything worth remembering.", className: "py-8" })) : (_jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: insightsQuery.data?.insights.map((insight) => (_jsxs("li", { className: "px-4 py-3", children: [_jsx("div", { className: "flex items-start gap-2", children: _jsx(Badge, { tone: insight.kind === 'failure'
                                                                ? 'danger'
                                                                : insight.kind === 'skill_proposal'
                                                                    ? 'accent'
                                                                    : 'thinking', children: insight.kind.replace('_', ' ') }) }), _jsx("p", { className: "mt-1.5 text-[13px] leading-snug text-ink", children: insight.title }), _jsx("p", { className: "mt-0.5 text-[11.5px] text-subtle", children: formatRelative(insight.createdAt) })] }, insight.id))) }))] })] }), _jsxs(Card, { children: [_jsxs("div", { className: "flex items-center justify-between gap-2 border-b border-line px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Timer, { className: "size-4 shrink-0 text-muted", "aria-hidden": true }), _jsx("h2", { className: "text-sm font-semibold text-ink", children: "Recent runs" })] }), _jsx(Link, { to: "/analytics", className: "text-[12.5px] text-accent hover:underline", children: "Analytics" })] }), runs.length === 0 ? (_jsx(EmptyState, { title: "No runs yet", description: "Start a session to see history here." })) : (_jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: runs
                                        .filter((run) => !activeRuns.includes(run))
                                        .slice(0, 12)
                                        .map((run) => (_jsx(RunRow, { run: run }, run.id))) }))] })] }) })] }));
}
/* -------------------------------------------------------------------------- */
function RunRow({ run, live = false }) {
    const tone = run.status === 'succeeded'
        ? 'success'
        : run.status === 'failed'
            ? 'danger'
            : run.status === 'interrupted'
                ? 'warning'
                : 'accent';
    return (_jsx("li", { children: _jsxs(Link, { to: `/w/${run.workspaceId}/s/${run.sessionId}`, className: "flex items-center gap-3 px-4 py-2.5 hover:bg-raised", children: [_jsx("span", { className: cn('relative shrink-0', live && 'pulse-ring rounded-full'), children: _jsx(Badge, { tone: tone, children: run.status }) }), _jsx("p", { className: "min-w-0 flex-1 truncate text-[13px] text-ink", children: run.prompt.split('\n')[0] }), run.policy.source === 'learned' ? (_jsx(Tooltip, { content: "Model chosen by the learned policy", children: _jsx("span", { className: "hidden shrink-0 sm:block", children: _jsxs(Badge, { tone: "thinking", children: [_jsx(Brain, { className: "size-2.5", "aria-hidden": true }), String(run.policy.model)] }) }) })) : null, run.usage.costUsd > 0 ? (_jsx("span", { className: "hidden shrink-0 text-[11.5px] tabular-nums text-subtle sm:block", children: formatCost(run.usage.costUsd) })) : null, _jsx("span", { className: "shrink-0 text-[11.5px] text-subtle", children: formatRelative(run.startedAt) })] }) }));
}
function timeOfDayGreeting() {
    const hour = new Date().getHours();
    if (hour < 5)
        return 'Still up';
    if (hour < 12)
        return 'Good morning';
    if (hour < 18)
        return 'Good afternoon';
    return 'Good evening';
}
//# sourceMappingURL=DashboardPage.js.map