/**
 * The colour square, and the icon it now carries.
 *
 * What is worth pinning is the rule rather than the pixels: four of the six
 * places this replaces render a 12px square, where an icon is not small but
 * illegible — so `dot` must keep rendering exactly what it rendered before,
 * and the icon must appear at the sizes that can hold one. An icon an operator
 * picks and never sees is a control that tells them it does nothing.
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkspaceAvatar } from './WorkspaceAvatar';

const glyphs = (container: HTMLElement) => container.querySelectorAll('svg');

describe('the workspace avatar', () => {
  it('paints the colour it was given', () => {
    const { container } = renderWithProviders(<WorkspaceAvatar color="#ec4899" size="lg" />);

    // happy-dom keeps the authored value; jsdom would have normalised it to
    // `rgb(…)`, and asserting that shape here fails against the engine that
    // actually runs the suite.
    expect((container.firstChild as HTMLElement).style.background).toBe('#ec4899');
  });

  it('shows the icon at a size that can hold one', () => {
    const { container } = renderWithProviders(
      <WorkspaceAvatar color="#6366f1" icon="rocket" size="lg" />,
    );

    expect(glyphs(container)).toHaveLength(1);
  });

  it('shows none at the 12px marker, whatever the workspace stores', () => {
    // The four listing columns render this size. An icon there is illegible,
    // and rendering one would change every one of them for the worse.
    const { container } = renderWithProviders(
      <WorkspaceAvatar color="#6366f1" icon="rocket" size="dot" />,
    );

    expect(glyphs(container)).toHaveLength(0);
  });

  /**
   * The two ways to have no icon look the same on purpose: one the operator
   * removed, one whose stored name this build no longer knows. A fallback
   * glyph would give every workspace an icon it never chose.
   */
  it('renders a plain square for no icon and for an unknown one alike', () => {
    for (const icon of ['', null, undefined, 'not-an-icon-we-ship']) {
      const { container } = renderWithProviders(
        <WorkspaceAvatar color="#6366f1" icon={icon} size="lg" />,
      );
      expect(glyphs(container)).toHaveLength(0);
    }
  });

  it('keeps the two icons already stored in production databases', () => {
    // `folder` is what creation has always written and `bot` is what the
    // system workspace gives itself. Dropping either would blank an icon
    // somebody already has, without anything saying so.
    for (const icon of ['folder', 'bot']) {
      const { container } = renderWithProviders(
        <WorkspaceAvatar color="#6366f1" icon={icon} size="lg" />,
      );
      expect(glyphs(container), icon).toHaveLength(1);
    }
  });
});
