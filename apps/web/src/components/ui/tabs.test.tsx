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
    expect(screen.getByRole('tablist').parentElement!.className).toContain('mb-4');
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

/**
 * A tab labels the panel under it, so it has to sit above it.
 *
 * AgentsPage draws a *sticky* strip, which cannot live inside the scrolling
 * body — so it was full-bleed while the panel below was centred at
 * `max-w-5xl`: the triggers began at the screen's left edge and their content
 * a hundred and eighty pixels further in. It read as a band of chrome rather
 * than as a label for what followed. That screen fixed it with four className
 * overrides — `sticky`, `mb-0`, its own gutter and the whole appearance of the
 * trigger — which is using the shared component while opting out of every
 * decision it makes.
 */
describe('a strip that must align with its panel', () => {
  const Sticky = () => (
    <Tabs value="a">
      <TabStrip label="Type" width="standard" sticky>
        <TabTrigger value="a">Un</TabTrigger>
        <TabTrigger value="b">Deux</TabTrigger>
      </TabStrip>
      <TabPanel value="a">contenu</TabPanel>
    </Tabs>
  );

  it('centres the triggers in the width the panel uses', () => {
    render(<Sticky />);
    const list = screen.getByRole('tablist');
    expect(list.className).toContain('max-w-5xl');
    expect(list.className).toContain('mx-auto');
    // The same gutter the page body uses, or the triggers sit against the edge
    // on a phone where the body does not.
    expect(list.className).toContain('px-gutter');
  });

  it('draws the rule across the whole width, not only across the triggers', () => {
    render(<Sticky />);
    const list = screen.getByRole('tablist');
    expect(list.className).not.toContain('border-b');
    expect(list.parentElement!.className).toContain('border-b');
  });

  it('sticks the band rather than the tablist, since the band carries the rule', () => {
    render(<Sticky />);
    const band = screen.getByRole('tablist').parentElement!;
    expect(band.className).toContain('sticky');
    // A sticky strip sits directly on its panel: the body owns the gap.
    expect(band.className).not.toContain('mb-4');
  });

  it('keeps every trigger a direct child of the tablist', () => {
    // `role="tablist"` owns `role="tab"` children. Wrapping the triggers in a
    // centring div would break that relationship, which is why the width goes
    // on the list itself and the rule on the band around it.
    render(<Sticky />);
    const list = screen.getByRole('tablist');
    expect([...list.children].map((child) => child.getAttribute('role'))).toEqual(['tab', 'tab']);
  });

  it('leaves an un-widthed strip exactly as it was', () => {
    // Settings and Help already sit inside a Page, so their strip is bounded
    // by the body around it and must not be bounded twice.
    render(<Example />);
    expect(screen.getByRole('tablist').className).not.toContain('max-w-');
    expect(screen.getByRole('tablist').className).not.toContain('mx-auto');
  });
});

/**
 * An icon in a tab, spelled once.
 *
 * Three screens, three spellings: AgentsPage wrapped the trigger's whole
 * appearance to get `flex items-center gap-1.5`, HelpPage reached for
 * `mr-1.5 inline` on the icon itself, and Settings has none. An icon is a
 * property of the trigger, so the trigger owns it.
 */
describe('a trigger with an icon', () => {
  const WithIcon = () => (
    <Tabs value="a">
      <TabStrip label="Type">
        <TabTrigger value="a" icon={<svg data-testid="glyphe" />}>
          Compétences
        </TabTrigger>
      </TabStrip>
      <TabPanel value="a">contenu</TabPanel>
    </Tabs>
  );

  it('keeps the icon out of the name the tab is announced by', () => {
    render(<WithIcon />);
    expect(screen.getByRole('tab', { name: 'Compétences' })).toBeDefined();
    expect(screen.getByTestId('glyphe').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('lays the icon beside the label rather than by a margin on the icon', () => {
    render(<WithIcon />);
    const tab = screen.getByRole('tab', { name: 'Compétences' });
    expect(tab.className).toContain('flex');
    expect(tab.className).toContain('gap-1.5');
  });
});
