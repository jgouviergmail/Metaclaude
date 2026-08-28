/**
 * The account menu: identity, theme, transcript preferences, sign out.
 *
 * The one behaviour worth guarding above the rest is that signing out
 * discards the local session **even when the request fails** — a sign-out
 * that leaves you signed in because the network blinked is the worst possible
 * failure mode for this particular button.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { UserMenu } from './UserMenu';

const { apiMock, socketMock, navigate, store, ui } = vi.hoisted(() => ({
  apiMock: { logout: vi.fn() },
  socketMock: { dispose: vi.fn() },
  navigate: vi.fn(),
  store: {
    user: {
      id: 'usr_1',
      username: 'jules',
      displayName: 'Jules Gouvier',
      role: 'owner',
      totpEnabled: true,
      createdAt: 0,
      lastLoginAt: null,
    } as { id: string; username: string; displayName: string; role: string } | null,
    setUser: vi.fn(),
  },
  ui: {
    theme: 'system' as string,
    setTheme: vi.fn(),
    showThinking: false,
    setShowThinking: vi.fn(),
    expandTools: false,
    setExpandTools: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/socket', () => ({ socket: socketMock }));
vi.mock('@/lib/store', () => ({
  useAuthStore: () => store,
  useUiStore: () => ui,
}));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
}));

const openMenu = () => {
  const trigger = screen.getByRole('button', { name: 'Account' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.logout.mockResolvedValue(undefined);
  ui.theme = 'system';
  ui.showThinking = false;
  ui.expandTools = false;
});

describe('identity', () => {
  it('shows initials, and names the trigger for a screen reader', () => {
    renderWithProviders(<UserMenu />);
    const trigger = screen.getByRole('button', { name: 'Account' });
    expect(trigger.textContent).toBe('JG');
  });

  it('renders nothing at all when nobody is signed in', () => {
    const previous = store.user;
    store.user = null;
    const { container } = renderWithProviders(<UserMenu />);
    expect(container.textContent).toBe('');
    store.user = previous;
  });

  it('states the role beside the name, because it decides what is possible', () => {
    renderWithProviders(<UserMenu />);
    openMenu();
    expect(screen.getByText(/Jules Gouvier/)).toBeDefined();
    expect(screen.getByText(/\(owner\)/)).toBeDefined();
  });
});

describe('preferences', () => {
  it('marks the active theme as checked, not merely ticked', () => {
    ui.theme = 'dark';
    renderWithProviders(<UserMenu />);
    openMenu();

    expect(screen.getByRole('menuitemcheckbox', { name: 'Dark' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'System' }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('changes the theme through the store', () => {
    renderWithProviders(<UserMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Light' }));
    expect(ui.setTheme).toHaveBeenCalledWith('light');
  });

  it('toggles both transcript preferences in one opening', () => {
    // The code carried a comment promising the menu stays open for exactly
    // this, and no `keepOpen` prop to make it true — so the second toggle
    // needed a reopen the comment said it would not.
    renderWithProviders(<UserMenu />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show reasoning' }));
    expect(ui.setShowThinking).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Expand tool calls' }));
    expect(ui.setExpandTools).toHaveBeenCalledWith(true);
  });
});

describe('signing out', () => {
  it('discards the session, drops the socket and leaves for the login screen', async () => {
    renderWithProviders(<UserMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(apiMock.logout).toHaveBeenCalled());
    expect(socketMock.dispose).toHaveBeenCalled();
    expect(store.setUser).toHaveBeenCalledWith(null);
    expect(navigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('signs out locally even when the request fails', async () => {
    // The worst failure mode this button has: a network blink leaving the
    // user signed in on a machine they meant to walk away from.
    apiMock.logout.mockRejectedValue(new Error('offline'));
    renderWithProviders(<UserMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(store.setUser).toHaveBeenCalledWith(null));
    expect(socketMock.dispose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login', { replace: true });
  });
});
