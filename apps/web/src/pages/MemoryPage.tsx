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
  Archive,
  Brain,
  Layers,
  RotateCcw,
  Check,
  ChevronDown,
  Filter,
  Folder,
  Globe,
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
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  normaliseTags,
  ReflexionInsightPayload,
  type GateOutcome,
  type Insight,
  type Memory,
  type MemoryKind,
  type MemoryShelf,
  type Workspace,
} from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { RetrievalStatus } from '@/components/system/RetrievalStatus';
import { MemoryConstellation } from '@/components/memory/MemoryConstellation';
import { KnowledgeSection } from '@/components/memory/KnowledgeSection';
import { ConsolidationCard, readProposal } from '@/components/memory/ConsolidationCard';
import { ScopeBadge, scopeName } from '@/components/memory/ScopeBadge';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Meter,
  Skeleton,
  Spinner,
  Stat,
  Textarea,
  Tooltip,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { INSIGHT_TONE } from '@/lib/insights';
import { cn, formatPercent, formatRelative } from '@/lib/utils';
import { usePlural, useT } from '@/lib/i18n';
import { describeRetrieval } from '@/lib/retrieval';

type KindFilter = 'all' | MemoryKind;

const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'episodic', label: 'Episodic' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'procedural', label: 'Procedural' },
];

type ShelfFilter = 'all' | MemoryShelf;

/** Copy for the shelf, translated at the render site. */
const SHELF_LABELS: Record<MemoryShelf, string> = {
  standing: 'Standing',
  durable: 'Durable',
  volatile: 'Volatile',
};
const SHELF_HINTS: Record<MemoryShelf, string> = {
  standing: 'Standing — a convention, injected into every run of its scope',
  durable: 'Durable — recalled by relevance, forgotten slowly',
  volatile: 'Volatile — a fact that can stop being true, forgotten three times faster',
};
const SHELF_TONE: Record<MemoryShelf, 'accent' | 'neutral' | 'thinking'> = {
  standing: 'accent',
  durable: 'neutral',
  volatile: 'thinking',
};
const OUTCOME_TONE: Record<GateOutcome, 'success' | 'info' | 'neutral' | 'warning'> = {
  kept: 'success',
  superseded: 'info',
  skipped: 'neutral',
  'over-budget': 'warning',
  unjudged: 'warning',
};
/** A refused note is one the operator may still keep. */
const REFUSED: ReadonlySet<GateOutcome> = new Set(['skipped', 'over-budget', 'unjudged']);

