/**
 * The Notifications card's three worlds: a browser that cannot push at all,
 * a device not yet subscribed (enable = permission + subscribe + register),
 * and a subscribed device (test and disable). The failure that matters most
 * is a declined permission surfacing as words, not as a dead button.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { NotificationsCard } from './NotificationsCard';

const { apiMock, pushLib } = vi.hoisted(() => ({
  apiMock: {
    push: { status: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), test: vi.fn() },
  },
  pushLib: {
    pushSupported: vi.fn<() => boolean>(),
    currentSubscription: vi.fn(),
    enablePush: vi.fn(),
    disablePush: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/push', () => pushLib);

const SUB = { endpoint: 'https://push.example/device-1', keys: { p256dh: 'p', auth: 'a' } };

beforeEach(() => {
  vi.clearAllMocks();
  pushLib.pushSupported.mockReturnValue(true);
  pushLib.currentSubscription.mockResolvedValue(null);
  pushLib.enablePush.mockResolvedValue(SUB);
  pushLib.disablePush.mockResolvedValue(SUB.endpoint);
  apiMock.push.status.mockResolvedValue({ publicKey: 'vapid-public', devices: 1 });
  apiMock.push.subscribe.mockResolvedValue({ devices: 2 });
  apiMock.push.unsubscribe.mockResolvedValue({ removed: true, devices: 1 });
  apiMock.push.test.mockResolvedValue({ sent: 2, pruned: 0 });
});

describe('NotificationsCard', () => {
  it('tells an incapable browser what would make it capable', () => {
    pushLib.pushSupported.mockReturnValue(false);
    renderWithProviders(<NotificationsCard />);
    expect(screen.getByText(/add to home screen/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /enable/i })).toBeNull();
  });

  it('enables this device: permission, browser subscription, server registration', async () => {
    renderWithProviders(<NotificationsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /enable on this device/i }));

    await waitFor(() => expect(apiMock.push.subscribe).toHaveBeenCalledWith(SUB));
    expect(pushLib.enablePush).toHaveBeenCalledWith('vapid-public');
    // The card flips to the subscribed state without a reload.
    expect(await screen.findByText(/this device is subscribed/i)).toBeTruthy();
  });

  it('surfaces a declined permission as words', async () => {
    pushLib.enablePush.mockRejectedValue(new Error('Notifications are blocked for this site.'));
    renderWithProviders(<NotificationsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /enable on this device/i }));

    await waitFor(() => expect(pushLib.enablePush).toHaveBeenCalled());
    expect(apiMock.push.subscribe).not.toHaveBeenCalled();
    // Still enabled-able: the button survives the refusal.
    expect(screen.getByRole('button', { name: /enable on this device/i })).toBeTruthy();
  });

  it('offers test and disable once subscribed, unregistering server-side too', async () => {
    pushLib.currentSubscription.mockResolvedValue(SUB);
    renderWithProviders(<NotificationsCard />);

    fireEvent.click(await screen.findByRole('button', { name: /send a test/i }));
    await waitFor(() => expect(apiMock.push.test).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /disable here/i }));
    await waitFor(() => expect(apiMock.push.unsubscribe).toHaveBeenCalledWith(SUB.endpoint));
    expect(await screen.findByRole('button', { name: /enable on this device/i })).toBeTruthy();
  });
});
