/**
 * The one routing decision the settings page makes on its own: which tab it
 * opens on. Pure-function tests, deliberately — rendering the whole page
 * would drag a dozen API mocks for a decision that takes a query string.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: { setRuntimeSetting: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';

import { AppearanceCard, initialSettingsTab } from './SettingsPage';

describe('which tab the settings page opens on', () => {
  it('opens Security by default', () => {
    expect(initialSettingsTab('')).toBe('security');
    expect(initialSettingsTab('?theme=dark')).toBe('security');
  });

  it('opens Connections when Google’s callback carried an outcome', () => {
    // The toast lives in the connection card, and Radix unmounts inactive
    // tabs: landing anywhere else swallows the outcome silently.
    expect(initialSettingsTab('?google=connected')).toBe('connections');
    expect(initialSettingsTab('?google=failed&reason=redirect_uri_mismatch')).toBe('connections');
  });
});

/* -------------------------------------------------------------------------- */
/* The language picker                                                         */
/* -------------------------------------------------------------------------- */

/**
 * "The app is in French" is one idea, so it is one control — but two settings
 * underneath, and they have to be. The interface's language is a per-browser
 * preference; what the system *writes* is a corpus with exactly one language
 * whoever reads it. The picker does both, and the second half is best effort.
 */
describe('choosing the language', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.setRuntimeSetting.mockResolvedValue({});
  });

  const asRole = (role: string) =>
    useAuthStore.setState({ user: { id: 'u1', username: 'jgo', role } as never });

  it('tells the server what to write in, as well as switching the interface', async () => {
    asRole('owner');
    renderWithProviders(<AppearanceCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Français' }));

    await waitFor(() => expect(apiMock.setRuntimeSetting).toHaveBeenCalledWith('language', 'fr'));
  });

  /** Only an owner may change a deployment setting; a reader's own language is still theirs. */
  it('changes only the interface for someone who cannot change the deployment', async () => {
    asRole('viewer');
    renderWithProviders(<AppearanceCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Français' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Français' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(apiMock.setRuntimeSetting).not.toHaveBeenCalled();
  });

  /** A refused write must not take the interface down with it. */
  it('survives the server refusing the write', async () => {
    asRole('owner');
    apiMock.setRuntimeSetting.mockRejectedValue(new Error('403'));
    renderWithProviders(<AppearanceCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Français' }));

    await waitFor(() => expect(apiMock.setRuntimeSetting).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Français' })).toBeDefined();
  });

  /** The card no longer claims everything in it is browser-only, because it is not. */
  it('does not claim the language stays in this browser', () => {
    asRole('owner');
    renderWithProviders(<AppearanceCard />);

    expect(screen.queryByText('These preferences live in this browser only.')).toBeNull();
    expect(screen.getByText(/Metaclaude writes in this language too/)).toBeTruthy();
  });
});
