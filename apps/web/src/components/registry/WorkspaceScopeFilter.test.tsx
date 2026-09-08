/**
 * The control that decides what a listing covers.
 *
 * The case worth pinning is "All workspaces": the API has served it since the
 * reach became a many-to-many, nothing ever asked for it, and its absence is
 * why a skill attached to one workspace was invisible from every other scope.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkspaceScopeFilter, scopeLabel } from './WorkspaceScopeFilter';

const WORKSPACES = [
  { id: 'ws_a', name: 'Metaclaude', color: '#6366f1', icon: 'folder' },
  { id: 'ws_b', name: 'Journaliste', color: '#f59e0b', icon: 'newspaper' },
];

/** Radix opens on the pointer event, not on click — happy-dom needs both. */
function open(): void {
  const trigger = screen.getByRole('button');
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe('WorkspaceScopeFilter', () => {
  it('offers every scope, widest first', () => {
    renderWithProviders(
      <WorkspaceScopeFilter value="all" onChange={() => {}} workspaces={WORKSPACES} />,
    );
    open();

    // `menuitemcheckbox`, not `menuitem`: a chosen entry is announced as chosen.
    const options = screen.getAllByRole('menuitemcheckbox').map((el) => el.textContent);
    expect(options?.[0]).toContain('All workspaces');
    expect(options?.[1]).toContain('Global');
    expect(options.some((label) => label?.includes('Journaliste'))).toBe(true);
  });

  it('withholds the global tier where no such tier exists', () => {
    // Analytics ranks runs, and a run belongs to a workspace. Offering "global"
    // there would be a control that returns an empty list forever.
    renderWithProviders(
      <WorkspaceScopeFilter
        value="all"
        onChange={() => {}}
        workspaces={WORKSPACES}
        withGlobal={false}
      />,
    );
    open();

    // The trigger also says the current scope, so the menu entry is asserted
    // by role rather than by text.
    const options = screen.getAllByRole('menuitemcheckbox').map((el) => el.textContent);
    expect(options.some((label) => label?.includes('All workspaces'))).toBe(true);
    expect(options.some((label) => label?.includes('Global'))).toBe(false);
  });

  it('reports the scope it was asked for', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <WorkspaceScopeFilter value="all" onChange={onChange} workspaces={WORKSPACES} />,
    );
    open();
    fireEvent.click(screen.getByText('Journaliste'));

    expect(onChange).toHaveBeenCalledWith('ws_b');
  });

  it('names the current scope on its own trigger', () => {
    renderWithProviders(
      <WorkspaceScopeFilter value="ws_b" onChange={() => {}} workspaces={WORKSPACES} />,
    );
    expect(screen.getByLabelText('Scope: Journaliste')).toBeTruthy();
  });
});

describe('scopeLabel', () => {
  const t = (key: string): string => key;

  it('names each of the three answers', () => {
    expect(scopeLabel('all', WORKSPACES, t)).toBe('All workspaces');
    expect(scopeLabel('global', WORKSPACES, t)).toBe('Global');
    expect(scopeLabel('ws_a', WORKSPACES, t)).toBe('Metaclaude');
  });

  it('does not render a raw id for a workspace that is gone', () => {
    // A stored scope outlives the workspace it names — the label has to hold.
    expect(scopeLabel('ws_deleted', WORKSPACES, t)).toBe('Workspace');
  });
});