/** The gate's decisions carried by a reflexion insight, or null when the payload is not that. */
export function readDecisions(payload: string | null): ReflexionInsightPayload | null {
  if (!payload) return null;
  try {
    const parsed = ReflexionInsightPayload.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const KIND_TONE: Record<MemoryKind, 'info' | 'accent' | 'thinking'> = {
  episodic: 'info',
  semantic: 'accent',
  procedural: 'thinking',
};

const MAINTENANCE: ReadonlyArray<{
  action: 'decay' | 'collect' | 'reindex' | 'consolidate';
  label: string;
  explanation: string;
}> = [
  {
    action: 'consolidate',
    label: 'Consolidate',
    explanation:
      'Look for memories that repeat one another, or that contradict one another, and file what is found below for review. Nothing is merged without you.',
  },
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
      'Recompute every vector — memories, documents and the classifier’s examples — with the embedder in force. It runs by itself after a change of provider; press it if the page still says vectors are waiting.',
  },
];

/** The label a maintenance action is announced by. One table, one spelling. */
function labelFor(action: (typeof MAINTENANCE)[number]['action']): string {
  return MAINTENANCE.find((entry) => entry.action === action)?.label ?? action;
}

export interface MemoryTier {
  /** `null` is the global tier. */
  workspaceId: string | null;
  name: string;
  memories: Memory[];
}

/**
 * Split the list into the tiers it has always contained.
 *
 * `GET /api/memory` for a workspace answers with that workspace's memories
 * *and* every global one, because that union is exactly what a run there is
 * given — and it is sorted by pinned, then confidence, which interleaves the
 * two so thoroughly that the page read as one undifferentiated pile. The list
 * is right; only its shape was wrong.
 *
 * Global first, always: it is the tier whose contents reach everywhere, and
 * the one an operator is least likely to expect to find in a workspace's list.
 * The rest go alphabetically, because any other order is a fact about the sort
 * above rather than about the workspaces.
 */
export function tiersOf(
  memories: readonly Memory[],
  workspaces: readonly Workspace[],
  t: (key: string) => string,
): MemoryTier[] {
  const byScope = new Map<string | null, Memory[]>();
  for (const memory of memories) {
    const bucket = byScope.get(memory.workspaceId);
    if (bucket) bucket.push(memory);
    else byScope.set(memory.workspaceId, [memory]);
  }

  const tiers: MemoryTier[] = [];
  const globals = byScope.get(null);
  if (globals) tiers.push({ workspaceId: null, name: t('Global'), memories: globals });

  const scoped = [...byScope.entries()]
    .filter((entry): entry is [string, Memory[]] => entry[0] !== null)
    .map(([workspaceId, rows]) => ({
      workspaceId,
      name: scopeName(workspaceId, workspaces, t),
      memories: rows,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...tiers, ...scoped];
}

/**
 * The session a memory was learned in, or null.
 *
 * A run is read inside its session — there is no page for one on its own —
 * so the link needs both ids, which the list response carries beside the
 * memories. A run past its retention window has no entry, and no link.
 */
function sourceHrefOf(
  memory: Memory,
  sources: Record<string, { sessionId: string; workspaceId: string }> | undefined,
): string | null {
  if (!memory.sourceRunId) return null;
  const source = sources?.[memory.sourceRunId];
  return source ? `/w/${source.workspaceId}/s/${source.sessionId}` : null;
}

export function MemoryPage() {
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();

  /** `all` = every memory, `global` = unscoped only, anything else = a workspace id. */
  const [scope, setScope] = useState<string>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [shelf, setShelf] = useState<ShelfFilter>('all');
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [recallInput, setRecallInput] = useState('');
  const [recallQuery, setRecallQuery] = useState('');

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  /** The memory whose tier is being changed, and where it would go. */
  const [moving, setMoving] = useState<{ memory: Memory; to: string | null } | null>(null);

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
  // The retrieval regime, refreshed on the beat a model load takes.
  const systemQuery = useQuery({ queryKey: ['system'], queryFn: () => api.system(), refetchInterval: 30_000 });
  const retrieval = describeRetrieval(systemQuery.data?.retrieval);

  const memoryQuery = useQuery({
    queryKey: ['memory', scope, kind, filter],
    queryFn: () =>
      api.memory({
        ...(workspaceId ? { workspaceId } : {}),
        ...(scope === 'global' ? { scope: 'global' as const } : {}),
        ...(kind !== 'all' ? { kind } : {}),
        ...(filter ? { search: filter } : {}),
        includeRetired: true,
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
        shelf: draft.shelf,
      }),
    onSuccess: (result) => {
      refreshMemory();
      setAdding(false);
      // A merge is not a failure, but the operator will look for a new row that
      // is not there unless we say what happened.
      if (result.merged) {
        toast.success(t('Merged into an existing memory'), {
          description: `A near-duplicate of “${result.memory.title}” already existed, so this was folded into it rather than stored twice.`,
        });
      } else {
        toast.success(t('Memory added'));
      }
    },
    onError: (error) => toast.error(messageFor(error, t('Could not save that memory.'))),
  });

  const updateMemory = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Memory> }) =>
      api.updateMemory(id, patch),
    onSuccess: () => {
      refreshMemory();
      setEditing(null);
    },
    onError: (error) => toast.error(messageFor(error, t('Could not update that memory.'))),
  });

  const retireMemory = useMutation({
    mutationFn: ({ id, retired }: { id: string; retired: boolean }) => api.updateMemory(id, { retired }),
    onSuccess: (_result, { retired }) => {
      refreshMemory();
      toast.success(retired ? t('Memory retired') : t('Memory restored'));
    },
    onError: (error, { retired }) =>
      toast.error(messageFor(error, retired ? t('Could not retire that memory.') : t('Could not restore that memory.'))),
  });

  const keepNote = useMutation({
    mutationFn: ({ id, index }: { id: string; index: number }) => api.keepInsightNote(id, index),
    onSuccess: () => {
      refreshMemory();
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success(t('Kept as a memory'));
    },
    onError: (error) => toast.error(messageFor(error, t('Could not keep that note.'))),
  });

  const deleteMemory = useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => {
      refreshMemory();
      toast.success(t('Memory deleted'));
    },
    onError: (error) => toast.error(messageFor(error, t('Could not delete that memory.'))),
  });

  const maintenance = useMutation({
    mutationFn: (action: 'decay' | 'collect' | 'reindex' | 'consolidate') =>
      api.memoryMaintenance(action),
    onSuccess: (result, action) => {
      refreshMemory();
      if (action === 'consolidate') {
        // The only action that answers with a queue rather than a change, so
        // it is the only one whose report has to say what to do next. A pass
        // that found nothing is the common and correct outcome, and saying so
        // plainly beats "0 memories affected", which reads like a failure.
        void queryClient.invalidateQueries({ queryKey: ['insights'] });
        const found = result.consolidation?.proposed ?? 0;
        // Three outcomes, and two of them used to read as the third. A pass
        // that could not reach the model reported nothing found, and so did a
        // pass that was capped part-way through the corpus — both saying the
        // corpus repeats nothing, which is a claim neither had earned.
        const seeds = result.consolidation?.seeds ?? 0;
        const corpus = result.consolidation?.corpus ?? 0;
        if (result.consolidation?.reachedArbiter === false) {
          toast.error(t('The consolidation pass could not finish'), {
            description: t(
              'The model did not answer, so nothing was examined. Nothing changed — try again.',
            ),
          });
          return;
        }
        toast.success(
          found === 0
            ? t('Nothing to consolidate')
            : plural(found, '{n} group to review', '{n} groups to review'),
          {
            description:
              corpus > seeds
                ? t('{seeds} of {corpus} memories examined — run it again to continue.', {
                    seeds,
                    corpus,
                  })
                : found === 0
                  ? t('No memory in this corpus repeats or contradicts another.')
                  : t('They are listed below. Nothing is merged until you say so.'),
          },
        );
        return;
      }
      toast.success(t('{action} complete', { action: t(labelFor(action)) }), {
        description: plural(result.affected, '{n} memory affected.', '{n} memories affected.'),
      });
    },
    onError: (error) => toast.error(messageFor(error, t('Maintenance failed.'))),
  });

  /**
   * Move a memory between tiers.
   *
   * Confirmed rather than immediate, and not because it is hard to undo — it
   * is one press back — but because promoting changes what every *other*
   * workspace recalls, and that consequence is invisible from the screen the
   * operator is looking at.
   */
  const setScopeOf = useMutation({
    mutationFn: ({ id, workspaceId }: { id: string; workspaceId: string | null }) =>
      api.setMemoryScope(id, workspaceId),
    onSuccess: (result) => {
      refreshMemory();
      setMoving(null);
      toast.success(
        result.memory.workspaceId === null ? t('Made global') : t('Confined to this workspace'),
        {
          description:
            result.memory.workspaceId === null
              ? t('Every workspace will now recall it.')
              : t('Only this workspace will recall it.'),
        },
      );
    },
    onError: (error) => toast.error(messageFor(error, t('Could not move that memory.'))),
  });

  const applyConsolidation = useMutation({
    mutationFn: ({ id, promote }: { id: string; promote: boolean }) =>
      api.applyConsolidation(id, promote),
    onSuccess: (result) => {
      refreshMemory();
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success(
        plural(result.absorbed.length, '{n} memory folded in', '{n} memories folded in'),
        {
          description: result.moved
            ? t('The survivor is now global — every workspace recalls it.')
            : t('The survivor keeps the history of all of them.'),
        },
      );
    },
    // A 409 here is the proposal having gone stale — a member edited or
    // collected since it was drawn up — and the message says which one, so it
    // is worth showing verbatim rather than behind a generic apology.
    onError: (error) =>
      toast.error(messageFor(error, t('That consolidation could not be applied.'))),
  });

  const setInsightStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Insight['status'] }) =>
      api.setInsightStatus(id, status),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success(variables.status === 'accepted' ? t(
        'Insight accepted',
      ) : t('Insight rejected'));
    },
    onError: (error) => toast.error(messageFor(error, t('Could not update that insight.'))),
  });

  const synthesise = useMutation({
    mutationFn: (id: string) => api.synthesiseSkill(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      if (result === undefined) {
        // 204: the model judged the procedures do not cohere — a legitimate
        // answer, reported as such rather than as silence or failure.
        toast.info(t('Nothing distilled — the procedures do not cohere into one skill yet.'));
      } else {
        toast.success('A skill was drafted. Review it below.');
      }
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('The synthesis could not run.')),
  });

  const installSkill = useMutation({
    mutationFn: (id: string) => api.installSkillFromInsight(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['insights'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      toast.success(t('Installed “{name}”', { name: result.skill.name }), {
        description: t('It is now in the skills registry and available to future runs.'),
      });
    },
    onError: (error) => toast.error(messageFor(error, t('Could not install that skill.'))),
  });

  /* -------------------------------- Render -------------------------------- */

  const stats = memoryQuery.data?.stats;
  const memories = memoryQuery.data?.memories ?? [];
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  // Retired rows come with the list so they can be folded below it; the
  // tiers only ever show what recall can still reach.
  const live = memories.filter(
    (memory) => memory.retiredAt === null && (shelf === 'all' || memory.shelf === shelf),
  );
  const retired = memories.filter((memory) => memory.retiredAt !== null);
  const tiers = tiersOf(live, workspaces, t);
  const insights = insightsQuery.data?.insights ?? [];
  const scopeLabel =
    scope === 'all'
      ? t('All memory')
      : scope === 'global'
        ? t('Global only')
        : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');

  return (
    <AppShell>
      <ContentHeader
        title={t('Memory')}
        subtitle={scopeLabel}
        showSidebarToggle={false}
        icon={<Brain />}
        actions={
          <>
            <Menu
              side="bottom"
              align="end"
              trigger={
                <Button variant="ghost" size="sm" aria-label={t(
                  'Memory scope: {scope}',
                  { scope: scopeLabel },
                )}>
                  <Filter className="size-4" />
                  <span className="hidden sm:inline">{scopeLabel}</span>
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              }
            >
              <MenuLabel>{t('Scope')}</MenuLabel>
              <MenuItem selected={scope === 'all'} onSelect={() => setScope('all')}>
                {t('All memory')}
              </MenuItem>
              <MenuItem
                selected={scope === 'global'}
                description={t('Memories that apply everywhere')}
                onSelect={() => setScope('global')}
              >
                {t('Global only')}
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
                <Button variant="ghost" size="sm" aria-label={t('Memory maintenance')}>
                  <Wrench className="size-4" />
                  <span className="hidden md:inline">{t('Maintenance')}</span>
                </Button>
              }
            >
              <MenuLabel>{t('Maintenance')}</MenuLabel>
              {MAINTENANCE.map((entry) => (
                <MenuItem
                  key={entry.action}
                  disabled={maintenance.isPending}
                  onSelect={() => maintenance.mutate(entry.action)}
                >
                  {/* The tooltip wraps the label rather than the item: `MenuItem`
                      does not forward the trigger props Radix needs. */}
                  <Tooltip content={entry.explanation} side="left">
                    <span className="inline-block">{t(entry.label)}</span>
                  </Tooltip>
                </MenuItem>
              ))}
            </Menu>

            {/* The label is `display: none` below `sm`, and hidden text is out
                of the accessible name — so on a phone this was an unnamed
                button with a plus in it. Every other control on this row
                already carried the label twice for that reason. */}
            <Button
              variant="primary"
              size="sm"
              aria-label={t('Add memory')}
              onClick={() => setAdding(true)}
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">{t('Add memory')}</span>
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-3 py-4 sm:px-6 sm:py-6">
          {/* What search is running on. Quiet when a model is loaded and
              nothing waits; a line the moment it is loading, absent, or a
              rebuild is behind — the states in which "semantic" would be a
              lie the rest of this page tells by omission. */}
          {retrieval.attention ? (
            <div className="rounded-xl border border-line bg-surface px-4 py-3" data-testid="retrieval-line">
              <RetrievalStatus status={systemQuery.data?.retrieval} />
            </div>
          ) : null}

          {/* ------------------------------ Stats ---------------------------- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {memoryQuery.isLoading || !stats ? (
              Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-[92px] rounded-xl" />
              ))
            ) : (
              <>
                <Stat label={t('Total')} value={memoryQuery.data?.total ?? 0} icon={<Brain />} />
                <Stat label={t(
                  'Episodic',
                )} value={stats.episodic} hint={t('What happened in a run')} />
                <Stat label={t('Semantic')} value={stats.semantic} hint={t('Durable facts')} />
                <Stat label={t(
                  'Procedural',
                )} value={stats.procedural} hint={t('How to do something')} />
              </>
            )}
          </div>

          {/* ---------------------------- Retrieval -------------------------- */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="space-y-3 p-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Search className="size-4 text-subtle" aria-hidden />
                  {t('Filter')}
                </h2>
                <p className="text-xs leading-relaxed text-muted">
                  {t(
                    'Plain keyword matching over titles, bodies and tags. It narrows the list below and nothing more.',
                  )}
                </p>
              </div>

              <Input
                id="memory-filter"
                value={filterInput}
                onChange={(event) => setFilterInput(event.target.value)}
                placeholder={t('e.g. migration, tsconfig, deploy')}
                aria-label={t('Filter memories by keyword')}
              />

              <div
                role="group"
                aria-label={t('Filter by memory kind')}
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
              <div
                role="group"
                aria-label={t('Filter by shelf')}
                className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-sunken p-0.5"
              >
                {(['all', 'standing', 'durable', 'volatile'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={shelf === value}
                    onClick={() => setShelf(value)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
                      shelf === value
                        ? 'bg-surface text-ink shadow-[var(--mc-shadow-sm)]'
                        : 'text-muted hover:text-ink',
                    )}
                  >
                    {value === 'all' ? t('Every shelf') : t(SHELF_LABELS[value])}
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
                  {/* "Semantic" only while a model is loaded and answering: under the
                      hashing embedder, or while a model loads, this box ranks by words. */}
                  {t(retrieval.semantic ? 'Semantic recall' : 'Recall')}
                </h2>
                <p className="text-xs leading-relaxed text-muted">
                  {t(
                    retrieval.semantic
                      ? 'Runs the same embedding search the agent runs before a prompt. Results are ranked by meaning, not wording — this is what would actually be injected into context.'
                      : 'Runs the same retrieval the agent runs before a prompt. Right now it matches words, not meaning — this is what would actually be injected into context.',
                  )}
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
                  placeholder={t('Describe a task, as you would to the agent')}
                  aria-label={t(retrieval.semantic ? 'Search memory by meaning' : 'Search memory by words')}
                  className="bg-surface"
                />
                <Button type="submit" variant="primary" size="md" className="shrink-0">
                  {t('Recall')}
                </Button>
              </form>

              {recallQuery ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
                      {t('Top matches')}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setRecallQuery('');
                        setRecallInput('');
                      }}
                      className="text-[11.5px] text-muted hover:text-ink"
                    >
                      {t('Clear')}
                    </button>
                  </div>

                  {recall.isLoading ? (
                    <Spinner />
                  ) : (recall.data?.results.length ?? 0) === 0 ? (
                    <p className="text-[13px] text-muted">
                      {t(
                        'Nothing scored high enough. The agent would run this prompt with no recalled memory.',
                      )}
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
                            aria-label={t(
                              'Similarity score {score}',
                              { score: result.score.toFixed(2) },
                            )}
                          >
                            {result.score.toFixed(2)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">
                              {result.memory.title}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
                              {/* The one list on this screen that is not
                                  grouped, and the only place a tier is
                                  otherwise unknowable: recall answers with the
                                  union a run would be given, best-first. */}
                              <ScopeBadge
                                workspaceId={result.memory.workspaceId}
                                workspaces={workspaces}
                              />
                              {t('{kind} · confidence {value}', {
                                kind: result.memory.kind,
                                value: formatPercent(result.memory.confidence),
                              })}
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
                {t('Stored memories')}
              </h2>
              <p className="text-xs tabular-nums text-muted">
                {/* Counted over the cards actually rendered: `total` excludes
                    the retired ones, and so does every card below — the fold
                    has its own count. The denominator appears whenever fewer
                    are shown than exist, which is a shelf filter as much as a
                    page of a longer list. */}
                {memoryQuery.data && memoryQuery.data.total > live.length
                  ? t('{shown} shown of {total}', { shown: live.length, total: memoryQuery.data.total })
                  : t('{shown} shown', { shown: live.length })}
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
                  title={t('Memory could not be loaded')}
                  description={messageFor(memoryQuery.error, t('The server did not answer.'))}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void memoryQuery.refetch()}>
                      {t('Try again')}
                    </Button>
                  }
                />
              </Card>
            ) : memories.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Brain />}
                  title={filter || kind !== 'all' ? t(
                    'Nothing matches those filters',
                  ) : t('No memories yet')}
                  description={
                    filter || kind !== 'all'
                      ? t('Try a broader kind, or clear the keyword filter.')
                      : t(
                        'Memories accumulate as runs finish and the reflexion pass distils them. You can also write one yourself.',
                      )
                  }
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                      <Plus className="size-4" />
                      {t('Add memory')}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="space-y-3">
                {/* The sky above the shelves: tap a star to land on its card. */}
                <Card className="p-3">
                  <MemoryConstellation
                    memories={live}
                    onSelect={(id) => {
                      const card = document.getElementById(`memory-${id}`);
                      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      card?.classList.add('memory-flash');
                      window.setTimeout(() => card?.classList.remove('memory-flash'), 1600);
                    }}
                  />
                </Card>
                {/* Grouped by tier rather than sorted into one pile. Retrieval
                    hands a run its own workspace's memories *and* every global
                    one, so the list has always shown the union — but sorted by
                    pinned, then confidence, which interleaves the two and
                    leaves an operator unable to tell which is which. The
                    heading is the answer: structure, not a badge to notice. */}
                {tiers.map((tier) => (
                  <section
                    key={tier.workspaceId ?? 'global'}
                    className="space-y-2"
                    aria-labelledby={`tier-${tier.workspaceId ?? 'global'}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line pb-1.5">
                      <h3
                        id={`tier-${tier.workspaceId ?? 'global'}`}
                        className="flex items-center gap-1.5 text-[13px] font-semibold text-ink"
                      >
                        {tier.workspaceId === null ? (
                          <Globe className="size-3.5 text-info" aria-hidden />
                        ) : (
                          <Folder className="size-3.5 text-subtle" aria-hidden />
                        )}
                        {tier.name}
                      </h3>
                      <span className="text-[11.5px] tabular-nums text-subtle">
                        {tier.memories.length}
                      </span>
                      <span className="ml-auto hidden text-[11.5px] text-subtle sm:inline">
                        {tier.workspaceId === null
                          ? t('Recalled in every workspace')
                          : t('Recalled only here')}
                      </span>
                    </div>

                    {tier.memories.map((memory) => (
                      <MemoryCard
                        key={memory.id}
                        memory={memory}
                        workspaces={workspaces}
                        onTogglePin={() =>
                          updateMemory.mutate({ id: memory.id, patch: { pinned: !memory.pinned } })
                        }
                        onEdit={() => setEditing(memory)}
                        onDelete={() => setDeleting(memory)}
                        onRetire={() => retireMemory.mutate({ id: memory.id, retired: true })}
                        onShelf={(next) => updateMemory.mutate({ id: memory.id, patch: { shelf: next } })}
                        onMove={(to) => setMoving({ memory, to })}
                        sourceHref={sourceHrefOf(memory, memoryQuery.data?.sources)}
                      />
                    ))}
                  </section>
                ))}
              </div>
            )}

            {retired.length > 0 ? (
              // Folded by default, and asserted on `open` in tests: jsdom does
              // not hide the children of a closed <details>.
              <details data-testid="retired-memories" className="rounded-lg border border-line bg-sunken/40 px-3 py-2">
                <summary className="cursor-pointer text-[12.5px] font-medium text-muted">
                  {plural(retired.length, 'Retired memory ({n})', 'Retired memories ({n})')}
                </summary>
                <p className="mt-1 text-[11.5px] leading-relaxed text-subtle">
                  {t('Collected thirty days after retirement. Restore one to bring it back into recall.')}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {retired.map((memory) => (
                    <li key={memory.id} className="flex items-center gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate text-muted">
                        {memory.title}
                        {memory.supersededBy ? (
                          <span className="ml-1.5 text-subtle">· {t('replaced by a newer memory')}</span>
                        ) : null}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => retireMemory.mutate({ id: memory.id, retired: false })}
                        aria-label={t('Restore {title}', { title: memory.title })}
                      >
                        <RotateCcw className="size-3.5" />
                        {t('Restore')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
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
                  {t('Insights awaiting review')}
                </h2>
                <p className="text-xs leading-relaxed text-muted">
                  {t(
                    "Distilled by the reflexion pass after a run. Proposals are never installed automatically — nothing here changes the agent's behaviour until you accept it.",
                  )}
                </p>
              </div>
              {workspaceId ? (
                <Tooltip content={t(
                  "Read this workspace's accumulated procedures and, if they cohere, draft one skill — as a proposal below, never installed directly.",
                )}>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={synthesise.isPending}
                    onClick={() => synthesise.mutate(workspaceId)}
                  >
                    <Sparkles className="size-4" aria-hidden />
                    {t('Distil a skill')}
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
                  title={t('Nothing waiting')}
                  description={t('New lessons appear here as runs complete.')}
                />
              </Card>
            ) : (
              <div className="space-y-3">
                {insights.map((insight) => {
                  // A consolidation is a decision about rows that already
                  // exist, not an observation to accept or reject, so it gets
                  // its own card with its own verbs — and the generic accept /
                  // reject pair below would be the wrong question entirely.
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
                  <Card key={insight.id} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={INSIGHT_TONE[insight.kind]}>
                        {insight.kind.replace('_', ' ')}
                      </Badge>
                      <span className="text-[11.5px] text-muted">
                        {t('confidence')} {formatPercent(insight.confidence)}
                      </span>
                      <span className="text-[11.5px] text-subtle">
                        {formatRelative(insight.createdAt)}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <h3 className="break-words text-[13.5px] font-medium text-ink">
                        {insight.title}
                      </h3>
                      {(() => {
                        const gate = readDecisions(insight.payload);
                        if (!gate) {
                          return (
                            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">
                              {insight.body}
                            </p>
                          );
                        }
                        return (
                          <div className="space-y-2">
                            <p className="text-[11.5px] text-subtle">
                              {t('What the memory gate made of each note this run proposed. A refused note can still be kept.')}
                            </p>
                            <ul className="space-y-2">
                              {gate.decisions.map((decision, index) => (
                                <li key={index} className="flex flex-wrap items-start gap-2 text-[13px]">
                                  <Badge tone={OUTCOME_TONE[decision.outcome]}>{t(decision.outcome)}</Badge>
                                  <span className="text-[11.5px] text-subtle">{t(decision.level)}</span>
                                  <span className="min-w-0 flex-1 text-muted">
                                    <span className="font-medium text-ink">{decision.title}</span>
                                    {decision.reason ? <span className="text-subtle"> — {decision.reason}</span> : null}
                                  </span>
                                  {REFUSED.has(decision.outcome) && !decision.memoryId ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => keepNote.mutate({ id: insight.id, index })}
                                      loading={
                                        keepNote.isPending &&
                                        keepNote.variables?.id === insight.id &&
                                        keepNote.variables.index === index
                                      }
                                      aria-label={t('Keep {title}', { title: decision.title })}
                                    >
                                      {t('Keep')}
                                    </Button>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })()}
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
                        {t('Accept')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setInsightStatus.mutate({ id: insight.id, status: 'rejected' })
                        }
                      >
                        <X className="size-4" />
                        {t('Reject')}
                      </Button>
                      {insight.kind === 'skill_proposal' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => installSkill.mutate(insight.id)}
                          loading={installSkill.isPending && installSkill.variables === insight.id}
                        >
                          <Sparkles className="size-4" />
                          {t('Install skill')}
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                  );
                })}
              </div>
            )}
          </section>

          <KnowledgeSection embedder={systemQuery.data?.retrieval.embedder} scope={scope} workspaces={workspaces} />
        </div>
      </div>

      {/* -------------------------------- Modals -------------------------------- */}

      <MemoryModal
        open={adding}
        onOpenChange={setAdding}
        title={t('Add a memory')}
        description={t(
          'Written straight into long-term memory and eligible for retrieval on the next run.',
        )}
        confirmLabel={t('Add memory')}
        busy={createMemory.isPending}
        onSubmit={(draft) => createMemory.mutate(draft)}
      />

      <MemoryModal
        key={editing?.id ?? 'edit'}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={t('Edit memory')}
        description={t(
          'Corrections take effect immediately; the embedding is recomputed on save.',
        )}
        confirmLabel={t('Save changes')}
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
              shelf: draft.shelf,
            },
          });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('Delete this memory?')}
        description={t(
          '{title} is removed permanently and will no longer be retrieved into any run.',
          { title: deleting?.title ?? '' },
        )}
        confirmLabel={t('Delete memory')}
        danger
        onConfirm={async () => {
          if (deleting) await deleteMemory.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />

      {/* Confirmed, though it is one press to undo. What is hard to undo is
          not the row — it is having every other workspace's runs shaped by a
          memory nobody there expected, which is a consequence invisible from
          the screen this is pressed on. */}
      <ConfirmDialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
        title={moving?.to === null ? t('Make this global?') : t('Confine this memory?')}
        description={
          moving?.to === null
            ? t(
                '“{title}” would be recalled by every workspace, not just this one. You can confine it again at any time.',
                { title: moving?.memory.title ?? '' },
              )
            : t(
                '“{title}” would only be recalled in {name}. Other workspaces stop seeing it.',
                {
                  title: moving?.memory.title ?? '',
                  name: scopeName(moving?.to ?? null, workspaces, t),
                },
              )
        }
        confirmLabel={moving?.to === null ? t('Make global') : t('Confine')}
        onConfirm={async () => {
          if (moving) {
            await setScopeOf.mutateAsync({ id: moving.memory.id, workspaceId: moving.to });
          }
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
  workspaces,
  sourceHref,
  onTogglePin,
  onEdit,
  onDelete,
  onMove,
  onRetire,
  onShelf,
}: {
  memory: Memory;
  workspaces: readonly Workspace[];
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** A soft delete, restorable for thirty days. */
  onRetire: () => void;
  onShelf: (shelf: MemoryShelf) => void;
  /** `null` promotes to the global tier; an id confines to that workspace. */
  onMove: (to: string | null) => void;
  /** The session this was learned in, when the run still exists. */
  sourceHref: string | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isGlobal = memory.workspaceId === null;

  return (
    <Card id={`memory-${memory.id}`} className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[memory.kind]}>{memory.kind}</Badge>
            {/* Repeated from the section heading on purpose: a card is reached
                directly — from the constellation, from a notification link —
                and one that does not say which tier it is on cannot be read
                on its own. */}
            <ScopeBadge workspaceId={memory.workspaceId} workspaces={workspaces} />
            {memory.pinned ? <Badge tone="warning">{t('pinned')}</Badge> : null}
            {/* The default shelf says nothing; a convention or a fact does. */}
            {memory.shelf !== 'durable' ? (
              <Badge tone={SHELF_TONE[memory.shelf]}>{t(memory.shelf)}</Badge>
            ) : null}
            {/* `break-words`: a memory's title is often an identifier or a
                URL — one word nothing can break. Measured at +300px outside the
                frame at 390px, with no ellipsis to say so. */}
            <h3 className="min-w-0 break-words text-[13.5px] font-medium text-ink">
              {memory.title}
            </h3>
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
              aria-label={memory.pinned ? t(
                'Unpin {title}',
                { title: memory.title },
              ) : t('Pin {title}', { title: memory.title })}
              className={cn(memory.pinned && 'text-warning')}
            >
              <Pin className="size-4" />
            </Button>
          </Tooltip>

          <Menu
            side="bottom"
            align="end"
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={t(
                'Actions for {title}',
                { title: memory.title },
              )}>
                <MoreHorizontal className="size-4" />
              </Button>
            }
          >
            <MenuItem icon={<Pencil />} onSelect={onEdit}>
              {t('Edit')}
            </MenuItem>

            <MenuSeparator />
            <MenuLabel>{t('Scope')}</MenuLabel>
            {isGlobal ? (
              // Confining needs a destination, and offering every workspace in
              // this menu would put a list of unrelated projects inside a
              // single memory's actions. The workspaces are listed; a global
              // memory with nowhere to go simply has no entry here.
              workspaces.map((workspace) => (
                <MenuItem
                  key={workspace.id}
                  icon={
                    <span
                      className="mt-0.5 block size-3 rounded-[4px]"
                      style={{ background: workspace.color }}
                      aria-hidden
                    />
                  }
                  onSelect={() => onMove(workspace.id)}
                >
                  {t('Confine to {name}', { name: workspace.name })}
                </MenuItem>
              ))
            ) : (
              <MenuItem
                icon={<Globe />}
                description={t('Every workspace would recall it')}
                onSelect={() => onMove(null)}
              >
                {t('Make global')}
              </MenuItem>
            )}

            <MenuSeparator />
            <MenuLabel>{t('Shelf')}</MenuLabel>
            {(['standing', 'durable', 'volatile'] as const).map((value) => (
              <MenuItem
                key={value}
                icon={<Layers />}
                selected={memory.shelf === value}
                description={t(SHELF_HINTS[value])}
                onSelect={() => onShelf(value)}
              >
                {t(SHELF_LABELS[value])}
              </MenuItem>
            ))}

            <MenuSeparator />
            <MenuItem icon={<Archive />} description={t('Leaves recall at once; restorable for thirty days')} onSelect={onRetire}>
              {t('Retire')}
            </MenuItem>
            <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
              {t('Delete')}
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
          {expanded ? t('Show less') : t('Show more')}
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
          {t('used')} {memory.useCount}× · {memory.successCount} {t('succeeded')}
        </span>
        <span>{t('updated')} {formatRelative(memory.updatedAt)}</span>
        {/* Where it came from. Stored since the table existed and never shown:
            a memory whose origin an operator can open is one they can judge,
            and judging is the whole point of this screen. */}
        {sourceHref ? (
          <Link to={sourceHref} className="font-medium text-accent hover:underline">
            {t('where this came from')}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * 0–1 confidence, with the colour thresholds the decay job also uses.
 *
 * Higher is better here, which is why the tone is decided at the call site:
 * the same bar draws memory pressure, where higher is worse.
 */
function ConfidenceBar({ value }: { value: number }) {
  const t = useT();
  const tone = value >= 0.7 ? 'success' : value >= 0.4 ? 'warning' : 'danger';

  return (
    <div className="flex items-center gap-2">
      <Meter value={value} tone={tone} label={t(
        'Confidence {value}',
        { value: formatPercent(value) },
      )} className="w-20" />
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
  shelf: MemoryShelf;
}

const EMPTY_DRAFT: MemoryDraft = {
  kind: 'semantic',
  title: '',
  content: '',
  tags: '',
  pinned: false,
  confidence: 0.7,
  shelf: 'durable',
};

function draftFrom(memory: Memory): MemoryDraft {
  return {
    kind: memory.kind,
    title: memory.title,
    content: memory.content,
    tags: memory.tags.join(', '),
    pinned: memory.pinned,
    confidence: memory.confidence,
    shelf: memory.shelf,
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
  const t = useT();
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
            {t('Cancel')}
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
        <Label htmlFor="memory-kind" hint={t(
          'Chooses how the retriever weights this against a prompt.',
        )}>
          {t('Kind')}
          <select
            id="memory-kind"
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryKind })}
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="episodic">{t('Episodic — what happened in a run')}</option>
            <option value="semantic">{t('Semantic — a durable fact')}</option>
            <option value="procedural">{t('Procedural — how to do something')}</option>
          </select>
        </Label>

        <Label htmlFor="memory-shelf" hint={t(
          'How long this is meant to hold. A convention applies whatever the request is about.',
        )}>
          {t('Shelf')}
          <select
            id="memory-shelf"
            value={draft.shelf}
            onChange={(event) => setDraft({ ...draft, shelf: event.target.value as MemoryShelf })}
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {(['durable', 'standing', 'volatile'] as const).map((value) => (
              <option key={value} value={value}>{t(SHELF_HINTS[value])}</option>
            ))}
          </select>
        </Label>

        <Label htmlFor="memory-title" hint={t('The retrieval key. One sentence works best.')}>
          {t('Title')}
          <Input
            id="memory-title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder={t('Prefer pnpm over npm in this repo')}
            className="mt-1.5"
            maxLength={300}
          />
        </Label>

        <Label htmlFor="memory-content" hint={t(
          'Injected verbatim into the system prompt when recalled.',
        )}>
          {t('Content')}
          <Textarea
            id="memory-content"
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            rows={7}
            className="mt-1.5"
            maxLength={20_000}
          />
        </Label>

        <Label htmlFor="memory-tags" hint={t('Comma separated.')}>
          {t('Tags')}
          <Input
            id="memory-tags"
            value={draft.tags}
            onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
            placeholder={t('tooling, conventions')}
            className="mt-1.5"
          />
        </Label>

        <Label
          htmlFor="memory-confidence"
          hint={t(
            'How much the retriever should trust this. Reinforced when runs that used it succeed.',
          )}
        >
          {t('Confidence — {value}', { value: formatPercent(draft.confidence) })}
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
            {t('Pinned')}
            <span className="mt-0.5 block text-xs text-muted">
              {t('Exempt from decay and garbage collection.')}
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
