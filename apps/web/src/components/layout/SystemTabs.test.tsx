/**
 * The six screens that make up System, and the strip that says so.
 *
 * They were six top-level rail entries out of ten — automations, agents,
 * plugins, analytics, settings, help — which is why the phone had to hide four
 * of them behind a "More" sheet: ten does not fit a tab bar, and the choice of
 * which four to hide was made by the available space rather than by meaning.
 *
 * Their URLs deliberately do not change. The API builds links to `/settings`
 * for the Google OAuth return and to `/automations` for a notification, push
 * notifications point at their own paths, and an operator has bookmarks. The
 * grouping is navigational, not a move.
 *
 * These are links, not tabs: each one changes the route. `role="tab"` would
 * promise a panel switching in place, and a screen reader would announce a
 * relationship that does not exist.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { SYSTEM_SECTION_PATHS } from '@metaclaude/shared';
import { isSystemPath, SYSTEM_PATHS, SystemTabs } from './SystemTabs';

describe('SystemTabs', () => {
  it('lists every screen of the section', () => {
    render(<SystemTabs />, { route: '/automations' });
    const nav = screen.getByRole('navigation', { name: 'System sections' });
    expect(nav.querySelectorAll('a')).toHaveLength(SYSTEM_PATHS.length);
  });

  it('marks the screen you are on, and only that one', () => {
    render(<SystemTabs />, { route: '/automations' });
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('href')).toBe('/automations');
  });

  it('keeps every URL exactly as it was, because other systems build them', () => {
    // The Google OAuth callback returns to `/settings?google=…`, a scheduler
    // notification links to `/automations`, and push notifications carry their
    // own paths. A rename here is a silent break there.
    expect(SYSTEM_PATHS.map((entry) => entry.to)).toEqual([
      '/server',
      '/automations',
      '/agents',
      '/plugins',
      '/analytics',
    ]);
    // And the same list the predicate reads, in the same order: the strip
    // pairs these paths with icons, `lib/sections` answers "which section owns
    // this" from the contract, and a screen added to one and forgotten in the
    // other leaves the rail highlighting nothing while you stand on it.
    expect(SYSTEM_PATHS.map((entry) => entry.to)).toEqual([...SYSTEM_SECTION_PATHS]);
  });

  /*
   * Settings is deliberately absent, and `isSystemPath` has to agree.
   *
   * The strip and the rail read the same list, so dropping the entry alone
   * would have left `/settings` matching nothing — no current chip, and the
   * rail highlighting no section at all on the screen an operator opens most.
   * Its URL is untouched: what changed is which group owns it.
   */
  it('no longer counts Settings or Help as one of its screens', () => {
    // Settings left because it is where an operator goes deliberately and by
    // name; Help left because it is the manual, not a capability. Both keep
    // their URLs — what changed is the group that owns them.
    expect(SYSTEM_PATHS.map((entry) => entry.to)).not.toContain('/settings');
    expect(SYSTEM_PATHS.map((entry) => entry.to)).not.toContain('/help');
    expect(isSystemPath('/settings')).toBe(false);
    expect(isSystemPath('/help')).toBe(false);
    expect(isSystemPath('/server')).toBe(true);
    expect(isSystemPath('/automations')).toBe(true);
  });

  it('scrolls rather than wrapping, because five French labels do not fit a phone', () => {
    render(<SystemTabs />, { route: '/automations' });
    expect(screen.getByRole('navigation', { name: 'System sections' }).className).toContain(
      'overflow-x-auto',
    );
  });

  it('does not claim to be a tab strip, since each entry changes the route', () => {
    render(<SystemTabs />, { route: '/automations' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

/**
 * Two levels of navigation, two registers.
 *
 * Agents carries four tabs of its own. Drawn in the same register as this
 * strip they stacked into two identical scrolling rows — ninety pixels of a
 * phone's height, with nothing saying which moved between screens and which
 * moved within one. Chips here, underline there.
 */
describe('the section strip reads as a different level from a page tab strip', () => {
  it('uses chips rather than the underline a tab strip uses', () => {
    render(<SystemTabs />, { route: '/automations' });
    const current = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page') as HTMLElement;
    expect(current.className).toContain('rounded-full');
    expect(current.className).toContain('bg-accent-soft');
    expect(current.className).not.toContain('border-b-2');
  });
});

/**
 * Where you are has to be visible.
 *
 * Five French labels are wider than a phone, so the strip scrolls — and it
 * scrolls from the left, which put the current chip off-screen on every
 * System screen at 390px. A strip that does not show your position is not
 * navigation; it is a row of links.
 */
describe('the current section is brought into view', () => {
  it('scrolls the current chip into the strip', () => {
    const calls: Array<HTMLElement> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      calls.push(this);
    };
    try {
      render(<SystemTabs />, { route: '/analytics' });
      const current = screen
        .getAllByRole('link')
        .find((link) => link.getAttribute('aria-current') === 'page');
      expect(calls).toContain(current);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

/**
 * A chip is 36px painted, which is right for the strip and short of a thumb.
 *
 * The app already solved this: an inset pseudo-element under `pointer: coarse`
 * grows the hit area without touching the layout, on the vertical axis only —
 * the chips sit 6px apart, so a sideways area would let one steal presses
 * meant for its neighbour. Reused rather than reinvented.
 */
describe('the chips are reachable with a thumb', () => {
  it('carries the coarse-pointer hit area the small controls use', () => {
    render(<SystemTabs />, { route: '/automations' });
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('pointer-coarse:before:');
    }
  });
});


/**
 * The strip and the predicate must agree.
 *
 * `isSystemPath` lives in `lib/sections` and lists the prefixes by hand, so
 * that `AppShell` — in the entry chunk — can ask which section a path belongs
 * to without pulling this module's six icons in behind it. The bundle ratchet
 * measured that at +1 kB gzip. The cost of writing them twice is that they can
 * drift: a screen added to the strip and forgotten there would leave the rail
 * highlighting nothing while you stand on it. This is the seam, held shut.
 */
describe('the strip and the predicate list the same screens', () => {
  it('recognises every screen the strip offers', () => {
    for (const entry of SYSTEM_PATHS) {
      expect(isSystemPath(entry.to), entry.to).toBe(true);
    }
  });

  it('recognises a child route of one, and nothing outside the section', () => {
    expect(isSystemPath(`${SYSTEM_PATHS[0]!.to}/anything`)).toBe(true);
    expect(isSystemPath('/')).toBe(false);
    expect(isSystemPath('/board')).toBe(false);
    // The trap a prefix test falls into: `/serverless` is not `/server`.
    expect(isSystemPath('/serverless')).toBe(false);
  });
});
