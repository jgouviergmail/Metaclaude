/**
 * The disclosure that keeps explanatory prose reachable in both densities.
 *
 * `Section`, `CardHeader` and the two retrieval boxes on the Memory page all
 * carry this, and each of their suites checks it from where it sits. What is
 * only visible here is the hook's own contract: what happens on a *second*
 * press, and that the open state does not survive a change of density in a way
 * that leaves a control claiming to be expanded over nothing.
 *
 * The density is set on the store *and* on the root element, because the two
 * are genuinely separate: the pre-paint script in `public/density-init.js`
 * stamps the attribute before React exists, and the store is what a component
 * reads. A test that moved only one of them would be measuring a state the app
 * never occupies.
 */

import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { useUiStore } from '@/lib/store';
import { useDisclosedDescription } from './density';

function Host({ description, subject }: { description?: string; subject?: string }) {
  const help = useDisclosedDescription(description, subject);
  return (
    <div>
      <h2>Exécution</h2>
      {help.trigger}
      {help.body}
    </div>
  );
}

function setDensity(density: 'compact' | 'comfortable') {
  document.documentElement.setAttribute('data-density', density);
  useUiStore.setState({ density });
}

// The attribute lives on the document, which no render tears down: leaving it
// behind hands the next case a density it never asked for.
afterEach(() => {
  document.documentElement.removeAttribute('data-density');
  useUiStore.setState({ density: 'compact' });
});

describe('useDisclosedDescription', () => {
  it('gives back nothing at all when there is nothing to explain', () => {
    setDensity('compact');
    render(<Host />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Exécution' })).toBeDefined();
  });

  it('folds the prose away again on a second press', () => {
    setDensity('compact');
    render(<Host description="Prend effet au prochain run." />);

    const explain = screen.getByRole('button', { name: 'Explain' });
    fireEvent.click(explain);
    expect(screen.getByText('Prend effet au prochain run.')).toBeDefined();

    fireEvent.click(explain);
    expect(screen.queryByText('Prend effet au prochain run.')).toBeNull();
    expect(explain.getAttribute('aria-expanded')).toBe('false');
  });

  /*
   * The control is the compact density's affordance and has no meaning in the
   * comfortable one, where the prose is simply there. Rendering it anyway —
   * `aria-expanded="false"` beside text that is already visible — would say
   * something false to anyone listening.
   */
  it('withdraws the control where the prose stands on its own', () => {
    setDensity('comfortable');
    render(<Host description="Prend effet au prochain run." />);
    expect(screen.getByText('Prend effet au prochain run.')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names the control for anyone who cannot see the glyph', () => {
    // An `i` in a circle has no accessible name of its own: the icon is
    // `aria-hidden` and the button holds no text, so without the label this is
    // an unnamed button — the same defect the phone tab bar's `hidden sm:inline`
    // labels produce, and one this app already treats as a bug.
    setDensity('compact');
    render(<Host description="Prend effet au prochain run." />);
    const explain = screen.getByRole('button', { name: 'Explain' });
    expect(explain.textContent).toBe('');
    expect(explain.getAttribute('aria-label')).toBe('Explain');
  });

  /*
   * Two of these sit side by side on the Memory page. Named alike they are one
   * entry twice in any list of the screen's controls: the heading above each
   * separates them on screen and by arrow navigation, and not there.
   */
  it('names itself by its subject when the caller knows one', () => {
    setDensity('compact');
    const { unmount } = render(<Host description="Cherche par mots." subject="Filter" />);
    expect(screen.getByRole('button', { name: 'Explain Filter' })).toBeDefined();
    unmount();

    render(<Host description="Cherche par sens." subject="Recall" />);
    expect(screen.getByRole('button', { name: 'Explain Recall' })).toBeDefined();
  });
});
