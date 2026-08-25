import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Automations — the loop engine's control surface.
 *
 * The distinction that matters and is made explicit in the UI: a one-shot
 * automation starts a fresh session each firing, while a *continuous* one
 * continues the same session, so the agent keeps its accumulated context. The
 * second is what turns a schedule into a genuinely long-running agent.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, MoreVertical, Pause, Play, Plus, Repeat, Timer, Trash2, Zap, } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { PERMISSION_MODE_INFO, } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Button, Card, EmptyState, Input, Label, Skeleton, Textarea, Tooltip, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';
/** Ready-made schedules, so nobody has to remember cron syntax to get started. */
const PRESETS = [
    { label: 'Every hour', expression: '0 * * * *' },
    { label: 'Every 4 hours', expression: '0 */4 * * *' },
    { label: 'Daily at 09:00', expression: '0 9 * * *' },
    { label: 'Weekdays at 09:00', expression: '0 9 * * 1-5' },
    { label: 'Weekly, Monday 09:00', expression: '0 9 * * 1' },
    { label: 'Monthly, 1st at 09:00', expression: '0 9 1 * *' },
];
export function AutomationsPage() {
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(null);
    const [pendingDelete, setPendingDelete] = useState(null);
    const { data, isLoading } = useQuery({
        queryKey: ['automations'],
        queryFn: () => api.automations(),
        refetchInterval: 30_000,
    });
    const { data: workspaceData } = useQuery({
        queryKey: ['workspaces'],
        queryFn: () => api.workspaces(),
    });
    const toggle = useMutation({
        mutationFn: ({ id, enabled }) => api.updateAutomation(id, { enabled }),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['automations'] }),
    });
    const fire = useMutation({
        mutationFn: (id) => api.fireAutomation(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['automations'] });
            toast.success('Automation started');
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not run the automation.'),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteAutomation(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['automations'] });
            toast.success('Automation deleted');
        },
    });
    const automations = data?.automations ?? [];
    const workspaces = workspaceData?.workspaces ?? [];
    const workspaceName = (id) => workspaces.find((workspace) => workspace.id === id)?.name ?? 'Unknown workspace';
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: "Automations", subtitle: "Scheduled and continuous agent loops.", showSidebarToggle: false, actions: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setEditing('new'), disabled: workspaces.length === 0, children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "New automation"] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsx("div", { className: "mx-auto max-w-4xl space-y-4 p-4 sm:p-6", children: isLoading ? (_jsx("div", { className: "space-y-3", children: Array.from({ length: 3 }, (_, i) => (_jsx(Skeleton, { className: "h-28" }, i))) })) : automations.length === 0 ? (_jsx(EmptyState, { icon: _jsx(Timer, {}), title: "No automations yet", description: workspaces.length === 0
                            ? 'Create a workspace first — an automation always runs inside one.'
                            : 'Give the agent a prompt and a schedule. It runs with the same permissions, memory and learning as a session you start by hand.', action: workspaces.length > 0 ? (_jsxs(Button, { variant: "primary", size: "sm", onClick: () => setEditing('new'), children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "Create one"] })) : (_jsx(Link, { to: "/workspaces", className: "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-[13px] font-medium text-ink hover:bg-line", children: "Go to workspaces" })) })) : (automations.map((automation) => (_jsx(Card, { className: cn(!automation.enabled && 'opacity-65'), children: _jsxs("div", { className: "flex items-start gap-3 p-4", children: [_jsx("span", { className: cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', automation.continuous
                                        ? 'bg-thinking-soft text-thinking'
                                        : 'bg-accent-soft text-accent'), "aria-hidden": true, children: automation.continuous ? (_jsx(Repeat, { className: "size-4" })) : (_jsx(Clock, { className: "size-4" })) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("h3", { className: "text-[14px] font-semibold text-ink", children: automation.name }), automation.continuous ? (_jsx(Tooltip, { content: "Each firing continues the same session, so context accumulates across runs.", children: _jsx("span", { children: _jsx(Badge, { tone: "thinking", children: "continuous" }) }) })) : null, !automation.enabled ? _jsx(Badge, { tone: "neutral", children: "paused" }) : null, automation.lastStatus ? (_jsx(Badge, { tone: automation.lastStatus === 'succeeded'
                                                        ? 'success'
                                                        : automation.lastStatus === 'failed'
                                                            ? 'danger'
                                                            : 'warning', children: automation.lastStatus })) : null] }), _jsxs("p", { className: "mt-1 text-[12.5px] text-muted", children: [workspaceName(automation.workspaceId), " \u00B7 ", describeTrigger(automation.trigger)] }), _jsx("p", { className: "mt-2 line-clamp-2 rounded-lg bg-sunken px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-muted", children: automation.prompt }), _jsxs("div", { className: "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle", children: [_jsxs("span", { children: [automation.runCount, " runs"] }), automation.lastRunAt ? (_jsxs("span", { children: ["last ", formatRelative(automation.lastRunAt)] })) : null, automation.enabled && automation.nextRunAt ? (_jsx(Tooltip, { content: formatDateTime(automation.nextRunAt), children: _jsxs("span", { className: "cursor-help underline decoration-dotted underline-offset-2", children: ["next ", formatRelative(automation.nextRunAt)] }) })) : null, automation.consecutiveFailures > 0 ? (_jsxs("span", { className: "flex items-center gap-1 text-warning", children: [_jsx(AlertTriangle, { className: "size-3", "aria-hidden": true }), automation.consecutiveFailures, " consecutive failure", automation.consecutiveFailures === 1 ? '' : 's'] })) : null, automation.sessionId ? (_jsx(Link, { to: `/w/${automation.workspaceId}/s/${automation.sessionId}`, className: "text-accent hover:underline", children: "Open session" })) : null] })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-1", children: [_jsx(Tooltip, { content: "Run now", children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": `Run ${automation.name} now`, onClick: () => fire.mutate(automation.id), children: _jsx(Zap, { className: "size-4" }) }) }), _jsx(Tooltip, { content: automation.enabled ? 'Pause' : 'Resume', children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": automation.enabled ? 'Pause' : 'Resume', onClick: () => toggle.mutate({ id: automation.id, enabled: !automation.enabled }), children: automation.enabled ? (_jsx(Pause, { className: "size-4" })) : (_jsx(Play, { className: "size-4" })) }) }), _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsx("button", { type: "button", className: "flex size-7 items-center justify-center rounded-md text-subtle hover:bg-raised hover:text-ink", "aria-label": `More actions for ${automation.name}`, children: _jsx(MoreVertical, { className: "size-4" }) }), children: [_jsx(MenuItem, { onSelect: () => setEditing(automation), children: "Edit" }), _jsx(MenuSeparator, {}), _jsx(MenuItem, { icon: _jsx(Trash2, {}), tone: "danger", onSelect: () => setPendingDelete(automation), children: "Delete" })] })] })] }) }, automation.id)))) }) }), editing ? (_jsx(AutomationEditor, { automation: editing === 'new' ? null : editing, workspaces: workspaces, onClose: () => setEditing(null) })) : null, _jsx(ConfirmDialog, { open: Boolean(pendingDelete), onOpenChange: (open) => !open && setPendingDelete(null), title: `Delete "${pendingDelete?.name ?? ''}"?`, description: "The schedule is removed. Sessions and transcripts it already produced are kept.", confirmLabel: "Delete", danger: true, onConfirm: () => {
                    if (pendingDelete)
                        remove.mutate(pendingDelete.id);
                } })] }));
}
/* -------------------------------------------------------------------------- */
function AutomationEditor({ automation, workspaces, onClose, }) {
    const queryClient = useQueryClient();
    const [name, setName] = useState(automation?.name ?? '');
    const [description, setDescription] = useState(automation?.description ?? '');
    const [prompt, setPrompt] = useState(automation?.prompt ?? '');
    const [workspaceId, setWorkspaceId] = useState(automation?.workspaceId ?? workspaces[0]?.id ?? '');
    const [triggerType, setTriggerType] = useState(automation?.trigger.type ?? 'cron');
    const [expression, setExpression] = useState(automation?.trigger.type === 'cron' ? automation.trigger.expression : '0 9 * * *');
    const [everyMinutes, setEveryMinutes] = useState(automation?.trigger.type === 'interval' ? Math.round(automation.trigger.everyMs / 60_000) : 60);
    const [continuous, setContinuous] = useState(automation?.continuous ?? false);
    const [permissionMode, setPermissionMode] = useState(automation?.policy.permissionMode ?? 'default');
    const [maxFailures, setMaxFailures] = useState(automation?.maxConsecutiveFailures ?? 3);
    const buildTrigger = () => {
        if (triggerType === 'interval')
            return { type: 'interval', everyMs: everyMinutes * 60_000 };
        if (triggerType === 'manual')
            return { type: 'manual' };
        return { type: 'cron', expression };
    };
    const save = useMutation({
        mutationFn: () => {
            const body = {
                name: name.trim(),
                description: description.trim(),
                prompt: prompt.trim(),
                trigger: buildTrigger(),
                continuous,
                maxConsecutiveFailures: maxFailures,
                policy: { permissionMode },
            };
            return automation
                ? api.updateAutomation(automation.id, body)
                : api.createAutomation({ ...body, workspaceId });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['automations'] });
            toast.success(automation ? 'Automation updated' : 'Automation created');
            onClose();
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save the automation.'),
    });
    const valid = name.trim() && prompt.trim() && workspaceId;
    return (_jsx(Modal, { open: true, onOpenChange: (open) => !open && onClose(), title: automation ? 'Edit automation' : 'New automation', description: "A prompt plus a trigger. It runs exactly as a session you start yourself would.", size: "lg", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: save.isPending, disabled: !valid, onClick: () => save.mutate(), children: automation ? 'Save' : 'Create' })] }), children: _jsxs("div", { className: "space-y-4", children: [_jsxs(Label, { htmlFor: "auto-name", children: ["Name", _jsx(Input, { id: "auto-name", value: name, onChange: (event) => setName(event.target.value), placeholder: "Nightly dependency audit", autoFocus: true, className: "mt-1.5" })] }), !automation ? (_jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block text-[13px] font-medium text-ink", children: "Workspace" }), _jsx(Menu, { side: "bottom", trigger: _jsx(Button, { variant: "secondary", size: "sm", className: "w-full justify-between", children: workspaces.find((w) => w.id === workspaceId)?.name ?? 'Choose a workspace' }), children: workspaces.map((workspace) => (_jsx(MenuItem, { selected: workspace.id === workspaceId, onSelect: () => setWorkspaceId(workspace.id), children: workspace.name }, workspace.id))) })] })) : null, _jsxs(Label, { htmlFor: "auto-prompt", hint: "What the agent should do each time this fires.", children: ["Prompt", _jsx(Textarea, { id: "auto-prompt", value: prompt, onChange: (event) => setPrompt(event.target.value), rows: 5, placeholder: "Check for outdated dependencies with known advisories and open a summary of what needs attention.", className: "mt-1.5" })] }), _jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block text-[13px] font-medium text-ink", children: "Trigger" }), _jsx("div", { className: "flex gap-1.5", children: ['cron', 'interval', 'manual'].map((type) => (_jsx("button", { type: "button", onClick: () => setTriggerType(type), "aria-pressed": triggerType === type, className: cn('flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-medium capitalize transition-colors', triggerType === type
                                    ? 'border-accent bg-accent-soft text-accent'
                                    : 'border-line text-muted hover:bg-raised'), children: type === 'cron' ? 'Schedule' : type === 'interval' ? 'Interval' : 'Manual' }, type))) }), triggerType === 'cron' ? (_jsxs("div", { className: "mt-2.5 space-y-2", children: [_jsx(Input, { value: expression, onChange: (event) => setExpression(event.target.value), placeholder: "0 9 * * *", "aria-label": "Cron expression", className: "font-mono text-[13px]" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: PRESETS.map((preset) => (_jsx("button", { type: "button", onClick: () => setExpression(preset.expression), className: cn('rounded-full border px-2.5 py-1 text-[11.5px] transition-colors', expression === preset.expression
                                            ? 'border-accent bg-accent-soft text-accent'
                                            : 'border-line text-muted hover:bg-raised'), children: preset.label }, preset.expression))) }), _jsx("p", { className: "text-[11.5px] text-subtle", children: "Standard 5-field cron, in the server's timezone." })] })) : triggerType === 'interval' ? (_jsxs("div", { className: "mt-2.5", children: [_jsx(Input, { type: "number", min: 1, value: everyMinutes, onChange: (event) => setEveryMinutes(Math.max(1, Number(event.target.value))), "aria-label": "Interval in minutes" }), _jsx("p", { className: "mt-1 text-[11.5px] text-subtle", children: "Minutes between runs. Minimum 1." })] })) : (_jsx("p", { className: "mt-2.5 text-[11.5px] text-subtle", children: "Runs only when you press \"Run now\"." }))] }), _jsxs("label", { className: "flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3", children: [_jsx("input", { type: "checkbox", checked: continuous, onChange: (event) => setContinuous(event.target.checked), className: "mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)]" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-[13px] font-medium text-ink", children: "Continuous loop" }), _jsx("span", { className: "block text-[12px] leading-relaxed text-muted", children: "Continue the same session on every firing instead of starting fresh. The agent keeps everything it has already learned in this loop, which is what makes long-running, self-directed work possible \u2014 and what makes its context grow over time." })] })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsx("span", { className: "mb-1.5 block text-[13px] font-medium text-ink", children: "Permission mode" }), _jsxs(Menu, { side: "bottom", trigger: _jsx(Button, { variant: "secondary", size: "sm", className: "w-full justify-between", children: PERMISSION_MODE_INFO[permissionMode].label }), children: [_jsx(MenuLabel, { children: "Unattended runs cannot answer prompts" }), ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'].map((mode) => (_jsx(MenuItem, { selected: permissionMode === mode, onSelect: () => setPermissionMode(mode), description: PERMISSION_MODE_INFO[mode].description, children: PERMISSION_MODE_INFO[mode].label }, mode)))] })] }), _jsxs(Label, { htmlFor: "auto-failures", hint: "0 disables the guard.", children: ["Stop after N failures", _jsx(Input, { id: "auto-failures", type: "number", min: 0, max: 100, value: maxFailures, onChange: (event) => setMaxFailures(Number(event.target.value)), className: "mt-1.5" })] })] }), permissionMode === 'default' ? (_jsxs("p", { className: "flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/30 p-3 text-[12px] leading-relaxed text-ink", children: [_jsx(AlertTriangle, { className: "mt-px size-3.5 shrink-0 text-warning", "aria-hidden": true }), "In \"Ask\" mode an unattended run will stall on the first prompt and be declined after ten minutes. For a schedule, prefer \"Plan\", \"Accept edits\" or \"Auto\"."] })) : null] }) }));
}
function describeTrigger(trigger) {
    switch (trigger.type) {
        case 'cron':
            return `cron: ${trigger.expression}`;
        case 'interval': {
            const minutes = Math.round(trigger.everyMs / 60_000);
            return minutes % 60 === 0
                ? `every ${minutes / 60}h`
                : `every ${minutes}m`;
        }
        case 'event':
            return `on ${trigger.event}`;
        default:
            return 'manual only';
    }
}
//# sourceMappingURL=AutomationsPage.js.map