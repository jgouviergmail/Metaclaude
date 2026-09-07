/**
 * Router and the live-connection lifecycle.
 *
 * The socket is owned here rather than by a page, because notifications and run
 * state must keep arriving while the operator is on any screen — that is the
 * difference between a chat window and an OS.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { SYSTEM_TOPIC } from '@metaclaude/shared';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { Spinner } from '@/components/ui/primitives';
import { api, setUnauthenticatedHandler } from '@/lib/api';
import { applyAppBadge } from '@/lib/push';
import { socket } from '@/lib/socket';
import {
  useAuthStore,
  useNotificationStore,
  useSessionStore,
  useUiStore,
} from '@/lib/store';
import { DashboardPage } from '@/pages/DashboardPage';
import { LoginPage } from '@/pages/LoginPage';
import { routePattern, routes } from '@metaclaude/shared';

// Login and the dashboard stay eager: one is the first screen an anonymous
// visitor sees, the other is where every authenticated load lands, and making
// either wait on a second round trip buys nothing. Everything else is split.
//
// The measurable half of this is the chart library, which only Analytics uses.
// Imported statically it was preloaded by index.html on every page — 114 kB
// gzipped of plotting code fetched to render a sign-in form on a phone.
const lazyPage = <K extends string>(load: () => Promise<Record<K, ComponentType>>, key: K) =>
  lazy(async () => ({ default: (await load())[key] }));

const AgentsPage = lazyPage(() => import('@/pages/AgentsPage'), 'AgentsPage');
const AnalyticsPage = lazyPage(() => import('@/pages/AnalyticsPage'), 'AnalyticsPage');
const HelpPage = lazyPage(() => import('@/pages/HelpPage'), 'HelpPage');
const AutomationsPage = lazyPage(() => import('@/pages/AutomationsPage'), 'AutomationsPage');
const BoardPage = lazyPage(() => import('@/pages/BoardPage'), 'BoardPage');
const MemoryPage = lazyPage(() => import('@/pages/MemoryPage'), 'MemoryPage');
const PluginsPage = lazyPage(() => import('@/pages/PluginsPage'), 'PluginsPage');
const SessionPage = lazyPage(() => import('@/pages/SessionPage'), 'SessionPage');
const SettingsPage = lazyPage(() => import('@/pages/SettingsPage'), 'SettingsPage');
const WorkspacePage = lazyPage(() => import('@/pages/WorkspacePage'), 'WorkspacePage');
const WorkspacesPage = lazyPage(() => import('@/pages/WorkspacesPage'), 'WorkspacesPage');

/** The one notification this app raises itself; the rest carry server copy. */
const APPROVAL_NEEDED = 'Permission needed';

