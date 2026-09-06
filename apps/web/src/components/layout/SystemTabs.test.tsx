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
import { SYSTEM_PATHS, SystemTabs } from './SystemTabs';

describe('SystemTabs', () => {
  it('lists every screen of the section', () => {
    render(<SystemTabs />, { route: '/settings' });
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
      '/automations',
      '/agents',
      '/plugins',
      '/analytics',
      '/settings',
      '/help',
    ]);
  });

  it('scrolls rather than wrapping, because six French labels do not fit a phone', () => {
    render(<SystemTabs />, { route: '/settings' });
    expect(screen.getByRole('navigation', { name: 'System sections' }).className).toContain(
      'overflow-x-auto',
    );
  });

  it('does not claim to be a tab strip, since each entry changes the route', () => {
    render(<SystemTabs />, { route: '/settings' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

/**
 * Two levels of navigation, two registers.
 *
 * Settings carries six tabs of its own. Drawn in the same register as this
 * strip they stacked into two identical scrolling rows — ninety pixels of a
 * phone's height, with nothing saying which moved between screens and which
 * moved within one. Chips here, underline there.
 */
describe('the section strip reads as a different level from a page tab strip', () => {
  it('uses chips rather than the underline a tab strip uses', () => {
    render(<SystemTabs />, { route: '/settings' });
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
 * Six French labels are wider than a phone, so the strip scrolls — and it
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
      render(<SystemTabs />, { route: '/help' });
      const current = screen
        .getAllByRole('link')
        .find((link) => link.getAttribute('aria-current') === 'page');
      expect(calls).toContain(current);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

