/**
 * The shared strip, tested where the two sections cannot test it for each
 * other.
 *
 * `SystemTabs` and `SettingsTabs` were the same forty lines twice and had
 * already drifted — one carried `[&>*]:shrink-0`, the other did not. What is
 * pinned here is the contract both now inherit, so a change to it fails once
 * rather than being fixed in one copy and forgotten in the second.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Home, Settings } from 'lucide-react';
import { renderWithProviders as render } from '@/test/render';
import { SectionTabs, type SectionPath } from './SectionTabs';

const ENTRIES: SectionPath[] = [
  { to: '/one', label: 'One', icon: <Home /> },
  { to: '/two', label: 'Two', icon: <Settings /> },
];

describe('SectionTabs', () => {
  it('names its landmark, so two strips on one page stay distinguishable', () => {
    // The rail and a section strip can both be on screen; a shared name would
    // make either unfindable by anything reading the page.
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/one' });
    expect(screen.getByRole('navigation', { name: 'Test sections' })).toBeTruthy();
  });

  it('marks the screen you are on, and only that one', () => {
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/one' });
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('href')).toBe('/one');
  });

  it('marks a parent when you are on a child route', () => {
    // A section's screen may have routes under it; the strip has to keep
    // saying which section you are in.
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/two/detail' });
    const current = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/two');
  });

  it('does not claim a path that merely shares a prefix', () => {
    // `/onething` is not `/one`. A `startsWith` without the separator would
    // light the wrong chip.
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/onething' });
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(0);
  });

  it('does not claim to be a tab strip, since each entry changes the route', () => {
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/one' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('scrolls rather than wrapping, and keeps each chip whole', () => {
    // The drift that prompted the shared component: a chip row that shrinks
    // instead of scrolling breaks its own labels over three lines and ends up
    // taller than the wrapping version it replaced.
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/one' });
    const nav = screen.getByRole('navigation', { name: 'Test sections' });
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.className).toContain('[&>*]:shrink-0');
    expect(nav.className).not.toContain('flex-wrap');
  });

  it('draws chips, not an underline, because a page strip may sit under it', () => {
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/one' });
    const current = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page') as HTMLElement;
    expect(current.className).toContain('rounded-full');
    expect(current.className).toContain('bg-accent-soft');
    expect(current.className).not.toContain('border-b-2');
  });

  it('carries the coarse-pointer hit area on every chip', () => {
    render(<SectionTabs label="Test sections" entries={ENTRIES} />, { route: '/one' });
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('pointer-coarse:before:');
    }
  });
});
