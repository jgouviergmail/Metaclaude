/**
 * The advisor on the dashboard: its inbox, and the button that asks it.
 *
 * The inbox lists proposals that would act the moment they existed — skills,
 * agents, MCP servers, plugins — parked until a person decides. Tickets and
 * disabled automations never pass through here: the advisor creates those
 * directly because they are inert by construction. Rendered only for roles
 * that can actually decide; a viewer would see buttons that only 403.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Compass, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AdvisorProposal } from '@metaclaude/shared';
import { Menu, MenuItem, MenuLabel } from '@/components/ui/Menu';
import { Badge, Button, Card } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { interpolate, useT } from '@/lib/i18n';
import { useAuthStore } from '@/lib/store';

const KIND_LABELS: Record<AdvisorProposal['kind'], string> = {
  skill: 'skill',
  agent: 'subagent',
  mcp: 'MCP server',
  plugin: 'plugin',
};

export function AdvisorCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canAct = user?.role === 'owner' || user?.role === 'operator';

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
    enabled: canAct,
  });
  const proposalsQuery = useQuery({
    queryKey: ['advisor-proposals'],
    queryFn: () => api.advisorProposals(),
    enabled: canAct,
    refetchInterval: 60_000,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['advisor-proposals'] });
  };

  const ask = useMutation({
    mutationFn: (workspaceId: string) => api.askAdvisor(workspaceId),
    onSuccess: (_result, workspaceId) => {
      const name =
        workspacesQuery.data?.workspaces.find((entry) => entry.id === workspaceId)?.name ?? '';
      toast.success(interpolate(t('The advisor is studying “{name}”'), { name }), {
        description: t('Follow the run in its “Advisor” session; proposals land here.'),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not start the advisor.')),
  });

  const accept = useMutation({
    mutationFn: (id: string) => api.acceptAdvisorProposal(id),
    onSuccess: (result) => {
      refresh();
      toast.success(interpolate(t('Accepted “{name}”'), { name: result.proposal.name }), {
        description:
          result.appliedId === null
            ? t('Recorded — the payload names the source to install it from.')
            : t('Created disabled in the registry; enable it when you want runs to see it.'),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not accept that proposal.',
      )),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissAdvisorProposal(id),
    onSuccess: () => refresh(),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not dismiss that proposal.',
      )),
  });

  if (!canAct) return null;

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const proposals = proposalsQuery.data?.proposals ?? [];
  const busy = accept.isPending || dismiss.isPending;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Compass className="size-4 text-accent" aria-hidden />
          <h2 className="text-sm font-semibold text-ink">{t('The advisor')}</h2>
        </div>
        <Menu
          side="bottom"
          align="end"
          trigger={
            <Button variant="secondary" size="sm" loading={ask.isPending} disabled={workspaces.length === 0}>
              {t('Ask the advisor')}
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          }
        >
          <MenuLabel>{t('Which workspace?')}</MenuLabel>
          {workspaces.map((workspace) => (
            <MenuItem key={workspace.id} onSelect={() => ask.mutate(workspace.id)}>
              {workspace.name}
            </MenuItem>
          ))}
        </Menu>
      </div>

      {proposals.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] leading-relaxed text-muted">
          {t(
            'Nothing waiting. The advisor studies a workspace on request — or daily where you opt in — creates backlog tickets and disabled automations itself, and leaves anything that would act here for your decision.',
          )}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[13px] font-medium text-ink">{proposal.name}</code>
                  <Badge tone="thinking">{t(KIND_LABELS[proposal.kind])}</Badge>
                  <Badge tone="neutral">
                    {workspaces.find((entry) => entry.id === proposal.workspaceId)?.name ??
                      proposal.workspaceId}
                  </Badge>
                </div>
                <p className="text-[13px] leading-relaxed text-muted">{proposal.summary}</p>
                <p className="text-[12px] leading-relaxed text-subtle">{proposal.rationale}</p>
              </div>
              <div className="flex items-center gap-2 sm:shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => accept.mutate(proposal.id)}
                  aria-label={interpolate(t('Accept “{name}”'), { name: proposal.name })}
                >
                  <Check className="size-4" aria-hidden />
                  {t('Accept')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => dismiss.mutate(proposal.id)}
                  aria-label={interpolate(t('Dismiss “{name}”'), { name: proposal.name })}
                >
                  <X className="size-4" aria-hidden />
                  {t('Dismiss')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
