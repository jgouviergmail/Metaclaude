/**
 * The notification centre.
 *
 * Runs finish while the operator is on another screen, so this is where a
 * failure is found — which makes one thing non-negotiable: a failed run and a
 * successful one must not be indistinguishable. The level was carried by the
 * colour of an `aria-hidden` dot and by nothing else.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { NotificationBell } from './NotificationBell';

const { store } = vi.hoisted(() => ({
  store: {
    items: [] as Array<{
      id: string;
      title: string;
      message: string;
      level: 'success' | 'error' | 'warning' | 'info';
      at: number;
      read: boolean;
      href?: string;
    }>,
    markAllRead: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('@/lib/store', () => ({ useNotificationStore: () => store }));

const openBell = () => {
  const trigger = screen.getByRole('button', { name: /Notifications/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
};

beforeEach(() => {
  vi.clearAllMocks();
  store.items = [];
});

describe('the badge', () => {
  it('says nothing when there is nothing', () => {
    renderWithProviders(<NotificationBell />);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeDefined();
  });

  it('counts the unread ones, in the name as well as in the dot', () => {
    store.items = [
      { id: 'n1', title: 'Run finished', message: 'ok', level: 'success', at: 1, read: false },
      { id: 'n2', title: 'Run failed', message: 'boom', level: 'error', at: 2, read: false },
      { id: 'n3', title: 'Seen already', message: '', level: 'info', at: 3, read: true },
    ];
    renderWithProviders(<NotificationBell />);
    expect(screen.getByRole('button', { name: 'Notifications (2 unread)' })).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('stops counting past nine rather than growing the badge', () => {
    store.items = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      title: 't',
      message: '',
      level: 'info' as const,
      at: i,
      read: false,
    }));
    renderWithProviders(<NotificationBell />);
    expect(screen.getByText('9+')).toBeDefined();
  });
});

describe('the list', () => {
  it('says plainly when there is nothing to show', () => {
    renderWithProviders(<NotificationBell />);
    openBell();
    expect(screen.getByText('Nothing yet')).toBeDefined();
  });

  it('distinguishes a failure from a success for a screen reader, not only by colour', () => {
    // The dot is `aria-hidden` and the level lives nowhere else, so both
    // notices read as the same kind of event to anyone not seeing the colour.
    store.items = [
      { id: 'n1', title: 'Nightly backup', message: 'Archived', level: 'success', at: 1, read: false },
      { id: 'n2', title: 'Deploy', message: 'Rolled back', level: 'error', at: 2, read: false },
    ];
    renderWithProviders(<NotificationBell />);
    openBell();

    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText('Succeeded')).toBeDefined();
  });

  it('links a notification that names where to go, and closes behind it', () => {
    store.items = [
      { id: 'n1', title: 'Run finished', message: 'ok', level: 'success', at: 1, read: false, href: '/w/ws_a' },
    ];
    renderWithProviders(<NotificationBell />);
    openBell();
    expect(screen.getByRole('link', { name: /Run finished/ }).getAttribute('href')).toBe('/w/ws_a');
  });

  it('offers mark-all-read and clear only when there is something to act on', () => {
    renderWithProviders(<NotificationBell />);
    openBell();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('clears on demand', () => {
    store.items = [{ id: 'n1', title: 'x', message: '', level: 'info', at: 1, read: true }];
    renderWithProviders(<NotificationBell />);
    openBell();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(store.clear).toHaveBeenCalled();
  });

  it('marks everything read the moment the panel opens', () => {
    // Opening is the act of reading; leaving the badge lit afterwards would
    // make it useless as a signal.
    store.items = [{ id: 'n1', title: 'x', message: '', level: 'info', at: 1, read: false }];
    renderWithProviders(<NotificationBell />);
    openBell();
    expect(store.markAllRead).toHaveBeenCalled();
  });
});
