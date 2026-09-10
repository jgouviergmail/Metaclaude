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
import { lazy, Suspense } from 'react';
import { Check, ChevronDown, Compass, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AdvisorProposal, RevisionPayload } from '@metaclaude/shared';
import { Menu, MenuItem, MenuLabel } from '@/components/ui/Menu';
import { Badge, Button, Card } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { interpolate, usePlural, useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TOUCH_TARGET_TEXT } from '@/components/ui/touch-target';
import { useAuthStore } from '@/lib/store';
import { readRevision } from './revision-payload';

/**
 * The revision card, and the diff renderer behind it, on demand.
 *
 * Imported statically it landed in the entry chunk — the Dashboard is the entry
 * route — and took the whole unified-diff renderer with it: 196 kB gzipped
 * became 198 for a card most dashboards never draw. The `import()` boundary is
 * what derives the chunk here, exactly as `FilesPanel` does for the code
 * editor, and for the same reason: a phone should not download a diff viewer to
 * reach a dashboard with nothing waiting on it.
 */
const RevisionProposalCard = lazy(async () => ({
  default: (await import('./RevisionProposalCard')).RevisionProposalCard,
}));

const KIND_LABELS: Record<AdvisorProposal['kind'], string> = {
  skill: 'skill',
  agent: 'subagent',
  mcp: 'MCP server',
  plugin: 'plugin',
  revision: 'revision',
};

/** Holds the card's place while its chunk arrives, so the list does not jump. */
function CardLoading() {
  const t = useT();
  return (
    <p className="text-caption text-subtle" role="status">
      {t('Loading the proposal…')}
    </p>
  );
}

export function AdvisorCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const plural = usePlural();
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

  /** What to call the workspace a proposal belongs to. */
  const nameOf = (workspaceId: string): string =>
    workspacesQuery.data?.workspaces.find((entry) => entry.id === workspaceId)?.name ?? workspaceId;

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

  /*
   * The revisions already in force, and the way back out of one.
   *
   * A second query rather than a second card, because it is the same inbox
   * seen at a different moment: a revision is the one proposal here that acts
   * the instant it is accepted, so "what did I agree to, and can I undo it"
   * has to be answerable from the same place it was agreed to.
   */
  const appliedQuery = useQuery({
    queryKey: ['advisor-proposals', 'accepted'],
    queryFn: () => api.advisorProposals(undefined, 'accepted'),
    enabled: canAct,
  });

  const revert = useMutation({
    mutationFn: (id: string) => api.revertAdvisorProposal(id),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast.success(t('Put back'), {
        description: t('The text it replaced is in force again.'),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not take that revision back.')),
  });

  if (!canAct) return null;

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const proposals = proposalsQuery.data?.proposals ?? [];
  const busy = accept.isPending || dismiss.isPending || revert.isPending;

  // Split once, so each list is rendered by the component that suits it.
  const revisions = proposals
    .map((proposal) => ({ proposal, payload: readRevision(proposal) }))
    .filter((entry): entry is { proposal: AdvisorProposal; payload: RevisionPayload } => entry.payload !== null);
  const others = proposals.filter((proposal) => proposal.kind !== 'revision');

  // Applied revisions that have not been taken back — the only rows in this
  // inbox where "accepted" still leaves something to decide.
  const applied = (appliedQuery.data?.proposals ?? [])
    .map((proposal) => ({ proposal, payload: readRevision(proposal) }))
    .filter((entry): entry is { proposal: AdvisorProposal; payload: RevisionPayload } => entry.payload !== null)
    .filter((entry) => entry.payload.revertedAt === null);

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 rounded-t-xl border-b border-section-line bg-section px-4 py-3">
        <div className="flex items-center gap-2">
          <Compass className="size-4 text-accent" aria-hidden />
          <h2 className="text-body font-semibold text-ink">{t('The advisor')}</h2>
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
        <p className="px-4 py-3 text-caption leading-relaxed text-muted">
          {t(
            'Nothing waiting. The advisor studies a workspace on request — or daily where you opt in — creates backlog tickets and disabled automations itself, and leaves anything that would act here for your decision.',
          )}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {/*
            A revision is not a row. It rewrites a text already in force, so
            what the operator needs is the diff and the runs behind it, and a
            summary line beside an Accept button would be asking them to
            approve something they cannot see. `RevisionProposalCard` carries
            its own verbs; the generic row below is for the four kinds that
            create something disabled.
          */}
          {revisions.map(({ proposal, payload }) => (
            <li key={proposal.id} className="px-4 py-3">
              <Suspense fallback={<CardLoading />}>
              <RevisionProposalCard
                proposal={proposal}
                payload={payload}
                workspaceName={nameOf(proposal.workspaceId)}
                busy={busy}
                onAccept={() => accept.mutate(proposal.id)}
                onDismiss={() => dismiss.mutate(proposal.id)}
              />
              </Suspense>
            </li>
          ))}
          {others.map((proposal) => (
            <li key={proposal.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-body font-medium text-ink">{proposal.name}</code>
                  <Badge tone="thinking">{t(KIND_LABELS[proposal.kind])}</Badge>
                  <Badge tone="neutral">{nameOf(proposal.workspaceId)}</Badge>
                </div>
                <p className="text-body leading-relaxed text-muted">{proposal.summary}</p>
                <p className="text-caption leading-relaxed text-subtle">{proposal.rationale}</p>
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

      {/*
        Revisions already in force, folded away.
        
        The half that makes accepting one safe. Every other proposal here lands
        disabled, so "accepted" is the end of it; a revision shapes the next run
        of its workspace, and an undo nobody can find is not an undo. Closed by
        default because the ordinary answer is that they are fine — and asserted
        as closed by its own test, since happy-dom does not hide the children of
        a shut `details` and `toBeVisible` would pass on a card that never folds.
      */}
      {applied.length > 0 ? (
        <details className="border-t border-line px-4 py-3">
          <summary className={cn('cursor-pointer text-caption font-medium text-muted', TOUCH_TARGET_TEXT)}>
            {plural(applied.length, 'One revision in force', '{n} revisions in force')}
          </summary>
          <ul className="mt-3 space-y-3">
            {applied.map(({ proposal, payload }) => (
              <li key={proposal.id}>
                <Suspense fallback={<CardLoading />}>
                  <RevisionProposalCard
                    proposal={proposal}
                    payload={payload}
                    workspaceName={nameOf(proposal.workspaceId)}
                    busy={busy}
                    onRevert={() => revert.mutate(proposal.id)}
                  />
                </Suspense>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
