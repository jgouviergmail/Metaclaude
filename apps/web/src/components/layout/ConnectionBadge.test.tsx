/**
 * The live-connection indicator.
 *
 * Small but load-bearing: when the socket drops, streaming silently stops and
 * the app merely looks broken. What is worth pinning is that the badge tracks
 * the socket rather than a snapshot, unsubscribes when it goes away, and
 * speaks the interface's language — it imported `useT` and never called it,
 * so all four states rendered English while `fr.ts` carried their
 * translations unused.
 */

import { readFileSync } from 'node:fs';

import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { ConnectionBadge } from './ConnectionBadge';

const { socketMock, handlers } = vi.hoisted(() => {
  const handlers: Array<(state: string) => void> = [];
  return {
    handlers,
    socketMock: {
      connectionState: 'open' as string,
      onState: vi.fn((handler: (state: string) => void) => {
        handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      }),
    },
  };
});

vi.mock('@/lib/socket', () => ({ socket: socketMock }));

const emit = (state: string) => act(() => handlers.forEach((handler) => handler(state)));

beforeEach(() => {
  handlers.length = 0;
  socketMock.connectionState = 'open';
  vi.clearAllMocks();
});

describe('what it shows', () => {
  it('starts from the socket’s current state, not from a default', () => {
    // Mounting after the socket already dropped must not show a green badge
    // until the next transition — which might never come.
    socketMock.connectionState = 'closed';
    renderWithProviders(<ConnectionBadge />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Offline');
  });

  it('follows the socket through every state', () => {
    renderWithProviders(<ConnectionBadge />);
    const badge = () => screen.getByRole('status').getAttribute('aria-label');

    expect(badge()).toBe('Live');
    emit('connecting');
    expect(badge()).toBe('Connecting');
    emit('closed');
    expect(badge()).toBe('Offline');
    emit('unauthorised');
    expect(badge()).toBe('Signed out');
  });

  it('draws the eye only when something is wrong', () => {
    // Green is deliberately quiet; the degraded states are the ones that must
    // be noticeable without being read.
    renderWithProviders(<ConnectionBadge />);
    const badge = () => screen.getByRole('status').className;

    expect(badge()).toContain('text-success');
    expect(badge()).not.toContain('animate-pulse');
    emit('connecting');
    expect(badge()).toContain('animate-pulse');
    emit('closed');
    expect(badge()).toContain('text-danger');
  });
});

describe('what it does not leak', () => {
  it('unsubscribes from the socket when it unmounts', () => {
    // The badge is mounted in the shell and survives navigation, but a leaked
    // handler updating an unmounted component is the kind of thing that only
    // shows up as noise much later.
    const { unmount } = renderWithProviders(<ConnectionBadge />);
    expect(handlers).toHaveLength(1);
    unmount();
    expect(handlers).toHaveLength(0);
  });
});

describe('language', () => {
  it('renders both strings through the translator, not as raw English', () => {
    // The regression this pins is a component that imported `useT`, never
    // called it, and left four translated strings in `fr.ts` unreachable —
    // invisible to every test, because `t` falls back to its English key and
    // the rendered output is identical either way. So the assertion is on the
    // source: `import(…?raw)` returns empty under vitest (see CLAUDE.md), a
    // plain read relative to the package root is what works.
    const source = readFileSync('src/components/layout/ConnectionBadge.tsx', 'utf8');
    expect(source).toMatch(/aria-label=\{t\(/);
    expect(source).toMatch(/content=\{t\(/);
  });
});
