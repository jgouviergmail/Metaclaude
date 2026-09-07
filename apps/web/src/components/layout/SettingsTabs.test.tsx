/**
 * The Settings strip, and the two promises it makes.
 *
 * It replaced Radix tabs, so the first promise is that it is *not* a tab strip:
 * each entry changes the route, and `role="tab"` would tell a screen reader
 * that a panel swaps in place under the same URL. The second is that it reads
 * as the same kind of thing as the System strip beside it — chips, not an
 * underline — because a section and the screens inside it is one idea, and the
 * two sections used to draw it two ways.
 *
 * The owner-only groups are the third: an operator has no business in
 * connections, configuration or the audit log, and the API refuses them there.
 * A strip that offered them would be a row of links to a redirect.
 */

import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { useAuthStore } from '@/lib/store';
import { SETTINGS_PATHS, SettingsTabs, isSettingsPath, landingSection } from './SettingsTabs';

const signIn = (role: 'owner' | 'operator') => {
  useAuthStore.setState({ user: { id: 'u1', username: 'jgo', role } as never });
};

beforeEach(() => signIn('owner'));

describe('SettingsTabs', () => {
  it('lists the six groups in the order they were asked for', () => {
    // Written out rather than derived: a table generated from the same source
    // as the component would agree with any reordering.
    expect(SETTINGS_PATHS.map((entry) => entry.label)).toEqual([
      'Appearance',
      'Connections',
      'Security',
      'Configuration',
      'Audit log',
      'Help',
    ]);
  });

  it('keeps Help’s URL exactly as it was', () => {
    // It moved section, not address: the guide, the command palette and any
    // bookmark still point at `/help`.
    expect(SETTINGS_PATHS.at(-1)?.to).toBe('/help');
  });

  it('marks the screen you are on, and only that one', () => {
    render(<SettingsTabs />, { route: '/settings/security' });
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('href')).toBe('/settings/security');
  });

  it('marks Help as current when you are reading it', () => {
    render(<SettingsTabs />, { route: '/help' });
    const current = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/help');
  });

  it('does not claim to be a tab strip, since each entry changes the route', () => {
    render(<SettingsTabs />, { route: '/settings/appearance' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('draws chips, in the same register as the System strip', () => {
    render(<SettingsTabs />, { route: '/settings/appearance' });
    const current = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page') as HTMLElement;
    expect(current.className).toContain('rounded-full');
    expect(current.className).toContain('bg-accent-soft');
    expect(current.className).not.toContain('border-b-2');
  });

  it('carries the coarse-pointer hit area the small controls use', () => {
    render(<SettingsTabs />, { route: '/settings/appearance' });
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('pointer-coarse:before:');
    }
  });

  it('scrolls rather than wrapping, and keeps each chip whole', () => {
    // Six French labels do not fit 390px. A strip that wraps pushes the content
    // down on every phone; one that only says `flex-nowrap` squeezes the chips
    // into multi-line pills and gets taller still.
    render(<SettingsTabs />, { route: '/settings/appearance' });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.className).toContain('[&>*]:shrink-0');
  });
});

describe('what an operator is offered', () => {
  it('hides the three groups the API would refuse them', () => {
    signIn('operator');
    render(<SettingsTabs />, { route: '/settings/appearance' });
    const names = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(names).toEqual(['/settings/appearance', '/settings/security', '/help']);
  });

  it('offers an owner all six', () => {
    signIn('owner');
    render(<SettingsTabs />, { route: '/settings/appearance' });
    expect(screen.getAllByRole('link')).toHaveLength(6);
  });
});

describe('which paths the section owns', () => {
  it('claims its own groups and the help screen', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/security')).toBe(true);
    expect(isSettingsPath('/help')).toBe(true);
  });

  it('claims nothing that belongs to another section', () => {
    // `/server` is the trap: it was a Settings tab until this change, and a
    // prefix test written carelessly would still answer yes.
    expect(isSettingsPath('/server')).toBe(false);
    expect(isSettingsPath('/automations')).toBe(false);
    expect(isSettingsPath('/')).toBe(false);
  });
});

describe('where a bare /settings forwards', () => {
  it('goes to the first group', () => {
    expect(landingSection('')).toBe('appearance');
  });

  it('goes to Connections when Google’s callback carried an outcome', () => {
    expect(landingSection('?google=connected')).toBe('connections');
  });
});
