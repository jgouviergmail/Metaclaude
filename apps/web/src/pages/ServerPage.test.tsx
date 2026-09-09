/**
 * The machine, on its own screen.
 *
 * It was a tab inside Settings, which was wrong twice over: nothing here is a
 * preference — it is what the deployment *is* — and "System" then named both
 * that tab and the rail section beside it. What this pins is the move itself:
 * the screen exists at its own address, it carries the System strip rather
 * than the Settings one, and the two owner-only cards stay owner-only.
 */

import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    system: vi.fn(),
    doctor: vi.fn(),
    updateStatus: vi.fn(),
    updateApplyStatus: vi.fn(),
    push: { status: vi.fn() },
    claudeCredential: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// The three cards have their own tests; what is under test here is the screen.
vi.mock('@/components/settings/ClaudeCredentialCard', () => ({
  ClaudeCredentialCard: () => <div data-testid="credential" />,
}));
vi.mock('@/components/settings/NotificationsCard', () => ({
  NotificationsCard: () => <div data-testid="notifications" />,
}));
vi.mock('@/components/settings/UpdateCard', () => ({
  UpdateCard: () => <div data-testid="updater" />,
}));

import { ServerPage } from './ServerPage';

const signIn = (role: 'owner' | 'operator') => {
  useAuthStore.setState({ user: { id: 'u1', username: 'jgo', role } as never });
};

beforeEach(() => {
  vi.clearAllMocks();
  signIn('owner');
  apiMock.system.mockResolvedValue({
    version: '0.66.0',
    uptimeMs: 12_500,
    timezone: 'Europe/Paris',
    activeRuns: 0,
    queuedRuns: 0,
    memoryCount: 22,
    retrieval: {
      family: 'hash',
      embedder: 'hash-v1',
      state: 'ready',
      pending: { memories: 0, documents: 0, exemplars: 0 },
    },
    resources: { cpu: {}, memory: {}, disk: {} },
    claudeCli: { available: true, version: '2.1.218', authenticated: true, authMode: 'subscription' },
  });
  apiMock.doctor.mockResolvedValue({ checks: [] });
  apiMock.updateApplyStatus.mockResolvedValue({ available: false, state: 'idle' });
});

describe('the server screen', () => {
  it('is titled for what it shows, not for the section it used to live in', async () => {
    renderWithProviders(<ServerPage />, { route: '/server' });
    expect(await screen.findByRole('heading', { name: 'Server', level: 1 })).toBeTruthy();
  });

  it('carries the Settings strip, not the System one', async () => {
    // The strip is what says which section you are in, and this screen leads
    // Settings now: what an operator opens Settings for is "how is this
    // deployment set up", and the machine is the first thing that answers.
    // Carrying the old strip would put it in a group that no longer lists it.
    renderWithProviders(<ServerPage />, { route: '/server' });
    expect(await screen.findByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'System sections' })).toBeNull();
  });

  it('shows the deployment’s own facts', async () => {
    renderWithProviders(<ServerPage />, { route: '/server' });
    await waitFor(() => expect(screen.getByText('0.66.0')).toBeTruthy());
    expect(screen.getByText('Europe/Paris')).toBeTruthy();
  });

  it('keeps the doctor and the updater to owners', async () => {
    // Both act on the host: one runs checks, the other replaces the running
    // image. The API refuses an operator there, and the screen agrees.
    signIn('operator');
    renderWithProviders(<ServerPage />, { route: '/server' });
    await waitFor(() => expect(screen.getByText('0.66.0')).toBeTruthy());
    expect(screen.queryByTestId('updater')).toBeNull();
  });

  it('offers them to an owner', async () => {
    renderWithProviders(<ServerPage />, { route: '/server' });
    await waitFor(() => expect(screen.getByTestId('updater')).toBeTruthy());
  });
});
