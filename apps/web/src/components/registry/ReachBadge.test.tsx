/**
 * The column that makes "all workspaces" readable.
 *
 * Every case here is a state an operator can actually reach, including the two
 * that look like nothing: attached to no workspace, which is what unticking the
 * last box leaves, and attached to a workspace that has since been deleted.
 * Both of those rendered as an empty badge in the first draft, which reads as
 * "global" to anyone scanning a list — the opposite of the truth.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ReachBadge } from './ReachBadge';

const WORKSPACES = [
  { id: 'ws_a', name: 'Metaclaude', color: '#6366f1', icon: 'folder' },
  { id: 'ws_b', name: 'Journaliste', color: '#f59e0b', icon: 'newspaper' },
  { id: 'ws_c', name: 'Personnel', color: '#10b981', icon: 'home' },
  { id: 'ws_d', name: 'Test', color: '#ef4444', icon: 'flask' },
];

describe('ReachBadge', () => {
  it('says Global when it reaches every workspace', () => {
    renderWithProviders(<ReachBadge global workspaceIds={[]} workspaces={WORKSPACES} />);
    expect(screen.getByText('Global')).toBeTruthy();
  });

  it('names the workspace when there is exactly one', () => {
    // The common case, and a name reads faster than a count.
    renderWithProviders(
      <ReachBadge global={false} workspaceIds={['ws_b']} workspaces={WORKSPACES} />,
    );
    expect(screen.getByText('Journaliste')).toBeTruthy();
  });

  it('counts them when there are several, and names them to a reader', () => {
    renderWithProviders(
      <ReachBadge global={false} workspaceIds={['ws_a', 'ws_b']} workspaces={WORKSPACES} />,
    );
    expect(screen.getByText('2 workspaces')).toBeTruthy();
    // The accessible name carries what the avatars cannot say out loud.
    expect(screen.getByLabelText('Metaclaude, Journaliste')).toBeTruthy();
  });

  it('counts past the avatars it can show rather than growing the row', () => {
    renderWithProviders(
      <ReachBadge
        global={false}
        workspaceIds={['ws_a', 'ws_b', 'ws_c', 'ws_d']}
        workspaces={WORKSPACES}
      />,
    );
    expect(screen.getByText('4 workspaces')).toBeTruthy();
  });

  it('says so when it reaches nothing, rather than showing an empty badge', () => {
    // Reachable by unticking the last box. A blank badge reads as "global".
    renderWithProviders(
      <ReachBadge global={false} workspaceIds={[]} workspaces={WORKSPACES} />,
    );
    expect(screen.getByText('No workspace')).toBeTruthy();
  });

  it('drops an id whose workspace is gone, and says nothing rather than nothing-shaped', () => {
    // A JSON list of ids is a foreign key nothing enforces — the grant survives
    // its workspace. Drawing a blank avatar for it would be worse than dropping it.
    renderWithProviders(
      <ReachBadge global={false} workspaceIds={['ws_deleted']} workspaces={WORKSPACES} />,
    );
    expect(screen.getByText('No workspace')).toBeTruthy();
  });

  it('survives a record serialised before the field existed', () => {
    // It renders wire data, and a badge is never worth throwing a page away for.
    expect(() =>
      renderWithProviders(<ReachBadge global={false} workspaces={WORKSPACES} />),
    ).not.toThrow();
    expect(screen.getByText('No workspace')).toBeTruthy();
  });
});
