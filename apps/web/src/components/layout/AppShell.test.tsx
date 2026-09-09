/**
 * The shell's promise on a phone: every section reachable with a thumb.
 *
 * The tab bar holds the six primary sections; everything else must be one
 * tap behind "More" — five screens used to have no touch entry point at
 * all, reachable only by URL or the command palette.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { SystemTabs } from './SystemTabs';
import { AppShell, ContentHeader } from './AppShell';

/** The System screens the rail no longer carries: its strip does. */
/** The System strip's own screens. `Server` left it for Settings. */
const SECONDARY = ['Automations', 'Agents & skills', 'Plugins', 'Analytics'];

describe('AppShell navigation', () => {
  it('offers the same six sections in the rail and in the phone tab bar', () => {
    // There is no seventh entry and no sheet: ten sections did not fit a tab
    // bar, so four were hidden behind "More" by the available space rather
    // than by meaning. Five of the ten are one section now, and Settings —
    // the screen reached most deliberately — keeps an entry of its own.
    renderWithProviders(<AppShell>content</AppShell>);

    const bars = screen.getAllByRole('navigation', { name: 'Sections' });
    expect(bars).toHaveLength(2); // the rail and the tab bar

    // By accessible name, not by visible text: the tab bar shortens two of
    // the labels to fit six cells across a phone, and the name is the part
    // that must not change.
    for (const label of ['Dashboard', 'Workspaces', 'Board', 'Memory', 'System', 'Settings']) {
      expect(screen.getAllByLabelText(label).length, label).toBeGreaterThanOrEqual(2);
    }
    for (const bar of bars) {
      expect(within(bar).getAllByRole('link').length).toBeLessThanOrEqual(7); // 6 + the logo
    }
  });

  it('reaches the four System screens from the section itself, not from the rail', () => {
    // The rail no longer carries them, so the section's own strip has to — and
    // it is the thing that makes them one section rather than five entries.
    renderWithProviders(<SystemTabs />, { route: '/automations' });
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
    // `text-caption` — 11.5px — rather than the literal 11px it pinned before.
    // What this case protects is the metric, not the number: a 24px glyph and a
    // label small enough that both fit the 56px bar with the home indicator
    // under it. Half a pixel does not move that, and a role is what the rest of
    // the app now speaks.
    expect(firstTab.className).toContain('text-caption');

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

  it('keeps the rail down to the six, on every screen width', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    const rail = screen
      .getAllByRole('navigation', { name: 'Sections' })
      .find((bar) => !bar.className.includes('fixed')) as HTMLElement;
    // Six sections plus the logo, and nothing that used to be hidden.
    expect(within(rail).getAllByRole('link')).toHaveLength(7);
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
 * Six sections, and no "More".
 *
 * Ten top-level entries did not fit a phone's tab bar, so four lived behind a
 * sheet — and which four was decided by the available space rather than by
 * meaning. Five of them were the same kind of thing: what the deployment can
 * do and how it is inspected, not what an operator works in. They are one
 * section, so the rail and the tab bar hold the same six, in the same order,
 * and nothing is one tap further away than anything else.
 */
describe('the six sections', () => {
  it('shows six in the rail and the same six on the phone', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    for (const label of ['Dashboard', 'Workspaces', 'Board', 'Memory', 'System', 'Settings']) {
      expect(screen.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
  });

  it('has no More sheet, because nothing is hidden any more', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    expect(screen.queryByLabelText('More sections')).toBeNull();
  });

  it('marks System as current on each of its four screens', () => {
    for (const route of ['/automations', '/agents', '/plugins', '/analytics']) {
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

  /*
   * Settings left the System group, and both halves of that have to hold.
   *
   * It was the group's `to`, so the rail pointed at `/settings` while the
   * strip listed it sixth — the entry an operator reaches for most often sat
   * one tap deeper than the four beside it, and "System" named both the group
   * and a tab inside Settings. Testing only that Settings lights up would
   * pass just as well if System lit up too, which is the state this replaces.
   */
  it('marks Settings as current on its own screen, and System not at all', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/settings/security' });

    const settings = screen.getAllByLabelText('Settings');
    expect(settings.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);

    const system = screen.getAllByLabelText('System');
    expect(system.some((el) => el.getAttribute('aria-current') === 'page')).toBe(false);
  });

  /*
   * The two labels the phone shortens.
   *
   * Six cells at 390px are 65px each; `Dashboard` inks 60px and `Workspaces`
   * 69, leaving a 2px gutter between them — measured with a Range by
   * `scripts/measure-tabbar.mjs`, not estimated. Nothing in the responsive
   * guard reports it and nothing should: neither label is clipped, neither
   * overlaps, no ancestor overflows. It is only unreadable.
   *
   * French never had the problem — it already says `Accueil` and `Espaces` —
   * so the short forms are those two labels said in English. What must not
   * follow the text is the accessible name: a tab announced as "Overview"
   * would not be findable by the section it opens.
   */
  it('shortens two labels on the phone and keeps their names intact', () => {
    renderWithProviders(<AppShell>content</AppShell>);
    const tabBar = screen
      .getAllByRole('navigation', { name: 'Sections' })
      .find((bar) => bar.className.includes('fixed')) as HTMLElement;

    expect(within(tabBar).getByText('Overview')).toBeDefined();
    expect(within(tabBar).getByText('Spaces')).toBeDefined();
    expect(within(tabBar).queryByText('Dashboard')).toBeNull();
    expect(within(tabBar).queryByText('Workspaces')).toBeNull();

    // Named by the section, whatever the cell shows.
    expect(within(tabBar).getByRole('link', { name: 'Dashboard' })).toBeDefined();
    expect(within(tabBar).getByRole('link', { name: 'Workspaces' })).toBeDefined();
  });

  it('leaves the four that fit alone, in both places', () => {
    // A short form is a concession to width, not a style: applying it where
    // the full label fits would be a second vocabulary for the same thing.
    renderWithProviders(<AppShell>content</AppShell>);
    const tabBar = screen
      .getAllByRole('navigation', { name: 'Sections' })
      .find((bar) => bar.className.includes('fixed')) as HTMLElement;
    for (const label of ['Board', 'Memory', 'System', 'Settings']) {
      expect(within(tabBar).getByText(label), label).toBeDefined();
    }
  });

  /*
   * Help moved out of the System group and into Settings.
   *
   * It was the one entry there that did not describe something the deployment
   * *does* — it is the manual. Its URL is untouched, so every link and
   * bookmark still lands; what changed is which section owns it, and the rail
   * has to agree or `/help` highlights nothing at all.
   */
  it('marks Settings as current on the help screen', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/help' });

    const settings = screen.getAllByLabelText('Settings');
    expect(settings.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);

    const system = screen.getAllByLabelText('System');
    expect(system.some((el) => el.getAttribute('aria-current') === 'page')).toBe(false);
  });

  it('sends each rail entry to the first screen of its own strip', () => {
    // Not to a screen the strip does not list: the entry and the strip under
    // it have to agree, or the first thing an operator sees is a page the
    // chips say they are not on. `/server` moved from System to Settings, and
    // both entries move with it — one loses its first screen, the other gains
    // one.
    renderWithProviders(<AppShell>content</AppShell>);

    const system = screen.getAllByLabelText('System')[0] as HTMLElement;
    expect(system.getAttribute('href')).toBe('/automations');

    const settings = screen.getAllByLabelText('Settings')[0] as HTMLElement;
    expect(settings.getAttribute('href')).toBe('/server');
  });

  it('marks Settings as current on the screen that moved into it', () => {
    renderWithProviders(<AppShell>content</AppShell>, { route: '/server' });

    const entries = screen.getAllByLabelText('Settings');
    expect(entries.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);
    expect(
      screen.getAllByLabelText('System').some((el) => el.getAttribute('aria-current') === 'page'),
    ).toBe(false);
  });
});

/**
 * The rail and the tab bar are the same list, and that is now structural.
 *
 * A `primary` flag used to say which sections the phone could afford. With ten
 * it discriminated; with six every entry carried it and the flag was a
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
    expect(tabSections).toHaveLength(6);
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


/**
 * The panel button exists only when there is a panel.
 *
 * Three screens shipped a "Toggle panel" button with nothing behind it —
 * Board, Help and Plugins — because `ContentHeader`'s default was `true` and
 * the two components live in different files, so nobody adding a header
 * remembered to say otherwise. A control that does nothing is worse than a
 * missing one: it teaches the operator that pressing things here has no
 * effect. The shell knows whether it was given a panel; the header asks it.
 */
describe('the panel toggle', () => {
  it('is absent on a screen with no panel', () => {
    renderWithProviders(
      <AppShell>
        <ContentHeader title="Board" />
      </AppShell>,
    );
    expect(screen.queryByRole('button', { name: 'Toggle panel' })).toBeNull();
  });

  it('is there on a screen that has one', () => {
    renderWithProviders(
      <AppShell sidebar={<div>panel</div>}>
        <ContentHeader title="Workspace" />
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'Toggle panel' })).toBeTruthy();
  });

  it('can still be hidden deliberately on a screen that has one', () => {
    // The override stays for a screen whose panel is reached another way.
    renderWithProviders(
      <AppShell sidebar={<div>panel</div>}>
        <ContentHeader title="Workspace" showSidebarToggle={false} />
      </AppShell>,
    );
    expect(screen.queryByRole('button', { name: 'Toggle panel' })).toBeNull();
  });
});

/**
 * The title keeps enough of the row to be read.
 *
 * `truncate` is doing exactly what it is for, so nothing reports this: no
 * control is clipped, nothing overflows, no ancestor scrolls. The title is
 * simply the flexible item in a row whose buttons are not — and it is the only
 * thing on screen saying which page you are on. Measured at 390px:
 * `Automations` had 91px, `Aut…`; `Board` had 24 of the 41 it wants; eight
 * titles across two languages were cut. `scripts/measure-titles.mjs` is what
 * found them and reports zero now.
 *
 * happy-dom lays nothing out, so what a test can hold is the class contract —
 * the two decisions that gave the row back its pixels.
 */
describe('what the header gives the title', () => {
  it('folds the decorative icon away on a phone', () => {
    // 28px with its gap, for something `aria-hidden` beside a title that
    // already says which page you are on.
    const { container } = renderWithProviders(
      <AppShell>
        <ContentHeader title="Memory" icon={<span data-testid="icon" />} />
      </AppShell>,
    );
    const wrapper = container.querySelector('[data-testid="icon"]')?.parentElement as HTMLElement;
    expect(wrapper.className).toContain('hidden');
    expect(wrapper.className).toContain('sm:block');
  });

  it('keeps the row tight on a phone and roomy beyond it', () => {
    const { container } = renderWithProviders(
      <AppShell>
        <ContentHeader title="Board" />
      </AppShell>,
    );
    const header = container.querySelector('main header') as HTMLElement;
    expect(header.className).toContain('gap-2');
    expect(header.className).toContain('sm:gap-3');
  });
});
