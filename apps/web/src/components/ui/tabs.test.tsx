/**
 * The tab strip, factored out of three copies.
 *
 * `TAB_CLASS` was declared byte-for-byte identically in SettingsPage and
 * HelpPage, and AgentsPage carried a third variant inline — three places to
 * change when the active underline moves, and three chances to forget one.
 *
 * Radix switches on `mousedown`, not on click: a `fireEvent.click` alone does
 * nothing here and reads as a broken component. That trap is why these tests
 * fire the pointer event first, and why they exist at all — the wrapper has to
 * keep Radix's behaviour, not merely its markup.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { TabPanel, Tabs, TabStrip, TabTrigger } from './tabs';

function Example({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  return (
    <Tabs value="guide" onValueChange={onChange}>
      <TabStrip label="Sections de l’aide">
        <TabTrigger value="guide">Guide</TabTrigger>
        <TabTrigger value="changelog">Nouveautés</TabTrigger>
      </TabStrip>
      <TabPanel value="guide">contenu du guide</TabPanel>
      <TabPanel value="changelog">contenu des nouveautés</TabPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('names the strip, so its tabs are not announced as loose buttons', () => {
    render(<Example />);
    expect(screen.getByRole('tablist', { name: 'Sections de l’aide' })).toBeDefined();
  });

  it('marks the selected tab and shows only its panel', () => {
    render(<Example />);
    expect(screen.getByRole('tab', { name: 'Guide' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Nouveautés' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByText('contenu du guide')).toBeDefined();
    expect(screen.queryByText('contenu des nouveautés')).toBeNull();
  });

  it('reports the tab that was chosen', () => {
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    const target = screen.getByRole('tab', { name: 'Nouveautés' });
    // Radix activates on the pointer event; a click alone does nothing.
    fireEvent.mouseDown(target);
    fireEvent.click(target);
    expect(onChange).toHaveBeenCalledWith('changelog');
  });

  it('scrolls the strip rather than letting it overflow the screen', () => {
    // Six sections in French do not fit 390px. Scrolling is the deliberate
    // answer, and `scripts/responsive.mjs` tolerates an off-frame control only
    // when an ancestor actually scrolls — so this class is load-bearing.
    render(<Example />);
    expect(screen.getByRole('tablist').className).toContain('overflow-x-auto');
  });

  it('keeps the gap below the rule, which the callers used to carry', () => {
    // Two of the three copies had their own bottom margin and one had none.
    // Factoring the class out without it left the first panel touching the
    // rule — a regression a test could not see and a screenshot could.
    render(<Example />);
    expect(screen.getByRole('tablist').className).toContain('mb-4');
  });

  it('gives every trigger the same appearance from one place', () => {
    // The duplication this replaces: two files declared the same class string
    // byte for byte, a third carried a variant. One source, one appearance.
    render(<Example />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.className).toBe(tabs[1]!.className);
  });
});
