/**
 * The Dashboard composer for Metaclaude.
 *
 * What matters: the prompt reaches the API trimmed, the operator is taken to
 * the session the server names, a busy conversation is opened rather than
 * doubled, and a viewer sees nothing at all.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';
import { MetaclaudeCard } from './MetaclaudeCard';

// The class lives in the hoisted block: `vi.mock` factories run before any
// top-level statement of this file, so a class declared beside them is still
// in its temporal dead zone when the factory reads it.
const { apiMock, navigate, ApiError } = vi.hoisted(() => ({
  apiMock: {
    metaclaude: vi.fn(),
    askMetaclaude: vi.fn(),
  },
  navigate: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code = 'error',
    ) {
      super(message);
    }
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
}));

const operator = { id: 'usr_1', username: 'op', displayName: 'Op', role: 'operator' } as User;

const idle = { workspaceId: 'ws_sys', session: null, running: false, lastRun: null };
const withSession = {
  workspaceId: 'ws_sys',
  session: { id: 'ses_conv', title: 'Conversation' },
  running: false,
  lastRun: { id: 'run_9', status: 'succeeded', finishedAt: Date.now() - 60_000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setUser(operator);
  apiMock.metaclaude.mockResolvedValue(idle);
  apiMock.askMetaclaude.mockResolvedValue({
    status: 'started', workspaceId: 'ws_sys', sessionId: 'ses_conv', runId: 'run_1',
  });
});

describe('MetaclaudeCard', () => {
  it('sends the trimmed prompt and goes to the session the server names', async () => {
    renderWithProviders(<MetaclaudeCard />);
    const box = await screen.findByLabelText('Ask Metaclaude');

    fireEvent.change(box, { target: { value: '  What failed overnight?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(apiMock.askMetaclaude).toHaveBeenCalledWith({ prompt: 'What failed overnight?' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/ws_sys/s/ses_conv'));
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('submits on Ctrl+Enter, and never an empty prompt', async () => {
    renderWithProviders(<MetaclaudeCard />);
    const box = await screen.findByLabelText('Ask Metaclaude');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(apiMock.askMetaclaude).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: 'Status?' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(apiMock.askMetaclaude).toHaveBeenCalledWith({ prompt: 'Status?' }));
  });

  it('links to the standing conversation and says when it last spoke', async () => {
    apiMock.metaclaude.mockResolvedValue(withSession);
    renderWithProviders(<MetaclaudeCard />);

    const link = await screen.findByRole('link', { name: /Open the conversation/ });
    expect(link.getAttribute('href')).toBe('/w/ws_sys/s/ses_conv');
    expect(screen.getByText(/last exchange/)).toBeDefined();
    expect(screen.queryByText('answering')).toBeNull();
  });

  it('shows that it is answering, and opens that conversation on a 409 instead of failing', async () => {
    apiMock.metaclaude.mockResolvedValue({ ...withSession, running: true });
    apiMock.askMetaclaude.mockRejectedValue(new ApiError(409, 'Metaclaude is still answering.'));
    renderWithProviders(<MetaclaudeCard />);

    expect(await screen.findByText('answering')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Ask Metaclaude'), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/ws_sys/s/ses_conv'));
  });

  it('locks the composer when the system workspace is missing, and says so', async () => {
    apiMock.metaclaude.mockResolvedValue({ workspaceId: null, session: null, running: false, lastRun: null });
    renderWithProviders(<MetaclaudeCard />);

    expect(await screen.findByText(/not ready/)).toBeDefined();
    expect((screen.getByLabelText('Ask Metaclaude') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('renders nothing for a viewer', () => {
    useAuthStore.getState().setUser({ ...operator, role: 'viewer' } as User);
    const { container } = renderWithProviders(<MetaclaudeCard />);

    expect(container.innerHTML).toBe('');
    expect(apiMock.metaclaude).not.toHaveBeenCalled();
  });
});
