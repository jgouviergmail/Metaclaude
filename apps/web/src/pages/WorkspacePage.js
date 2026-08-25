import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Workspace overview — sessions, settings and health for one project.
 *
 * Opening a workspace with no session at all jumps straight into a new one:
 * the operator came here to talk to the agent, not to press "new" first.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Loader2, Plus, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { PERMISSION_MODE_INFO, } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { SessionList } from '@/components/workspace/SessionList';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Card, EmptyState, Input, Label, Spinner, Stat, Textarea, Tooltip, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useUiStore } from '@/lib/store';
import { formatRelative } from '@/lib/utils';
export function WorkspacePage() {
    const { workspaceId = '' } = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const setLastWorkspace = useUiStore((state) => state.setLastWorkspace);
    const [showSettings, setShowSettings] = useState(false);
    const { data, isLoading, isError } = useQuery({
        queryKey: ['workspace', workspaceId],
        queryFn: () => api.workspace(workspaceId),
        enabled: Boolean(workspaceId),
    });
    useEffect(() => {
        if (workspaceId)
            setLastWorkspace(workspaceId);
    }, [workspaceId, setLastWorkspace]);
    const createSession = useMutation({
        mutationFn: () => api.createSession({ workspaceId }),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
            navigate(`/w/${workspaceId}/s/${result.session.id}`);
        },
        onError: () => toast.error('Could not start a session.'),
    });
    const workspace = data?.workspace;
    const sessions = data?.sessions ?? [];
    // Land directly in a session when this workspace has none yet.
    const noSessions = Boolean(data) && sessions.length === 0;
    useEffect(() => {
        if (noSessions && !createSession.isPending && !createSession.isSuccess) {
            createSession.mutate();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noSessions]);
    const sidebar = (_jsx(SessionList, { workspaceId: workspaceId, activeSessionId: "", sessions: sessions, onCreate: () => createSession.mutate(), creating: createSession.isPending }));
    if (isLoading) {
        return (_jsx(AppShell, { sidebar: sidebar, children: _jsx("div", { className: "flex flex-1 items-center justify-center", children: _jsx(Spinner, { className: "size-6" }) }) }));
    }
    if (isError || !workspace) {
        return (_jsx(AppShell, { children: _jsxs("div", { className: "flex flex-1 flex-col items-center justify-center gap-3", children: [_jsx("p", { className: "text-sm text-muted", children: "That workspace could not be loaded." }), _jsx(Button, { variant: "secondary", size: "sm", onClick: () => navigate('/workspaces'), children: "All workspaces" })] }) }));
    }
    const git = data?.gitStatus;
    const memoryStats = data?.memoryStats;
    const totalMemories = memoryStats
        ? memoryStats.episodic + memoryStats.semantic + memoryStats.procedural
        : 0;
    return (_jsxs(AppShell, { sidebar: sidebar, children: [_jsx(ContentHeader, { title: workspace.name, subtitle: workspace.path, icon: _jsx("span", { className: "block size-4 rounded", style: { background: workspace.color }, "aria-hidden": true }), actions: _jsxs(_Fragment, { children: [_jsx(Tooltip, { content: "Workspace settings", children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Workspace settings", onClick: () => setShowSettings(true), children: _jsx(Settings2, { className: "size-4" }) }) }), _jsxs(Button, { variant: "primary", size: "sm", onClick: () => createSession.mutate(), loading: createSession.isPending, children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "New session"] })] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs("div", { className: "mx-auto max-w-5xl space-y-5 p-4 sm:p-6", children: [workspace.description ? (_jsx("p", { className: "text-[13.5px] leading-relaxed text-muted", children: workspace.description })) : null, _jsxs("div", { className: "grid grid-cols-2 gap-3 lg:grid-cols-4", children: [_jsx(Stat, { label: "Sessions", value: sessions.length }), _jsx(Stat, { label: "Memories", value: totalMemories, hint: memoryStats
                                        ? `${memoryStats.semantic} facts · ${memoryStats.procedural} procedures`
                                        : undefined }), _jsx(Stat, { label: "Permission mode", value: _jsx("span", { className: "text-base", children: PERMISSION_MODE_INFO[workspace.settings.defaultPermissionMode].label }), tone: workspace.settings.defaultPermissionMode === 'bypassPermissions'
                                        ? 'danger'
                                        : undefined }), _jsx(Stat, { label: "Branch", value: _jsx("span", { className: "text-base", children: git?.branch ?? '—' }), hint: git?.isRepo
                                        ? `${git.modified.length} modified · ${git.untracked.length} untracked`
                                        : 'Not a git repository' })] }), git?.isRepo && (git.modified.length > 0 || git.untracked.length > 0) ? (_jsxs(Card, { children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-line px-4 py-3", children: [_jsx(GitBranch, { className: "size-4 shrink-0 text-muted", "aria-hidden": true }), _jsx("h2", { className: "text-sm font-semibold text-ink", children: "Uncommitted changes" }), _jsx(Badge, { tone: "warning", className: "ml-auto", children: git.modified.length + git.untracked.length })] }), _jsx("ul", { className: "max-h-56 overflow-y-auto px-4 py-2", children: [...git.modified.map((p) => ({ path: p, kind: 'modified' })),
                                        ...git.untracked.map((p) => ({ path: p, kind: 'untracked' }))]
                                        .slice(0, 40)
                                        .map((entry) => (_jsxs("li", { className: "flex items-center gap-2 py-1", children: [_jsx(Badge, { tone: entry.kind === 'modified' ? 'warning' : 'neutral', children: entry.kind === 'modified' ? 'M' : 'U' }), _jsx("code", { className: "min-w-0 truncate font-mono text-[12px] text-muted", children: entry.path })] }, `${entry.kind}-${entry.path}`))) })] })) : null, _jsxs(Card, { children: [_jsxs("div", { className: "flex items-center justify-between gap-2 border-b border-line px-4 py-3", children: [_jsx("h2", { className: "text-sm font-semibold text-ink", children: "Sessions" }), _jsx("span", { className: "text-[12px] text-subtle", children: sessions.length })] }), sessions.length === 0 ? (_jsx(EmptyState, { icon: _jsx(Loader2, { className: "animate-spin" }), title: "Starting your first session", description: "One moment." })) : (_jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: sessions.map((session) => (_jsx("li", { children: _jsxs(Link, { to: `/w/${workspaceId}/s/${session.id}`, className: "flex items-center gap-3 px-4 py-3 hover:bg-raised", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "truncate text-[13.5px] font-medium text-ink", children: session.title || 'New session' }), _jsxs("p", { className: "text-[11.5px] text-subtle", children: [session.runCount, " run", session.runCount === 1 ? '' : 's', " \u00B7", ' ', formatRelative(session.lastActivityAt)] })] }), session.status === 'running' ? _jsx(Badge, { tone: "accent", children: "running" }) : null, session.status === 'waiting_approval' ? (_jsx(Badge, { tone: "warning", children: "waiting" })) : null, session.status === 'error' ? _jsx(Badge, { tone: "danger", children: "error" }) : null] }) }, session.id))) }))] })] }) }), _jsx(WorkspaceSettingsModal, { open: showSettings, onOpenChange: setShowSettings, workspaceId: workspaceId, settings: workspace.settings, name: workspace.name, description: workspace.description })] }));
}
/* -------------------------------------------------------------------------- */
const MODELS = ['default', 'opus', 'sonnet', 'haiku', 'opusplan'];
const EFFORTS = [null, 'low', 'medium', 'high', 'xhigh', 'max'];
function WorkspaceSettingsModal({ open, onOpenChange, workspaceId, settings, name, description, }) {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState(settings);
    const [draftName, setDraftName] = useState(name);
    const [draftDescription, setDraftDescription] = useState(description);
    // Re-seed whenever the dialog opens, so a cancelled edit does not persist.
    useEffect(() => {
        if (open) {
            setDraft(settings);
            setDraftName(name);
            setDraftDescription(description);
        }
    }, [open, settings, name, description]);
    const save = useMutation({
        mutationFn: () => api.updateWorkspace(workspaceId, {
            name: draftName.trim(),
            description: draftDescription.trim(),
            settings: draft,
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            toast.success('Settings saved');
            onOpenChange(false);
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save the settings.'),
    });
    const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    return (_jsx(Modal, { open: open, onOpenChange: onOpenChange, title: "Workspace settings", description: "Defaults for every session started in this workspace.", size: "lg", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: _jsxs("div", { className: "space-y-5", children: [_jsxs(Label, { htmlFor: "ws-edit-name", children: ["Name", _jsx(Input, { id: "ws-edit-name", value: draftName, onChange: (event) => setDraftName(event.target.value), className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "ws-edit-description", children: ["Description", _jsx(Textarea, { id: "ws-edit-description", value: draftDescription, onChange: (event) => setDraftDescription(event.target.value), rows: 2, className: "mt-1.5" })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block text-[13px] font-medium text-ink", children: "Default model" }), _jsx(Menu, { side: "bottom", trigger: _jsx(Button, { variant: "secondary", size: "sm", className: "w-full justify-between", children: String(draft.defaultModel) }), children: MODELS.map((model) => (_jsx(MenuItem, { selected: draft.defaultModel === model, onSelect: () => update('defaultModel', model), children: model }, model))) })] }), _jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block text-[13px] font-medium text-ink", children: "Default effort" }), _jsx(Menu, { side: "bottom", trigger: _jsx(Button, { variant: "secondary", size: "sm", className: "w-full justify-between", children: draft.defaultEffort ?? 'auto' }), children: EFFORTS.map((effort) => (_jsx(MenuItem, { selected: draft.defaultEffort === effort, onSelect: () => update('defaultEffort', effort), children: effort ?? 'auto' }, effort ?? 'auto'))) })] })] }), _jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block text-[13px] font-medium text-ink", children: "Default permission mode" }), _jsxs(Menu, { side: "bottom", trigger: _jsx(Button, { variant: "secondary", size: "sm", className: "w-full justify-between", children: PERMISSION_MODE_INFO[draft.defaultPermissionMode].label }), children: [_jsx(MenuLabel, { children: "How much to ask before acting" }), Object.keys(PERMISSION_MODE_INFO).map((mode) => (_jsx(MenuItem, { selected: draft.defaultPermissionMode === mode, onSelect: () => update('defaultPermissionMode', mode), description: PERMISSION_MODE_INFO[mode].description, tone: PERMISSION_MODE_INFO[mode].risk === 'high' ? 'danger' : undefined, children: PERMISSION_MODE_INFO[mode].label }, mode)))] })] }), _jsx(MenuSeparator, {}), _jsxs("fieldset", { className: "space-y-3", children: [_jsx("legend", { className: "text-[13px] font-semibold text-ink", children: "Learning" }), _jsx(Toggle, { checked: draft.memoryEnabled, onChange: (value) => update('memoryEnabled', value), label: "Recall long-term memory", hint: "Inject what Metaclaude learned in earlier sessions into each run's context." }), _jsx(Toggle, { checked: draft.autoPolicyEnabled, onChange: (value) => update('autoPolicyEnabled', value), label: "Choose the model automatically", hint: "Pick model and effort from what has performed best on similar tasks here." }), _jsx(Toggle, { checked: draft.reflexionEnabled, onChange: (value) => update('reflexionEnabled', value), label: "Reflect after each run", hint: "Run a small, tool-less pass that extracts durable lessons from what happened." }), _jsx(Toggle, { checked: draft.checkpointing, onChange: (value) => update('checkpointing', value), label: "File checkpointing", hint: "Track file changes so a run can be rewound." })] }), _jsx(MenuSeparator, {}), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2", children: [_jsxs(Label, { htmlFor: "ws-max-turns", hint: "Blank means no limit.", children: ["Max turns per run", _jsx(Input, { id: "ws-max-turns", type: "number", min: 1, max: 1000, value: draft.maxTurns ?? '', onChange: (event) => update('maxTurns', event.target.value ? Number(event.target.value) : null), className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "ws-max-budget", hint: "Stops a run once it reaches this cost.", children: ["Cost ceiling (USD)", _jsx(Input, { id: "ws-max-budget", type: "number", min: 0, step: 0.5, value: draft.maxBudgetUsd ?? '', onChange: (event) => update('maxBudgetUsd', event.target.value ? Number(event.target.value) : null), className: "mt-1.5" })] })] }), _jsxs(Label, { htmlFor: "ws-system-prompt", hint: "Appended to Claude Code's own system prompt for every run here. Project conventions, things to avoid, house style.", children: ["Additional instructions", _jsx(Textarea, { id: "ws-system-prompt", value: draft.systemPromptAppend, onChange: (event) => update('systemPromptAppend', event.target.value), rows: 5, className: "mt-1.5 font-mono text-[12.5px]" })] })] }) }));
}
function Toggle({ checked, onChange, label, hint, }) {
    return (_jsxs("label", { className: "flex cursor-pointer items-start gap-3", children: [_jsx("input", { type: "checkbox", checked: checked, onChange: (event) => onChange(event.target.checked), className: "mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)]" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-[13px] font-medium text-ink", children: label }), _jsx("span", { className: "block text-[12px] leading-relaxed text-muted", children: hint })] })] }));
}
//# sourceMappingURL=WorkspacePage.js.map