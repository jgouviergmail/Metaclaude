/**
 * Choosing a workspace's colour and icon.
 *
 * The colour row existed only in the creation dialog, so a colour was chosen
 * once and never again. The icon was worse: a field the schema stored and the
 * PATCH route accepted, that no control ever set and no screen ever showed —
 * the "a schema field nothing forwards" shape, on a field an operator would
 * reasonably expect to be able to change.
 *
 * What is pinned here is that both controls report a *choice* rather than
 * merely render, and that removing an icon is one of the choices: without it
 * an operator who picked one could never go back to the plain square.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WORKSPACE_COLORS } from '@/lib/utils';
import { WORKSPACE_ICON_NAMES } from '@/lib/workspace-icons';
import { ColourPicker, IconPicker } from './WorkspaceAppearance';

describe('the colour picker', () => {
  it('offers every swatch and reports the one pressed', () => {
    const onChange = vi.fn();
    renderWithProviders(<ColourPicker value={WORKSPACE_COLORS[0]} onChange={onChange} />);

    const swatches = screen.getAllByRole('button');
    expect(swatches).toHaveLength(WORKSPACE_COLORS.length);

    fireEvent.click(swatches[3]!);
    expect(onChange).toHaveBeenCalledWith(WORKSPACE_COLORS[3]);
  });

  it('says which one is current, and not by colour alone', () => {
    // Colour cannot be heard. `aria-pressed` is what tells a screen reader
    // which swatch is the workspace's.
    renderWithProviders(<ColourPicker value={WORKSPACE_COLORS[2]!} onChange={vi.fn()} />);

    const pressed = screen.getAllByRole('button').filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toHaveLength(1);
  });

  it('locks every swatch for a workspace whose appearance is fixed', () => {
    renderWithProviders(<ColourPicker value={WORKSPACE_COLORS[0]} onChange={vi.fn()} disabled />);

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('the icon picker', () => {
  it('offers every icon it ships, plus removing it', () => {
    renderWithProviders(<IconPicker value="" color="#6366f1" onChange={vi.fn()} />);

    expect(screen.getAllByRole('button')).toHaveLength(WORKSPACE_ICON_NAMES.length + 1);
    expect(screen.getByLabelText(/no icon/i)).toBeTruthy();
  });

  it('reports the stored name, not a label', () => {
    // The name is what the row holds and what the audit log will show; a
    // translated label would name the control something the database has
    // never heard of.
    const onChange = vi.fn();
    renderWithProviders(<IconPicker value="" color="#6366f1" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('rocket'));

    expect(onChange).toHaveBeenCalledWith('rocket');
  });

  /**
   * Removing is a choice, not an absence of one. An operator who picked an
   * icon and cannot go back is stuck with it — and the plain square is what
   * every workspace looked like before this existed.
   */
  it('lets an icon be taken back off', () => {
    const onChange = vi.fn();
    renderWithProviders(<IconPicker value="rocket" color="#6366f1" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(/no icon/i));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('marks the current choice, removal included', () => {
    renderWithProviders(<IconPicker value="" color="#6366f1" onChange={vi.fn()} />);

    expect(screen.getByLabelText(/no icon/i).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('rocket').getAttribute('aria-pressed')).toBe('false');
  });

  it('previews each icon on the workspace’s own colour', () => {
    // The only place it will ever be seen. A picker that showed the glyph on
    // the page background would be showing something that does not exist.
    const { container } = renderWithProviders(
      <IconPicker value="" color="#ec4899" onChange={vi.fn()} />,
    );

    const previews = container.querySelectorAll('span[style*="ec4899"]');
    expect(previews.length).toBe(WORKSPACE_ICON_NAMES.length);
  });
});
