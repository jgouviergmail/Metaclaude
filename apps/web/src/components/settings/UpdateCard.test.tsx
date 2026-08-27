/**
 * The Updates card's apply affordance.
 *
 * The button exists only when there is both something to apply and a host
 * updater to hand it to; the confirm dialog is the gate; and a failed past
 * attempt stays visible — a silent failed update is an operator flying blind.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateApplyStatus, UpdateCheck } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { UpdateCard } from './UpdateCard';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { updateCheck: vi.fn(), updateApplyStatus: vi.fn(), applyUpdate: vi.fn() },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

const check = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  current: '0.9.0',
  latest: 'v9.9.9',
  updateAvailable: true,
  releaseUrl: 'https://example.invalid/releases/tag/v9.9.9',
  error: null,
  checkedAt: 1_000,
  ...over,
});

const status = (over: Partial<UpdateApplyStatus> = {}): UpdateApplyStatus => ({
  available: true,
  state: 'idle',
  version: null,
  message: null,
  at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.updateCheck.mockResolvedValue(check());
  apiMock.updateApplyStatus.mockResolvedValue(status());
  apiMock.applyUpdate.mockResolvedValue({ ok: true });
});

const checkFirst = async () => {
  renderWithProviders(<UpdateCard />);
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  await screen.findByText(/is published/);
};

describe('UpdateCard', () => {
  it('offers Apply only when an update exists and the host has an updater', async () => {
    await checkFirst();
    expect(await screen.findByRole('button', { name: /apply v9\.9\.9/i })).toBeDefined();
  });

  it('withholds Apply without the host updater, and says what to do instead', async () => {
    apiMock.updateApplyStatus.mockResolvedValue(status({ available: false }));
    await checkFirst();

    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    expect(await screen.findByText(/install-app\.sh/)).toBeDefined();
  });

  it('applies only through the confirm dialog', async () => {
    await checkFirst();
    fireEvent.click(await screen.findByRole('button', { name: /apply v9\.9\.9/i }));
    expect(apiMock.applyUpdate).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
    await waitFor(() => expect(apiMock.applyUpdate).toHaveBeenCalledWith('v9.9.9'));
  });

  it('shows the deploy in flight and hides the button meanwhile', async () => {
    apiMock.updateApplyStatus.mockResolvedValue(status({ state: 'running', version: 'v9.9.9' }));
    await checkFirst();

    expect(await screen.findByRole('status')).toBeDefined();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('keeps a failed attempt visible, message included', async () => {
    apiMock.updateApplyStatus.mockResolvedValue(
      status({ state: 'failed', version: 'v9.9.8', message: 'health gate refused' }),
    );
    renderWithProviders(<UpdateCard />);

    expect(await screen.findByText(/did not go healthy/)).toBeDefined();
    expect(screen.getByText(/health gate refused/)).toBeDefined();
  });
});
