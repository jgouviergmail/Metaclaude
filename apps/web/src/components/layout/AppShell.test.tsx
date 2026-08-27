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

  it('keeps the rail listing every section for wider screens', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    for (const label of SECONDARY) {
      // Sheet closed: the rail's entry is the only one.
      expect(screen.getAllByLabelText(label)).toHaveLength(1);
    }
  });
});
