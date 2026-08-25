import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Workspace index — create, browse and archive projects.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderGit2, MoreVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Button, EmptyState, Input, Label, Skeleton, Textarea, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { colorForName, formatRelative, WORKSPACE_COLORS } from '@/lib/utils';
export function WorkspacesPage() {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const [showArchived, setShowArchived] = useState(false);
    const [creating, setCreating] = useState(false);
    const [pendingDelete, setPendingDelete] = useState(null);
    // `?new=1` lets the command palette deep-link straight into creation.
    useEffect(() => {
        if (searchParams.get('new') === '1') {
            setCreating(true);
            searchParams.delete('new');
            setSearchParams(searchParams, { replace: true });
        }
    }, [searchParams, setSearchParams]);
    const { data, isLoading } = useQuery({
        queryKey: ['workspaces', showArchived],
        queryFn: () => api.workspaces(showArchived),
    });
    const archive = useMutation({
        mutationFn: ({ id, archived }) => api.updateWorkspace(id, { archived }),
        onSuccess: (_, variables) => {
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            toast.success(variables.archived ? 'Workspace archived' : 'Workspace restored');
        },
    });
    const remove = useMutation({
        mutationFn: ({ id, purge }) => api.deleteWorkspace(id, purge),
        onSuccess: (_, variables) => {
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            toast.success(variables.purge ? 'Workspace and files deleted' : 'Workspace removed');
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not delete the workspace.'),
    });
    const workspaces = data?.workspaces ?? [];
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: "Workspaces", subtitle: "Each workspace is a project directory with its own agent policy and memory.", showSidebarToggle: false, actions: _jsxs(_Fragment, { children: [_jsxs(Button, { variant: "ghost", size: "sm", onClick: () => setShowArchived((value) => !value), "aria-pressed": showArchived, children: [_jsx(Archive, { className: "size-4", "aria-hidden": true }), showArchived ? 'Hide archived' : 'Show archived'] }), _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setCreating(true), children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "New"] })] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsx("div", { className: "mx-auto max-w-6xl p-4 sm:p-6", children: isLoading ? (_jsx("div", { className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3", children: Array.from({ length: 6 }, (_, i) => (_jsx(Skeleton, { className: "h-32" }, i))) })) : workspaces.length === 0 ? (_jsx(EmptyState, { icon: _jsx(FolderGit2, {}), title: "No workspaces", description: "Create one to give the agent a project directory to work in. You can start empty or clone a git repository.", action: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => setCreating(true), children: [_jsx(Plus, { className: "size-4", "aria-hidden": true }), "New workspace"] }) })) : (_jsx("ul", { className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3", children: workspaces.map((workspace) => (_jsxs("li", { className: "group relative", children: [_jsxs(Link, { to: `/w/${workspace.id}`, className: "block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx("span", { className: "size-10 shrink-0 rounded-lg", style: { background: workspace.color }, "aria-hidden": true }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "truncate text-sm font-semibold text-ink", children: workspace.name }), _jsx("p", { className: "truncate font-mono text-[11.5px] text-subtle", children: workspace.slug })] })] }), workspace.description ? (_jsx("p", { className: "mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-muted", children: workspace.description })) : null, _jsxs("div", { className: "mt-3 flex flex-wrap items-center gap-1.5", children: [workspace.archived ? _jsx(Badge, { tone: "warning", children: "archived" }) : null, workspace.settings.autoPolicyEnabled ? (_jsx(Badge, { tone: "thinking", children: "learning" })) : null, workspace.settings.defaultPermissionMode === 'bypassPermissions' ? (_jsx(Badge, { tone: "danger", children: "bypass" })) : null, _jsx("span", { className: "ml-auto text-[11px] text-subtle", children: formatRelative(workspace.updatedAt) })] })] }), _jsx("div", { className: "absolute right-2 top-2", children: _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsx("button", { type: "button", className: "flex size-7 items-center justify-center rounded-md text-subtle opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100", "aria-label": `Actions for ${workspace.name}`, children: _jsx(MoreVertical, { className: "size-4" }) }), children: [_jsx(MenuItem, { icon: _jsx(Archive, {}), onSelect: () => archive.mutate({ id: workspace.id, archived: !workspace.archived }), children: workspace.archived ? 'Restore' : 'Archive' }), _jsx(MenuSeparator, {}), _jsx(MenuItem, { icon: _jsx(Trash2, {}), tone: "danger", onSelect: () => setPendingDelete(workspace), children: "Delete" })] }) })] }, workspace.id))) })) }) }), _jsx(CreateWorkspaceModal, { open: creating, onOpenChange: setCreating }), _jsx(DeleteWorkspaceDialog, { workspace: pendingDelete, onClose: () => setPendingDelete(null), onConfirm: (purge) => {
                    if (pendingDelete)
                        remove.mutate({ id: pendingDelete.id, purge });
                } })] }));
}
/* -------------------------------------------------------------------------- */
function CreateWorkspaceModal({ open, onOpenChange, }) {
    const queryClient = useQueryClient();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [gitUrl, setGitUrl] = useState('');
    const [color, setColor] = useState(WORKSPACE_COLORS[0]);
    const [touchedColor, setTouchedColor] = useState(false);
    // Until the user picks a colour, derive one from the name so each new
    // workspace looks distinct without anyone having to choose.
    useEffect(() => {
        if (!touchedColor && name)
            setColor(colorForName(name));
    }, [name, touchedColor]);
    const create = useMutation({
        mutationFn: () => api.createWorkspace({
            name: name.trim(),
            description: description.trim(),
            color,
            ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}),
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            toast.success('Workspace created');
            onOpenChange(false);
            setName('');
            setDescription('');
            setGitUrl('');
            setTouchedColor(false);
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not create the workspace.'),
    });
    return (_jsx(Modal, { open: open, onOpenChange: onOpenChange, title: "New workspace", description: "A directory the agent can work in, with its own settings, memory and automations.", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: create.isPending, disabled: !name.trim(), onClick: () => create.mutate(), children: "Create" })] }), children: _jsxs("div", { className: "space-y-4", children: [_jsxs(Label, { htmlFor: "ws-name", children: ["Name", _jsx(Input, { id: "ws-name", value: name, onChange: (event) => setName(event.target.value), placeholder: "Payments service", autoFocus: true, className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "ws-description", children: ["Description", _jsx(Textarea, { id: "ws-description", value: description, onChange: (event) => setDescription(event.target.value), placeholder: "What this project is, in one line.", rows: 2, className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "ws-git", hint: "Optional. Leave blank to start from an empty directory with a starter CLAUDE.md.", children: ["Clone a repository", _jsx(Input, { id: "ws-git", value: gitUrl, onChange: (event) => setGitUrl(event.target.value), placeholder: "https://github.com/you/project.git", className: "mt-1.5 font-mono text-[13px]" })] }), _jsxs("fieldset", { children: [_jsx("legend", { className: "mb-1.5 text-[13px] font-medium text-ink", children: "Colour" }), _jsx("div", { className: "flex flex-wrap gap-2", children: WORKSPACE_COLORS.map((swatch) => (_jsx("button", { type: "button", onClick: () => {
                                    setColor(swatch);
                                    setTouchedColor(true);
                                }, "aria-label": `Use colour ${swatch}`, "aria-pressed": color === swatch, className: "size-7 rounded-lg ring-offset-2 ring-offset-[var(--mc-surface)] transition-all data-[active=true]:ring-2 data-[active=true]:ring-[var(--mc-accent)]", "data-active": color === swatch, style: { background: swatch } }, swatch))) })] })] }) }));
}
function DeleteWorkspaceDialog({ workspace, onClose, onConfirm, }) {
    const [purge, setPurge] = useState(false);
    useEffect(() => {
        if (workspace)
            setPurge(false);
    }, [workspace]);
    return (_jsx(ConfirmDialog, { open: Boolean(workspace), onOpenChange: (open) => !open && onClose(), title: `Delete "${workspace?.name ?? ''}"?`, confirmLabel: purge ? 'Delete workspace and files' : 'Delete workspace', danger: true, onConfirm: () => onConfirm(purge), description: _jsxs("div", { className: "space-y-3", children: [_jsx("p", { children: "Its sessions, transcripts, memories and automations are removed permanently." }), _jsxs("label", { className: "flex cursor-pointer items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/30 p-3", children: [_jsx("input", { type: "checkbox", checked: purge, onChange: (event) => setPurge(event.target.checked), className: "mt-0.5 size-3.5 accent-[var(--mc-danger)]" }), _jsxs("span", { className: "text-[12.5px] leading-relaxed", children: [_jsx("span", { className: "font-medium text-ink", children: "Also delete the files on disk" }), _jsx("br", {}), "Everything under", ' ', _jsx("code", { className: "font-mono text-[11.5px]", children: workspace?.path }), " is erased. This cannot be undone. Leave this unchecked to keep the files and only forget the workspace."] })] })] }) }));
}
//# sourceMappingURL=WorkspacesPage.js.map