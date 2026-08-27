/**
 * The passkey path on the sign-in screen. The button is a promise — it only
 * appears when pressing it could work (a passkey exists somewhere, the
 * browser can, the address is a domain), and pressing it drives the full
 * ceremony: server challenge → browser assertion → server verify → session.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';
import { LoginPage } from './LoginPage';

const { apiMock, passkeyLib } = vi.hoisted(() => ({
  apiMock: {
    bootstrapStatus: vi.fn(),
    login: vi.fn(),
    passkeys: { loginBegin: vi.fn(), loginFinish: vi.fn() },
  },
  passkeyLib: {
    passkeySupported: vi.fn<() => boolean>(),
    passkeyDomainOk: vi.fn<() => boolean>(),
    assertPasskey: vi.fn(),
    isCeremonyCancelled: vi.fn(() => false),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/passkeys', () => passkeyLib);

const USER = {
  id: 'user_1',
  username: 'alice',
  displayName: 'alice',
  role: 'owner',
  totpEnabled: false,
  createdAt: 0,
  lastLoginAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setUser(null);
  apiMock.bootstrapStatus.mockResolvedValue({ needsBootstrap: false, passkeysEnrolled: true });
  passkeyLib.passkeySupported.mockReturnValue(true);
  passkeyLib.passkeyDomainOk.mockReturnValue(true);
  apiMock.passkeys.loginBegin.mockResolvedValue({ ceremonyId: 'cer-1', options: { challenge: 'c' } });
  passkeyLib.assertPasskey.mockResolvedValue({ id: 'cred-1' });
  apiMock.passkeys.loginFinish.mockResolvedValue({ status: 'ok', user: USER, csrfToken: 't' });
});

describe('LoginPage — passkeys', () => {
  it('offers the button only when it could work', async () => {
    renderWithProviders(<LoginPage />);
    expect(await screen.findByRole('button', { name: /sign in with a passkey/i })).toBeTruthy();
  });

  it('hides the button on an IP address, where the ceremony cannot happen', async () => {
    passkeyLib.passkeyDomainOk.mockReturnValue(false);
    renderWithProviders(<LoginPage />);
    // The password form is there; the passkey button never appears.
    expect(await screen.findByLabelText(/username/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign in with a passkey/i })).toBeNull();
  });

  it('hides the button while no passkey is enrolled anywhere', async () => {
    apiMock.bootstrapStatus.mockResolvedValue({ needsBootstrap: false, passkeysEnrolled: false });
    renderWithProviders(<LoginPage />);
    expect(await screen.findByLabelText(/username/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign in with a passkey/i })).toBeNull();
  });

  it('drives the ceremony end to end and signs the user in', async () => {
    renderWithProviders(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in with a passkey/i }));

    await waitFor(() => expect(useAuthStore.getState().user?.username).toBe('alice'));
    expect(passkeyLib.assertPasskey).toHaveBeenCalledWith({ challenge: 'c' });
    expect(apiMock.passkeys.loginFinish).toHaveBeenCalledWith('cer-1', { id: 'cred-1' });
  });

  it('stays silent when the person closes the passkey sheet', async () => {
    const dismissed = new Error('dismissed');
    dismissed.name = 'NotAllowedError';
    passkeyLib.assertPasskey.mockRejectedValue(dismissed);
    passkeyLib.isCeremonyCancelled.mockReturnValue(true);

    renderWithProviders(<LoginPage />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in with a passkey/i }));

    await waitFor(() => expect(passkeyLib.assertPasskey).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });
});
