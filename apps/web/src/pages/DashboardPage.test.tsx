/**
 * The dashboard — the screen every authenticated load lands on.
 *
 * It reads from seven queries at once, which makes its real risk not any one
 * of them but what happens when one is empty or absent: a control room that
 * renders a blank column, or worse an error, on a fresh install is the first
 * thing a new operator sees. The header line is the other load-bearing bit —
 * it is where "are my credentials configured?" gets answered without going
 * looking.
 */

import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { DashboardPage } from './DashboardPage';

const { apiMock, auth } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(),
    system: vi.fn(),
    runs: vi.fn(),
    approvals: vi.fn(),
    analytics: vi.fn(),
    insights: vi.fn(),
    brief: vi.fn(),
    createWorkspace: vi.fn(),
  },
  auth: { user: { displayName: 'Jules', username: 'jules', role: 'owner' } as Record<string, unknown> | null },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  // The page reads a slice — `useAuthStore((state) => state.user)` — so a
  // mock that ignores the selector hands it the whole store and the greeting
  // falls through to its last resort.
  return {
    ...actual,
    useAuthStore: (selector?: (s: typeof auth) => unknown) => (selector ? selector(auth) : auth),
  };
});

const empty = () => {
  apiMock.workspaces.mockResolvedValue({ workspaces: [] });
  apiMock.system.mockResolvedValue({ claudeCli: { authenticated: false } });
  apiMock.runs.mockResolvedValue({ runs: [] });
  apiMock.approvals.mockResolvedValue({ approvals: [] });
  apiMock.analytics.mockResolvedValue({ summary: undefined, series: [] });
  apiMock.insights.mockResolvedValue({ insights: [] });
  apiMock.brief.mockResolvedValue(null);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { displayName: 'Jules', username: 'jules', role: 'owner' };
  empty();
});

describe('a fresh install', () => {
  it('renders without a single figure to show', async () => {
    // Seven queries, all empty. This is what the very first load looks like,
    // and it must be an invitation rather than a wall of blanks.
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('No workspaces yet')).toBeDefined();
  });

  it('says plainly that Claude is not configured yet', async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('No Claude credentials configured')).toBeDefined();
  });

  it('offers the one action that unblocks everything else', async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByRole('button', { name: /New workspace/ })).toBeDefined();
  });
});

describe('the header', () => {
  it('greets the person by the name they chose', async () => {
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Jules\./)).toBeDefined());
  });

  it('falls back to the username, then to something human', async () => {
    auth.user = { username: 'jules' };
    const { unmount } = renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/jules\./)).toBeDefined());
    unmount();

    auth.user = null;
    renderWithProviders(<DashboardPage />);
    // Never "undefined." at the top of the first screen anyone sees.
    await waitFor(() => expect(screen.getByText(/there\./)).toBeDefined());
  });

  it('names the CLI and how it is authenticated once it is', async () => {
    apiMock.system.mockResolvedValue({
      claudeCli: { authenticated: true, version: '2.1.246', authMode: 'subscription' },
    });
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/2\.1\.246/)).toBeDefined());
    expect(screen.getByText(/subscription/)).toBeDefined();
  });
});

describe('what is happening now', () => {
  // `policy` and `usage` are required by the shared schema, not optional —
  // the first draft of this fixture omitted them and the page crashed on
  // `run.policy.source`, which is the schema being right rather than a bug.
  const run = (id: string, status: string) =>
    ({
      id,
      sessionId: 'ses_1',
      workspaceId: 'ws_a',
      prompt: `prompt ${id}`,
      status,
      startedAt: 1_700_000_000_000,
      finishedAt: null,
      policy: { model: 'claude-sonnet-5', effort: 'medium', source: 'default' },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      category: null,
      error: null,
      rating: null,
      rewindPoint: null,
    }) as never;

  it('counts a run as in flight while it is running, queued or waiting on you', async () => {
    // All three are "not finished", and a dashboard that only counted
    // `running` would show nothing while an approval blocks the queue —
    // exactly when the operator needs to look.
    apiMock.runs.mockResolvedValue({
      runs: [
        run('run_1', 'running'),
        run('run_2', 'queued'),
        run('run_3', 'waiting_approval'),
        run('run_4', 'succeeded'),
      ],
    });
    renderWithProviders(<DashboardPage />);

    // Scoped to the In-flight card: a finished run legitimately appears
    // further down under recent activity, so asserting on the whole page
    // would pass for the wrong reason.
    const heading = await screen.findByText('In flight');
    const card = heading.closest('div')?.parentElement as HTMLElement;

    expect(card.textContent).toContain('prompt run_1');
    expect(card.textContent).toContain('prompt run_2');
    expect(card.textContent).toContain('prompt run_3');
    expect(card.textContent).not.toContain('prompt run_4');
  });

  it('lists the workspaces it was given', async () => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [
        {
          id: 'ws_a',
          name: 'Alpha',
          slug: 'alpha',
          description: '',
          path: '/srv/a',
          color: '#6366f1',
          icon: 'folder',
          archived: false,
          settings: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Alpha')).toBeDefined();
  });
});

/**
 * "Recently learned" is a five-row digest of the review queue, and a
 * consolidation proposal shares that queue without being anything the system
 * learned: it is a request to delete rows. Left in, a single sweep's worth of
 * them fills the panel and the lessons it exists for fall off the end.
 */
describe('the recently-learned digest', () => {
  const insight = (id: string, kind: string, title: string) => ({
    id,
    workspaceId: null,
    runId: null,
    kind,
    title,
    body: 'b',
    confidence: 0.7,
    status: 'new',
    payload: null,
    createdAt: 1_700_000_000_000,
  });

  it('shows lessons and hides consolidation proposals', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [
        insight('ins_1', 'consolidation', '2 memories say the same thing'),
        insight('ins_2', 'lesson', 'Les tests tournent avec pnpm test:run'),
      ],
    });

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('Les tests tournent avec pnpm test:run')).toBeDefined();
    expect(screen.queryByText('2 memories say the same thing')).toBeNull();
  });

  it('reads the panel as empty when only proposals are waiting', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [insight('ins_1', 'consolidation', '2 memories say the same thing')],
    });

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('Nothing new')).toBeDefined();
  });

  /**
   * The server is asked for more than the five shown for exactly this reason:
   * taking five and then filtering would let a sweep's proposals empty a panel
   * that has lessons behind them.
   */
  it('still fills the panel when proposals arrive first', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [
        ...Array.from({ length: 6 }, (_, i) => insight(`ins_c${i}`, 'consolidation', `dup ${i}`)),
        insight('ins_l', 'lesson', 'Une vraie leçon'),
      ],
    });

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText('Une vraie leçon')).toBeDefined();
    await waitFor(() =>
      expect(apiMock.insights).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 })),
    );
  });
});
