/**
 * A workspace's landing screen.
 *
 * The behaviour worth guarding is the one that runs without being asked: a
 * workspace with no sessions creates one and lands the operator inside it,
 * rather than showing an empty room. That effect is guarded against firing
 * twice — a double-create would leave a stray empty session behind on every
 * visit — and the guard is exactly the kind that a refactor quietly loses.
 */

import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSettings } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { WorkspacePage } from './WorkspacePage';

const { apiMock, navigate, setLastWorkspace } = vi.hoisted(() => ({
  apiMock: {
    workspace: vi.fn(),
    createSession: vi.fn(),
    claudeCliSessions: vi.fn(),
    adoptCliSession: vi.fn(),
  },
  navigate: vi.fn(),
  setLastWorkspace: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: 'ws_a' }),
}));
vi.mock('@/components/workspace/SessionList', () => ({ SessionList: () => null }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return {
    ...actual,
    useUiStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { setLastWorkspace, theme: 'dark', showThinking: false, expandTools: false };
      return selector ? selector(state) : state;
    },
  };
});

const workspace = {
  id: 'ws_a',
  name: 'Alpha',
  slug: 'alpha',
  description: '',
  path: '/srv/a',
  color: '#6366f1',
  icon: 'folder',
  archived: false,
  // Parsed from the schema rather than hand-written: every field carries a
  // default, so the server never sends a partial object and the page reads
  // `settings.defaultPermissionMode` unguarded — correctly.
  settings: WorkspaceSettings.parse({}),
  createdAt: 0,
  updatedAt: 0,
};

const session = {
  id: 'ses_1',
  workspaceId: 'ws_a',
  title: 'Bail',
  pinned: false,
  archived: false,
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspace.mockResolvedValue({
    workspace,
    sessions: [session],
    gitStatus: null,
    memoryStats: { episodic: 1, semantic: 2, procedural: 3 },
  });
  apiMock.claudeCliSessions.mockResolvedValue({ sessions: [] });
  apiMock.createSession.mockResolvedValue({ session: { ...session, id: 'ses_new' } });
});

describe('a workspace that exists', () => {
  it('shows it, and counts what it remembers', async () => {
    renderWithProviders(<WorkspacePage />);
    expect(await screen.findByText('Alpha')).toBeDefined();
    // 1 + 2 + 3 across the three memory kinds.
    await waitFor(() => expect(screen.getByText('6')).toBeDefined());
  });

  it('remembers which workspace was last opened', async () => {
    renderWithProviders(<WorkspacePage />);
    await waitFor(() => expect(setLastWorkspace).toHaveBeenCalledWith('ws_a'));
  });

  it('creates nothing when there is already a session', async () => {
    renderWithProviders(<WorkspacePage />);
    await screen.findByText('Alpha');
    expect(apiMock.createSession).not.toHaveBeenCalled();
  });
});

describe('a workspace with no sessions yet', () => {
  it('opens one instead of showing an empty room', async () => {
    apiMock.workspace.mockResolvedValue({
      workspace,
      sessions: [],
      gitStatus: null,
      memoryStats: { episodic: 0, semantic: 0, procedural: 0 },
    });
    renderWithProviders(<WorkspacePage />);

    await waitFor(() => expect(apiMock.createSession).toHaveBeenCalledWith({ workspaceId: 'ws_a' }));
  });

  it('creates exactly one, however many times it re-renders', async () => {
    // The effect keys off "no sessions", which stays true until the refetch
    // lands. Without the pending/success guard every render would open
    // another empty session.
    apiMock.workspace.mockResolvedValue({
      workspace,
      sessions: [],
      gitStatus: null,
      memoryStats: { episodic: 0, semantic: 0, procedural: 0 },
    });
    const { rerender } = renderWithProviders(<WorkspacePage />);
    await waitFor(() => expect(apiMock.createSession).toHaveBeenCalled());

    rerender(<WorkspacePage />);
    rerender(<WorkspacePage />);
    await waitFor(() => expect(apiMock.createSession).toHaveBeenCalledTimes(1));
  });
});

describe('a workspace that cannot be loaded', () => {
  it('says so and offers a way out rather than a blank screen', async () => {
    apiMock.workspace.mockRejectedValue(new Error('gone'));
    renderWithProviders(<WorkspacePage />);

    expect(await screen.findByText('That workspace could not be loaded.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'All workspaces' })).toBeDefined();
  });
});
