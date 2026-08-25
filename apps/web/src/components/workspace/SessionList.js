import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Session list for the workspace sidebar.
 *
 * Sessions are the unit people actually navigate between, so the row carries
 * everything needed to choose one at a glance — what it is, whether it is doing
 * something right now, and how recently it was touched — and nothing else.
 * The server sends the list already sorted (pinned first, then activity); this
 * component never reorders it, so a pin does not make rows jump before the
 * refetch confirms the change.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, MessageSquarePlus, MoreHorizontal, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Button, EmptyState, Input } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
export function SessionList({ workspaceId, activeSessionId, sessions, onCreate, creating, }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [filter, setFilter] = useState('');
    const [pendingDelete, setPendingDelete] = useState(null);
    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
    };
    const fail = (error, fallback) => {
        toast.error(error instanceof ApiError ? error.message : fallback);
    };
    const setPinned = useMutation({
        mutationFn: ({ id, pinned }) => api.updateSession(id, { pinned }),
        onSuccess: invalidate,
        onError: (error) => fail(error, 'Could not pin the session.'),
    });
    const archive = useMutation({
        mutationFn: (id) => api.updateSession(id, { archived: true }),
        onSuccess: (_data, id) => {
            invalidate();
            toast.success('Session archived');
            // Archiving drops the session out of the list; staying on it would leave
            // the transcript pointing at something the sidebar no longer offers.
            if (id === activeSessionId)
                navigate(`/w/${workspaceId}`);
        },
        onError: (error) => fail(error, 'Could not archive the session.'),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteSession(id),
        onSuccess: (_data, id) => {
            invalidate();
            toast.success('Session deleted');
            if (id === activeSessionId)
                navigate(`/w/${workspaceId}`, { replace: true });
        },
        onError: (error) => fail(error, 'Could not delete the session.'),
    });
    const visible = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle)
            return sessions;
        return sessions.filter((session) => sessionTitle(session).toLowerCase().includes(needle));
    }, [sessions, filter]);
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [_jsxs("div", { className: "shrink-0 space-y-2 border-b border-line px-3 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("h2", { className: "text-[11px] font-semibold uppercase tracking-wide text-subtle", children: "Sessions" }), _jsx("span", { className: "text-[11px] tabular-nums text-subtle", children: sessions.length }), _jsx(Button, { variant: "ghost", size: "icon-sm", className: "ml-auto", "aria-label": "New session", onClick: onCreate, loading: creating, children: creating ? null : _jsx(Plus, { className: "size-4" }) })] }), sessions.length > 5 ? (_jsxs("div", { className: "relative", children: [_jsx(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle", "aria-hidden": true }), _jsx(Input, { type: "search", value: filter, onChange: (event) => setFilter(event.target.value), placeholder: "Filter sessions", "aria-label": "Filter sessions", className: "h-8 pl-8 text-[13px]" })] })) : null] }), _jsx("nav", { className: "min-h-0 flex-1 overflow-y-auto p-2", "aria-label": "Sessions", children: sessions.length === 0 ? (_jsx(EmptyState, { icon: _jsx(MessageSquarePlus, {}), title: "No sessions yet", description: "Start one to give Metaclaude something to work on in this workspace.", action: _jsxs(Button, { variant: "primary", size: "sm", onClick: onCreate, loading: creating, children: [_jsx(Plus, { className: "size-4" }), "New session"] }), className: "py-10" })) : visible.length === 0 ? (_jsxs("p", { className: "px-3 py-8 text-center text-[13px] text-muted", children: ["No session matches \u201C", filter.trim(), "\u201D."] })) : (_jsx("ul", { className: "space-y-0.5", children: visible.map((session) => (_jsx(SessionRow, { session: session, workspaceId: workspaceId, active: session.id === activeSessionId, onTogglePin: () => setPinned.mutate({ id: session.id, pinned: !session.pinned }), onArchive: () => archive.mutate(session.id), onDelete: () => setPendingDelete(session) }, session.id))) })) }), _jsx(ConfirmDialog, { open: pendingDelete !== null, onOpenChange: (open) => {
                    if (!open)
                        setPendingDelete(null);
                }, title: "Delete this session?", description: _jsxs(_Fragment, { children: ["\u201C", pendingDelete ? sessionTitle(pendingDelete) : '', "\u201D and its run history are removed permanently. Files in the workspace are untouched."] }), confirmLabel: "Delete session", danger: true, onConfirm: async () => {
                    if (pendingDelete)
                        await remove.mutateAsync(pendingDelete.id);
                    setPendingDelete(null);
                } })] }));
}
function SessionRow({ session, workspaceId, active, onTogglePin, onArchive, onDelete, }) {
    const menuTrigger = useRef(null);
    const title = sessionTitle(session);
    return (_jsxs("li", { className: "group relative", onContextMenu: (event) => {
            event.preventDefault();
            // Radix opens the menu on pointerdown, not click, so a synthesised
            // click would be ignored — dispatch the event it actually listens for.
            menuTrigger.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        }, children: [_jsxs(Link, { to: `/w/${workspaceId}/s/${session.id}`, "aria-current": active ? 'page' : undefined, className: cn('block rounded-lg py-2 pl-2.5 pr-9 transition-colors', active ? 'bg-accent-soft' : 'hover:bg-raised'), children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [session.pinned ? (_jsx(Pin, { className: "size-3 shrink-0 text-subtle", "aria-label": "Pinned" })) : null, _jsx(StatusDot, { status: session.status }), _jsx("span", { className: cn('min-w-0 flex-1 truncate text-[13px] leading-tight', active ? 'font-medium text-ink' : 'text-muted group-hover:text-ink'), children: title })] }), _jsxs("div", { className: "mt-1 flex items-center gap-1.5 text-[11px] text-subtle", children: [_jsx("span", { children: formatRelative(session.lastActivityAt) }), _jsx("span", { "aria-hidden": true, children: "\u00B7" }), _jsxs("span", { className: "tabular-nums", children: [session.runCount, " ", session.runCount === 1 ? 'run' : 'runs'] })] })] }), _jsxs(Menu, { side: "bottom", align: "end", trigger: _jsx("button", { ref: menuTrigger, type: "button", "aria-label": `Actions for ${title}`, className: cn('absolute right-1 top-1.5 flex size-7 items-center justify-center rounded-md', 'text-subtle transition-colors hover:bg-raised hover:text-ink', 
                    // Kept mounted for keyboard and touch users; only the paint is hover-gated.
                    'opacity-0 focus-visible:opacity-100 group-hover:opacity-100', 'data-[state=open]:opacity-100', active && 'opacity-100'), children: _jsx(MoreHorizontal, { className: "size-4", "aria-hidden": true }) }), children: [_jsx(MenuItem, { icon: session.pinned ? _jsx(PinOff, {}) : _jsx(Pin, {}), onSelect: onTogglePin, children: session.pinned ? 'Unpin' : 'Pin to top' }), _jsx(MenuItem, { icon: _jsx(Archive, {}), onSelect: onArchive, children: "Archive" }), _jsx(MenuSeparator, {}), _jsx(MenuItem, { icon: _jsx(Trash2, {}), tone: "danger", onSelect: onDelete, children: "Delete" })] })] }));
}
/** Idle sessions get no dot at all — quiet is the common case and needs no ink. */
function StatusDot({ status }) {
    if (status === 'running') {
        return (_jsx("span", { role: "img", "aria-label": "Running", title: "Running", className: "pulse-ring relative size-1.5 shrink-0 rounded-full bg-accent" }));
    }
    if (status === 'waiting_approval') {
        return (_jsx("span", { role: "img", "aria-label": "Waiting for approval", title: "Waiting for approval", className: "size-1.5 shrink-0 rounded-full bg-warning" }));
    }
    if (status === 'error') {
        return (_jsx("span", { role: "img", "aria-label": "Failed", title: "Failed", className: "size-1.5 shrink-0 rounded-full bg-danger" }));
    }
    return null;
}
function sessionTitle(session) {
    return session.title || 'New session';
}
//# sourceMappingURL=SessionList.js.map