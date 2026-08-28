/**
 * The dialog every destructive action in the product goes through.
 *
 * It had no test at all, which is how a component ends up carrying safety
 * properties nobody can see: that the confirm button is never what the Enter
 * key lands on, and that a failed confirmation leaves the dialog open instead
 * of dismissing itself over an error the user never read.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { ConfirmDialog, Modal } from './Modal';

describe('Modal', () => {
  it('renders its title, body and footer only while open', () => {
    const { rerender } = renderWithProviders(
      <Modal open={false} onOpenChange={vi.fn()} title="Settings" footer={<button>Save</button>}>
        <p>Body copy</p>
      </Modal>,
    );
    expect(screen.queryByText('Body copy')).toBeNull();

    rerender(
      <Modal open onOpenChange={vi.fn()} title="Settings" footer={<button>Save</button>}>
        <p>Body copy</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.getByText('Body copy')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
  });

  it('names the dialog for a screen reader, and describes it when asked to', () => {
    renderWithProviders(
      <Modal open onOpenChange={vi.fn()} title="Delete workspace" description="This cannot be undone.">
        <p>Body</p>
      </Modal>,
    );
    // The accessible name comes from Dialog.Title, not from a hand-written
    // aria-label that could drift from what is displayed.
    expect(screen.getByRole('dialog', { name: 'Delete workspace' })).toBeDefined();
    expect(screen.getByText('This cannot be undone.')).toBeDefined();
  });

  it('closes from the header button, which carries an accessible name', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <Modal open onOpenChange={onOpenChange} title="Settings">
        <p>Body</p>
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape — the reflex every dialog owes its user', () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <Modal open onOpenChange={onOpenChange} title="Settings">
        <p>Body</p>
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ConfirmDialog', () => {
  it('puts the focus on Cancel, never on the destructive action', async () => {
    // The whole point of a confirmation is that the dangerous button is not
    // what a reflexive Enter press lands on.
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete this document?"
        description="Everything indexed from it is removed."
        confirmLabel="Delete document"
        danger
        onConfirm={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
  });

  it('runs the action and closes once it resolves', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Gone for good."
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open when the action fails, so the error is not dismissed with it', async () => {
    // Closing on failure hides the toast the caller just raised and leaves the
    // user believing a destructive action succeeded.
    const onConfirm = vi.fn().mockRejectedValue(new Error('server said no'));
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Gone for good."
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('labels the action with the caller’s own words', () => {
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Remove the stored credential?"
        description="The agent stops running until a new one is paired."
        confirmLabel="Remove credential"
        danger
        onConfirm={vi.fn()}
      />,
    );
    // A generic "Confirm" on a destructive dialog is how people confirm the
    // wrong thing; every caller names the act.
    expect(screen.getByRole('button', { name: 'Remove credential' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
});
