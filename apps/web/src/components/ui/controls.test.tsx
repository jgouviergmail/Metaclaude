/**
 * The two controls that were copied around the app.
 *
 * A switch and a labelled checkbox existed three times between AgentsPage and
 * WorkspacePage — twice under the same name `Toggle` for two different
 * components, and once as `CheckboxRow` for the same component as the second
 * `Toggle`. Factoring them out is only safe if the behaviour they must have is
 * written down, so this is that.
 *
 * These are the web app's first component tests. What they assert is the part a
 * visual review misses: the accessible role and state, keyboard operation, the
 * label association, and the touch target on a control that is 20px tall.
 */

import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { CheckboxField, SegmentedControl, Switch } from './controls';

describe('Switch', () => {
  it('exposes itself as a switch with its state', () => {
    render(<Switch checked onChange={() => {}} label="Enable plugin formatter" />);

    const control = screen.getByRole('switch', { name: 'Enable plugin formatter' });
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('reports unchecked as unchecked, not as absent', () => {
    // `aria-checked` omitted entirely reads to a screen reader as a button, not
    // as an off switch — the user cannot tell the state without toggling it.
    render(<Switch checked={false} onChange={() => {}} label="Enable" />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('is operable by pointer', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Enable" />);

    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is operable from the keyboard', async () => {
    // It is a real <button>, so this comes for free — and it is exactly what a
    // div-with-onClick would silently lose.
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Enable" />);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch'));
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('carries a coarse-pointer hit area, because it is 20px tall', () => {
    // The box is 20×36 by design: a switch that filled 44px would loosen every
    // dense row it appears in. The pseudo-element takes the press instead, so
    // the thumb gets its target and the layout keeps its density.
    render(<Switch checked onChange={() => {}} label="Enable" />);
    expect(screen.getByRole('switch').className).toContain('pointer-coarse:before:');
  });

  it('does not fire while disabled', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Enable" disabled />);

    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CheckboxField', () => {
  it('associates its label with the input', async () => {
    // The three copies all wrapped the input in a <label>, which works — and
    // breaks the moment someone reaches for a layout that cannot nest. Finding
    // it by its accessible name is what pins the association down.
    render(
      <CheckboxField
        checked={false}
        onChange={() => {}}
        label="Enable memory"
        hint="Retrieved notes are added to the prompt."
      />,
    );

    const input = screen.getByRole('checkbox', { name: /enable memory/i });
    expect((input as HTMLInputElement).checked).toBe(false);
  });

  it('reports the new value, not the old one', async () => {
    // The copies passed `event.target.checked`, which is the value *after* the
    // click. Handing back the previous state is the classic way a checkbox row
    // ends up needing two clicks to take effect.
    const onChange = vi.fn();
    render(<CheckboxField checked={false} onChange={onChange} label="Enable" hint="…" />);

    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows its hint as description rather than as part of the name', () => {
    // The name has to be *exactly* the label. Nesting the hint inside the
    // <label> — which all three copies did — folds the sentence into the name,
    // and `aria-describedby` does not undo that: the name is computed from the
    // label's text content, so the hint has to sit outside it.
    render(
      <CheckboxField
        checked
        onChange={() => {}}
        label="Checkpointing"
        hint="So runs can be rewound."
      />,
    );

    const input = screen.getByRole('checkbox', { name: 'Checkpointing' });
    const hint = screen.getByText('So runs can be rewound.');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('toggles when the label is clicked, not only the box', async () => {
    // 16px is a small target. Moving the hint out of the <label> is exactly the
    // kind of change that quietly severs `htmlFor`, so pin the behaviour.
    const onChange = vi.fn();
    render(<CheckboxField checked={false} onChange={onChange} label="Enable memory" hint="…" />);

    await userEvent.click(screen.getByText('Enable memory'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not fire while disabled', async () => {
    const onChange = vi.fn();
    render(<CheckboxField checked={false} onChange={onChange} label="Enable" hint="…" disabled />);

    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The segmented control, tested for the three things that go wrong with it.
 *
 * It replaces three hand-rolled button rows that sat in one card — language,
 * theme and density — and it exists because that shape has cost this app a
 * release already: four `flex-1` buttons in one row cannot shrink below their
 * own text, so the fourth went off a 390px screen and an event trigger could
 * not be chosen *or seen* on a phone. French is where it shows, being half
 * again the English.
 *
 * happy-dom has no layout, so no test here can prove the row fits. What a test
 * can hold is the contract that makes it fit: a grid with a column count, never
 * a bare flex row. That is a class assertion and therefore a proxy — the real
 * proof is `scripts/responsive.mjs`, which measures a live browser at 390px in
 * both languages.
 */

const OPTIONS = [
  { value: 'compact' as const, label: 'Compacte' },
  { value: 'comfortable' as const, label: 'Confortable' },
];

describe('SegmentedControl', () => {
  it('marks exactly one option as pressed, and reports the other when chosen', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Densité" value="compact" onChange={onChange} options={OPTIONS} />,
    );

    const compact = screen.getByRole('button', { name: /Compacte/ });
    const comfortable = screen.getByRole('button', { name: /Confortable/ });
    expect(compact.getAttribute('aria-pressed')).toBe('true');
    expect(comfortable.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(comfortable);
    expect(onChange).toHaveBeenCalledWith('comfortable');
  });

  it('names the group, so the options are not announced as loose buttons', () => {
    render(<SegmentedControl label="Densité" value="compact" onChange={() => {}} options={OPTIONS} />);
    expect(screen.getByRole('group', { name: 'Densité' })).toBeDefined();
  });

  it('lays the options out as a grid, never as a bare flex row', () => {
    render(<SegmentedControl label="Densité" value="compact" onChange={() => {}} options={OPTIONS} />);
    const group = screen.getByRole('group', { name: 'Densité' });
    expect(group.className).toContain('grid');
    expect(group.className).toContain('grid-cols-2');
    // A `flex-1` child is the shape that cannot shrink below its own text.
    expect(group.className).not.toContain('flex');
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).not.toContain('flex-1');
    }
  });

  it('keeps two columns on a phone and opens up above the breakpoint', () => {
    render(
      <SegmentedControl
        label="Thème"
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Clair' },
          { value: 'b', label: 'Sombre' },
          { value: 'c', label: 'Système' },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Thème' });
    expect(group.className).toContain('grid-cols-2');
    expect(group.className).toContain('sm:grid-cols-3');
  });

  it('gives an odd last option the whole row on a phone, not a half-width orphan', () => {
    render(
      <SegmentedControl
        label="Thème"
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Clair' },
          { value: 'b', label: 'Sombre' },
          { value: 'c', label: 'Système' },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Thème' });
    expect(group.className).toContain('[&>*:last-child]:col-span-2');
    expect(group.className).toContain('sm:[&>*:last-child]:col-span-1');
  });

  it('leaves an even count alone', () => {
    render(<SegmentedControl label="Densité" value="compact" onChange={() => {}} options={OPTIONS} />);
    expect(screen.getByRole('group', { name: 'Densité' }).className).not.toContain('col-span');
  });

  it('carries a hint under an option without folding it into the button name', () => {
    render(
      <SegmentedControl
        label="Densité"
        value="compact"
        onChange={() => {}}
        options={[
          { value: 'compact', label: 'Compacte', hint: "Plus de lignes d'un coup d'œil." },
          { value: 'comfortable', label: 'Confortable' },
        ]}
      />,
    );
    // The hint is readable on screen…
    expect(screen.getByText("Plus de lignes d'un coup d'œil.")).toBeDefined();
    // …and the button still answers to its short name, which is what voice
    // control and a screen reader's list of controls both need.
    const button = screen.getByRole('button', { name: 'Compacte' });
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
  });
});
