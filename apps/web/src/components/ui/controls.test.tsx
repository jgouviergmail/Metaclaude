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

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { CheckboxField, Switch } from './controls';

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
