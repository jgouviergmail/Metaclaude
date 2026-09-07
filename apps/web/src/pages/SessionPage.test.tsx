/**
 * The session screen: the transcript, the composer, and the run lifecycle.
 *
 * Its children have their own tests, so they are stubbed here and what remains
 * is this page's own logic — which is mostly about what a submitted prompt
 * carries and what happens to attachments when it fails. The comment in the
 * source says the chips stay on error, "ready to ride the retry"; that is a
 * promise about data the user cannot re-create from the interface, so it is
 * worth holding still.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestQueryClient, renderWithProviders } from '@/test/render';
import { useSessionStore } from '@/lib/store';

import { SessionPage } from './SessionPage';

const { apiMock, navigate, pending } = vi.hoisted(() => ({
  apiMock: {
    workspace: vi.fn(),
    session: vi.fn(),
    claudeCatalogue: vi.fn(),
    skills: vi.fn(),
    mcpServers: vi.fn(),
    submitRun: vi.fn(),
    rateRun: vi.fn(),
    deleteSession: vi.fn(),
    markSessionRead: vi.fn(),
    transcript: vi.fn(),
    approvals: vi.fn(),
  },
  navigate: vi.fn(),
  pending: { readyIds: [] as string[], clear: vi.fn(), items: [] },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: 'ws_a', sessionId: 'ses_1' }),
}));
vi.mock('@/lib/attachments', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/attachments');
  return { ...actual, usePendingAttachments: () => pending };
});

// The transcript, the composer and the side panels are tested where they live.
vi.mock('@/components/transcript/MessageStream', () => ({
  MessageStream: () => <div data-testid="stream" />,
}));
vi.mock('@/components/transcript/Composer', () => ({
  Composer: ({ onSubmit }: { onSubmit: (prompt: string) => void }) => (
    <button type="button" onClick={() => onSubmit('Résume le bail')}>
      submit
    </button>
  ),
}));
vi.mock('@/components/workspace/SessionList', () => ({ SessionList: () => null }));
vi.mock('@/components/workspace/FilesPanel', () => ({ FilesPanel: () => null }));
vi.mock('@/components/workspace/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('@/components/transcript/RewindDialog', () => ({ RewindDialog: () => null }));

const session = {
  id: 'ses_1',
  workspaceId: 'ws_a',
  title: 'Bail',
  model: 'default',
  effort: null,
  permissionMode: 'default',
  pinned: false,
  archived: false,
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  lastReadAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  pending.readyIds = [];
  apiMock.workspace.mockResolvedValue({
    workspace: { id: 'ws_a', name: 'Alpha', path: '/srv/a', settings: {} },
    sessions: [session],
    gitStatus: null,
    memoryStats: {},
  });
  apiMock.session.mockResolvedValue({ session, runs: [], events: [] });
  apiMock.claudeCatalogue.mockResolvedValue({ models: [], efforts: [] });
  apiMock.skills.mockResolvedValue({ skills: [] });
  apiMock.mcpServers.mockResolvedValue({ servers: [] });
  apiMock.submitRun.mockResolvedValue({ run: { id: 'run_1' } });
  apiMock.deleteSession.mockResolvedValue({ ok: true });
  apiMock.markSessionRead.mockResolvedValue({ session });
});

const page = () => renderWithProviders(<SessionPage />);

describe('submitting a prompt', () => {
  it('carries the composer’s settings with it', async () => {
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'submit' }));

    await waitFor(() =>
      expect(apiMock.submitRun).toHaveBeenCalledWith(
        'ses_1',
        expect.objectContaining({
          prompt: 'Résume le bail',
          model: 'default',
          permissionMode: 'default',
          ultracode: false,
        }),
      ),
    );
  });

  it('sends the attachments that finished uploading, and only then forgets them', async () => {
    pending.readyIds = ['att_1', 'att_2'];
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'submit' }));

    await waitFor(() =>
      expect(apiMock.submitRun).toHaveBeenCalledWith(
        'ses_1',
        expect.objectContaining({ attachmentIds: ['att_1', 'att_2'] }),
      ),
    );
    await waitFor(() => expect(pending.clear).toHaveBeenCalled());
  });

  it('keeps the attachments when the run could not start', async () => {
    // The user picked those files; nothing in this interface can put them
    // back. Only a message that actually left consumes them.
    pending.readyIds = ['att_1'];
    apiMock.submitRun.mockRejectedValue(new Error('quota'));
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'submit' }));

    await waitFor(() => expect(apiMock.submitRun).toHaveBeenCalled());
    expect(pending.clear).not.toHaveBeenCalled();
  });

  it('omits the attachment field entirely when there is nothing to attach', async () => {
    // An empty array and an absent key are not the same request; the API
    // treats the field as "the attachments for this run".
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'submit' }));

    await waitFor(() => expect(apiMock.submitRun).toHaveBeenCalled());
    const body = apiMock.submitRun.mock.calls[0]![1] as Record<string, unknown>;
    expect('attachmentIds' in body).toBe(false);
  });
});

describe('the screen itself', () => {
  it('renders the transcript for the session in the URL', async () => {
    page();
    expect(await screen.findByTestId('stream')).toBeDefined();
    expect(apiMock.session).toHaveBeenCalledWith('ses_1');
  });

  it('seeds the composer from the session’s own settings', async () => {
    apiMock.session.mockResolvedValue({
      session: { ...session, model: 'claude-opus-5', effort: 'high' },
      runs: [],
      events: [],
    });
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'submit' }));

    await waitFor(() =>
      expect(apiMock.submitRun).toHaveBeenCalledWith(
        'ses_1',
        expect.objectContaining({ model: 'claude-opus-5', effort: 'high' }),
      ),
    );
  });
});

/**
 * The read marker.
 *
 * The dot in the sidebar is only honest if opening the session clears it, and
 * only useful if leaving mid-run does not. Both halves live here: the page is
 * the one thing that knows a reply was actually put in front of somebody.
 */
