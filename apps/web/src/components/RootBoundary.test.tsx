/**
 * The root error boundary.
 *
 * There was no boundary anywhere in the app — no `componentDidCatch`, no
 * `getDerivedStateFromError`, no `window.onerror`, and a `<Suspense>` over nine
 * lazy routes with a spinner and no error path. One throw took the whole tree
 * with it, and on a standalone PWA there is no URL bar to reload from.
 */

import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { RootBoundary } from './RootBoundary';

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs the caught error itself; that is expected here, not a failure.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('RootBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <RootBoundary>
        <p>the app</p>
      </RootBoundary>,
    );
    expect(screen.getByText('the app')).toBeDefined();
  });

  it('catches a throw and offers a way back instead of a blank page', () => {
    render(
      <RootBoundary>
        <Boom message="Failed to fetch dynamically imported module" />
      </RootBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
  });

  it('shows the error message, which is what identifies a stale chunk', () => {
    render(
      <RootBoundary>
        <Boom message="Failed to fetch dynamically imported module" />
      </RootBoundary>,
    );
    expect(screen.getByText(/dynamically imported module/)).toBeDefined();
  });

  it('reloads on demand, because the shell is network-first', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });

    render(
      <RootBoundary>
        <Boom message="boom" />
      </RootBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});
