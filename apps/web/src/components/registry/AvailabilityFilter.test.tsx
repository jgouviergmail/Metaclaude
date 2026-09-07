/**
 * The one filter three tabs share.
 *
 * Written as its own file rather than three times inside `AgentsPage.test.tsx`
 * for the reason the component exists at all: a segmented row copied per tab
 * is a row that loses `[&>*]:shrink-0` in one of the copies and squeezes its
 * chips on a phone instead of scrolling them.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { AvailabilityFilter, filterByAvailability } from './AvailabilityFilter';

const items = [
  { id: 'a', enabled: true },
  { id: 'b', enabled: false },
  { id: 'c', enabled: true },
];

describe('filterByAvailability', () => {
  it('answers the whole list, the enabled half, and the disabled half', () => {
    expect(filterByAvailability(items, 'all')).toHaveLength(3);
    expect(filterByAvailability(items, 'enabled').map((item) => item.id)).toEqual(['a', 'c']);
    expect(filterByAvailability(items, 'disabled').map((item) => item.id)).toEqual(['b']);
  });

  it('copies rather than returning the caller its own array', () => {
    // The tabs hand it a React Query result, which is shared structure: sorting
    // or splicing what comes back would mutate the cache.
    expect(filterByAvailability(items, 'all')).not.toBe(items);
  });
});

describe('AvailabilityFilter', () => {
  const render = (value: 'all' | 'enabled' | 'disabled', onChange = vi.fn()) => {
    renderWithProviders(
      <AvailabilityFilter value={value} onChange={onChange} items={items} label="Disponibilité" />,
    );
    return { onChange, group: screen.getByRole('group', { name: 'Disponibilité' }) };
  };

  it('carries each count, so "none are off" is readable without a click', () => {
    const { group } = render('all');
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'All statuses 3',
      'Active 2',
      'Inactive 1',
    ]);
  });

  it('marks exactly one chip pressed, and reports the one clicked', () => {
    const { group, onChange } = render('enabled');
    const pressed = within(group)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toContain('Active');

    fireEvent.click(within(group).getAllByRole('button')[2] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('disabled');
  });

  it('scrolls rather than wrapping, which is what makes it usable at 360px', () => {
    // happy-dom lays nothing out, so the class contract is what a test can
    // hold — and `[&>*]:shrink-0` is the half that a bare `flex-nowrap` misses:
    // without it the chips squeeze into taller pills instead of scrolling.
    const { group } = render('all');
    expect(group.className).toContain('flex-nowrap');
    expect(group.className).toContain('overflow-x-auto');
    expect(group.className).toContain('[&>*]:shrink-0');
  });
});
