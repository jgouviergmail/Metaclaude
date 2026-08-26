/**
 * Dashboard — the answer to "what is my agent OS doing right now?".
 *
 * Ordered by urgency rather than by category: anything waiting on a human comes
 * first, then work in flight, then the state of the system, then history.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Badge, Button, Card, EmptyState, Spinner, Stat, Tooltip } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { decideApproval } from '@/lib/approvals';
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

  const activeRuns = runs.filter(
    (run) => run.status === 'running' || run.status === 'waiting_approval' || run.status === 'queued',
  );

  const greeting = `${timeOfDayGreeting()}, ${user?.displayName || user?.username || 'there'}.`;

  return (
    <AppShell>
      <ContentHeader
        title={greeting}
        subtitle={
          system?.claudeCli.authenticated
            ? `Claude CLI ${system.claudeCli.version ?? ''} · ${
                system.claudeCli.authMode === 'subscription' ? 'subscription' : 'API key'
              }`
            : 'No Claude credentials configured'
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
            New workspace
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
          {/* Credential warning: without this the first run just fails opaquely. */}
          {system && !system.claudeCli.authenticated ? (
            <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft/40 p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 space-y-1 text-[13px] leading-relaxed">
                <p className="font-medium text-ink">Claude is not authenticated.</p>
                <p className="text-muted">
                  Run <code className="rounded bg-raised px-1 font-mono text-[12px]">claude setup-token</code>{' '}
                  on a machine where you are signed in with your Pro or Max plan, then set{' '}
                  <code className="rounded bg-raised px-1 font-mono text-[12px]">CLAUDE_CODE_OAUTH_TOKEN</code>{' '}
                  in <code className="rounded bg-raised px-1 font-mono text-[12px]">.env</code> and restart.
                </p>
              </div>
            </div>
          ) : null}

          {/* Pending approvals — the only thing that blocks an agent. */}
          {approvals.length > 0 ? (
            <Card className="border-warning/40 bg-warning-soft/25">
              <div className="flex items-center gap-2 border-b border-warning/25 px-4 py-3">
                <ShieldQuestion className="size-4 shrink-0 text-warning" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">
                  {approvals.length} action{approvals.length === 1 ? '' : 's'} waiting for you
                </h2>
              </div>
              <ul className="divide-y divide-[var(--mc-border)]">
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
                        onClick={() => void decideApproval(approval.id, false)}
                      >
                        Deny
                      </Button>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() =>
                          navigate(`/w/${approval.workspaceId}/s/${approval.sessionId}`)
                        }
                      >
                        Review
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* Metrics */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Active runs"
              value={system?.activeRuns ?? 0}
              hint={system?.queuedRuns ? `${system.queuedRuns} queued` : 'Nothing queued'}
              icon={<Cpu />}
              tone={system && system.activeRuns > 0 ? 'success' : undefined}
            />
            <Stat
              label="Cost, 7 days"
              value={formatCost(summary?.totalCostUsd ?? 0)}
              hint={`${summary?.totalRuns ?? 0} runs`}
              icon={<Coins />}
            />
            <Stat
              label="Success rate"
              value={summary ? formatPercent(summary.successRate) : '—'}
              hint={
                summary?.medianDurationMs
                  ? `median ${formatDuration(summary.medianDurationMs)}`
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
              label="Memories"
              value={system?.memoryCount ?? 0}
              hint={system?.embeddingProvider}
              icon={<Brain />}
            />
          </div>

          {/* In-flight work */}
          {activeRuns.length > 0 ? (
            <Card>
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <Activity className="size-4 shrink-0 text-accent" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">In flight</h2>
              </div>
              <ul className="divide-y divide-[var(--mc-border)]">
                {activeRuns.map((run) => (
                  <RunRow key={run.id} run={run} live />
                ))}
              </ul>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Workspaces */}
            <Card className="lg:col-span-2">
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-4 shrink-0 text-muted" aria-hidden />
                  <h2 className="text-sm font-semibold text-ink">Workspaces</h2>
                </div>
                <Link to="/workspaces" className="text-[12.5px] text-accent hover:underline">
                  View all
                </Link>
              </div>

              {workspacesQuery.isLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner />
                </div>
              ) : workspaces.length === 0 ? (
                <EmptyState
                  icon={<FolderGit2 />}
                  title="No workspaces yet"
                  description="A workspace is a project directory plus the agent policy that applies inside it."
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => createWorkspace.mutate()}
                      loading={createWorkspace.isPending}
                    >
                      <Plus className="size-4" aria-hidden />
                      Create the first one
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-[var(--mc-border)]">
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
                  <h2 className="text-sm font-semibold text-ink">Recently learned</h2>
                </div>
                <Link to="/memory" className="text-[12.5px] text-accent hover:underline">
                  Review
                </Link>
              </div>

              {(insightsQuery.data?.insights ?? []).length === 0 ? (
                <EmptyState
                  title="Nothing new"
                  description="After each run, Metaclaude reflects on what happened and records anything worth remembering."
                  className="py-8"
                />
              ) : (
                <ul className="divide-y divide-[var(--mc-border)]">
                  {insightsQuery.data?.insights.map((insight) => (
                    <li key={insight.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <Badge
                          tone={
                            insight.kind === 'failure'
                              ? 'danger'
                              : insight.kind === 'skill_proposal'
                                ? 'accent'
                                : 'thinking'
                          }
                        >
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
          </div>

          {/* History */}
          <Card>
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <Timer className="size-4 shrink-0 text-muted" aria-hidden />
                <h2 className="text-sm font-semibold text-ink">Recent runs</h2>
              </div>
              <Link to="/analytics" className="text-[12.5px] text-accent hover:underline">
                Analytics
              </Link>
            </div>

            {runs.length === 0 ? (
              <EmptyState title="No runs yet" description="Start a session to see history here." />
            ) : (
              <ul className="divide-y divide-[var(--mc-border)]">
                {runs
                  .filter((run) => !activeRuns.includes(run))
                  .slice(0, 12)
                  .map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function RunRow({ run, live = false }: { run: Run; live?: boolean }) {
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
          <Tooltip content="Model chosen by the learned policy">
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

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
