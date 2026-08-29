/**
 * The fold, and the one property it exists to keep: a folded body is still
 * mounted.
 *
 * Every assertion here reads the `<details>` element's own `open`, never
 * visibility. jsdom does not implement `<details>` hiding — every child is
 * findable whether the section is open or shut — so a test written against
 * `toBeVisible()` would pass just as happily on a card that never folds at
 * all. Same family as the `env()` trap CLAUDE.md records: assert the thing the
 * DOM actually carries.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { CollapsibleCard } from './CollapsibleCard';

describe('CollapsibleCard', () => {
  it('is folded by default, and says so on the element itself', () => {
    const { container } = renderWithProviders(
      <CollapsibleCard title="Google">
        <p>the body</p>
      </CollapsibleCard>,
    );

    expect(container.querySelector('details')?.open).toBe(false);
  });

  /**
   * The reason this is a `<details>` and not a conditional render.
   *
   * The Google card reads its OAuth outcome in an effect and raises the toast
   * that reports it. A fold that unmounted the body would swallow the result
   * of a consent the operator had just given, with nothing to show for it.
   */
  it('keeps the body mounted while folded, effects and all', () => {
    const mounted = vi.fn();
    function Body() {
      mounted();
      return <p>the body</p>;
    }

    renderWithProviders(
      <CollapsibleCard title="Google">
        <Body />
      </CollapsibleCard>,
    );

    expect(mounted).toHaveBeenCalled();
    expect(screen.getByText('the body')).toBeDefined();
  });

  it('opens when asked to', () => {
    const { container } = renderWithProviders(
      <CollapsibleCard title="Google" defaultOpen>
        <p>the body</p>
      </CollapsibleCard>,
    );

    expect(container.querySelector('details')?.open).toBe(true);
  });

  /**
   * A fold that hides the one thing the card answers has replaced a big card
   * with a useless one. The status sits on the summary, outside the fold.
   */
  it('shows the status without opening anything', () => {
    const { container } = renderWithProviders(
      <CollapsibleCard title="Google" status={<span>Connected</span>}>
        <p>the body</p>
      </CollapsibleCard>,
    );

    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toContain('Connected');
  });

  it('puts the description inside the fold — it is the bulk of the room', () => {
    const { container } = renderWithProviders(
      <CollapsibleCard title="Google" description="A long explanation.">
        <p>the body</p>
      </CollapsibleCard>,
    );

    expect(container.querySelector('summary')?.textContent).not.toContain('A long explanation.');
    expect(screen.getByText('A long explanation.')).toBeDefined();
  });

  it('toggles from the summary, with no handler of its own', () => {
    const { container } = renderWithProviders(
      <CollapsibleCard title="Google">
        <p>the body</p>
      </CollapsibleCard>,
    );
    const details = container.querySelector('details')!;

    // jsdom implements the toggling itself, which is the point of using the
    // native element: no state, no keyboard handler, no aria wiring.
    fireEvent.click(container.querySelector('summary')!);
    expect(details.open).toBe(true);
  });
});