describe('marking the session read', () => {
  it('stamps it on arrival', async () => {
    page();
    await waitFor(() => expect(apiMock.markSessionRead).toHaveBeenCalledWith('ses_1'));
  });

  it('stamps it again when the run settles under the operator’s eyes', async () => {
    const run = (status: string) => ({
      id: 'run_1',
      sessionId: 'ses_1',
      workspaceId: 'ws_a',
      status,
      prompt: 'x',
      policy: {},
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0, turns: 0 },
      startedAt: 0,
      finishedAt: null,
    });
    apiMock.session.mockResolvedValue({ session, runs: [run('running')], events: [], isRunning: true });
    page();

    // Arriving stamps it once — the operator is here, whatever is running.
    await screen.findByTestId('stream');
    await waitFor(() => expect(apiMock.markSessionRead).toHaveBeenCalledTimes(1));

    // The result frame arrives while the page is still open: the reply has
    // now been put in front of somebody, so the mark moves past it. Without
    // this second stamp the dot would light up on the session being read.
    act(() => useSessionStore.getState().applyRun(run('succeeded') as never));

    await waitFor(() => expect(apiMock.markSessionRead).toHaveBeenCalledTimes(2));
  });
});

/**
 * Reopening a session shows the session, not what it looked like last time.
 *
 * `staleTime: Infinity` makes the cached answer eternally fresh, so React
 * Query's default "refetch when stale" never fires: the second visit rendered
 * the transcript as it was when the screen was last closed, and anything that
 * happened in between — an automation's run, work done from the phone — was
 * missing until a live frame happened to arrive. The socket keeps an *open*
 * session current; it cannot fill in what was missed while nobody watched.
 */
describe('reopening a session', () => {
  it('asks the server again on every mount, warm cache or not', async () => {
    const queryClient = createTestQueryClient();

    const first = renderWithProviders(<SessionPage />, { queryClient });
    await waitFor(() => expect(apiMock.session).toHaveBeenCalledTimes(1));
    first.unmount();

    renderWithProviders(<SessionPage />, { queryClient });
    await waitFor(() => expect(apiMock.session).toHaveBeenCalledTimes(2));
  });
});


/**
 * Four icon actions and a status cluster leave a phone's header no room.
 *
 * At 390px the title was truncated to `Workin…`: the header carries Files,
 * Source control, New session, Delete session, then the connection badge, the
 * bell and the avatar. Nothing is clipped or covered, so no guard reports it —
 * `truncate` is doing exactly what it is for, on a name that is the only thing
 * saying which session you are in.
 *
 * The panels take the whole screen at that width anyway, so on a phone the two
 * toggles and the destructive action move into a menu and only `+` stays. The
 * actions are declared once and rendered twice: a second copy is how the two
 * would come to disagree.
 */
describe('the header on a phone', () => {
  it('keeps every action reachable, whatever the width', async () => {
    page();
    await screen.findByRole('button', { name: 'New session' });

    // The wide form: one button each.
    for (const name of ['Files', 'Source control', 'New session', 'Delete session']) {
      expect(screen.getByRole('button', { name }), name).toBeDefined();
    }
  });

  it('offers the secondary ones in a menu, and only on a phone', async () => {
    page();
    const trigger = await screen.findByRole('button', { name: 'Session actions' });
    // The class, not a selector: escaping a `:` inside `querySelector` is a
    // happy-dom minefield and the contract is the class itself.
    expect(trigger.parentElement?.className).toContain('sm:hidden');

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    // A toggle is announced as a toggle: `MenuItem` with `selected` renders
    // `menuitemcheckbox`, which is why this asks for both roles.
    const items = [...(await screen.findAllByRole('menuitemcheckbox')), ...screen.queryAllByRole('menuitem')];
    const names = items.map((item) => item.textContent);
    expect(names.join(' | ')).toContain('Files');
    expect(names.join(' | ')).toContain('Source control');
    expect(names.join(' | ')).toContain('Delete session');
  });

  it('leaves the wide buttons out of the phone layout', async () => {
    page();
    const files = await screen.findByRole('button', { name: 'Files' });
    // happy-dom lays nothing out, so what a test can hold is the class
    // contract; `scripts/responsive.mjs` measures the result in a browser.
    // Walk up to the row that decides the layout rather than guessing a depth:
    // `Tooltip` wraps the button, so the class is two ancestors away.
    let row: HTMLElement | null = files;
    while (row && !row.className.includes('sm:flex')) row = row.parentElement;
    expect(row?.className).toContain('hidden');
  });
});
