/**
 * The tool list, and the reason it exists: the descriptions used to live in a
 * `title` attribute, which is text that does not exist on a phone.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ClaudeMcpServerStatus } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { McpToolList } from './McpToolList';

const tools: ClaudeMcpServerStatus['tools'] = [
  { name: 'search_issues', description: 'Find issues matching a query.', readOnly: true, destructive: null },
  { name: 'close_issue', description: 'Close an issue permanently.', readOnly: null, destructive: true },
  { name: 'comment', description: '', readOnly: null, destructive: null },
];

describe('McpToolList', () => {
  it('renders each description as text, not as a hover-only attribute', () => {
    const { container } = renderWithProviders(<McpToolList tools={tools} defaultOpen />);

    expect(screen.getByText('Find issues matching a query.')).toBeDefined();
    expect(screen.getByText('Close an issue permanently.')).toBeDefined();
    // The thing this component was written to remove.
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('folds by default, but says on the summary how much is folded away', () => {
    const { container } = renderWithProviders(<McpToolList tools={tools} />);

    const details = container.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    // The count is outside the fold: hiding *whether* there is anything to
    // see would be a worse default than showing thirty tools.
    expect(screen.getByText('3 tools exposed')).toBeDefined();
  });

  it('opens on the summary, which is a real disclosure and not a click handler', () => {
    const { container } = renderWithProviders(<McpToolList tools={tools} />);
    const details = container.querySelector('details')!;

    fireEvent.click(container.querySelector('summary')!);

    expect(details.hasAttribute('open')).toBe(true);
  });

  it('shows the server’s own hints as badges, and neither of them when it said nothing', () => {
    renderWithProviders(<McpToolList tools={tools} defaultOpen />);

    expect(screen.getByText('read-only')).toBeDefined();
    expect(screen.getByText('destructive')).toBeDefined();
    // Three tools, two hints: the third advertised neither.
    expect(screen.queryAllByText(/read-only|destructive/)).toHaveLength(2);
  });

  it('renders nothing at all when the server exposed nothing', () => {
    const { container } = renderWithProviders(<McpToolList tools={[]} />);

    expect(container.querySelector('details')).toBeNull();
  });

  it('handles a tool with no description without leaving an empty paragraph', () => {
    const { container } = renderWithProviders(
      <McpToolList tools={[tools[2]!]} defaultOpen />,
    );

    expect(screen.getByText('comment')).toBeDefined();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});
