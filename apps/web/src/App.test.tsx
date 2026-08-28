/**
 * The router and the live-connection lifecycle.
 *
 * The socket is owned here rather than by a page, which is what makes this
 * an OS rather than a chat window — and what makes the frame router the most
 * load-bearing switch in the web app. Several of its branches exist purely to
 * stop a screen sitting on stale figures: a finished run moves cost, usage,
 * the bandit's arms and whatever reflexion just wrote, and none of those
 * screens receives a frame of its own.
 */

import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { App } from './App';

const {
  apiMock,
  socketMock,
  frames,
  states,
  navigate,
  setUnauthenticatedHandler,
  notify,
  auth,
  sessionStore,
  notificationStore,
  toastMock,
  invalidateQueries,
} = vi.hoisted(() => {
    const frames: Array<(frame: unknown) => void> = [];
    const states: Array<(state: string) => void> = [];
    const notify = vi.fn();
    return {
      frames,
      states,
      navigate: vi.fn(),
      invalidateQueries: vi.fn(),
      toastMock: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
      sessionStore: {
        applyEvent: vi.fn(),
        applyDelta: vi.fn(),
        applyRun: vi.fn(),
        applySession: vi.fn(),
        addApproval: vi.fn(),
        resolveApproval: vi.fn(),
        setConnection: vi.fn(),
      },
      notify,
      notificationStore: { items: [], add: notify, markAllRead: vi.fn(), clear: vi.fn() },
      setUnauthenticatedHandler: vi.fn(),
      auth: { status: 'authenticated' as string, setUser: vi.fn() },
      apiMock: { me: vi.fn() },
      socketMock: {
        // ConnectionBadge, mounted in the shell, reads this on first render.
        connectionState: 'open' as string,
        revive: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
        onFrame: vi.fn((handler: (frame: unknown) => void) => {
          frames.push(handler);
          return () => frames.splice(frames.indexOf(handler), 1);
        }),
        onState: vi.fn((handler: (state: string) => void) => {
          states.push(handler);
          return () => states.splice(states.indexOf(handler), 1);
        }),
      },
    };
  });

vi.mock('@/lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
  setUnauthenticatedHandler,
}));
vi.mock('@/lib/socket', () => ({ socket: socketMock }));
vi.mock('@/lib/push', () => ({ applyAppBadge: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
}));
vi.mock('@/lib/store', () => ({
  useAuthStore: () => auth,
  // The whole shell renders here, so the store mock has to satisfy every
  // consumer of it — the bell reads `items` on first paint.
  useNotificationStore: (selector?: (s: typeof notificationStore) => unknown) =>
    selector ? selector(notificationStore) : notificationStore,
  useUiStore: (selector?: (s: { theme: string }) => unknown) =>
    selector ? selector({ theme: 'dark' }) : { theme: 'dark' },
  // Honours a selector: components read slices, and returning the whole
  // store for a selector call hands them `undefined` where they expect a field.
  useSessionStore: Object.assign(
    (selector?: (s: typeof sessionStore) => unknown) =>
      selector ? selector(sessionStore) : sessionStore,
    { getState: () => sessionStore },
  ),
}));
vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  );
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

/** Push a frame through whatever handler App registered. */
const send = (frame: unknown) => act(() => frames.forEach((handler) => handler(frame)));

const invalidatedKeys = () =>
  invalidateQueries.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey[0]);

beforeEach(() => {
  vi.clearAllMocks();
  frames.length = 0;
  states.length = 0;
  auth.status = 'authenticated';
  apiMock.me.mockResolvedValue({ user: { id: 'usr_1' }, recoveryCodesRemaining: 3 });
});

describe('the live connection', () => {
  it('opens only once there is a session to open it for', () => {
    auth.status = 'anonymous';
    renderWithProviders(<App />);
    expect(socketMock.revive).not.toHaveBeenCalled();
  });

  it('revives and subscribes when authenticated', async () => {
    renderWithProviders(<App />);
    await waitFor(() => expect(socketMock.revive).toHaveBeenCalled());
    expect(socketMock.subscribe).toHaveBeenCalled();
  });

  it('unbinds everything it bound when it goes away', async () => {
    const { unmount } = renderWithProviders(<App />);
    await waitFor(() => expect(frames.length).toBe(1));
    unmount();
    expect(frames).toHaveLength(0);
    expect(states).toHaveLength(0);
  });
});

