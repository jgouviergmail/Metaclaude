/**
 * The dropdown every menu in the product is built from.
 *
 * Radix supplies keyboard navigation and dismissal; what this file owns is
 * the part Radix cannot know about — that a *selected* item says so to
 * assistive technology and not only to the eye, and that `keepOpen` really
 * keeps a multi-select list open.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';

/** Radix opens on pointerdown, not click — see CLAUDE.md. */
const open = (name: RegExp | string = /open menu/i) => {
  const trigger = screen.getByRole('button', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
};

const withMenu = (children: React.ReactNode) =>
  renderWithProviders(
    <Menu trigger={<button type="button">Open menu</button>}>{children}</Menu>,
  );

describe('opening and choosing', () => {
  it('stays shut until the trigger is used', () => {
    withMenu(<MenuItem onSelect={vi.fn()}>Rename</MenuItem>);
    expect(screen.queryByRole('menuitem')).toBeNull();
    open();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDefined();
  });

  it('runs the item’s action', () => {
    const onSelect = vi.fn();
    withMenu(<MenuItem onSelect={onSelect}>Rename</MenuItem>);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not run a disabled item', () => {
    const onSelect = vi.fn();
    withMenu(
      <MenuItem onSelect={onSelect} disabled>
        Rename
      </MenuItem>,
    );
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a description under the label when one is given', () => {
    withMenu(
      <MenuItem onSelect={vi.fn()} description="Moves the card to Done">
        Finish
      </MenuItem>,
    );
    open();
    expect(screen.getByText('Moves the card to Done')).toBeDefined();
  });

  it('renders labels and separators without becoming selectable', () => {
    withMenu(
      <>
        <MenuLabel>Theme</MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={vi.fn()}>Dark</MenuItem>
      </>,
    );
    open();
    expect(screen.getByText('Theme')).toBeDefined();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });
});

describe('selection state', () => {
  it('tells assistive technology which item is selected, not just the eye', () => {
    // The tick is `aria-hidden`, so without a checked state a screen-reader
    // user cannot tell which theme, which model, which tool is active — and
    // these menus exist precisely to show a current choice.
    withMenu(
      <>
        <MenuItem onSelect={vi.fn()} selected>
          Dark
        </MenuItem>
        <MenuItem onSelect={vi.fn()} selected={false}>
          Light
        </MenuItem>
      </>,
    );
    open();

    const dark = screen.getByRole('menuitemcheckbox', { name: 'Dark' });
    expect(dark.getAttribute('aria-checked')).toBe('true');
    // Every item in a picker declares its state, so the unselected ones are
    // announced as unchecked rather than as unrelated commands.
    const light = screen.getByRole('menuitemcheckbox', { name: 'Light' });
    expect(light.getAttribute('aria-checked')).toBe('false');
  });

  it('stays an ordinary menu item when selection is not a concept', () => {
    // An action like "Delete" is not checkable, and announcing it as an
    // unchecked checkbox would be worse than saying nothing.
    withMenu(<MenuItem onSelect={vi.fn()}>Delete</MenuItem>);
    open();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDefined();
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  });
});

describe('keepOpen', () => {
  it('leaves a multi-select list open so several choices cost one opening', () => {
    const onSelect = vi.fn();
    withMenu(
      <MenuItem onSelect={onSelect} keepOpen selected={false}>
        Bash
      </MenuItem>,
    );
    open();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Bash' }));

    expect(onSelect).toHaveBeenCalled();
    // Still there: the tools picker would otherwise need reopening per tool.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Bash' })).toBeDefined();
  });
});
