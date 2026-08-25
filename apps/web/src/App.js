import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Router and the live-connection lifecycle.
 *
 * The socket is owned here rather than by a page, because notifications and run
 * state must keep arriving while the operator is on any screen — that is the
 * difference between a chat window and an OS.
 */
import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { SYSTEM_TOPIC } from '@metaclaude/shared';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { Spinner } from '@/components/ui/primitives';
import { api, setUnauthenticatedHandler } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useAuthStore, useNotificationStore, useSessionStore, useUiStore, } from '@/lib/store';
import { AgentsPage } from '@/pages/AgentsPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { AutomationsPage } from '@/pages/AutomationsPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { LoginPage } from '@/pages/LoginPage';
import { MemoryPage } from '@/pages/MemoryPage';
import { SessionPage } from '@/pages/SessionPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { WorkspacePage } from '@/pages/WorkspacePage';
import { WorkspacesPage } from '@/pages/WorkspacesPage';
export function App() {
    const navigate = useNavigate();
    const { status, setUser } = useAuthStore();
    const addNotification = useNotificationStore((state) => state.add);
    const applyTheme = useUiStore((state) => state.theme);
    /* --------------------------- Session bootstrap --------------------------- */
    useEffect(() => {
        setUnauthenticatedHandler(() => {
            setUser(null);
            socket.dispose();
            navigate('/login', { replace: true });
        });
        // `quiet` so the probe itself does not trigger the redirect above — an
        // anonymous first load is expected, not an error.
        api
            .me({ quiet: true })
            .then((response) => setUser(response.user, response.recoveryCodesRemaining))
            .catch(() => setUser(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    /* ------------------------- Theme system listener ------------------------- */
    useEffect(() => {
        if (applyTheme !== 'system')
            return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const sync = () => {
            document.documentElement.classList.toggle('dark', media.matches);
        };
        sync();
        media.addEventListener('change', sync);
        return () => media.removeEventListener('change', sync);
    }, [applyTheme]);
    /* ----------------------------- Live socket ------------------------------- */
    useEffect(() => {
        if (status !== 'authenticated')
            return;
        socket.revive();
        const unsubscribeSystem = socket.subscribe(SYSTEM_TOPIC);
        const store = useSessionStore.getState();
        const unbindState = socket.onState((state) => useSessionStore.getState().setConnection(state));
        const unbindFrames = socket.onFrame((frame) => {
            const session = useSessionStore.getState();
            switch (frame.type) {
                case 'transcript':
                    session.applyEvent(frame.event);
                    break;
                case 'delta':
                    session.applyDelta(frame.eventId, frame.channel, frame.text);
                    break;
                case 'run':
                    session.applyRun(frame.run);
                    break;
                case 'session':
                    session.applySession(frame.session);
                    break;
                case 'approval_request':
                    session.addApproval(frame.request);
                    // Mirrored on the system topic too, so this fires wherever the user is.
                    if (frame.topic === SYSTEM_TOPIC) {
                        addNotification({
                            level: frame.request.risk === 'high' ? 'error' : 'warning',
                            title: 'Permission needed',
                            message: frame.request.summary,
                            href: `/w/${frame.request.workspaceId}/s/${frame.request.sessionId}`,
                        });
                    }
                    break;
                case 'approval_resolved':
                    session.resolveApproval(frame.approvalId);
                    break;
                case 'notification':
                    addNotification({
                        level: frame.level,
                        title: frame.title,
                        message: frame.message,
                        href: frame.href,
                    });
                    // Only failures interrupt with a toast; success is recorded quietly.
                    if (frame.level === 'error')
                        toast.error(frame.title, { description: frame.message });
                    break;
                case 'error':
                    toast.error(frame.message);
                    break;
                default:
                    break;
            }
        });
        return () => {
            unsubscribeSystem();
            unbindFrames();
            unbindState();
            void store;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);
    /* -------------------------------- Render --------------------------------- */
    if (status === 'loading') {
        return (_jsx("div", { className: "flex h-full items-center justify-center bg-bg", children: _jsx(Spinner, { className: "size-6" }) }));
    }
    if (status === 'anonymous') {
        return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/login", replace: true }) })] }));
    }
    return (_jsxs(_Fragment, { children: [_jsx(CommandPalette, {}), _jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(Navigate, { to: "/", replace: true }) }), _jsx(Route, { path: "/", element: _jsx(DashboardPage, {}) }), _jsx(Route, { path: "/workspaces", element: _jsx(WorkspacesPage, {}) }), _jsx(Route, { path: "/w/:workspaceId", element: _jsx(WorkspacePage, {}) }), _jsx(Route, { path: "/w/:workspaceId/s/:sessionId", element: _jsx(SessionPage, {}) }), _jsx(Route, { path: "/memory", element: _jsx(MemoryPage, {}) }), _jsx(Route, { path: "/automations", element: _jsx(AutomationsPage, {}) }), _jsx(Route, { path: "/agents", element: _jsx(AgentsPage, {}) }), _jsx(Route, { path: "/analytics", element: _jsx(AnalyticsPage, {}) }), _jsx(Route, { path: "/settings", element: _jsx(SettingsPage, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] })] }));
}
//# sourceMappingURL=App.js.map