/**
 * The Passkeys card's three worlds: a browser without WebAuthn, a deployment
 * reached by IP (the honest refusal, with the fix in the words), and a
 * domain where enrolment works. The flows both re-prove the password — that
 * is the property worth pinning, along with the full add chain:
 * password → server options → browser ceremony → server verify.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PasskeysCard } from './PasskeysCard';

const { apiMock, passkeyLib } = vi.hoisted(() => ({
  apiMock: {
    passkeys: { list: vi.fn(), begin: vi.fn(), finish: vi.fn(), remove: vi.fn() },
  },
  passkeyLib: {
    passkeySupported: vi.fn<() => boolean>(),
    passkeyDomainOk: vi.fn<() => boolean>(),
    createPasskey: vi.fn(),
    isCeremonyCancelled: vi.fn(() => false),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/passkeys', () => passkeyLib);

const ENROLLED = {
  id: 'pky_1',
  label: 'My phone',
  rpId: 'claude.home.arpa',
  createdAt: 1_000,
  lastUsedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  passkeyLib.passkeySupported.mockReturnValue(true);
  passkeyLib.passkeyDomainOk.mockReturnValue(true);
  passkeyLib.isCeremonyCancelled.mockReturnValue(false);
  apiMock.passkeys.list.mockResolvedValue({ passkeys: [] });
  apiMock.passkeys.begin.mockResolvedValue({ options: { challenge: 'c' } });
  passkeyLib.createPasskey.mockResolvedValue({ id: 'cred-1', rawId: 'cred-1' });
  apiMock.passkeys.finish.mockResolvedValue({ passkey: ENROLLED });
  apiMock.passkeys.remove.mockResolvedValue({ ok: true });
});

describe('PasskeysCard', () => {
  it('explains an IP deployment instead of offering a dead button', async () => {
    passkeyLib.passkeyDomainOk.mockReturnValue(false);
    renderWithProviders(<PasskeysCard />);
    expect(await screen.findByText(/reached by IP address/i)).toBeTruthy();
    expect(screen.getByText(/METACLAUDE_SITE/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add a passkey/i })).toBeNull();
  });

  it('says when the browser has no WebAuthn at all', () => {
    passkeyLib.passkeySupported.mockReturnValue(false);
    renderWithProviders(<PasskeysCard />);
    expect(screen.getByText(/does not support passkeys/i)).toBeTruthy();
  });

  it('lists what is enrolled, with its domain', async () => {
    apiMock.passkeys.list.mockResolvedValue({ passkeys: [ENROLLED] });
    renderWithProviders(<PasskeysCard />);
    expect(await screen.findByText('My phone')).toBeTruthy();
    expect(screen.getByText(/claude\.home\.arpa/)).toBeTruthy();
  });

  it('adds a passkey: password to the server, ceremony in the browser, verify back', async () => {
    renderWithProviders(<PasskeysCard />);
    fireEvent.click(await screen.findByRole('button', { name: /add a passkey/i }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw-123456789012' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(apiMock.passkeys.finish).toHaveBeenCalled());
    expect(apiMock.passkeys.begin).toHaveBeenCalledWith('pw-123456789012');
    expect(passkeyLib.createPasskey).toHaveBeenCalledWith({ challenge: 'c' });
    expect(apiMock.passkeys.finish).toHaveBeenCalledWith('Laptop', { id: 'cred-1', rawId: 'cred-1' });
  });

  it('the create button stays disabled until the password is typed', async () => {
    renderWithProviders(<PasskeysCard />);
    fireEvent.click(await screen.findByRole('button', { name: /add a passkey/i }));
    const create = screen.getByRole('button', { name: /create/i }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it('removal sends the typed password with the right credential', async () => {
    apiMock.passkeys.list.mockResolvedValue({ passkeys: [ENROLLED] });
    renderWithProviders(<PasskeysCard />);

    fireEvent.click(await screen.findByRole('button', { name: /remove my phone/i }));
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw-123456789012' } });
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() =>
      expect(apiMock.passkeys.remove).toHaveBeenCalledWith('pky_1', 'pw-123456789012'),
    );
  });
});
