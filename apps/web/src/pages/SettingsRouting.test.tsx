/**
 * Where Settings sends you, and what it refuses.
 *
 * Its groups became routes, and a route can be typed, bookmarked and linked
 * from outside — none of which a Radix tab could. Three things follow, and all
 * three are the kind that fail silently:
 *
 *  - `/settings` still has to work and still has to carry its query, because
 *    `integrations.ts` returns from Google's consent there. The toast that
 *    reports the outcome lives in the connection card; lose the query and the
 *    operator sees a settings page and never learns whether it worked.
 *  - a slug nobody defined must land somewhere real, not on an empty shell.
 *  - an operator typing an owner-only group must be sent away, exactly as the
 *    API sends them away.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createTestQueryClient } from '@/test/render';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/primitives';
import { useAuthStore } from '@/lib/store';
import { routePattern, routes } from '@metaclaude/shared';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    system: vi.fn(),
    auditLog: vi.fn(),
    runtimeSettings: vi.fn(),
    googleStatus: vi.fn(),
    apiTokens: vi.fn(),
    workspaces: vi.fn(),
    sessions: vi.fn(),
    passkeys: vi.fn(),
    push: { status: vi.fn() },
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { SettingsPage, SettingsRedirect } from './SettingsPage';

const signIn = (role: 'owner' | 'operator') => {
  useAuthStore.setState({ user: { id: 'u1', username: 'jgo', role } as never });
};

/** The two routes as `App.tsx` wires them, so the redirect actually lands. */
function renderAt(route: string) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[route]}>
          <TooltipProvider>
            <Routes>
              <Route path={routes.settings()} element={<SettingsRedirect />} />
              <Route path={routePattern.settingsSection} element={<SettingsPage />} />
              {/* Where an unknown or forbidden slug is expected to end up. */}
              <Route path="*" element={<div data-testid="elsewhere" />} />
            </Routes>
          </TooltipProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn('owner');
  for (const fn of [apiMock.auditLog, apiMock.runtimeSettings, apiMock.googleStatus, apiMock.apiTokens]) {
    fn.mockResolvedValue({});
  }
  apiMock.system.mockResolvedValue({ claudeCli: {} });
  apiMock.workspaces.mockResolvedValue({ workspaces: [] });
  apiMock.push.status.mockResolvedValue({ publicKey: 'k', devices: 0 });
  apiMock.passkeys.mockResolvedValue({ credentials: [] });
  apiMock.sessions.mockResolvedValue({ sessions: [] });
});

describe('a bare /settings', () => {
  it('lands on the first group', async () => {
    renderAt('/settings');
    // The appearance group is the only one that renders the density control.
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy(),
    );
    // Scoped to the strip: the rail marks itself current on these routes too —
    // correctly, it owns the section — so an unscoped query picks the rail's
    // link and reads `/settings/appearance` whatever the group.
    const strip = screen.getByRole('navigation', { name: 'Settings sections' });
    const current = within(strip)
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/settings/appearance');
  });

  it('carries Google’s outcome to the group that can report it', async () => {
    // Not merely "goes to connections": the query has to survive the redirect,
    // or the card mounts with nothing to read and the outcome is swallowed.
    renderAt('/settings?google=connected');
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy(),
    );
    // Scoped to the strip: the rail marks itself current on these routes too —
    // correctly, it owns the section — so an unscoped query picks the rail's
    // link and reads `/settings/appearance` whatever the group.
    const strip = screen.getByRole('navigation', { name: 'Settings sections' });
    const current = within(strip)
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/settings/connections');
  });
});

describe('a group that does not exist', () => {
  it('sends you to the first one rather than rendering an empty page', async () => {
    renderAt('/settings/nonexistent');
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy(),
    );
    // Scoped to the strip: the rail marks itself current on these routes too —
    // correctly, it owns the section — so an unscoped query picks the rail's
    // link and reads `/settings/appearance` whatever the group.
    const strip = screen.getByRole('navigation', { name: 'Settings sections' });
    const current = within(strip)
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/settings/appearance');
  });
});

describe('an owner-only group, typed by an operator', () => {
  it('sends them away, exactly as the API would', async () => {
    signIn('operator');
    renderAt('/settings/audit');
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy(),
    );
    // Scoped to the strip: the rail marks itself current on these routes too —
    // correctly, it owns the section — so an unscoped query picks the rail's
    // link and reads `/settings/appearance` whatever the group.
    const strip = screen.getByRole('navigation', { name: 'Settings sections' });
    const current = within(strip)
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/settings/appearance');
  });

  it('still lets an owner in', async () => {
    signIn('owner');
    renderAt('/settings/audit');
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy(),
    );
    // Scoped to the strip: the rail marks itself current on these routes too —
    // correctly, it owns the section — so an unscoped query picks the rail's
    // link and reads `/settings/appearance` whatever the group.
    const strip = screen.getByRole('navigation', { name: 'Settings sections' });
    const current = within(strip)
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/settings/audit');
  });
});