export function App() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { status, setUser } = useAuthStore();
  const addNotification = useNotificationStore((state) => state.add);
  const applyTheme = useUiStore((state) => state.theme);

  /* --------------------------- Session bootstrap --------------------------- */

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null);
      socket.dispose();
      navigate(routes.login(), { replace: true });
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
    if (applyTheme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => {
      document.documentElement.classList.toggle('dark', media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [applyTheme]);

  /* ----------------------------- Live socket ------------------------------- */

  useEffect(() => {
    if (status !== 'authenticated') return;

    socket.revive();
    const unsubscribeSystem = socket.subscribe(SYSTEM_TOPIC);

    const store = useSessionStore.getState();
    const unbindState = socket.onState((state) => useSessionStore.getState().setConnection(state));

    const unbindFrames = socket.onFrame((frame) => {
      const session = useSessionStore.getState();

      switch (frame.type) {
        case 'transcript':
          session.applyEvent(frame.topic, frame.event);
          break;
        case 'delta':
          session.applyDelta(frame.topic, frame.eventId, frame.channel, frame.text);
          break;
        case 'run':
          session.applyRun(frame.run);
          // A finished run is what moves every derived number: cost and usage
          // on Analytics, the bandit's arms, whatever reflexion just wrote to
          // Memory and Insights. None of those screens receives a frame of its
          // own, so without this they would sit on stale figures until the next
          // poll — the operator watches a run end and the dashboard disagrees.
          if (
            frame.run.status === 'succeeded' ||
            frame.run.status === 'failed' ||
            frame.run.status === 'interrupted'
          ) {
            for (const key of ['analytics', 'memory', 'insights', 'approvals'] as const) {
              void queryClient.invalidateQueries({ queryKey: [key] });
            }
          }
          break;
        case 'session':
          session.applySession(frame.session);
          // The sidebar renders from the workspace query, not the live store,
          // so a session renamed by its first prompt would stay "New session"
          // there until something else refetched.
          void queryClient.invalidateQueries({
            queryKey: ['workspace', frame.session.workspaceId],
          });
          break;
        case 'approval_request':
          session.addApproval(frame.request);
          // Mirrored on the system topic too, so this fires wherever the user is.
          if (frame.topic === SYSTEM_TOPIC) {
            addNotification({
              level: frame.request.risk === 'high' ? 'error' : 'warning',
              // English as data: the bell translates at render, which is what
              // keeps a notification raised before a language switch readable
              // after it. See the note in `lib/i18n.tsx`.
              title: APPROVAL_NEEDED,
              message: frame.request.summary,
              href: routes.session(frame.request.workspaceId, frame.request.sessionId),
            });
            // The app-icon badge counts from the server's list, not the
            // session store — refresh it the moment the count changed.
            void queryClient.invalidateQueries({ queryKey: ['approvals'] });
          }
          break;
        case 'approval_resolved':
          session.resolveApproval(frame.approvalId);
          void queryClient.invalidateQueries({ queryKey: ['approvals'] });
          break;
        case 'notification':
          addNotification({
            level: frame.level,
            title: frame.title,
            message: frame.message,
            href: frame.href,
          });
          // Only failures interrupt with a toast; success is recorded quietly.
          if (frame.level === 'error') toast.error(frame.title, { description: frame.message });
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

  /* ----------------------- App-icon badge (approvals) ----------------------- */

  // The installed PWA's icon shows how many decisions wait. The server is
  // the truth — the session store only holds the open session plus what
  // arrived live — refreshed by the approval frames above and by run ends,
  // with a slow poll as the safety net for a missed frame.
  const approvalsQuery = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.approvals(),
    enabled: status === 'authenticated',
    refetchInterval: 120_000,
  });
  const pendingApprovals = approvalsQuery.data?.approvals.length ?? 0;
  useEffect(() => {
    applyAppBadge(navigator as Parameters<typeof applyAppBadge>[0], pendingApprovals);
  }, [pendingApprovals]);

  /* -------------------------------- Render --------------------------------- */

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path={routes.login()} element={<LoginPage />} />
        <Route path="*" element={<Navigate to={routes.login()} replace />} />
      </Routes>
    );
  }

  return (
    <>
      <CommandPalette />
      {/* One boundary around the table rather than one per route: navigating
          between split pages should read as a single transition, not as ten
          independent ones that each flash their own spinner. */}
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-bg">
            <Spinner className="size-6" />
          </div>
        }
      >
        <Routes>
          <Route path={routes.login()} element={<Navigate to={routes.dashboard()} replace />} />
          <Route path={routes.dashboard()} element={<DashboardPage />} />
          <Route path={routes.workspaces()} element={<WorkspacesPage />} />
          <Route path={routePattern.workspace} element={<WorkspacePage />} />
          <Route path={routePattern.session} element={<SessionPage />} />
          <Route path={routes.board()} element={<BoardPage />} />
          <Route path={routes.memory()} element={<MemoryPage />} />
          <Route path={routes.automations()} element={<AutomationsPage />} />
          <Route path={routes.agents()} element={<AgentsPage />} />
          <Route path={routes.plugins()} element={<PluginsPage />} />
          <Route path={routes.analytics()} element={<AnalyticsPage />} />
          <Route path={routes.help()} element={<HelpPage />} />
          <Route path={routes.settings()} element={<SettingsPage />} />
          <Route path="*" element={<Navigate to={routes.dashboard()} replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
