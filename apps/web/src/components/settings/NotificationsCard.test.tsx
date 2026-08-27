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

const { apiMock, pushLib, toastMock } = vi.hoisted(() => ({
  apiMock: {
    push: { status: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), test: vi.fn() },
  },
  pushLib: {
    pushSupported: vi.fn<() => boolean>(),
    currentSubscription: vi.fn(),
    enablePush: vi.fn(),
    disablePush: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/push', () => pushLib);
vi.mock('sonner', () => ({ toast: toastMock }));

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
  apiMock.push.test.mockResolvedValue({ devices: 2, sent: 2, pruned: 0, lastError: null });
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

  it('re-registers a subscribed device with the server on mount', async () => {
    // The browser's subscription and the server's row can drift apart — a
    // restored database, a registration that failed after the permission
    // was granted. The card then said "subscribed" from the browser's half
    // alone while the server had nothing to send to, and the test button's
    // "no device is subscribed" read as nonsense. Re-registering is an
    // idempotent upsert, so the two halves converge on every visit.
    pushLib.currentSubscription.mockResolvedValue(SUB);
    renderWithProviders(<NotificationsCard />);

    await waitFor(() => expect(apiMock.push.subscribe).toHaveBeenCalledWith(SUB));
    expect(pushLib.enablePush).not.toHaveBeenCalled(); // no permission prompt on mount
  });

  it('the test button tells a delivery failure from an absent device', async () => {
    pushLib.currentSubscription.mockResolvedValue(SUB);
    apiMock.push.test.mockResolvedValue({
      devices: 1,
      sent: 0,
      pruned: 0,
      lastError: 'push service answered 503',
    });
    renderWithProviders(<NotificationsCard />);

    fireEvent.click(await screen.findByRole('button', { name: /send a test/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const message = String(toastMock.error.mock.calls[0]?.[0]);
    expect(message).toMatch(/could not be delivered/i);
    expect(message).toContain('503');
    expect(toastMock.success).not.toHaveBeenCalledWith(expect.stringMatching(/no device/i));
  });
});
