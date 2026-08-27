/**
 * The shell's promise on a phone: every section reachable with a thumb.
 *
 * The tab bar holds the five primary sections; everything else must be one
 * tap behind "More" — five screens used to have no touch entry point at
 * all, reachable only by URL or the command palette.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AppShell } from './AppShell';

const SECONDARY = ['Memory', 'Agents & skills', 'Plugins', 'Analytics', 'Help'];

describe('AppShell navigation', () => {
  it('offers every primary section plus More in the phone tab bar', () => {
    renderWithProviders(<AppShell>content</AppShell>);

    const bars = screen.getAllByRole('navigation', { name: 'Sections' });
    expect(bars).toHaveLength(2); // the rail and the tab bar

    for (const label of ['Dashboard', 'Workspaces', 'Board', 'Automations', 'Settings']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.getByRole('button', { name: 'More sections' })).toBeDefined();
  });

  it('More opens a sheet carrying the sections the tab bar cannot hold', () => {
    renderWithProviders(<AppShell>content</AppShell>);

    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    // Scoped to the sheet: the rail carries the same labels (jsdom ignores
    // the responsive `hidden`), and the point is that the sheet has them.
    const sheet = within(screen.getByRole('menu', { name: 'More sections' }));
    for (const label of SECONDARY) {
      expect(sheet.getByRole('link', { name: label })).toBeDefined();
    }
  });

  it('navigating from the sheet closes it', () => {
    renderWithProviders(<AppShell>content</AppShell>);

    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    const sheet = within(screen.getByRole('menu', { name: 'More sections' }));
    fireEvent.click(sheet.getByRole('link', { name: 'Memory' }));
    expect(screen.queryByRole('menu', { name: 'More sections' })).toBeNull();
  });

  it('holds platform tap-target metrics in the tab bar, safe area included', () => {
    // An installed PWA renders raw CSS metrics: unlike a browser tab, no
    // accessibility text-scaling rescues undersized icons, and on gesture-nav
    // iPhones the bar grows by the safe-area inset while the content behind
    // it does not — unless both are stated here. 24px icons and 11px labels
    // are the Material/iOS floor for a bottom bar; 19px and 10px read as
    // miniatures the moment nothing scales them up.
    renderWithProviders(<AppShell>content</AppShell>);

    const tabBar = screen
      .getAllByRole('navigation', { name: 'Sections' })
      .find((bar) => bar.className.includes('fixed'));
    expect(tabBar).toBeDefined();
    const firstTab = within(tabBar as HTMLElement).getAllByRole('link')[0] as HTMLElement;
    expect(firstTab.className).toContain('[&>svg]:size-6');
    expect(firstTab.className).toContain('text-[11px]');

    const main = screen.getByRole('main');
    expect(main.className).toContain('env(safe-area-inset-bottom)');
  });

  it('keeps the rail listing every section for wider screens', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    for (const label of SECONDARY) {
      // Sheet closed: the rail's entry is the only one.
      expect(screen.getAllByLabelText(label)).toHaveLength(1);
    }
  });
});
