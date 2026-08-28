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

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

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
