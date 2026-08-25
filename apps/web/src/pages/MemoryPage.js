import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { Brain, Check, ChevronDown, Filter, Lightbulb, MoreHorizontal, Pencil, Pin, Plus, Search, Sparkles, Trash2, Wrench, X, } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Button, Card, EmptyState, Input, Label, Skeleton, Spinner, Stat, Textarea, Tooltip, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatPercent, formatRelative } from '@/lib/utils';
const KIND_FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'episodic', label: 'Episodic' },
    { value: 'semantic', label: 'Semantic' },
    { value: 'procedural', label: 'Procedural' },
];
const KIND_TONE = {
    episodic: 'info',
    semantic: 'accent',
    procedural: 'thinking',
};
const MAINTENANCE = [
    {
        action: 'decay',
        label: 'Decay',
        explanation: 'Lower the confidence of memories that have not been retrieved recently, so stale facts stop outranking fresh ones. Pinned memories are exempt.',
    },
    {
        action: 'collect',
        label: 'Collect',
        explanation: 'Delete unpinned memories whose confidence has decayed below the keep threshold. This is the only maintenance action that removes rows.',
    },
    {
        action: 'reindex',
        label: 'Re-index',
        explanation: 'Recompute every embedding. Needed after switching embedding provider, otherwise semantic recall compares vectors from two different spaces.',
    },
];
const INSIGHT_TONE = {
    lesson: 'info',
    pattern: 'accent',
    failure: 'danger',
    preference: 'success',
    skill_proposal: 'thinking',
};
export function MemoryPage() {
    const queryClient = useQueryClient();
    /** `all` = every memory, `global` = unscoped only, anything else = a workspace id. */
    const [scope, setScope] = useState('all');
    const [kind, setKind] = useState('all');
    const [filterInput, setFilterInput] = useState('');
    const [filter, setFilter] = useState('');
    const [recallInput, setRecallInput] = useState('');
    const [recallQuery, setRecallQuery] = useState('');
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
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
        queryFn: () => api.memory({
            ...(workspaceId ? { workspaceId } : {}),
            ...(scope === 'global' ? { scope: 'global' } : {}),
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
    const refreshMemory = () => {
        void queryClient.invalidateQueries({ queryKey: ['memory'] });
        void queryClient.invalidateQueries({ queryKey: ['memory-search'] });
    };
    const createMemory = useMutation({
        mutationFn: (draft) => api.createMemory({
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
            }
            else {
                toast.success('Memory added');
            }
        },
        onError: (error) => toast.error(messageFor(error, 'Could not save that memory.')),
    });
    const updateMemory = useMutation({
        mutationFn: ({ id, patch }) => api.updateMemory(id, patch),
        onSuccess: () => {
            refreshMemory();
            setEditing(null);
        },
        onError: (error) => toast.error(messageFor(error, 'Could not update that memory.')),
    });
    const deleteMemory = useMutation({
        mutationFn: (id) => api.deleteMemory(id),
        onSuccess: () => {
            refreshMemory();
            toast.success('Memory deleted');
        },
        onError: (error) => toast.error(messageFor(error, 'Could not delete that memory.')),
    });
    const maintenance = useMutation({
        mutationFn: (action) => api.memoryMaintenance(action),
        onSuccess: (result, action) => {
            refreshMemory();
            toast.success(`${MAINTENANCE.find((m) => m.action === action)?.label ?? action} complete`, {
                description: `${result.affected} ${result.affected === 1 ? 'memory' : 'memories'} affected.`,
            });
        },
        onError: (error) => toast.error(messageFor(error, 'Maintenance failed.')),
    });
    const setInsightStatus = useMutation({
        mutationFn: ({ id, status }) => api.setInsightStatus(id, status),
        onSuccess: (_result, variables) => {
            void queryClient.invalidateQueries({ queryKey: ['insights'] });
            toast.success(variables.status === 'accepted' ? 'Insight accepted' : 'Insight rejected');
        },
        onError: (error) => toast.error(messageFor(error, 'Could not update that insight.')),
    });
    const installSkill = useMutation({
        mutationFn: (id) => api.installSkillFromInsight(id),
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
    const scopeLabel = scope === 'all'
        ? 'All memory'
        : scope === 'global'
            ? 'Global only'
            : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: "Memory", subtitle: scopeLabel, showSidebarToggle: false, icon: _jsx(Brain, {}), actions: _jsxs(_Fragment, { children: [_jsxs(Menu, { side: "bottom", align: "end", trigger: _jsxs(Button, { variant: "ghost", size: "sm", "aria-label": `Memory scope: ${scopeLabel}`, children: [_jsx(Filter, { className: "size-4" }), _jsx("span", { className: "hidden sm:inline", children: scopeLabel }), _jsx(ChevronDown, { className: "size-3.5", "aria-hidden": true })] }), children: [_jsx(MenuLabel, { children: "Scope" }), _jsx(MenuItem, { selected: scope === 'all', onSelect: () => setScope('all'), children: "All memory" }), _jsx(MenuItem, { selected: scope === 'global', description: "Memories that apply everywhere", onSelect: () => setScope('global'), children: "Global only" }), (workspacesQuery.data?.workspaces.length ?? 0) > 0 ? _jsx(MenuSeparator, {}) : null, workspacesQuery.data?.workspaces.map((workspace) => (_jsx(MenuItem, { selected: scope === workspace.id, onSelect: () => setScope(workspace.id), icon: _jsx("span", { className: "mt-0.5 block size-3 rounded-[4px]", style: { background: workspace.color }, "aria-hidden": true }), children: workspace.name }, workspace.id)))] }), _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsxs(Button, { variant: "ghost", size: "sm", "aria-label": "Memory maintenance", children: [_jsx(Wrench, { className: "size-4" }), _jsx("span", { className: "hidden md:inline", children: "Maintenance" })] }), children: [_jsx(MenuLabel, { children: "Maintenance" }), MAINTENANCE.map((entry) => (_jsx(MenuItem, { disabled: maintenance.isPending, onSelect: () => maintenance.mutate(entry.action), children: _jsx(Tooltip, { content: entry.explanation, side: "left", children: _jsx("span", { className: "inline-block", children: entry.label }) }) }, entry.action)))] }), _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setAdding(true), children: [_jsx(Plus, { className: "size-4" }), _jsx("span", { className: "hidden sm:inline", children: "Add memory" })] })] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs("div", { className: "mx-auto w-full max-w-5xl space-y-6 px-3 py-4 sm:px-6 sm:py-6", children: [_jsx("div", { className: "grid grid-cols-2 gap-3 lg:grid-cols-4", children: memoryQuery.isLoading || !stats ? (Array.from({ length: 4 }, (_, index) => (_jsx(Skeleton, { className: "h-[92px] rounded-xl" }, index)))) : (_jsxs(_Fragment, { children: [_jsx(Stat, { label: "Total", value: memoryQuery.data?.total ?? 0, icon: _jsx(Brain, {}) }), _jsx(Stat, { label: "Episodic", value: stats.episodic, hint: "What happened in a run" }), _jsx(Stat, { label: "Semantic", value: stats.semantic, hint: "Durable facts" }), _jsx(Stat, { label: "Procedural", value: stats.procedural, hint: "How to do something" })] })) }), _jsxs("div", { className: "grid gap-3 lg:grid-cols-2", children: [_jsxs(Card, { className: "space-y-3 p-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsxs("h2", { className: "flex items-center gap-2 text-sm font-semibold text-ink", children: [_jsx(Search, { className: "size-4 text-subtle", "aria-hidden": true }), "Filter"] }), _jsx("p", { className: "text-xs leading-relaxed text-muted", children: "Plain keyword matching over titles, bodies and tags. It narrows the list below and nothing more." })] }), _jsx(Input, { id: "memory-filter", value: filterInput, onChange: (event) => setFilterInput(event.target.value), placeholder: "e.g. migration, tsconfig, deploy", "aria-label": "Filter memories by keyword" }), _jsx("div", { role: "group", "aria-label": "Filter by memory kind", className: "inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-sunken p-0.5", children: KIND_FILTERS.map((entry) => (_jsx("button", { type: "button", "aria-pressed": kind === entry.value, onClick: () => setKind(entry.value), className: cn('rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors', kind === entry.value
                                                    ? 'bg-surface text-ink shadow-[var(--mc-shadow-sm)]'
                                                    : 'text-muted hover:text-ink'), children: entry.label }, entry.value))) })] }), _jsxs(Card, { className: "space-y-3 border-accent/30 bg-accent-soft/30 p-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsxs("h2", { className: "flex items-center gap-2 text-sm font-semibold text-ink", children: [_jsx(Sparkles, { className: "size-4 text-accent", "aria-hidden": true }), "Semantic recall"] }), _jsx("p", { className: "text-xs leading-relaxed text-muted", children: "Runs the same embedding search the agent runs before a prompt. Results are ranked by meaning, not wording \u2014 this is what would actually be injected into context." })] }), _jsxs("form", { className: "flex gap-2", onSubmit: (event) => {
                                                event.preventDefault();
                                                setRecallQuery(recallInput.trim());
                                            }, children: [_jsx(Input, { id: "memory-recall", value: recallInput, onChange: (event) => setRecallInput(event.target.value), placeholder: "Describe a task, as you would to the agent", "aria-label": "Search memory by meaning", className: "bg-surface" }), _jsx(Button, { type: "submit", variant: "primary", size: "md", className: "shrink-0", children: "Recall" })] }), recallQuery ? (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("p", { className: "text-[11px] font-semibold uppercase tracking-wide text-subtle", children: "Top matches" }), _jsx("button", { type: "button", onClick: () => {
                                                                setRecallQuery('');
                                                                setRecallInput('');
                                                            }, className: "text-[11.5px] text-muted hover:text-ink", children: "Clear" })] }), recall.isLoading ? (_jsx(Spinner, {})) : (recall.data?.results.length ?? 0) === 0 ? (_jsx("p", { className: "text-[13px] text-muted", children: "Nothing scored high enough. The agent would run this prompt with no recalled memory." })) : (_jsx("ul", { className: "space-y-1.5", children: recall.data?.results.map((result) => (_jsxs("li", { className: "flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-2", children: [_jsx("span", { className: "mt-0.5 shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-accent", "aria-label": `Similarity score ${result.score.toFixed(2)}`, children: result.score.toFixed(2) }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-[13px] font-medium text-ink", children: result.memory.title }), _jsxs("span", { className: "mt-0.5 block text-[11.5px] text-muted", children: [result.memory.kind, " \u00B7 confidence", ' ', formatPercent(result.memory.confidence)] })] })] }, result.memory.id))) }))] })) : null] })] }), _jsxs("section", { className: "space-y-3", "aria-labelledby": "memory-list-heading", children: [_jsxs("div", { className: "flex items-baseline justify-between gap-3", children: [_jsx("h2", { id: "memory-list-heading", className: "text-sm font-semibold text-ink", children: "Stored memories" }), _jsxs("p", { className: "text-xs tabular-nums text-muted", children: [memories.length, " shown", memoryQuery.data && memoryQuery.data.total > memories.length
                                                    ? ` of ${memoryQuery.data.total}`
                                                    : ''] })] }), memoryQuery.isLoading ? (_jsx("div", { className: "space-y-3", children: Array.from({ length: 3 }, (_, index) => (_jsx(Skeleton, { className: "h-32 rounded-xl" }, index))) })) : memoryQuery.isError ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Brain, {}), title: "Memory could not be loaded", description: messageFor(memoryQuery.error, 'The server did not answer.'), action: _jsx(Button, { size: "sm", variant: "secondary", onClick: () => void memoryQuery.refetch(), children: "Try again" }) }) })) : memories.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Brain, {}), title: filter || kind !== 'all' ? 'Nothing matches those filters' : 'No memories yet', description: filter || kind !== 'all'
                                            ? 'Try a broader kind, or clear the keyword filter.'
                                            : 'Memories accumulate as runs finish and the reflexion pass distils them. You can also write one yourself.', action: _jsxs(Button, { size: "sm", variant: "secondary", onClick: () => setAdding(true), children: [_jsx(Plus, { className: "size-4" }), "Add memory"] }) }) })) : (_jsx("div", { className: "space-y-3", children: memories.map((memory) => (_jsx(MemoryCard, { memory: memory, onTogglePin: () => updateMemory.mutate({ id: memory.id, patch: { pinned: !memory.pinned } }), onEdit: () => setEditing(memory), onDelete: () => setDeleting(memory) }, memory.id))) }))] }), _jsxs("section", { className: "space-y-3", "aria-labelledby": "insights-heading", children: [_jsxs("div", { className: "space-y-1", children: [_jsxs("h2", { id: "insights-heading", className: "flex items-center gap-2 text-sm font-semibold text-ink", children: [_jsx(Lightbulb, { className: "size-4 text-warning", "aria-hidden": true }), "Insights awaiting review"] }), _jsx("p", { className: "text-xs leading-relaxed text-muted", children: "Distilled by the reflexion pass after a run. Proposals are never installed automatically \u2014 nothing here changes the agent's behaviour until you accept it." })] }), insightsQuery.isLoading ? (_jsx(Skeleton, { className: "h-24 rounded-xl" })) : insights.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Lightbulb, {}), title: "Nothing waiting", description: "New lessons appear here as runs complete." }) })) : (_jsx("div", { className: "space-y-3", children: insights.map((insight) => (_jsxs(Card, { className: "space-y-3 p-4", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Badge, { tone: INSIGHT_TONE[insight.kind], children: insight.kind.replace('_', ' ') }), _jsxs("span", { className: "text-[11.5px] text-muted", children: ["confidence ", formatPercent(insight.confidence)] }), _jsx("span", { className: "text-[11.5px] text-subtle", children: formatRelative(insight.createdAt) })] }), _jsxs("div", { className: "space-y-1", children: [_jsx("h3", { className: "text-[13.5px] font-medium text-ink", children: insight.title }), _jsx("p", { className: "whitespace-pre-wrap text-[13px] leading-relaxed text-muted", children: insight.body })] }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsxs(Button, { size: "sm", variant: "success", onClick: () => setInsightStatus.mutate({ id: insight.id, status: 'accepted' }), loading: setInsightStatus.isPending &&
                                                            setInsightStatus.variables?.id === insight.id &&
                                                            setInsightStatus.variables.status === 'accepted', children: [_jsx(Check, { className: "size-4" }), "Accept"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setInsightStatus.mutate({ id: insight.id, status: 'rejected' }), children: [_jsx(X, { className: "size-4" }), "Reject"] }), insight.kind === 'skill_proposal' ? (_jsxs(Button, { size: "sm", variant: "outline", onClick: () => installSkill.mutate(insight.id), loading: installSkill.isPending && installSkill.variables === insight.id, children: [_jsx(Sparkles, { className: "size-4" }), "Install skill"] })) : null] })] }, insight.id))) }))] })] }) }), _jsx(MemoryModal, { open: adding, onOpenChange: setAdding, title: "Add a memory", description: "Written straight into long-term memory and eligible for retrieval on the next run.", confirmLabel: "Add memory", busy: createMemory.isPending, onSubmit: (draft) => createMemory.mutate(draft) }), _jsx(MemoryModal, { open: editing !== null, onOpenChange: (open) => {
                    if (!open)
                        setEditing(null);
                }, title: "Edit memory", description: "Corrections take effect immediately; the embedding is recomputed on save.", confirmLabel: "Save changes", busy: updateMemory.isPending, initial: editing ? draftFrom(editing) : undefined, onSubmit: (draft) => {
                    if (!editing)
                        return;
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
                } }, editing?.id ?? 'edit'), _jsx(ConfirmDialog, { open: deleting !== null, onOpenChange: (open) => {
                    if (!open)
                        setDeleting(null);
                }, title: "Delete this memory?", description: _jsxs(_Fragment, { children: [_jsx("span", { className: "font-medium text-ink", children: deleting?.title }), " is removed permanently and will no longer be retrieved into any run."] }), confirmLabel: "Delete memory", danger: true, onConfirm: async () => {
                    if (deleting)
                        await deleteMemory.mutateAsync(deleting.id);
                    setDeleting(null);
                } })] }));
}
/* -------------------------------------------------------------------------- */
/* Memory card                                                                 */
/* -------------------------------------------------------------------------- */
function MemoryCard({ memory, onTogglePin, onEdit, onDelete, }) {
    const [expanded, setExpanded] = useState(false);
    return (_jsxs(Card, { className: "p-4", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsxs("div", { className: "min-w-0 flex-1 space-y-2", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Badge, { tone: KIND_TONE[memory.kind], children: memory.kind }), memory.pinned ? _jsx(Badge, { tone: "warning", children: "pinned" }) : null, _jsx("h3", { className: "min-w-0 text-[13.5px] font-medium text-ink", children: memory.title })] }), _jsx(ConfidenceBar, { value: memory.confidence })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1", children: [_jsx(Tooltip, { content: memory.pinned ? 'Unpin — allow decay' : 'Pin — never decay or collect', children: _jsx(Button, { variant: "ghost", size: "icon-sm", onClick: onTogglePin, "aria-pressed": memory.pinned, "aria-label": memory.pinned ? `Unpin ${memory.title}` : `Pin ${memory.title}`, className: cn(memory.pinned && 'text-warning'), children: _jsx(Pin, { className: "size-4" }) }) }), _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": `Actions for ${memory.title}`, children: _jsx(MoreHorizontal, { className: "size-4" }) }), children: [_jsx(MenuItem, { icon: _jsx(Pencil, {}), onSelect: onEdit, children: "Edit" }), _jsx(MenuSeparator, {}), _jsx(MenuItem, { icon: _jsx(Trash2, {}), tone: "danger", onSelect: onDelete, children: "Delete" })] })] })] }), _jsx("p", { className: cn('mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-muted', !expanded && 'line-clamp-3'), children: memory.content }), memory.content.length > 180 ? (_jsx("button", { type: "button", onClick: () => setExpanded((value) => !value), "aria-expanded": expanded, className: "mt-1 text-[12px] font-medium text-accent hover:underline", children: expanded ? 'Show less' : 'Show more' })) : null, _jsxs("div", { className: "mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3 text-[11.5px] text-subtle", children: [memory.tags.length > 0 ? (_jsx("span", { className: "flex flex-wrap gap-1", children: memory.tags.map((tag) => (_jsxs("span", { className: "rounded bg-sunken px-1.5 py-0.5 text-muted", children: ["#", tag] }, tag))) })) : null, _jsxs("span", { className: "tabular-nums", children: ["used ", memory.useCount, "\u00D7 \u00B7 ", memory.successCount, " succeeded"] }), _jsxs("span", { children: ["updated ", formatRelative(memory.updatedAt)] })] })] }));
}
/** 0–1 confidence, with the colour thresholds the decay job also uses. */
function ConfidenceBar({ value }) {
    const tone = value >= 0.7 ? 'bg-success' : value >= 0.4 ? 'bg-warning' : 'bg-danger';
    return (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "h-1.5 w-20 overflow-hidden rounded-full bg-sunken", role: "img", "aria-label": `Confidence ${formatPercent(value)}`, children: _jsx("div", { className: cn('h-full rounded-full transition-[width]', tone), style: { width: `${Math.round(value * 100)}%` } }) }), _jsx("span", { className: "text-[11px] tabular-nums text-muted", children: formatPercent(value) })] }));
}
const EMPTY_DRAFT = {
    kind: 'semantic',
    title: '',
    content: '',
    tags: '',
    pinned: false,
    confidence: 0.7,
};
function draftFrom(memory) {
    return {
        kind: memory.kind,
        title: memory.title,
        content: memory.content,
        tags: memory.tags.join(', '),
        pinned: memory.pinned,
        confidence: memory.confidence,
    };
}
function parseTags(raw) {
    return [
        ...new Set(raw
            .split(',')
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean)),
    ].slice(0, 24);
}
function MemoryModal({ open, onOpenChange, title, description, confirmLabel, busy, initial, onSubmit, }) {
    const [draft, setDraft] = useState(initial ?? EMPTY_DRAFT);
    const valid = draft.title.trim().length > 0 && draft.content.trim().length > 0;
    // Reopening the add dialog should start clean; the edit dialog is remounted
    // per memory by its key, so its initial value is already correct.
    useEffect(() => {
        if (open && !initial)
            setDraft(EMPTY_DRAFT);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    return (_jsx(Modal, { open: open, onOpenChange: onOpenChange, title: title, description: description, footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: busy, disabled: !valid, onClick: () => onSubmit(draft), children: confirmLabel })] }), children: _jsxs("div", { className: "space-y-4", children: [_jsxs(Label, { htmlFor: "memory-kind", hint: "Chooses how the retriever weights this against a prompt.", children: ["Kind", _jsxs("select", { id: "memory-kind", value: draft.kind, onChange: (event) => setDraft({ ...draft, kind: event.target.value }), className: "mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none", children: [_jsx("option", { value: "episodic", children: "Episodic \u2014 what happened in a run" }), _jsx("option", { value: "semantic", children: "Semantic \u2014 a durable fact" }), _jsx("option", { value: "procedural", children: "Procedural \u2014 how to do something" })] })] }), _jsxs(Label, { htmlFor: "memory-title", hint: "The retrieval key. One sentence works best.", children: ["Title", _jsx(Input, { id: "memory-title", value: draft.title, onChange: (event) => setDraft({ ...draft, title: event.target.value }), placeholder: "Prefer pnpm over npm in this repo", className: "mt-1.5", maxLength: 300 })] }), _jsxs(Label, { htmlFor: "memory-content", hint: "Injected verbatim into the system prompt when recalled.", children: ["Content", _jsx(Textarea, { id: "memory-content", value: draft.content, onChange: (event) => setDraft({ ...draft, content: event.target.value }), rows: 7, className: "mt-1.5", maxLength: 20_000 })] }), _jsxs(Label, { htmlFor: "memory-tags", hint: "Comma separated.", children: ["Tags", _jsx(Input, { id: "memory-tags", value: draft.tags, onChange: (event) => setDraft({ ...draft, tags: event.target.value }), placeholder: "tooling, conventions", className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "memory-confidence", hint: "How much the retriever should trust this. Reinforced when runs that used it succeed.", children: ["Confidence \u2014 ", formatPercent(draft.confidence), _jsx("input", { id: "memory-confidence", type: "range", min: 0, max: 1, step: 0.05, value: draft.confidence, onChange: (event) => setDraft({ ...draft, confidence: Number(event.target.value) }), className: "mt-1.5 w-full accent-[var(--mc-accent)]" })] }), _jsxs("label", { className: "flex items-start gap-2.5 text-[13px] text-ink", children: [_jsx("input", { type: "checkbox", checked: draft.pinned, onChange: (event) => setDraft({ ...draft, pinned: event.target.checked }), className: "mt-0.5 size-4 accent-[var(--mc-accent)]" }), _jsxs("span", { children: ["Pinned", _jsx("span", { className: "mt-0.5 block text-xs text-muted", children: "Exempt from decay and garbage collection." })] })] })] }) }));
}
function messageFor(error, fallback) {
    return error instanceof ApiError ? error.message : fallback;
}
export { MemoryPage as default };
//# sourceMappingURL=MemoryPage.js.map