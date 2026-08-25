import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Agents & skills — the extension registry.
 *
 * Three kinds of extension, one registry: skills (instructions the CLI
 * discovers), subagents (named prompts with their own tool budget) and MCP
 * servers (outside tools). They share a page because they share a lifecycle —
 * each is materialised into the workspace immediately before a run, and each is
 * scoped either to one workspace or to every workspace at once.
 */
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, Filter, Plug, Plus, ShieldCheck, Sparkles, Trash2, X, } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Button, Card, EmptyState, Input, Label, Skeleton, Textarea, Tooltip, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MCP_NAME = /^[a-zA-Z0-9_-]+$/;
const MCP_STATUS_TONE = {
    connected: 'success',
    failed: 'danger',
    disabled: 'neutral',
    unknown: 'neutral',
};
export function AgentsPage() {
    const queryClient = useQueryClient();
    /** `global` = unscoped definitions only; a workspace id = that workspace plus globals. */
    const [scope, setScope] = useState('global');
    const [tab, setTab] = useState('skills');
    const workspaceId = scope === 'global' ? undefined : scope;
    const workspacesQuery = useQuery({
        queryKey: ['workspaces'],
        queryFn: () => api.workspaces(),
        staleTime: 60_000,
    });
    const scopeLabel = scope === 'global'
        ? 'Global'
        : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');
    const invalidate = (key) => {
        void queryClient.invalidateQueries({ queryKey: [key] });
    };
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: "Agents & skills", subtitle: scopeLabel, showSidebarToggle: false, icon: _jsx(Bot, {}), actions: _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsxs(Button, { variant: "ghost", size: "sm", "aria-label": `Scope: ${scopeLabel}`, children: [_jsx(Filter, { className: "size-4" }), _jsx("span", { className: "hidden sm:inline", children: scopeLabel }), _jsx(ChevronDown, { className: "size-3.5", "aria-hidden": true })] }), children: [_jsx(MenuLabel, { children: "Scope" }), _jsx(MenuItem, { selected: scope === 'global', description: "Available in every workspace", onSelect: () => setScope('global'), children: "Global" }), (workspacesQuery.data?.workspaces.length ?? 0) > 0 ? _jsx(MenuSeparator, {}) : null, workspacesQuery.data?.workspaces.map((workspace) => (_jsx(MenuItem, { selected: scope === workspace.id, description: "Its own definitions, plus the global ones", onSelect: () => setScope(workspace.id), icon: _jsx("span", { className: "mt-0.5 block size-3 rounded-[4px]", style: { background: workspace.color }, "aria-hidden": true }), children: workspace.name }, workspace.id)))] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs(Tabs.Root, { value: tab, onValueChange: (value) => setTab(value), children: [_jsx(Tabs.List, { "aria-label": "Extension type", className: "sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-line bg-bg px-3 sm:px-6", children: [
                                { value: 'skills', label: 'Skills', icon: _jsx(Sparkles, { className: "size-4" }) },
                                { value: 'agents', label: 'Subagents', icon: _jsx(Bot, { className: "size-4" }) },
                                { value: 'mcp', label: 'MCP servers', icon: _jsx(Plug, { className: "size-4" }) },
                            ].map((entry) => (_jsxs(Tabs.Trigger, { value: entry.value, className: cn('flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 py-3', 'text-[13px] font-medium text-muted transition-colors hover:text-ink', 'data-[state=active]:border-accent data-[state=active]:text-accent'), children: [entry.icon, entry.label] }, entry.value))) }), _jsxs("div", { className: "mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-6", children: [_jsx(Tabs.Content, { value: "skills", className: "focus-visible:outline-none", children: _jsx(SkillsTab, { workspaceId: workspaceId, onChanged: () => invalidate('skills') }) }), _jsx(Tabs.Content, { value: "agents", className: "focus-visible:outline-none", children: _jsx(AgentsTab, { workspaceId: workspaceId, onChanged: () => invalidate('agents') }) }), _jsx(Tabs.Content, { value: "mcp", className: "focus-visible:outline-none", children: _jsx(McpTab, { workspaceId: workspaceId, onChanged: () => invalidate('mcp-servers') }) })] })] }) })] }));
}
function SkillsTab({ workspaceId, onChanged, }) {
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const query = useQuery({
        queryKey: ['skills', workspaceId ?? null],
        queryFn: () => api.skills(workspaceId),
    });
    const save = useMutation({
        mutationFn: (draft) => api.saveSkill({
            ...(draft.id ? { id: draft.id } : {}),
            workspaceId: workspaceId ?? null,
            name: draft.name.trim(),
            description: draft.description.trim(),
            body: draft.body,
            enabled: draft.enabled,
        }),
        onSuccess: (result) => {
            onChanged();
            setEditing(null);
            toast.success(`Saved “${result.skill.name}”`);
        },
        onError: (error) => toast.error(messageFor(error, 'Could not save that skill.')),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteSkill(id),
        onSuccess: () => {
            onChanged();
            toast.success('Skill deleted');
        },
        onError: (error) => toast.error(messageFor(error, 'Could not delete that skill.')),
    });
    const toggle = useMutation({
        mutationFn: (skill) => api.saveSkill({
            id: skill.id,
            workspaceId: skill.workspaceId,
            name: skill.name,
            description: skill.description,
            body: skill.body,
            enabled: !skill.enabled,
        }),
        onSuccess: () => onChanged(),
        onError: (error) => toast.error(messageFor(error, 'Could not change that skill.')),
    });
    const skills = query.data?.skills ?? [];
    return (_jsxs("div", { className: "space-y-4", children: [_jsx(SectionIntro, { description: "Enabled skills are written into the workspace's .claude/skills/ directory before every run, which is how the Claude CLI discovers them \u2014 nothing is injected into the prompt.", action: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setEditing({ name: '', description: '', body: SKILL_TEMPLATE, enabled: true }), children: [_jsx(Plus, { className: "size-4" }), "New skill"] }) }), query.isLoading ? (_jsx(ListSkeleton, {})) : skills.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Sparkles, {}), title: "No skills in this scope", description: "Write one, or accept a skill proposal from the Memory page \u2014 the reflexion pass drafts them from runs that went well." }) })) : (_jsx("div", { className: "space-y-3", children: skills.map((skill) => (_jsx(Card, { className: "p-4", children: _jsxs("div", { className: "flex flex-col gap-3 sm:flex-row sm:items-start", children: [_jsxs("div", { className: "min-w-0 flex-1 space-y-1.5", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("code", { className: "font-mono text-[13px] font-medium text-ink", children: skill.name }), skill.autoGenerated ? _jsx(Badge, { tone: "thinking", children: "auto-generated" }) : null, skill.workspaceId === null ? _jsx(Badge, { tone: "neutral", children: "global" }) : null, !skill.enabled ? _jsx(Badge, { tone: "neutral", children: "disabled" }) : null] }), _jsx("p", { className: "text-[13px] leading-relaxed text-muted", children: skill.description }), _jsxs("p", { className: "text-[11.5px] tabular-nums text-subtle", children: ["used ", skill.useCount, "\u00D7 \u00B7 updated ", formatRelative(skill.updatedAt)] })] }), _jsxs("div", { className: "flex items-center gap-2 sm:shrink-0", children: [_jsx(Toggle, { checked: skill.enabled, onChange: () => toggle.mutate(skill), label: `${skill.enabled ? 'Disable' : 'Enable'} skill ${skill.name}` }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => setEditing({
                                            id: skill.id,
                                            name: skill.name,
                                            description: skill.description,
                                            body: skill.body,
                                            enabled: skill.enabled,
                                        }), children: "Edit" }), _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": `Delete skill ${skill.name}`, onClick: () => setDeleting(skill), children: _jsx(Trash2, { className: "size-4" }) })] })] }) }, skill.id))) })), _jsx(SkillEditor, { draft: editing, busy: save.isPending, onClose: () => setEditing(null), onSubmit: (draft) => save.mutate(draft) }), _jsx(ConfirmDialog, { open: deleting !== null, onOpenChange: (open) => {
                    if (!open)
                        setDeleting(null);
                }, title: "Delete this skill?", description: _jsxs(_Fragment, { children: [_jsx("span", { className: "font-mono text-ink", children: deleting?.name }), " is removed from the registry and will not be written into any workspace again."] }), confirmLabel: "Delete skill", danger: true, onConfirm: async () => {
                    if (deleting)
                        await remove.mutateAsync(deleting.id);
                    setDeleting(null);
                } })] }));
}
const SKILL_TEMPLATE = `# When to use this

Describe the situation that should trigger this skill.

# How to do it

1. …
`;
function SkillEditor({ draft, busy, onClose, onSubmit, }) {
    const [value, setValue] = useState(draft ?? { name: '', description: '', body: '', enabled: true });
    useEffect(() => {
        if (draft)
            setValue(draft);
    }, [draft]);
    const nameError = value.name.length > 0 && !SKILL_NAME.test(value.name)
        ? 'Use lowercase letters, digits and dashes only, starting with a letter or digit — for example “review-migrations”. It becomes a directory name.'
        : null;
    const valid = SKILL_NAME.test(value.name) && value.description.trim().length > 0 && !busy;
    return (_jsx(Modal, { open: draft !== null, onOpenChange: (open) => {
            if (!open)
                onClose();
        }, title: draft?.id ? 'Edit skill' : 'New skill', description: "The description is what the model reads when deciding whether to open the skill, so make it say when to use it.", size: "lg", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: busy, disabled: !valid, onClick: () => onSubmit(value), children: "Save skill" })] }), children: _jsxs("div", { className: "space-y-4", children: [_jsxs(Label, { htmlFor: "skill-name", hint: "Lowercase and dashes; this is the directory name.", children: ["Name", _jsx(Input, { id: "skill-name", value: value.name, onChange: (event) => setValue({ ...value, name: event.target.value }), placeholder: "review-migrations", className: "mt-1.5 font-mono", "aria-invalid": nameError !== null, "aria-describedby": nameError ? 'skill-name-error' : undefined, maxLength: 64 })] }), nameError ? (_jsx("p", { id: "skill-name-error", role: "alert", className: "-mt-2 text-xs leading-relaxed text-danger", children: nameError })) : null, _jsxs(Label, { htmlFor: "skill-description", hint: "One sentence, written as a trigger condition.", children: ["Description", _jsx(Input, { id: "skill-description", value: value.description, onChange: (event) => setValue({ ...value, description: event.target.value }), placeholder: "Use when reviewing a database migration before it ships.", className: "mt-1.5", maxLength: 1024 })] }), _jsxs(Label, { htmlFor: "skill-body", hint: "Markdown. Written verbatim to SKILL.md.", children: ["Body", _jsx(Textarea, { id: "skill-body", value: value.body, onChange: (event) => setValue({ ...value, body: event.target.value }), rows: 16, className: "mt-1.5 font-mono text-[12.5px]", spellCheck: false })] }), _jsx(CheckboxRow, { checked: value.enabled, onChange: (enabled) => setValue({ ...value, enabled }), label: "Enabled", hint: "Disabled skills stay in the registry but are not written to disk." })] }) }));
}
const AGENT_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
function AgentsTab({ workspaceId, onChanged, }) {
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const query = useQuery({
        queryKey: ['agents', workspaceId ?? null],
        queryFn: () => api.agents(workspaceId),
    });
    const save = useMutation({
        mutationFn: (draft) => api.saveAgent({
            ...(draft.id ? { id: draft.id } : {}),
            workspaceId: workspaceId ?? null,
            name: draft.name.trim(),
            description: draft.description.trim(),
            prompt: draft.prompt,
            // Null and [] mean different things here: null inherits every tool,
            // an empty list would hand the subagent nothing at all.
            tools: parseList(draft.tools),
            model: draft.model.trim() === '' ? null : draft.model.trim(),
            enabled: draft.enabled,
        }),
        onSuccess: (result) => {
            onChanged();
            setEditing(null);
            toast.success(`Saved “${result.agent.name}”`);
        },
        onError: (error) => toast.error(messageFor(error, 'Could not save that subagent.')),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteAgent(id),
        onSuccess: () => {
            onChanged();
            toast.success('Subagent deleted');
        },
        onError: (error) => toast.error(messageFor(error, 'Could not delete that subagent.')),
    });
    const toggle = useMutation({
        mutationFn: (agent) => api.saveAgent({
            id: agent.id,
            workspaceId: agent.workspaceId,
            name: agent.name,
            description: agent.description,
            prompt: agent.prompt,
            tools: agent.tools,
            model: agent.model,
            enabled: !agent.enabled,
        }),
        onSuccess: () => onChanged(),
        onError: (error) => toast.error(messageFor(error, 'Could not change that subagent.')),
    });
    const agents = query.data?.agents ?? [];
    return (_jsxs("div", { className: "space-y-4", children: [_jsx(SectionIntro, { description: "A subagent runs in its own context window with its own prompt and tool budget, and reports a summary back. Use them to keep long side-quests out of the main transcript.", action: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setEditing({
                        name: '',
                        description: '',
                        prompt: '',
                        tools: '',
                        model: '',
                        enabled: true,
                    }), children: [_jsx(Plus, { className: "size-4" }), "New subagent"] }) }), query.isLoading ? (_jsx(ListSkeleton, {})) : agents.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Bot, {}), title: "No subagents in this scope", description: "Define one to give a recurring job \u2014 code review, release notes, dependency triage \u2014 its own instructions." }) })) : (_jsx("div", { className: "space-y-3", children: agents.map((agent) => (_jsx(Card, { className: "p-4", children: _jsxs("div", { className: "flex flex-col gap-3 sm:flex-row sm:items-start", children: [_jsxs("div", { className: "min-w-0 flex-1 space-y-1.5", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("code", { className: "font-mono text-[13px] font-medium text-ink", children: agent.name }), agent.workspaceId === null ? _jsx(Badge, { tone: "neutral", children: "global" }) : null, !agent.enabled ? _jsx(Badge, { tone: "neutral", children: "disabled" }) : null] }), _jsx("p", { className: "text-[13px] leading-relaxed text-muted", children: agent.description }), _jsxs("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle", children: [_jsxs("span", { children: ["model: ", _jsx("span", { className: "text-muted", children: agent.model ?? 'inherit' })] }), _jsxs("span", { children: ["tools:", ' ', _jsx("span", { className: "text-muted", children: agent.tools === null ? 'all tools' : agent.tools.join(', ') || 'none' })] })] })] }), _jsxs("div", { className: "flex items-center gap-2 sm:shrink-0", children: [_jsx(Toggle, { checked: agent.enabled, onChange: () => toggle.mutate(agent), label: `${agent.enabled ? 'Disable' : 'Enable'} subagent ${agent.name}` }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => setEditing({
                                            id: agent.id,
                                            name: agent.name,
                                            description: agent.description,
                                            prompt: agent.prompt,
                                            tools: agent.tools === null ? '' : agent.tools.join(', '),
                                            model: agent.model === null ? '' : String(agent.model),
                                            enabled: agent.enabled,
                                        }), children: "Edit" }), _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": `Delete subagent ${agent.name}`, onClick: () => setDeleting(agent), children: _jsx(Trash2, { className: "size-4" }) })] })] }) }, agent.id))) })), _jsx(AgentEditor, { draft: editing, busy: save.isPending, onClose: () => setEditing(null), onSubmit: (draft) => save.mutate(draft) }), _jsx(ConfirmDialog, { open: deleting !== null, onOpenChange: (open) => {
                    if (!open)
                        setDeleting(null);
                }, title: "Delete this subagent?", description: _jsxs(_Fragment, { children: [_jsx("span", { className: "font-mono text-ink", children: deleting?.name }), " is removed from the registry. Sessions that name it will fall back to the main agent."] }), confirmLabel: "Delete subagent", danger: true, onConfirm: async () => {
                    if (deleting)
                        await remove.mutateAsync(deleting.id);
                    setDeleting(null);
                } })] }));
}
function AgentEditor({ draft, busy, onClose, onSubmit, }) {
    const [value, setValue] = useState(draft ?? { name: '', description: '', prompt: '', tools: '', model: '', enabled: true });
    useEffect(() => {
        if (draft)
            setValue(draft);
    }, [draft]);
    const nameError = value.name.length > 0 && !AGENT_NAME.test(value.name)
        ? 'Use lowercase letters, digits and dashes only — for example “release-notes”. This is the name a run refers to.'
        : null;
    const valid = AGENT_NAME.test(value.name) &&
        value.description.trim().length > 0 &&
        value.prompt.trim().length > 0 &&
        !busy;
    return (_jsx(Modal, { open: draft !== null, onOpenChange: (open) => {
            if (!open)
                onClose();
        }, title: draft?.id ? 'Edit subagent' : 'New subagent', description: "The description tells the main agent when to delegate; the prompt is the subagent's entire system prompt.", size: "lg", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: busy, disabled: !valid, onClick: () => onSubmit(value), children: "Save subagent" })] }), children: _jsxs("div", { className: "space-y-4", children: [_jsxs(Label, { htmlFor: "agent-name", hint: "Lowercase and dashes.", children: ["Name", _jsx(Input, { id: "agent-name", value: value.name, onChange: (event) => setValue({ ...value, name: event.target.value }), placeholder: "release-notes", className: "mt-1.5 font-mono", "aria-invalid": nameError !== null, "aria-describedby": nameError ? 'agent-name-error' : undefined, maxLength: 64 })] }), nameError ? (_jsx("p", { id: "agent-name-error", role: "alert", className: "-mt-2 text-xs leading-relaxed text-danger", children: nameError })) : null, _jsxs(Label, { htmlFor: "agent-description", hint: "When should the main agent hand work to this one?", children: ["Description", _jsx(Input, { id: "agent-description", value: value.description, onChange: (event) => setValue({ ...value, description: event.target.value }), placeholder: "Summarises merged pull requests into release notes.", className: "mt-1.5", maxLength: 1024 })] }), _jsxs(Label, { htmlFor: "agent-prompt", hint: "The subagent's system prompt, in full.", children: ["Prompt", _jsx(Textarea, { id: "agent-prompt", value: value.prompt, onChange: (event) => setValue({ ...value, prompt: event.target.value }), rows: 14, className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "agent-model", hint: "Leave blank to inherit whatever the parent run is using.", children: ["Model", _jsxs("select", { id: "agent-model", value: value.model, onChange: (event) => setValue({ ...value, model: event.target.value }), className: "mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none", children: [_jsx("option", { value: "", children: "Inherit" }), AGENT_MODELS.map((model) => (_jsx("option", { value: model, children: model }, model)))] })] }), _jsxs(Label, { htmlFor: "agent-tools", hint: "Comma separated, e.g. Read, Grep, Glob. Leave blank to allow every tool the run has.", children: ["Tools", _jsx(Input, { id: "agent-tools", value: value.tools, onChange: (event) => setValue({ ...value, tools: event.target.value }), placeholder: "Read, Grep, Glob", className: "mt-1.5 font-mono" })] }), _jsx(CheckboxRow, { checked: value.enabled, onChange: (enabled) => setValue({ ...value, enabled }), label: "Enabled", hint: "Disabled subagents cannot be selected by a run." })] }) }));
}
function McpTab({ workspaceId, onChanged, }) {
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const query = useQuery({
        queryKey: ['mcp-servers', workspaceId ?? null],
        queryFn: () => api.mcpServers(workspaceId),
    });
    const save = useMutation({
        mutationFn: (draft) => api.saveMcpServer({
            ...(draft.id ? { id: draft.id } : {}),
            workspaceId: workspaceId ?? null,
            name: draft.name.trim(),
            transport: draft.transport,
            command: draft.transport === 'stdio' ? draft.command.trim() : null,
            args: draft.transport === 'stdio' ? parseArgs(draft.args) : [],
            url: draft.transport === 'stdio' ? null : draft.url.trim(),
            env: pairsToRecord(draft.env),
            headers: pairsToRecord(draft.headers),
            enabled: draft.enabled,
        }),
        onSuccess: (result) => {
            onChanged();
            setEditing(null);
            toast.success(`Saved “${result.server.name}”`, {
                description: 'The connection is retried on the next run in this workspace.',
            });
        },
        onError: (error) => toast.error(messageFor(error, 'Could not save that server.')),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteMcpServer(id),
        onSuccess: () => {
            onChanged();
            toast.success('Server deleted', { description: 'Its stored secrets were deleted with it.' });
        },
        onError: (error) => toast.error(messageFor(error, 'Could not delete that server.')),
    });
    const servers = query.data?.servers ?? [];
    return (_jsxs("div", { className: "space-y-4", children: [_jsx(SectionIntro, { description: "Each enabled server is started or connected at the beginning of a run, and its tools join the agent's tool list. A server that fails to connect is skipped rather than failing the run.", action: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setEditing({
                        name: '',
                        transport: 'stdio',
                        command: '',
                        args: '',
                        url: '',
                        env: [],
                        headers: [],
                        enabled: true,
                    }), children: [_jsx(Plus, { className: "size-4" }), "New server"] }) }), query.isLoading ? (_jsx(ListSkeleton, {})) : servers.length === 0 ? (_jsx(Card, { children: _jsx(EmptyState, { icon: _jsx(Plug, {}), title: "No MCP servers in this scope", description: "Connect one to give the agent tools this system does not ship with \u2014 a database, an issue tracker, an internal API." }) })) : (_jsx("div", { className: "space-y-3", children: servers.map((server) => (_jsx(Card, { className: "p-4", children: _jsxs("div", { className: "flex flex-col gap-3 sm:flex-row sm:items-start", children: [_jsxs("div", { className: "min-w-0 flex-1 space-y-1.5", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("code", { className: "font-mono text-[13px] font-medium text-ink", children: server.name }), _jsx(Badge, { tone: "info", children: server.transport }), _jsx(Badge, { tone: MCP_STATUS_TONE[server.status], children: server.status }), server.workspaceId === null ? _jsx(Badge, { tone: "neutral", children: "global" }) : null] }), _jsx("p", { className: "break-all font-mono text-[12px] leading-relaxed text-muted", children: server.transport === 'stdio'
                                            ? [server.command, ...server.args].filter(Boolean).join(' ') || '—'
                                            : (server.url ?? '—') }), server.envKeys.length > 0 ? (_jsxs("p", { className: "flex flex-wrap items-center gap-1 text-[11.5px] text-subtle", children: [_jsx(ShieldCheck, { className: "size-3.5", "aria-hidden": true }), server.envKeys.length, " encrypted secret", server.envKeys.length === 1 ? '' : 's', ": ", server.envKeys.join(', ')] })) : null, server.lastError ? (_jsx("p", { className: "rounded-lg border border-danger/25 bg-danger-soft px-2.5 py-1.5 text-[12px] leading-relaxed text-danger", children: server.lastError })) : null] }), _jsxs("div", { className: "flex items-center gap-2 sm:shrink-0", children: [_jsx(Toggle, { checked: server.enabled, onChange: () => setEditing({
                                            ...draftFromServer(server),
                                            enabled: !server.enabled,
                                        }), label: `${server.enabled ? 'Disable' : 'Enable'} server ${server.name}`, tooltip: `${server.enabled ? 'Disable' : 'Enable'} ${server.name} — opens the editor, because saving replaces this server's stored secrets` }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => setEditing(draftFromServer(server)), children: "Edit" }), _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": `Delete server ${server.name}`, onClick: () => setDeleting(server), children: _jsx(Trash2, { className: "size-4" }) })] })] }) }, server.id))) })), _jsx(McpEditor, { draft: editing, busy: save.isPending, onClose: () => setEditing(null), onSubmit: (draft) => save.mutate(draft) }), _jsx(ConfirmDialog, { open: deleting !== null, onOpenChange: (open) => {
                    if (!open)
                        setDeleting(null);
                }, title: "Delete this MCP server?", description: _jsxs(_Fragment, { children: [_jsx("span", { className: "font-mono text-ink", children: deleting?.name }), " is removed and its stored secrets are erased from the vault. Its tools disappear from every run in this scope."] }), confirmLabel: "Delete server", danger: true, onConfirm: async () => {
                    if (deleting)
                        await remove.mutateAsync(deleting.id);
                    setDeleting(null);
                } })] }));
}
/**
 * Secret *values* are never returned by the API, so an existing server's env
 * rows come back key-only with an empty value — see the notice in the editor.
 */
function draftFromServer(server) {
    return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command ?? '',
        args: server.args.join(' '),
        url: server.url ?? '',
        env: server.envKeys.map((key) => ({ key, value: '' })),
        headers: Object.entries(server.headers).map(([key, value]) => ({ key, value })),
        enabled: server.enabled,
    };
}
function McpEditor({ draft, busy, onClose, onSubmit, }) {
    const [value, setValue] = useState(draft ?? {
        name: '',
        transport: 'stdio',
        command: '',
        args: '',
        url: '',
        env: [],
        headers: [],
        enabled: true,
    });
    useEffect(() => {
        if (draft)
            setValue(draft);
    }, [draft]);
    const nameError = value.name.length > 0 && !MCP_NAME.test(value.name)
        ? 'Letters, digits, dashes and underscores only — this becomes the tool prefix the agent sees.'
        : null;
    const valid = MCP_NAME.test(value.name) &&
        (value.transport === 'stdio' ? value.command.trim().length > 0 : value.url.trim().length > 0) &&
        !busy;
    const isStdio = value.transport === 'stdio';
    return (_jsx(Modal, { open: draft !== null, onOpenChange: (open) => {
            if (!open)
                onClose();
        }, title: draft?.id ? 'Edit MCP server' : 'New MCP server', description: "Connection details are stored in the clear so they stay auditable; anything secret goes to the encrypted vault.", size: "lg", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: busy, disabled: !valid, onClick: () => onSubmit(value), children: "Save server" })] }), children: _jsxs("div", { className: "space-y-4", children: [_jsxs(Label, { htmlFor: "mcp-name", hint: "Prefixes every tool this server exposes.", children: ["Name", _jsx(Input, { id: "mcp-name", value: value.name, onChange: (event) => setValue({ ...value, name: event.target.value }), placeholder: "linear", className: "mt-1.5 font-mono", "aria-invalid": nameError !== null, "aria-describedby": nameError ? 'mcp-name-error' : undefined, maxLength: 64 })] }), nameError ? (_jsx("p", { id: "mcp-name-error", role: "alert", className: "-mt-2 text-xs leading-relaxed text-danger", children: nameError })) : null, _jsxs(Label, { htmlFor: "mcp-transport", hint: "stdio launches a local process; sse and http reach a remote one.", children: ["Transport", _jsxs("select", { id: "mcp-transport", value: value.transport, onChange: (event) => setValue({ ...value, transport: event.target.value }), className: "mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none", children: [_jsx("option", { value: "stdio", children: "stdio \u2014 local process" }), _jsx("option", { value: "sse", children: "sse \u2014 server-sent events" }), _jsx("option", { value: "http", children: "http \u2014 streamable HTTP" })] })] }), isStdio ? (_jsxs(_Fragment, { children: [_jsxs(Label, { htmlFor: "mcp-command", hint: "The executable, without its arguments.", children: ["Command", _jsx(Input, { id: "mcp-command", value: value.command, onChange: (event) => setValue({ ...value, command: event.target.value }), placeholder: "npx", className: "mt-1.5 font-mono", spellCheck: false })] }), _jsxs(Label, { htmlFor: "mcp-args", hint: "One per line, or separated by spaces.", children: ["Arguments", _jsx(Textarea, { id: "mcp-args", value: value.args, onChange: (event) => setValue({ ...value, args: event.target.value }), rows: 3, className: "mt-1.5 font-mono text-[12.5px]", placeholder: '-y\n@modelcontextprotocol/server-linear', spellCheck: false })] })] })) : (_jsxs(Label, { htmlFor: "mcp-url", hint: "Must be http or https.", children: ["URL", _jsx(Input, { id: "mcp-url", value: value.url, onChange: (event) => setValue({ ...value, url: event.target.value }), placeholder: "https://mcp.example.com/sse", className: "mt-1.5 font-mono", spellCheck: false, inputMode: "url" })] })), _jsxs("div", { className: "space-y-3 rounded-xl border border-warning/30 bg-warning-soft/40 p-3", children: [_jsxs("div", { className: "flex items-start gap-2", children: [_jsx(ShieldCheck, { className: "mt-0.5 size-4 shrink-0 text-warning", "aria-hidden": true }), _jsxs("div", { className: "space-y-1 text-[12.5px] leading-relaxed", children: [_jsx("p", { className: "font-medium text-ink", children: "Secrets are encrypted and never read back" }), _jsx("p", { className: "text-muted", children: "Values go into the encrypted vault; only the key names are stored on the record and only key names are ever returned. That is why every value box below is blank on an existing server \u2014 the value cannot be shown, not even to you." }), _jsx("p", { className: "text-muted", children: "Saving replaces this server's whole secret set, so re-enter the value for any key you want to keep. A key left blank is dropped." })] })] }), _jsx(PairEditor, { idPrefix: "mcp-env", legend: "Environment secrets", keyPlaceholder: "LINEAR_API_KEY", valuePlaceholder: "Paste the value", secret: true, pairs: value.env, onChange: (env) => setValue({ ...value, env }) })] }), _jsx(PairEditor, { idPrefix: "mcp-headers", legend: "Headers", hint: "Sent with every request. Not secret \u2014 these are stored and displayed in the clear.", keyPlaceholder: "X-Tenant", valuePlaceholder: "acme", pairs: value.headers, onChange: (headers) => setValue({ ...value, headers }) }), _jsx(CheckboxRow, { checked: value.enabled, onChange: (enabled) => setValue({ ...value, enabled }), label: "Enabled", hint: "Disabled servers are skipped when a run starts." })] }) }));
}
/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */
function SectionIntro({ description, action, }) {
    return (_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [_jsx("p", { className: "max-w-2xl text-xs leading-relaxed text-muted", children: description }), _jsx("div", { className: "shrink-0", children: action })] }));
}
function ListSkeleton() {
    return (_jsx("div", { className: "space-y-3", children: Array.from({ length: 3 }, (_, index) => (_jsx(Skeleton, { className: "h-24 rounded-xl" }, index))) }));
}
function Toggle({ checked, onChange, label, tooltip, }) {
    return (_jsx(Tooltip, { content: tooltip ?? label, children: _jsx("button", { type: "button", role: "switch", "aria-checked": checked, "aria-label": label, onClick: onChange, className: cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong'), children: _jsx("span", { className: cn('absolute top-0.5 size-4 rounded-full transition-[left]', checked ? 'left-[1.125rem] bg-accent-ink' : 'left-0.5 bg-surface'), "aria-hidden": true }) }) }));
}
function CheckboxRow({ checked, onChange, label, hint, }) {
    return (_jsxs("label", { className: "flex items-start gap-2.5 text-[13px] text-ink", children: [_jsx("input", { type: "checkbox", checked: checked, onChange: (event) => onChange(event.target.checked), className: "mt-0.5 size-4 accent-[var(--mc-accent)]" }), _jsxs("span", { children: [label, _jsx("span", { className: "mt-0.5 block text-xs text-muted", children: hint })] })] }));
}
/** Editable key/value list, used for both env secrets and plain headers. */
function PairEditor({ idPrefix, legend, hint, keyPlaceholder, valuePlaceholder, secret, pairs, onChange, }) {
    const update = (index, patch) => {
        onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
    };
    return (_jsxs("fieldset", { className: "space-y-2", children: [_jsx("legend", { className: "text-[13px] font-medium text-ink", children: legend }), hint ? _jsx("p", { className: "text-xs leading-relaxed text-muted", children: hint }) : null, pairs.length === 0 ? (_jsx("p", { className: "text-xs text-subtle", children: "None." })) : (_jsx("ul", { className: "space-y-2", children: pairs.map((pair, index) => (_jsxs("li", { className: "flex flex-col gap-2 sm:flex-row sm:items-center", children: [_jsx(Input, { value: pair.key, onChange: (event) => update(index, { key: event.target.value }), placeholder: keyPlaceholder, "aria-label": `${legend} name ${index + 1}`, className: "font-mono text-[12.5px] sm:flex-1" }), _jsx(Input, { value: pair.value, onChange: (event) => update(index, { value: event.target.value }), placeholder: valuePlaceholder, "aria-label": `${legend} value ${index + 1}`, type: secret ? 'password' : 'text', autoComplete: secret ? 'new-password' : 'off', className: "font-mono text-[12.5px] sm:flex-1" }), _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": `Remove ${pair.key || `entry ${index + 1}`}`, onClick: () => onChange(pairs.filter((_, i) => i !== index)), className: "self-end sm:self-auto", children: _jsx(X, { className: "size-4" }) })] }, index))) })), _jsxs(Button, { variant: "secondary", size: "xs", onClick: () => onChange([...pairs, { key: '', value: '' }]), id: `${idPrefix}-add`, children: [_jsx(Plus, { className: "size-3.5" }), "Add ", legend.toLowerCase()] })] }));
}
/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */
/** Comma-separated list, or `null` when blank — the two mean different things. */
function parseList(raw) {
    const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length > 0 ? items : null;
}
function parseArgs(raw) {
    return raw.split(/\s+/).filter(Boolean);
}
/** Drop incomplete rows: a key with no value would blank the stored secret. */
function pairsToRecord(pairs) {
    const record = {};
    for (const pair of pairs) {
        const key = pair.key.trim();
        if (key && pair.value !== '')
            record[key] = pair.value;
    }
    return record;
}
function messageFor(error, fallback) {
    return error instanceof ApiError ? error.message : fallback;
}
export { AgentsPage as default };
//# sourceMappingURL=AgentsPage.js.map