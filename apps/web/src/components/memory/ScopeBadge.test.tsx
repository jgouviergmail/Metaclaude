/**
 * One vocabulary for the two tiers. What is worth pinning is that a global
 * memory never reads as belonging to a project, and that a workspace this
 * client cannot name degrades to a noun rather than to an id.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { ScopeBadge, scopeName } from './ScopeBadge';

const workspace = (overrides: Partial<Workspace>): Workspace =>
  ({
    id: 'ws_a',
    name: 'Alpha',
    slug: 'alpha',
    description: '',
    path: '/srv/workspaces/alpha',
    color: '#6366f1',
    icon: 'folder',
    archived: false,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as Workspace;

const WORKSPACES = [workspace({}), workspace({ id: 'ws_b', name: 'Beta', slug: 'beta' })];

describe('ScopeBadge', () => {
  it('names the global tier', () => {
    renderWithProviders(<ScopeBadge workspaceId={null} workspaces={WORKSPACES} />);

    expect(screen.getByText('Global')).toBeTruthy();
  });

  it('names the workspace a scoped memory belongs to', () => {
    renderWithProviders(<ScopeBadge workspaceId="ws_b" workspaces={WORKSPACES} />);

    expect(screen.getByText('Beta')).toBeTruthy();
  });

  /**
   * A memory outlives the list of workspaces this client happens to hold: the
   * query can be in flight, or the workspace archived out of the list. Showing
   * the raw id would put an internal identifier in front of an operator for no
   * benefit — the badge's job is only to say "not global".
   */
  it('falls back to a noun for a workspace it cannot name', () => {
    renderWithProviders(<ScopeBadge workspaceId="ws_gone" workspaces={WORKSPACES} />);

    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.queryByText('ws_gone')).toBeNull();
  });

  /** The global tier is the exception in a list, and is coloured as one. */
  it('distinguishes the tiers by tone, not only by text', () => {
    const { container: globalTier } = renderWithProviders(
      <ScopeBadge workspaceId={null} workspaces={WORKSPACES} />,
    );
    const globalClass = globalTier.querySelector('span')?.className ?? '';

    const { container: scoped } = renderWithProviders(
      <ScopeBadge workspaceId="ws_a" workspaces={WORKSPACES} />,
    );
    const scopedClass = scoped.querySelector('span')?.className ?? '';

    expect(globalClass).not.toBe(scopedClass);
  });
});

describe('scopeName', () => {
  const t = (key: string) => key;

  it('answers the same words the badge shows', () => {
    expect(scopeName(null, WORKSPACES, t)).toBe('Global');
    expect(scopeName('ws_a', WORKSPACES, t)).toBe('Alpha');
    expect(scopeName('ws_gone', WORKSPACES, t)).toBe('Workspace');
  });

  it('copes with an empty workspace list', () => {
    expect(scopeName('ws_a', [], t)).toBe('Workspace');
    expect(scopeName(null, [], t)).toBe('Global');
  });
});
