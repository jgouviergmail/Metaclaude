/**
 * The card's three exits: not the owner, dismissed, or nothing left to say —
 * and the one state where it earns its place: steps with doors.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';
import { GettingStartedCard } from './GettingStartedCard';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    system: vi.fn(),
    workspaces: vi.fn(),
    runs: vi.fn(),
    push: { status: vi.fn() },
    updateApplyStatus: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

function signIn(role: 'owner' | 'operator', totpEnabled = false) {
  useAuthStore.setState({
    status: 'authenticated',
    user: { id: 'usr_1', username: 'o', role, totpEnabled } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signIn('owner');
  apiMock.system.mockResolvedValue({ claudeCli: { authenticated: true } });
  apiMock.workspaces.mockResolvedValue({ workspaces: [{ id: 'ws_1' }] });
  apiMock.runs.mockResolvedValue({ runs: [] });
  apiMock.push.status.mockResolvedValue({ publicKey: 'k', devices: 0 });
  apiMock.updateApplyStatus.mockResolvedValue({ available: false, state: 'idle' });
});

describe('GettingStartedCard', () => {
  it('lists what remains, each step a link to its screen', async () => {
    renderWithProviders(<GettingStartedCard />);

    expect(await screen.findByText(/getting set up/i)).toBeTruthy();
    expect(screen.getByText(/run the agent once/i).closest('a')?.getAttribute('href')).toBe(
      '/workspaces',
    );
    expect(screen.getByText(/install the host updater/i)).toBeTruthy();
    // Done steps stay visible, struck through — progress reads as progress.
    expect(screen.getByText(/pair claude/i)).toBeTruthy();
  });

  it('says nothing once everything is done', async () => {
    apiMock.runs.mockResolvedValue({ runs: [{ id: 'run_1' }] });
    apiMock.push.status.mockResolvedValue({ publicKey: 'k', devices: 1 });
    apiMock.updateApplyStatus.mockResolvedValue({ available: true, state: 'idle' });
    signIn('owner', true);

    const { container } = renderWithProviders(<GettingStartedCard />);
    // Give the queries a beat; the card must never appear.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).not.toContain('Getting set up');
  });

  it('is not for operators — every step it names is an owner act', async () => {
    signIn('operator');
    const { container } = renderWithProviders(<GettingStartedCard />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
    expect(apiMock.system).not.toHaveBeenCalled();
  });

  it('stays dismissed across visits', async () => {
    renderWithProviders(<GettingStartedCard />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss the checklist/i }));
    expect(screen.queryByText(/getting set up/i)).toBeNull();

    const { container } = renderWithProviders(<GettingStartedCard />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });
});
