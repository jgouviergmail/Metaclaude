import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Source-control panel.
 *
 * Deliberately a review surface rather than a full git client: see what the
 * agent changed, read the diff, stage what is right and commit it. Anything
 * that rewrites history stays in the terminal, where the safeguards are.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronRight, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, X, } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DiffView } from '@/components/transcript/DiffView';
import { Badge, Button, EmptyState, Spinner, Textarea, Tooltip, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
const SECTIONS = [
    { key: 'staged', label: 'Staged', staged: true },
    { key: 'modified', label: 'Modified', staged: false },
    { key: 'untracked', label: 'Untracked', staged: false },
    { key: 'conflicted', label: 'Conflicted', staged: false },
];
export function GitPanel({ workspaceId, onClose }) {
    const queryClient = useQueryClient();
    const [message, setMessage] = useState('');
    const [selected, setSelected] = useState(null);
    const [collapsed, setCollapsed] = useState({});
    const status = useQuery({
        queryKey: ['git-status', workspaceId],
        queryFn: () => api.gitStatus(workspaceId),
    });
    const log = useQuery({
        queryKey: ['git-log', workspaceId],
        queryFn: () => api.gitLog(workspaceId, 15),
        enabled: status.data?.isRepo === true,
    });
    const diff = useQuery({
        queryKey: ['git-diff', workspaceId, selected?.path ?? null, selected?.staged ?? false],
        queryFn: async () => (selected ? api.gitDiff(workspaceId, selected) : { diff: '', files: [] }),
        enabled: selected !== null,
    });
    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ['git-status', workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ['git-diff', workspaceId] });
    };
    const fail = (error, fallback) => {
        toast.error(error instanceof ApiError ? error.message : fallback);
    };
    const stage = useMutation({
        mutationFn: (paths) => api.gitStage(workspaceId, paths),
        onSuccess: invalidate,
        onError: (error) => fail(error, 'Could not stage those files.'),
    });
    const unstage = useMutation({
        mutationFn: (paths) => api.gitUnstage(workspaceId, paths),
        onSuccess: invalidate,
        onError: (error) => fail(error, 'Could not unstage those files.'),
    });
    const commit = useMutation({
        mutationFn: (text) => api.gitCommit(workspaceId, text),
        onSuccess: (result) => {
            toast.success(`Committed ${result.hash.slice(0, 7)}`);
            setMessage('');
            setSelected(null);
            invalidate();
            void queryClient.invalidateQueries({ queryKey: ['git-log', workspaceId] });
        },
        onError: (error) => fail(error, 'The commit failed.'),
    });
    const data = status.data;
    const busy = stage.isPending || unstage.isPending;
    const header = (_jsxs("header", { className: "flex h-12 shrink-0 items-center gap-2 border-b border-line px-3", children: [_jsx("h2", { className: "shrink-0 text-sm font-semibold text-ink", children: "Source control" }), data?.isRepo && data.branch ? (_jsxs(Badge, { tone: "accent", className: "min-w-0", children: [_jsx(GitBranch, { className: "size-3 shrink-0", "aria-hidden": true }), _jsx("span", { className: "truncate", children: data.branch })] })) : null, data && data.ahead > 0 ? (_jsxs("span", { className: "flex items-center gap-0.5 text-[11px] tabular-nums text-muted", children: [_jsx(ArrowUp, { className: "size-3", "aria-hidden": true }), _jsx("span", { "aria-label": `${data.ahead} commits ahead`, children: data.ahead })] })) : null, data && data.behind > 0 ? (_jsxs("span", { className: "flex items-center gap-0.5 text-[11px] tabular-nums text-muted", children: [_jsx(ArrowDown, { className: "size-3", "aria-hidden": true }), _jsx("span", { "aria-label": `${data.behind} commits behind`, children: data.behind })] })) : null, _jsxs("div", { className: "ml-auto flex shrink-0 items-center gap-1", children: [_jsx(Tooltip, { content: "Refresh", children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Refresh source control", onClick: () => {
                                invalidate();
                                void queryClient.invalidateQueries({ queryKey: ['git-log', workspaceId] });
                            }, children: _jsx(RefreshCw, { className: cn('size-4', status.isFetching && 'animate-spin') }) }) }), _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Close source control", onClick: onClose, children: _jsx(X, { className: "size-4" }) })] })] }));
    if (status.isPending) {
        return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [header, _jsx("div", { className: "flex flex-1 items-center justify-center", children: _jsx(Spinner, {}) })] }));
    }
    if (status.isError || !data?.isRepo) {
        return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [header, _jsx(EmptyState, { icon: _jsx(GitBranch, {}), title: status.isError ? 'Git status is unavailable' : 'Not a git repository', description: status.isError
                        ? status.error instanceof ApiError
                            ? status.error.message
                            : 'The repository status could not be read.'
                        : 'This workspace has no git repository, so there is nothing to review or commit. Run `git init` in the workspace to start tracking changes.' })] }));
    }
    const unstaged = [...data.modified, ...data.untracked, ...data.conflicted];
    const canCommit = message.trim().length > 0 && data.staged.length > 0 && !commit.isPending;
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [header, _jsxs("div", { className: "shrink-0 space-y-2 border-b border-line p-3", children: [_jsx(Textarea, { value: message, onChange: (event) => setMessage(event.target.value), placeholder: "Commit message", "aria-label": "Commit message", rows: 2, className: "text-[13px]" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "text-[11px] tabular-nums text-subtle", children: [data.staged.length, " staged"] }), _jsxs(Button, { variant: "primary", size: "sm", className: "ml-auto", onClick: () => commit.mutate(message.trim()), disabled: !canCommit, loading: commit.isPending, children: [_jsx(GitCommitHorizontal, { className: "size-3.5", "aria-hidden": true }), "Commit"] })] })] }), _jsxs("div", { className: "min-h-0 flex-1 overflow-y-auto", children: [unstaged.length > 0 ? (_jsx("div", { className: "flex items-center justify-end border-b border-line px-3 py-1.5", children: _jsxs(Button, { variant: "ghost", size: "xs", onClick: () => stage.mutate(unstaged), disabled: busy, children: [_jsx(Plus, { className: "size-3", "aria-hidden": true }), "Stage all"] }) })) : null, SECTIONS.map((section) => {
                        const paths = data[section.key];
                        if (paths.length === 0)
                            return null;
                        const open = collapsed[section.key] !== true;
                        return (_jsxs("section", { className: "border-b border-line", children: [_jsxs("button", { type: "button", "aria-expanded": open, onClick: () => setCollapsed((previous) => ({ ...previous, [section.key]: open })), className: "flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-raised", children: [_jsx(ChevronRight, { className: cn('size-3.5 shrink-0 text-subtle transition-transform duration-150', open && 'rotate-90'), "aria-hidden": true }), _jsx("span", { className: "text-[11px] font-semibold uppercase tracking-wide text-subtle", children: section.label }), _jsx("span", { className: "text-[11px] tabular-nums text-subtle", children: paths.length })] }), open ? (_jsx("ul", { className: "pb-1", children: paths.map((path) => (_jsx(FileRow, { path: path, selected: selected?.path === path && selected.staged === section.staged, staged: section.key === 'staged', busy: busy, onSelect: () => setSelected((current) => current?.path === path && current.staged === section.staged
                                            ? null
                                            : { path, staged: section.staged }), onStage: () => stage.mutate([path]), onUnstage: () => unstage.mutate([path]) }, `${section.key}:${path}`))) })) : null] }, section.key));
                    }), selected ? (_jsx("div", { className: "border-b border-line p-2", children: diff.isPending ? (_jsx("div", { className: "flex justify-center py-6", children: _jsx(Spinner, {}) })) : diff.isError ? (_jsx("p", { className: "px-1 py-4 text-center text-[12.5px] text-danger", children: diff.error instanceof ApiError
                                ? diff.error.message
                                : 'That diff could not be loaded.' })) : diff.data.diff.trim() === '' ? (
                        // `git diff` says nothing about a path it has never seen, which is
                        // exactly the case for every untracked file.
                        _jsx("p", { className: "px-1 py-4 text-center text-[12.5px] text-muted", children: "No diff to show \u2014 an untracked file has no previous version to compare against." })) : (_jsx(DiffView, { patch: diff.data.diff, path: selected.path })) })) : null, _jsx(RecentCommits, { commits: log.data?.commits ?? [], loading: log.isPending })] })] }));
}
function FileRow({ path, selected, staged, busy, onSelect, onStage, onUnstage, }) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const directory = path.slice(0, path.length - name.length);
    return (_jsxs("li", { className: "group flex items-center gap-1 px-2", children: [_jsxs("button", { type: "button", onClick: onSelect, "aria-pressed": selected, className: cn('flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors', selected ? 'bg-accent-soft' : 'hover:bg-raised'), children: [_jsx("span", { className: "truncate font-mono text-[12px] text-ink", children: name }), directory ? (_jsx("span", { className: "min-w-0 shrink truncate font-mono text-[11px] text-subtle", children: directory.replace(/\/$/, '') })) : null] }), _jsx(Tooltip, { content: staged ? 'Unstage' : 'Stage', children: _jsx("button", { type: "button", onClick: staged ? onUnstage : onStage, disabled: busy, "aria-label": `${staged ? 'Unstage' : 'Stage'} ${path}`, className: cn('flex size-6 shrink-0 items-center justify-center rounded-md text-subtle', 'transition-colors hover:bg-raised hover:text-ink disabled:opacity-40', 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'), children: staged ? _jsx(Minus, { className: "size-3.5", "aria-hidden": true }) : _jsx(Plus, { className: "size-3.5", "aria-hidden": true }) }) })] }));
}
function RecentCommits({ commits, loading, }) {
    return (_jsxs("section", { className: "p-2", children: [_jsx("h3", { className: "px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-subtle", children: "Recent commits" }), loading ? (_jsx("div", { className: "flex justify-center py-4", children: _jsx(Spinner, {}) })) : commits.length === 0 ? (_jsx("p", { className: "px-1.5 py-3 text-[12.5px] text-muted", children: "No commits yet." })) : (_jsx("ul", { className: "space-y-0.5", children: commits.map((entry) => (_jsx("li", { className: "rounded-md px-1.5 py-1.5 hover:bg-raised", children: _jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("code", { className: "shrink-0 font-mono text-[11px] text-accent", children: entry.hash.slice(0, 7) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "truncate text-[12.5px] text-ink", children: entry.subject }), _jsxs("p", { className: "mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle", children: [_jsx("span", { className: "truncate", children: entry.author }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsx("span", { className: "shrink-0", children: formatRelative(entry.date) })] })] })] }) }, entry.hash))) }))] }));
}
//# sourceMappingURL=GitPanel.js.map