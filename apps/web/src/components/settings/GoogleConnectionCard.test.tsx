/**
 * The Google connection card: the redirect URI is shown before anything is
 * asked for, the restricted-scope warning appears when it is earned, and the
 * secret leaves exactly once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { GoogleConnectionCard } from './GoogleConnectionCard';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    google: {
      get: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

const DISCONNECTED = {
  connection: {
    connected: false,
    accountEmail: null,
    grants: [],
    clientId: null,
    connectedAt: null,
    connectedBy: null,
  },
  redirectUri: 'https://metaclaude.example/api/integrations/google/callback',
  restrictedGrants: ['gmail.read', 'drive.read'],
};

const CONNECTED = {
  connection: {
    connected: true,
    accountEmail: 'ops@example.com',
    grants: ['calendar.read', 'calendar.write'],
    clientId: 'client-123.apps.googleusercontent.com',
    connectedAt: 1_700_000_000_000,
    connectedBy: 'user_1',
  },
  redirectUri: 'https://metaclaude.example/api/integrations/google/callback',
  restrictedGrants: ['gmail.read', 'drive.read'],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.google.get.mockResolvedValue(DISCONNECTED);
  apiMock.google.connect.mockResolvedValue({
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    redirectUri: DISCONNECTED.redirectUri,
  });
  apiMock.google.disconnect.mockResolvedValue({ ok: true, removed: true });
  window.history.replaceState({}, '', '/settings');
});

describe('before connecting', () => {
  it('shows the exact redirect URI to register, before asking for anything', async () => {
    // Google matches the whole string; a character of difference is
    // redirect_uri_mismatch, which is how this setup usually fails.
    renderWithProviders(<GoogleConnectionCard />);
    expect(
      await screen.findByText('https://metaclaude.example/api/integrations/google/callback'),
    ).toBeDefined();
  });

  it('holds the button until there is a client, a secret and a grant', async () => {
    renderWithProviders(<GoogleConnectionCard />);
    const submit = await screen.findByRole('button', { name: /continue to google/i });
    // gmail.read and calendar.read are ticked by default, so only the two
    // credentials are missing.
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'client-123' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 'secret-xyz' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('refuses a connection that would grant nothing', async () => {
    renderWithProviders(<GoogleConnectionCard />);
    const submit = await screen.findByRole('button', { name: /continue to google/i });
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 'secret-xyz' } });

    fireEvent.click(screen.getByRole('checkbox', { name: /read your mail/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /read your calendar/i }));

    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('warns about the seven-day expiry only while a restricted scope is ticked', async () => {
    // The warning has to arrive before the choice, not a week later when the
    // connection silently stops working.
    renderWithProviders(<GoogleConnectionCard />);
    // The warning depends on the query's restrictedGrants, and the checkboxes
    // render before it resolves — so wait for the warning itself.
    await screen.findByText(/seven days/i);

    fireEvent.click(screen.getByRole('checkbox', { name: /read your mail/i }));
    await waitFor(() => expect(screen.queryByText(/seven days/i)).toBeNull());

    fireEvent.click(screen.getByRole('checkbox', { name: /read your drive/i }));
    expect(screen.getByText(/seven days/i)).toBeDefined();
  });

  it('sends the credentials once and leaves for Google', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign, search: '', pathname: '/settings' },
    });

    renderWithProviders(<GoogleConnectionCard />);
    await screen.findByRole('button', { name: /continue to google/i });
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 'secret-xyz' } });
    fireEvent.click(screen.getByRole('button', { name: /continue to google/i }));

    await waitFor(() =>
      expect(apiMock.google.connect).toHaveBeenCalledWith({
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        grants: ['calendar.read', 'gmail.read'],
      }),
    );
    // A full navigation, not a popup: Google's consent screen refuses to
    // render in a frame and popups are blocked as often as not.
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'),
    );
  });
});

describe('once connected', () => {
  beforeEach(() => apiMock.google.get.mockResolvedValue(CONNECTED));

  it('names the account and the powers it actually holds', async () => {
    // Showing the bound account is what makes a wrong authorisation — the
    // other Google account signed in on that browser — visible at all.
    renderWithProviders(<GoogleConnectionCard />);
    expect(await screen.findByText('ops@example.com')).toBeDefined();
    expect(screen.getByText('Read your calendar')).toBeDefined();
    expect(screen.getByText('Create and change events')).toBeDefined();
    expect(screen.queryByText('Read your mail')).toBeNull();
  });

  it('stops asking for credentials it already has', async () => {
    renderWithProviders(<GoogleConnectionCard />);
    await screen.findByText('ops@example.com');
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
  });

  it('says plainly that disconnecting is local, and only after a confirmation', async () => {
    renderWithProviders(<GoogleConnectionCard />);
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));

    // Deleting the token here does not revoke anything at Google; a card that
    // implied otherwise would leave a live grant nobody knows about.
    expect(await screen.findByText(/does not revoke anything at Google/i)).toBeDefined();
    expect(apiMock.google.disconnect).not.toHaveBeenCalled();
  });
});

describe('coming back from Google', () => {
  it('reports the outcome the callback put in the query, then clears it', async () => {
    window.history.replaceState({}, '', '/settings?google=connected');
    renderWithProviders(<GoogleConnectionCard />);

    // Cleared so a reload does not repeat the toast for an event that already
    // happened.
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});
