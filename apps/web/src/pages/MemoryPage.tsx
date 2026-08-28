/**
 * Memory — the operator's window into what the system has learned.
 *
 * Two ways of finding a memory sit side by side here on purpose. The filter box
 * is a literal substring match over what is stored; the recall box runs the same
 * embedding search the kernel runs before a run, so it answers "what would the
 * agent actually be given for this prompt?". Conflating them would hide the one
 * thing an operator needs to know about a retrieval system.
 *
 * Nothing on this page is automatic: insights are proposals until accepted, and
 * a proposed skill is only installed by an explicit click.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  Check,
  ChevronDown,
  Filter,
  Lightbulb,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { normaliseTags, type Insight, type Memory, type MemoryKind } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { MemoryConstellation } from '@/components/memory/MemoryConstellation';
import { KnowledgeSection } from '@/components/memory/KnowledgeSection';
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
  Spinner,
  Stat,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatPercent, formatRelative } from '@/lib/utils';

type KindFilter = 'all' | MemoryKind;

const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'episodic', label: 'Episodic' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'procedural', label: 'Procedural' },
];

const KIND_TONE: Record<MemoryKind, 'info' | 'accent' | 'thinking'> = {
  episodic: 'info',
  semantic: 'accent',
  procedural: 'thinking',
};

const MAINTENANCE: ReadonlyArray<{
  action: 'decay' | 'collect' | 'reindex';
  label: string;
  explanation: string;
}> = [
  {
    action: 'decay',
    label: 'Decay',
    explanation:
      'Lower the confidence of memories that have not been retrieved recently, so stale facts stop outranking fresh ones. Pinned memories are exempt.',
  },
  {
    action: 'collect',
    label: 'Collect',
    explanation:
      'Delete unpinned memories whose confidence has decayed below the keep threshold. This is the only maintenance action that removes rows.',
  },
  {
    action: 'reindex',
    label: 'Re-index',
    explanation:
      'Recompute every embedding. Needed after switching embedding provider, otherwise semantic recall compares vectors from two different spaces.',
  },
];

const INSIGHT_TONE: Record<Insight['kind'], 'info' | 'accent' | 'danger' | 'success' | 'thinking'> = {
  lesson: 'info',
  pattern: 'accent',
  failure: 'danger',
  preference: 'success',
  skill_proposal: 'thinking',
};

export function MemoryPage() {
  const queryClient = useQueryClient();

  /** `all` = every memory, `global` = unscoped only, anything else = a workspace id. */
  const [scope, setScope] = useState<string>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [recallInput, setRecallInput] = useState('');
  const [recallQuery, setRecallQuery] = useState('');

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);

  // Typing should not fire a request per keystroke; 250ms is below the point
  // where the list feels detached from the box.
  useEffect(() => {
    const timer = window.setTimeout(() => setFilter(filterInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filterInput]);

  const workspaceId = scope === 'all' || scope === 'global' ? undefined : scope;

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
    staleTime: 60_000,
  });

  const memoryQuery = useQuery({
    queryKey: ['memory', scope, kind, filter],
    queryFn: () =>
      api.memory({
        ...(workspaceId ? { workspaceId } : {}),
        ...(scope === 'global' ? { scope: 'global' as const } : {}),
        ...(kind !== 'all' ? { kind } : {}),
        ...(filter ? { search: filter } : {}),
        limit: 200,
      }),
  });

  const recall = useQuery({
    queryKey: ['memory-search', recallQuery, workspaceId ?? null],
    queryFn: () => api.searchMemory(recallQuery, workspaceId),
    enabled: recallQuery.length > 0,
  });

  const insightsQuery = useQuery({
    queryKey: ['insights', 'new', workspaceId ?? null],
    queryFn: () => api.insights({ status: 'new', ...(workspaceId ? { workspaceId } : {}) }),
  });

  /* ------------------------------ Mutations ------------------------------- */

  /** Both lists read the same rows, so any write has to touch both caches. */
  const refreshMemory = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['memory'] });
    void queryClient.invalidateQueries({ queryKey: ['memory-search'] });
  };

  const createMemory = useMutation({
    mutationFn: (draft: MemoryDraft) =>
      api.createMemory({
        workspaceId: workspaceId ?? null,
        kind: draft.kind,
        title: draft.title.trim(),
        content: draft.content.trim(),
        tags: parseTags(draft.tags),
        pinned: draft.pinned,
        confidence: draft.confidence,
      }),
    onSuccess: (result) => {
      refreshMemory();
      setAdding(false);
      // A merge is not a failure, but the operator will look for a new row that
      // is not there unless we say what happened.
      if (result.merged) {
        toast.success('Merged into an existing memory', {
          description: `A near-duplicate of “${result.memory.title}” already existed, so this was folded into it rather than stored twice.`,
        });
      } else {
        toast.success('Memory added');
      }
    },
    onError: (error) => toast.error(messageFor(error, 'Could not save that memory.')),
  });

  const updateMemory = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Memory> }) =>
      api.updateMemory(id, patch),
    onSuccess: () => {
      refreshMemory();
      setEditing(null);
    },
    onError: (error) => toast.error(messageFor(error, 'Could not update that memory.')),
  });

  const deleteMemory = useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => {
      refreshMemory();
      toast.success('Memory deleted');
    },
    onError: (error) => toast.error(messageFor(error, 'Could not delete that memory.')),
  });

  const maintenance = useMutation({
    mutationFn: (action: 'decay' | 'collect' | 'reindex') => api.memoryMaintenance(action),
    onSuccess: (result, action) => {
      refreshMemory();
      toast.success(`${MAINTENANCE.find((m) => m.action === action)?.label ?? action} complete`, {
        description: `${result.affected} ${result.affected === 1 ? 'memory' : 'memories'} affected.`,
      });
    },
    onError: (error) => toast.error(messageFor(error, 'Maintenance failed.')),
  });

  const setInsightStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Insight['status'] }) =>
      api.setInsightStatus(id, status),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success(variables.status === 'accepted' ? 'Insight accepted' : 'Insight rejected');
    },
    onError: (error) => toast.error(messageFor(error, 'Could not update that insight.')),
  });

  const synthesise = useMutation({
    mutationFn: (id: string) => api.synthesiseSkill(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      if (result === undefined) {
        // 204: the model judged the procedures do not cohere — a legitimate
        // answer, reported as such rather than as silence or failure.
        toast.info('Nothing distilled — the procedures do not cohere into one skill yet.');
      } else {
        toast.success('A skill was drafted. Review it below.');
      }
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The synthesis could not run.'),
  });

  const installSkill = useMutation({
    mutationFn: (id: string) => api.installSkillFromInsight(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      toast.success(`Installed “${result.skill.name}”`, {
        description: 'It is now in the skills registry and available to future runs.',
      });
    },
    onError: (error) => toast.error(messageFor(error, 'Could not install that skill.')),
  });

  /* -------------------------------- Render -------------------------------- */

  const stats = memoryQuery.data?.stats;
  const memories = memoryQuery.data?.memories ?? [];
  const insights = insightsQuery.data?.insights ?? [];
  const scopeLabel =
    scope === 'all'
      ? 'All memory'
      : scope === 'global'
        ? 'Global only'
        : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');

  return (
    <AppShell>
      <ContentHeader
        title="Memory"
        subtitle={scopeLabel}
        showSidebarToggle={false}
        icon={<Brain />}
        actions={
          <>
            <Menu
              side="bottom"
              align="end"
              trigger={
                <Button variant="ghost" size="sm" aria-label={`Memory scope: ${scopeLabel}`}>
                  <Filter className="size-4" />
                  <span className="hidden sm:inline">{scopeLabel}</span>
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              }
            >
              <MenuLabel>Scope</MenuLabel>
              <MenuItem selected={scope === 'all'} onSelect={() => setScope('all')}>
                All memory
              </MenuItem>
              <MenuItem
                selected={scope === 'global'}
                description="Memories that apply everywhere"
                onSelect={() => setScope('global')}
              >
                Global only
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

            <Menu
              side="bottom"
              align="end"
              trigger={
                <Button variant="ghost" size="sm" aria-label="Memory maintenance">
                  <Wrench className="size-4" />
                  <span className="hidden md:inline">Maintenance</span>
                </Button>
              }
            >
              <MenuLabel>Maintenance</MenuLabel>
              {MAINTENANCE.map((entry) => (
                <MenuItem
                  key={entry.action}
                  disabled={maintenance.isPending}
                  onSelect={() => maintenance.mutate(entry.action)}
                >
                  {/* The tooltip wraps the label rather than the item: `MenuItem`
                      does not forward the trigger props Radix needs. */}
                  <Tooltip content={entry.explanation} side="left">
                    <span className="inline-block">{entry.label}</span>
                  </Tooltip>
                </MenuItem>
              ))}
            </Menu>

            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              <span className="hidden sm:inline">Add memory</span>
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-3 py-4 sm:px-6 sm:py-6">
          {/* ------------------------------ Stats ---------------------------- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {memoryQuery.isLoading || !stats ? (
              Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-[92px] rounded-xl" />
              ))
            ) : (
              <>
                <Stat label="Total" value={memoryQuery.data?.total ?? 0} icon={<Brain />} />
                <Stat label="Episodic" value={stats.episodic} hint="What happened in a run" />
                <Stat label="Semantic" value={stats.semantic} hint="Durable facts" />
                <Stat label="Procedural" value={stats.procedural} hint="How to do something" />
              </>
            )}
          </div>

          {/* ---------------------------- Retrieval -------------------------- */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="space-y-3 p-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Search className="size-4 text-subtle" aria-hidden />
                  Filter
                </h2>
                <p className="text-xs leading-relaxed text-muted">
                  Plain keyword matching over titles, bodies and tags. It narrows the list below and
                  nothing more.
                </p>
              </div>

              <Input
                id="memory-filter"
                value={filterInput}
                onChange={(event) => setFilterInput(event.target.value)}
                placeholder="e.g. migration, tsconfig, deploy"
                aria-label="Filter memories by keyword"
              />

              <div
                role="group"
                aria-label="Filter by memory kind"
                className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-sunken p-0.5"
              >
                {KIND_FILTERS.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    aria-pressed={kind === entry.value}
                    onClick={() => setKind(entry.value)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
                      kind === entry.value
                        ? 'bg-surface text-ink shadow-[var(--mc-shadow-sm)]'
                        : 'text-muted hover:text-ink',
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </Card>

            {/* Deliberately tinted: this box does something categorically
                different from the one beside it. */}
            <Card className="space-y-3 border-accent/30 bg-accent-soft/30 p-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Sparkles className="size-4 text-accent" aria-hidden />
                  Semantic recall
                </h2>
                <p className="text-xs leading-relaxed text-muted">
                  Runs the same embedding search the agent runs before a prompt. Results are ranked
                  by meaning, not wording — this is what would actually be injected into context.
                </p>
              </div>

              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setRecallQuery(recallInput.trim());
                }}
              >
                <Input
                  id="memory-recall"
                  value={recallInput}
                  onChange={(event) => setRecallInput(event.target.value)}
                  placeholder="Describe a task, as you would to the agent"
                  aria-label="Search memory by meaning"
                  className="bg-surface"
                />
                <Button type="submit" variant="primary" size="md" className="shrink-0">
                  Recall
                </Button>
              </form>

              {recallQuery ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
                      Top matches
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setRecallQuery('');
                        setRecallInput('');
                      }}
                      className="text-[11.5px] text-muted hover:text-ink"
                    >
                      Clear
                    </button>
                  </div>

                  {recall.isLoading ? (
                    <Spinner />
                  ) : (recall.data?.results.length ?? 0) === 0 ? (
                    <p className="text-[13px] text-muted">
                      Nothing scored high enough. The agent would run this prompt with no recalled
                      memory.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {recall.data?.results.map((result) => (
                        <li
                          key={result.memory.id}
                          className="flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-2"
                        >
                          <span
                            className="mt-0.5 shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-accent"
                            aria-label={`Similarity score ${result.score.toFixed(2)}`}
                          >
                            {result.score.toFixed(2)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">
                              {result.memory.title}
                            </span>
                            <span className="mt-0.5 block text-[11.5px] text-muted">
                              {result.memory.kind} · confidence{' '}
                              {formatPercent(result.memory.confidence)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </Card>
          </div>

          {/* ----------------------------- The list -------------------------- */}
          <section className="space-y-3" aria-labelledby="memory-list-heading">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="memory-list-heading" className="text-sm font-semibold text-ink">
                Stored memories
              </h2>
              <p className="text-xs tabular-nums text-muted">
                {memories.length} shown
                {memoryQuery.data && memoryQuery.data.total > memories.length
                  ? ` of ${memoryQuery.data.total}`
                  : ''}
              </p>
            </div>

            {memoryQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }, (_, index) => (
                  <Skeleton key={index} className="h-32 rounded-xl" />
                ))}
              </div>
            ) : memoryQuery.isError ? (
              <Card>
                <EmptyState
                  icon={<Brain />}
                  title="Memory could not be loaded"
                  description={messageFor(memoryQuery.error, 'The server did not answer.')}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void memoryQuery.refetch()}>
                      Try again
                    </Button>
                  }
                />
              </Card>
            ) : memories.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Brain />}
                  title={filter || kind !== 'all' ? 'Nothing matches those filters' : 'No memories yet'}
                  description={
                    filter || kind !== 'all'
                      ? 'Try a broader kind, or clear the keyword filter.'
                      : 'Memories accumulate as runs finish and the reflexion pass distils them. You can also write one yourself.'
                  }
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                      <Plus className="size-4" />
                      Add memory
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="space-y-3">
                {/* The sky above the shelves: tap a star to land on its card. */}
                <Card className="p-3">
                  <MemoryConstellation
                    memories={memories}
                    onSelect={(id) => {
                      const card = document.getElementById(`memory-${id}`);
                      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      card?.classList.add('memory-flash');
                      window.setTimeout(() => card?.classList.remove('memory-flash'), 1600);
                    }}
                  />
                </Card>
                {memories.map((memory) => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
                    onTogglePin={() =>
                      updateMemory.mutate({ id: memory.id, patch: { pinned: !memory.pinned } })
                    }
                    onEdit={() => setEditing(memory)}
                    onDelete={() => setDeleting(memory)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ----------------------------- Insights -------------------------- */}
          <section className="space-y-3" aria-labelledby="insights-heading">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="space-y-1">
                <h2
                  id="insights-heading"
                  className="flex items-center gap-2 text-sm font-semibold text-ink"
                >
                  <Lightbulb className="size-4 text-warning" aria-hidden />
                  Insights awaiting review
                </h2>
                <p className="text-xs leading-relaxed text-muted">
                  Distilled by the reflexion pass after a run. Proposals are never installed
                  automatically — nothing here changes the agent's behaviour until you accept it.
                </p>
              </div>
              {workspaceId ? (
                <Tooltip content="Read this workspace's accumulated procedures and, if they cohere, draft one skill — as a proposal below, never installed directly.">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={synthesise.isPending}
                    onClick={() => synthesise.mutate(workspaceId)}
                  >
                    <Sparkles className="size-4" aria-hidden />
                    Distil a skill
                  </Button>
                </Tooltip>
              ) : null}
            </div>

            {insightsQuery.isLoading ? (
              <Skeleton className="h-24 rounded-xl" />
            ) : insights.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Lightbulb />}
                  title="Nothing waiting"
                  description="New lessons appear here as runs complete."
                />
              </Card>
            ) : (
              <div className="space-y-3">
                {insights.map((insight) => (
                  <Card key={insight.id} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={INSIGHT_TONE[insight.kind]}>
                        {insight.kind.replace('_', ' ')}
                      </Badge>
                      <span className="text-[11.5px] text-muted">
                        confidence {formatPercent(insight.confidence)}
                      </span>
                      <span className="text-[11.5px] text-subtle">
                        {formatRelative(insight.createdAt)}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <h3 className="text-[13.5px] font-medium text-ink">{insight.title}</h3>
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">
                        {insight.body}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="success"
                        onClick={() =>
                          setInsightStatus.mutate({ id: insight.id, status: 'accepted' })
                        }
                        loading={
                          setInsightStatus.isPending &&
                          setInsightStatus.variables?.id === insight.id &&
                          setInsightStatus.variables.status === 'accepted'
                        }
                      >
                        <Check className="size-4" />
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setInsightStatus.mutate({ id: insight.id, status: 'rejected' })
                        }
                      >
                        <X className="size-4" />
                        Reject
                      </Button>
                      {insight.kind === 'skill_proposal' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => installSkill.mutate(insight.id)}
                          loading={installSkill.isPending && installSkill.variables === insight.id}
                        >
                          <Sparkles className="size-4" />
                          Install skill
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <KnowledgeSection scope={scope} workspaces={workspacesQuery.data?.workspaces ?? []} />
        </div>
      </div>

      {/* -------------------------------- Modals -------------------------------- */}

      <MemoryModal
        open={adding}
        onOpenChange={setAdding}
        title="Add a memory"
        description="Written straight into long-term memory and eligible for retrieval on the next run."
        confirmLabel="Add memory"
        busy={createMemory.isPending}
        onSubmit={(draft) => createMemory.mutate(draft)}
      />

      <MemoryModal
        key={editing?.id ?? 'edit'}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit memory"
        description="Corrections take effect immediately; the embedding is recomputed on save."
        confirmLabel="Save changes"
        busy={updateMemory.isPending}
        initial={editing ? draftFrom(editing) : undefined}
        onSubmit={(draft) => {
          if (!editing) return;
          updateMemory.mutate({
            id: editing.id,
            patch: {
              kind: draft.kind,
              title: draft.title.trim(),
              content: draft.content.trim(),
              tags: parseTags(draft.tags),
              pinned: draft.pinned,
              confidence: draft.confidence,
            },
          });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this memory?"
        description={
          <>
            <span className="font-medium text-ink">{deleting?.title}</span> is removed permanently
            and will no longer be retrieved into any run.
          </>
        }
        confirmLabel="Delete memory"
        danger
        onConfirm={async () => {
          if (deleting) await deleteMemory.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Memory card                                                                 */
/* -------------------------------------------------------------------------- */

function MemoryCard({
  memory,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  memory: Memory;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card id={`memory-${memory.id}`} className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[memory.kind]}>{memory.kind}</Badge>
            {memory.pinned ? <Badge tone="warning">pinned</Badge> : null}
            <h3 className="min-w-0 text-[13.5px] font-medium text-ink">{memory.title}</h3>
          </div>

          <ConfidenceBar value={memory.confidence} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content={memory.pinned ? 'Unpin — allow decay' : 'Pin — never decay or collect'}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onTogglePin}
              aria-pressed={memory.pinned}
              aria-label={memory.pinned ? `Unpin ${memory.title}` : `Pin ${memory.title}`}
              className={cn(memory.pinned && 'text-warning')}
            >
              <Pin className="size-4" />
            </Button>
          </Tooltip>

          <Menu
            side="bottom"
            align="end"
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${memory.title}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            }
          >
            <MenuItem icon={<Pencil />} onSelect={onEdit}>
              Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
              Delete
            </MenuItem>
          </Menu>
        </div>
      </div>

      <p
        className={cn(
          'mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-muted',
          !expanded && 'line-clamp-3',
        )}
      >
        {memory.content}
      </p>

      {memory.content.length > 180 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="mt-1 text-[12px] font-medium text-accent hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3 text-[11.5px] text-subtle">
        {memory.tags.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {memory.tags.map((tag) => (
              <span key={tag} className="rounded bg-sunken px-1.5 py-0.5 text-muted">
                #{tag}
              </span>
            ))}
          </span>
        ) : null}

        <span className="tabular-nums">
          used {memory.useCount}× · {memory.successCount} succeeded
        </span>
        <span>updated {formatRelative(memory.updatedAt)}</span>
      </div>
    </Card>
  );
}

/** 0–1 confidence, with the colour thresholds the decay job also uses. */
function ConfidenceBar({ value }: { value: number }) {
  const tone = value >= 0.7 ? 'bg-success' : value >= 0.4 ? 'bg-warning' : 'bg-danger';

  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-20 overflow-hidden rounded-full bg-sunken"
        role="img"
        aria-label={`Confidence ${formatPercent(value)}`}
      >
        <div
          className={cn('h-full rounded-full transition-[width]', tone)}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-muted">{formatPercent(value)}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

interface MemoryDraft {
  kind: MemoryKind;
  title: string;
  content: string;
  /** Raw comma-separated text; split only on submit so commas can be typed. */
  tags: string;
  pinned: boolean;
  confidence: number;
}

const EMPTY_DRAFT: MemoryDraft = {
  kind: 'semantic',
  title: '',
  content: '',
  tags: '',
  pinned: false,
  confidence: 0.7,
};

function draftFrom(memory: Memory): MemoryDraft {
  return {
    kind: memory.kind,
    title: memory.title,
    content: memory.content,
    tags: memory.tags.join(', '),
    pinned: memory.pinned,
    confidence: memory.confidence,
  };
}

/**
 * Split the comma-separated field, then hand the result to the shared rule —
 * the same one the store applies on write. Two copies of "what a tag looks
 * like" is how `Bail` and `bail` came to coexist.
 */
function parseTags(raw: string): string[] {
  return normaliseTags(raw.split(','));
}

function MemoryModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  initial?: MemoryDraft;
  onSubmit: (draft: MemoryDraft) => void;
}) {
  const [draft, setDraft] = useState<MemoryDraft>(initial ?? EMPTY_DRAFT);
  const valid = draft.title.trim().length > 0 && draft.content.trim().length > 0;

  // Reopening the add dialog should start clean; the edit dialog is remounted
  // per memory by its key, so its initial value is already correct.
  useEffect(() => {
    if (open && !initial) setDraft(EMPTY_DRAFT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!valid}
            onClick={() => onSubmit(draft)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Label htmlFor="memory-kind" hint="Chooses how the retriever weights this against a prompt.">
          Kind
          <select
            id="memory-kind"
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryKind })}
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="episodic">Episodic — what happened in a run</option>
            <option value="semantic">Semantic — a durable fact</option>
            <option value="procedural">Procedural — how to do something</option>
          </select>
        </Label>

        <Label htmlFor="memory-title" hint="The retrieval key. One sentence works best.">
          Title
          <Input
            id="memory-title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="Prefer pnpm over npm in this repo"
            className="mt-1.5"
            maxLength={300}
          />
        </Label>

        <Label htmlFor="memory-content" hint="Injected verbatim into the system prompt when recalled.">
          Content
          <Textarea
            id="memory-content"
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            rows={7}
            className="mt-1.5"
            maxLength={20_000}
          />
        </Label>

        <Label htmlFor="memory-tags" hint="Comma separated.">
          Tags
          <Input
            id="memory-tags"
            value={draft.tags}
            onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
            placeholder="tooling, conventions"
            className="mt-1.5"
          />
        </Label>

        <Label
          htmlFor="memory-confidence"
          hint="How much the retriever should trust this. Reinforced when runs that used it succeed."
        >
          Confidence — {formatPercent(draft.confidence)}
          <input
            id="memory-confidence"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.confidence}
            onChange={(event) => setDraft({ ...draft, confidence: Number(event.target.value) })}
            className="mt-1.5 w-full accent-[var(--mc-accent)]"
          />
        </Label>

        <label className="flex items-start gap-2.5 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={draft.pinned}
            onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
            className="mt-0.5 size-4 accent-[var(--mc-accent)]"
          />
          <span>
            Pinned
            <span className="mt-0.5 block text-xs text-muted">
              Exempt from decay and garbage collection.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export { MemoryPage as default };
