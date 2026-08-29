/**
 * The Google connection card: the redirect URI is shown before anything is
 * asked for, the restricted-scope warning appears when it is earned, and the
 * secret leaves exactly once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * The real `window.location`, captured before any test can replace it.
 *
 * One test swaps it for a stub to intercept `assign` — jsdom cannot navigate —
 * and it used not to put it back. Everything after it then ran against a frozen
 * object whose `search` was permanently `''`, which is worse than it sounds:
 * the callback test below asserts that the query string gets *cleared*, and on
 * a stub that starts cleared it passed without the effect ever running. The
 * trap CLAUDE.md names about the uninstall rehearsal — a check that cannot tell
 * "the guard held" from "the code never ran" proves nothing.
 */
const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, 'location')!;

afterEach(() => {
  Object.defineProperty(window, 'location', REAL_LOCATION);
});

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
    // Establish that the state under test actually exists before asserting it
    // goes away: on a stubbed location whose search was already '', this test
    // passed for years without the effect ever running.
    expect(window.location.search).toBe('?google=connected');

    renderWithProviders(<GoogleConnectionCard />);

    // Cleared so a reload does not repeat the toast for an event that already
    // happened.
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  /**
   * The card is folded by default, and the outcome of a consent the operator
   * just gave must survive that. It does because the fold is a `<details>`,
   * which keeps its children mounted — the effect that reads the query string
   * and raises the toast runs either way. A fold built on conditional
   * rendering would have swallowed it silently.
   */
  it('opens itself when the operator has just come back', async () => {
    window.history.replaceState({}, '', '/settings?google=connected');
    const { container } = renderWithProviders(<GoogleConnectionCard />);

    // Opened by the effect, not by a check at mount: `waitFor`, because the
    // fact arrives with the effect rather than with the first render. That is
    // the whole point — a mount-time read races the same effect's clearing of
    // the query string, and loses it under StrictMode's remount.
    await waitFor(() => expect(container.querySelector('details')?.open).toBe(true));
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});

describe('the fold', () => {
  /**
   * Asserted on the element's own `open`, never on visibility: jsdom does not
   * implement `<details>` hiding, so every child is findable whether the
   * section is open or shut. A test written against `toBeVisible` would pass
   * on a card that never folds.
   */
  it('is folded on an ordinary visit', async () => {
    window.history.replaceState({}, '', '/settings');
    apiMock.google.get.mockResolvedValue(CONNECTED);
    const { container } = renderWithProviders(<GoogleConnectionCard />);

    // Folded, it still answers the question the card exists for.
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('says "not connected" on the folded line when it is not', async () => {
    window.history.replaceState({}, '', '/settings');
    apiMock.google.get.mockResolvedValue(DISCONNECTED);
    renderWithProviders(<GoogleConnectionCard />);

    expect(await screen.findByText('Not connected')).toBeDefined();
  });
});
