import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Application shell.
 *
 * One layout, three form factors:
 *  - Phone: a bottom tab bar; panels become full-screen sheets.
 *  - Tablet: the icon rail, with the contextual sidebar as an overlay.
 *  - Desktop: rail + persistent sidebar + content.
 *
 * The rail is the OS-level navigation (which subsystem am I in); the sidebar is
 * contextual (which session, which file). Keeping those separate is what makes
 * the app navigable with one thumb on a phone.
 */
import { Activity, Bot, Brain, FolderGit2, LayoutDashboard, Menu as MenuIcon, Settings, Timer, } from 'lucide-react';
import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/primitives';
import { ConnectionBadge } from './ConnectionBadge';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
const NAV = [
    { to: '/', label: 'Dashboard', icon: _jsx(LayoutDashboard, {}), primary: true },
    { to: '/workspaces', label: 'Workspaces', icon: _jsx(FolderGit2, {}), primary: true },
    { to: '/memory', label: 'Memory', icon: _jsx(Brain, {}), primary: true },
    { to: '/automations', label: 'Automations', icon: _jsx(Timer, {}), primary: true },
    { to: '/agents', label: 'Agents & skills', icon: _jsx(Bot, {}) },
    { to: '/analytics', label: 'Analytics', icon: _jsx(Activity, {}) },
    { to: '/settings', label: 'Settings', icon: _jsx(Settings, {}), primary: true },
];
export function AppShell({ sidebar, children, }) {
    const { sidebarOpen, setSidebar } = useUiStore();
    const location = useLocation();
    // On a phone the sidebar is an overlay; navigating must dismiss it, or the
    // user lands on a new screen still covered by the old panel.
    useEffect(() => {
        if (window.matchMedia('(max-width: 1023px)').matches)
            setSidebar(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname]);
    return (_jsxs("div", { className: "flex h-full overflow-hidden bg-bg text-ink", children: [_jsxs("nav", { className: "hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3 sm:flex", "aria-label": "Sections", children: [_jsx(NavLink, { to: "/", className: "mb-3 flex size-9 items-center justify-center", "aria-label": "Metaclaude", children: _jsx(Logo, {}) }), NAV.map((entry) => (_jsx(Tooltip, { content: entry.label, side: "right", children: _jsx(NavLink, { to: entry.to, end: entry.to === '/', className: ({ isActive }) => cn('flex size-9 items-center justify-center rounded-lg transition-colors', '[&>svg]:size-[18px]', isActive
                                ? 'bg-accent-soft text-accent'
                                : 'text-subtle hover:bg-raised hover:text-ink'), "aria-label": entry.label, children: entry.icon }) }, entry.to))), _jsxs("div", { className: "mt-auto flex flex-col items-center gap-2", children: [_jsx(ConnectionBadge, {}), _jsx(NotificationBell, {}), _jsx(UserMenu, {})] })] }), sidebar ? (_jsxs(_Fragment, { children: [_jsx("aside", { className: cn('w-72 shrink-0 border-r border-line bg-surface', 'hidden lg:flex lg:flex-col', !sidebarOpen && 'lg:hidden'), "aria-label": "Context", children: sidebar }), sidebarOpen ? (_jsxs("div", { className: "fixed inset-0 z-40 lg:hidden", children: [_jsx("button", { type: "button", className: "absolute inset-0 bg-black/50", onClick: () => setSidebar(false), "aria-label": "Close panel" }), _jsx("aside", { className: "animate-in-up absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-surface shadow-[var(--mc-shadow-lg)]", children: sidebar })] })) : null] })) : null, _jsx("main", { className: "flex min-w-0 flex-1 flex-col pb-14 sm:pb-0", children: children }), _jsx("nav", { className: "fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-line bg-surface/95 backdrop-blur sm:hidden", style: { paddingBottom: 'env(safe-area-inset-bottom)' }, "aria-label": "Sections", children: NAV.filter((entry) => entry.primary).map((entry) => (_jsxs(NavLink, { to: entry.to, end: entry.to === '/', className: ({ isActive }) => cn('flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium', '[&>svg]:size-[19px]', isActive ? 'text-accent' : 'text-subtle'), children: [entry.icon, entry.label.split(' ')[0]] }, entry.to))) })] }));
}
/** Toolbar button that reveals the contextual sidebar on narrow screens. */
export function SidebarToggle({ className }) {
    const toggleSidebar = useUiStore((state) => state.toggleSidebar);
    return (_jsx("button", { type: "button", onClick: toggleSidebar, className: cn('flex size-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink', className), "aria-label": "Toggle panel", children: _jsx(MenuIcon, { className: "size-4" }) }));
}
/** Header used by the session view and other full-width screens. */
export function ContentHeader({ title, subtitle, actions, showSidebarToggle = true, icon, }) {
    return (_jsxs("header", { className: "flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4", children: [showSidebarToggle ? _jsx(SidebarToggle, {}) : null, icon ? _jsx("span", { className: "shrink-0 [&>svg]:size-4", children: icon }) : null, _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("h1", { className: "truncate text-sm font-semibold text-ink", children: title }), subtitle ? _jsx("p", { className: "truncate text-[11.5px] text-muted", children: subtitle }) : null] }), actions ? _jsx("div", { className: "flex shrink-0 items-center gap-1.5", children: actions }) : null, _jsxs("div", { className: "flex items-center gap-1 sm:hidden", children: [_jsx(ConnectionBadge, {}), _jsx(NotificationBell, {})] })] }));
}
function Logo() {
    return (_jsxs("svg", { viewBox: "0 0 32 32", className: "size-7", "aria-hidden": true, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "mc-logo", x1: "0", y1: "0", x2: "1", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: "var(--mc-accent)" }), _jsx("stop", { offset: "100%", stopColor: "var(--mc-thinking)" })] }) }), _jsx("circle", { cx: "16", cy: "16", r: "11", fill: "none", stroke: "url(#mc-logo)", strokeWidth: "3", strokeLinecap: "round", strokeDasharray: "52 17", transform: "rotate(-45 16 16)" }), _jsx("circle", { cx: "16", cy: "16", r: "3.5", fill: "url(#mc-logo)" })] }));
}
//# sourceMappingURL=AppShell.js.map