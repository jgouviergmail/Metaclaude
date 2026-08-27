/**
 * The note preview's contract: a wikilink click opens the note the shared
 * resolver picks (never a browser navigation), backlinks arrive with their
 * context, and the local graph draws exactly the one-hop neighbourhood.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotesIndex } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { NotePreview } from './NotePreview';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { notesGraph: vi.fn(), noteBacklinks: vi.fn() },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

const graph: NotesIndex = {
  truncated: false,
  notes: [
    { path: 'Hub.md', title: 'Hub', links: ['Widget.md'], unresolved: ['Ghost'] },
    { path: 'Widget.md', title: 'Widget', links: ['Hub.md'], unresolved: [] },
    { path: 'notes/Other.md', title: 'Other', links: ['Hub.md'], unresolved: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.notesGraph.mockResolvedValue(graph);
  apiMock.noteBacklinks.mockResolvedValue({
    backlinks: [{ path: 'Widget.md', title: 'Widget', context: 'Links back to [[Hub]].' }],
  });
});

describe('NotePreview', () => {
  const render = (over: Partial<Parameters<typeof NotePreview>[0]> = {}) => {
    const onOpenNote = vi.fn();
    renderWithProviders(
      <NotePreview
        workspaceId="ws_1"
        path="Hub.md"
        content="# Hub\n\nGo to [[Widget]] and [[Ghost]]."
        onOpenNote={onOpenNote}
        {...over}
      />,
    );
    return { onOpenNote };
  };

  it('renders a resolved wikilink and opens it in the panel on click', async () => {
    const { onOpenNote } = render();

    const link = await screen.findByRole('link', { name: 'Widget' });
    fireEvent.click(link);
    expect(onOpenNote).toHaveBeenCalledWith('Widget.md');
  });

  it('marks the unresolved link and lists it under the backlinks', async () => {
    render();
    expect(await screen.findByText(/do not exist yet/)).toBeDefined();
    expect(screen.getAllByText('Ghost').length).toBeGreaterThanOrEqual(1);
  });

  it('lists backlinks with their context and opens them', async () => {
    const { onOpenNote } = render();

    const backlink = await screen.findByRole('button', { name: /Links back to/ });
    fireEvent.click(backlink);
    expect(onOpenNote).toHaveBeenCalledWith('Widget.md');
  });

  it('draws the local graph with incoming and outgoing neighbours', async () => {
    render();
    const svg = await screen.findByRole('img', { name: /local graph of hub/i });
    expect(svg).toBeDefined();
    // Widget links in AND is linked out; Other only links in.
    expect(screen.getAllByRole('button', { name: 'Open Other' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Open Widget' }).length).toBeGreaterThanOrEqual(1);
  });
});
