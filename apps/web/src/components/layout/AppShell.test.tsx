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

  it('never lets the safe-area padding share an element with the fixed height', () => {
    // The trap that shipped miniature icons twice: with border-box sizing,
    // `h-14` and `padding-bottom: env(safe-area-inset-bottom)` on the SAME
    // element leave 56 − ~34 = 22px of content on a gesture-nav phone, and
    // flexbox crushes the icons into it — while every browser tab (inset 0)
    // looks fine. The outer nav must own the padding and paint the
    // home-indicator zone; the inner row must own the full 3.5rem.
    renderWithProviders(<AppShell>content</AppShell>);

    const tabBar = screen
      .getAllByRole('navigation', { name: 'Sections' })
      .find((bar) => bar.className.includes('fixed')) as HTMLElement;
    expect(tabBar.className).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(tabBar.className).not.toMatch(/\bh-14\b/);

    const row = tabBar.firstElementChild as HTMLElement;
    expect(row.className).toMatch(/\bh-14\b/);

    // And no future squeeze may crush the icon: it opts out of shrinking.
    const firstTab = within(tabBar).getAllByRole('link')[0] as HTMLElement;
    expect(firstTab.className).toContain('[&>svg]:shrink-0');
  });

  it('leaves the bottom inset to the tab bar — the page chrome must not pad it too', async () => {
    // Three layers once reserved the same ~34px (body padding, main padding,
    // the bar's own) and the stack showed as bare bands around the bar. The
    // body's global padding therefore states 0 for the bottom, and this
    // reads the stylesheet to keep it that way.
    const { readFileSync } = await import('node:fs');
    // Not import.meta.url: vitest serves modules over http, not file://.
    const css = readFileSync('src/styles/index.css', 'utf8');
    const bodyRule = /body\s*\{[^}]*\}/g;
    for (const match of css.match(bodyRule) ?? []) {
      expect(match).not.toContain('env(safe-area-inset-bottom)');
    }
    // The padding shorthand still guards the notch and the sides.
    expect(css).toContain('env(safe-area-inset-top)');
  });

  it('keeps the rail listing every section for wider screens', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    for (const label of SECONDARY) {
      // Sheet closed: the rail's entry is the only one.
      expect(screen.getAllByLabelText(label)).toHaveLength(1);
    }
  });
});

/**
 * Which section is announced as current.
 *
 * `NavLink` marks itself current by comparing the location to its own `to`, so
 * `/w/:id` and `/w/:id/s/:id` matched nothing at all: the two screens an
 * operator spends the most time in announced no active section, and the rail
 * showed none highlighted either.
 */
describe('the current section', () => {
  it('stays Workspaces inside a workspace', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/w/ws_1' });
    const entries = screen.getAllByLabelText('Workspaces');
    expect(entries.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);
  });

  it('stays Workspaces inside a session', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/w/ws_1/s/ses_1' });
    const entries = screen.getAllByLabelText('Workspaces');
    expect(entries.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);
  });

  it('does not claim a section the route does not belong to', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/w/ws_1' });
    const board = screen.getAllByLabelText('Board');
    expect(board.some((el) => el.getAttribute('aria-current') === 'page')).toBe(false);
  });
});