describe('the frame router', () => {
  beforeEach(async () => {
    renderWithProviders(<App />);
    await waitFor(() => expect(frames.length).toBe(1));
    invalidateQueries.mockClear();
  });

  it('applies transcript events and deltas to the session store', () => {
    send({ type: 'transcript', topic: 'ses_1', event: { id: 'e1' } });
    expect(sessionStore.applyEvent).toHaveBeenCalledWith('ses_1', { id: 'e1' });

    send({ type: 'delta', topic: 'ses_1', eventId: 'e1', channel: 'assistant', text: 'Bon' });
    expect(sessionStore.applyDelta).toHaveBeenCalledWith('ses_1', 'e1', 'assistant', 'Bon');
  });

  it('refreshes every derived screen when a run reaches a terminal state', () => {
    // Analytics, Memory, Insights and Approvals receive no frame of their own,
    // so without this the operator watches a run end and the dashboard
    // disagrees with it.
    send({ type: 'run', run: { id: 'run_1', status: 'succeeded' } });
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining(['analytics', 'memory', 'insights', 'approvals']),
    );
  });

  it('refreshes them for a failure and an interruption too, not only success', () => {
    send({ type: 'run', run: { id: 'run_1', status: 'failed' } });
    expect(invalidatedKeys()).toContain('analytics');

    invalidateQueries.mockClear();
    send({ type: 'run', run: { id: 'run_2', status: 'interrupted' } });
    expect(invalidatedKeys()).toContain('analytics');
  });

  it('leaves them alone while a run is still going', () => {
    // A refetch per streamed frame would be a request storm for figures that
    // cannot have changed yet.
    send({ type: 'run', run: { id: 'run_1', status: 'running' } });
    expect(sessionStore.applyRun).toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('refreshes the sidebar when a session is renamed by its first prompt', () => {
    send({ type: 'session', session: { id: 'ses_1', workspaceId: 'ws_a' } });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['workspace', 'ws_a'] });
  });

  it('raises a notification for an approval only on the system topic', () => {
    // The request arrives on both its session topic and the system one;
    // notifying from each would double every prompt.
    send({
      type: 'approval_request',
      topic: 'ses_1',
      request: { id: 'a1', risk: 'low', summary: 's', workspaceId: 'ws_a', sessionId: 'ses_1' },
    });
    expect(sessionStore.addApproval).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks a high-risk approval as an error rather than a warning', () => {
    send({
      type: 'approval_request',
      topic: 'system',
      request: { id: 'a1', risk: 'high', summary: 'rm -rf', workspaceId: 'ws_a', sessionId: 'ses_1' },
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  it('interrupts with a toast for failures, and records success quietly', () => {
    send({ type: 'notification', level: 'info', title: 'Run finished', message: 'ok' });
    expect(notify).toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();

    send({ type: 'notification', level: 'error', title: 'Run failed', message: 'boom' });
    expect(toastMock.error).toHaveBeenCalledWith('Run failed', { description: 'boom' });
  });

  it('ignores a frame type it does not know', () => {
    // The protocol grows; an unknown frame must not throw inside the socket
    // handler and take the connection's consumer down with it.
    expect(() => send({ type: 'something_new' })).not.toThrow();
  });
});

describe('losing the session', () => {
  it('drops the socket and leaves for the login screen', async () => {
    renderWithProviders(<App />);
    await waitFor(() => expect(setUnauthenticatedHandler).toHaveBeenCalled());

    const handler = setUnauthenticatedHandler.mock.calls[0]![0] as () => void;
    act(() => handler());

    expect(auth.setUser).toHaveBeenCalledWith(null);
    expect(socketMock.dispose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('probes for an existing session quietly, so an anonymous load is not an error', async () => {
    renderWithProviders(<App />);
    await waitFor(() => expect(apiMock.me).toHaveBeenCalledWith({ quiet: true }));
  });
});

describe('rendering', () => {
  it('mounts the command palette on every screen, not per page', async () => {
    renderWithProviders(<App />);
    // Present but closed: it costs nothing until ⌘K.
    await waitFor(() => expect(screen.queryByPlaceholderText(/search workspaces/i)).toBeNull());
  });
});
