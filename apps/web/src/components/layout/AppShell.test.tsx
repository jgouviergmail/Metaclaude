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
import { SystemTabs } from './SystemTabs';
import { AppShell, ContentHeader } from './AppShell';

/** The System screens the rail no longer carries: its strip does. */
const SECONDARY = ['Automations', 'Agents & skills', 'Plugins', 'Analytics', 'Help'];

describe('AppShell navigation', () => {
  it('offers the same five sections in the rail and in the phone tab bar', () => {
    // There is no sixth entry and no sheet: ten sections did not fit a tab bar,
    // so four were hidden behind "More" by the available space rather than by
    // meaning. Six of the ten are one section now.
    renderWithProviders(<AppShell>content</AppShell>);

    const bars = screen.getAllByRole('navigation', { name: 'Sections' });
    expect(bars).toHaveLength(2); // the rail and the tab bar

    for (const label of ['Dashboard', 'Workspaces', 'Board', 'Memory', 'System']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    for (const bar of bars) {
      expect(within(bar).getAllByRole('link').length).toBeLessThanOrEqual(6); // 5 + the logo
    }
  });

  it('reaches the six System screens from the section itself, not from the rail', () => {
    // The rail no longer carries them, so the section's own strip has to — and
    // it is the thing that makes them one section rather than six entries.
    renderWithProviders(<SystemTabs />, { route: '/settings' });
    const strip = within(screen.getByRole('navigation', { name: 'System sections' }));
    for (const label of SECONDARY) {
      expect(strip.getByRole('link', { name: new RegExp(label) })).toBeDefined();
    }
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

  it('keeps the rail down to the five, on every screen width', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    const rail = screen
      .getAllByRole('navigation', { name: 'Sections' })
      .find((bar) => !bar.className.includes('fixed')) as HTMLElement;
    // Five sections plus the logo, and nothing that used to be hidden.
    expect(within(rail).getAllByRole('link')).toHaveLength(6);
    for (const label of SECONDARY) {
      expect(within(rail).queryByLabelText(label)).toBeNull();
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

/**
 * Five sections, and no "More".
 *
 * Ten top-level entries did not fit a phone's tab bar, so four lived behind a
 * sheet — and which four was decided by the available space rather than by
 * meaning. Six of them were the same kind of thing: how the deployment is
 * configured and inspected, not what an operator works in. They are one
 * section now, so the rail and the tab bar hold the same five, in the same
 * order, and nothing is one tap further away than anything else.
 */
describe('the five sections', () => {
  it('shows five in the rail and the same five on the phone', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    for (const label of ['Dashboard', 'Workspaces', 'Board', 'Memory', 'System']) {
      expect(screen.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
  });

  it('has no More sheet, because nothing is hidden any more', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    expect(screen.queryByLabelText('More sections')).toBeNull();
  });

  it('marks System as current on each of its six screens', () => {
    for (const route of ['/automations', '/agents', '/plugins', '/analytics', '/settings', '/help']) {
      const { unmount } = renderWithProviders(<AppShell>content</AppShell>, { route });
      const entries = screen.getAllByLabelText('System');
      expect(
        entries.some((el) => el.getAttribute('aria-current') === 'page'),
        route,
      ).toBe(true);
      unmount();
    }
  });

  it('does not claim System on a screen that is not one of them', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/board' });
    const entries = screen.getAllByLabelText('System');
    expect(entries.some((el) => el.getAttribute('aria-current') === 'page')).toBe(false);
  });
});

/**
 * The rail and the tab bar are the same list, and that is now structural.
 *
 * A `primary` flag used to say which sections the phone could afford. With ten
 * it discriminated; with five every entry carried it and the flag was a
 * distinction without a difference — the kind of dead branch that reads as a
 * choice long after it stopped being one. It is gone, and this is what
 * replaces it: one list, rendered twice, in one order.
 */
describe('one list, two renderings', () => {
  it('renders the same sections in the same order in the rail and the tab bar', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    const bars = screen.getAllByRole('navigation', { name: 'Sections' });
    const rail = bars.find((bar) => !bar.className.includes('fixed')) as HTMLElement;
    const tabBar = bars.find((bar) => bar.className.includes('fixed')) as HTMLElement;

    // The rail leads with the logo, which is not a section.
    const railSections = within(rail)
      .getAllByRole('link')
      .slice(1)
      .map((link) => link.getAttribute('href'));
    const tabSections = within(tabBar)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));

    expect(railSections).toEqual(tabSections);
    expect(tabSections).toHaveLength(5);
  });
});

describe('ContentHeader', () => {
  it('renders a section strip under the header row when given one', () => {
    renderWithProviders(
      <ContentHeader title="Réglages" tabs={<nav aria-label="Sections de test">bande</nav>} />,
    );
    const strip = screen.getByRole('navigation', { name: 'Sections de test' });
    // Under the header row, not inside it: the strip is navigation for the
    // section, the row names the screen.
    expect(strip.closest('header')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Réglages' })).toBeDefined();
  });

  it('draws one rule, not two, when a strip is present', () => {
    const { container } = renderWithProviders(
      <ContentHeader title="Réglages" tabs={<nav aria-label="Sections de test">bande</nav>} />,
    );
    const bordered = container.querySelectorAll('.border-b');
    expect(bordered).toHaveLength(1);
  });
});

