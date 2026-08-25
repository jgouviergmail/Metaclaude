import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Notification centre.
 *
 * Runs finish while the operator is on another screen — often on another
 * device — so completion, failure and "I learned something" notices collect
 * here rather than only appearing as transient toasts.
 */
import * as Popover from '@radix-ui/react-popover';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useNotificationStore } from '@/lib/store';
import { Button, EmptyState } from '@/components/ui/primitives';
import { cn, formatRelative } from '@/lib/utils';
export function NotificationBell() {
    const { items, markAllRead, clear } = useNotificationStore();
    const unread = items.filter((item) => !item.read).length;
    return (_jsxs(Popover.Root, { onOpenChange: (open) => open && markAllRead(), children: [_jsx(Popover.Trigger, { asChild: true, children: _jsxs("button", { type: "button", className: "relative flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-raised hover:text-ink", "aria-label": unread > 0 ? `Notifications (${unread} unread)` : 'Notifications', children: [_jsx(Bell, { className: "size-4", "aria-hidden": true }), unread > 0 ? (_jsx("span", { className: "absolute right-1 top-1 flex min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-[15px] text-accent-ink", children: unread > 9 ? '9+' : unread })) : null] }) }), _jsx(Popover.Portal, { children: _jsxs(Popover.Content, { side: "right", align: "end", sideOffset: 8, collisionPadding: 12, className: "animate-in-up z-50 flex max-h-[70vh] w-[min(22rem,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-[var(--mc-shadow-lg)]", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-line px-3 py-2", children: [_jsx("h3", { className: "text-[13px] font-semibold text-ink", children: "Notifications" }), items.length > 0 ? (_jsxs("div", { className: "flex items-center gap-1", children: [_jsx(Button, { variant: "ghost", size: "icon-sm", onClick: markAllRead, "aria-label": "Mark all read", children: _jsx(CheckCheck, { className: "size-3.5" }) }), _jsx(Button, { variant: "ghost", size: "icon-sm", onClick: clear, "aria-label": "Clear all", children: _jsx(Trash2, { className: "size-3.5" }) })] })) : null] }), _jsx("div", { className: "min-h-0 flex-1 overflow-y-auto", children: items.length === 0 ? (_jsx(EmptyState, { title: "Nothing yet", description: "Run results and things Metaclaude learns will show up here.", className: "py-10" })) : (_jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: items.map((item) => {
                                    const body = (_jsx(_Fragment, { children: _jsxs("div", { className: "flex items-start gap-2", children: [_jsx("span", { className: cn('mt-1.5 size-1.5 shrink-0 rounded-full', item.level === 'success' && 'bg-success', item.level === 'error' && 'bg-danger', item.level === 'warning' && 'bg-warning', item.level === 'info' && 'bg-info'), "aria-hidden": true }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "truncate text-[13px] font-medium text-ink", children: item.title }), _jsx("p", { className: "mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted", children: item.message })] }), _jsx("span", { className: "shrink-0 text-[10.5px] text-subtle", children: formatRelative(item.at) })] }) }));
                                    return (_jsx("li", { children: item.href ? (_jsx(Popover.Close, { asChild: true, children: _jsx(Link, { to: item.href, className: "block px-3 py-2.5 hover:bg-surface", children: body }) })) : (_jsx("div", { className: "px-3 py-2.5", children: body })) }, item.id));
                                }) })) })] }) })] }));
}
//# sourceMappingURL=NotificationBell.js.map