/**
 * The command palette — on a keyboard, the primary way through the OS, and
 * until now entirely untested.
 *
 * Two things are worth pinning beyond "it opens": that the shortcut works with
 * either modifier (the product is used on both platforms), and that selecting
 * an entry navigates to *that* entry — cmdk identifies rows by their `value`
 * string, not by the React key, so anything that makes two rows share a value
 * makes them interchangeable.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { CommandPalette } from './CommandPalette';

const { apiMock, navigate } = vi.hoisted(() => ({
  apiMock: { workspaces: vi.fn(), runs: vi.fn() },
  navigate: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
}));

const workspace = (id: string, name: string, description = '') => ({
  id,
  name,
  slug: id,
  description,
  color: '#6366f1',
  icon: 'folder',
  archived: false,
  path: `/srv/${id}`,
  settings: {},
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspaces.mockResolvedValue({ workspaces: [] });
  apiMock.runs.mockResolvedValue({ runs: [] });
});

const openPalette = () => fireEvent.keyDown(window, { key: 'k', metaKey: true });

describe('opening', () => {
  it('stays out of the way until asked for', () => {
    renderWithProviders(<CommandPalette />);
    expect(screen.queryByPlaceholderText(/search workspaces/i)).toBeNull();
    // Closed means no data fetched: the palette costs nothing until used.
    expect(apiMock.workspaces).not.toHaveBeenCalled();
  });

  it('opens on ⌘K and on Ctrl+K, because the product is used on both', async () => {
    renderWithProviders(<CommandPalette />);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText(/search workspaces/i)).toBeDefined();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.queryByPlaceholderText(/search workspaces/i)).toBeNull());

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    expect(await screen.findByPlaceholderText(/search workspaces/i)).toBeDefined();
  });

  it('lists the places to go', async () => {
    renderWithProviders(<CommandPalette />);
    openPalette();
    await screen.findByPlaceholderText(/search workspaces/i);

    for (const label of ['Dashboard', 'Board', 'Memory', 'Settings']) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });
});

describe('choosing', () => {
  it('navigates where the entry says, and closes behind itself', async () => {
    renderWithProviders(<CommandPalette />);
    openPalette();
    await screen.findByPlaceholderText(/search workspaces/i);

    fireEvent.click(screen.getByText('Memory'));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/memory'));
    await waitFor(() => expect(screen.queryByPlaceholderText(/search workspaces/i)).toBeNull());
  });

  it('keeps two identically named workspaces apart', async () => {
    // cmdk keys rows by their `value` string. Two workspaces may legitimately
    // share a name — "Perso" at home and at work — and if their rows collapse
    // into one value the palette sends you to whichever it kept.
    apiMock.workspaces.mockResolvedValue({
      workspaces: [workspace('ws_a', 'Perso'), workspace('ws_b', 'Perso')],
    });
    renderWithProviders(<CommandPalette />);
    openPalette();
    await screen.findByPlaceholderText(/search workspaces/i);

    await waitFor(() => expect(screen.getAllByText('Perso').length).toBe(2));
  });

  it('never shows a run with no label at all', async () => {
    // `prompt.split('\n')[0]` is '' for an empty prompt, and '' is not null,
    // so a `??` fallback never fires — the row renders blank and unclickable
    // by name.
    apiMock.runs.mockResolvedValue({
      runs: [
        {
          id: 'run_1',
          sessionId: 'ses_1',
          workspaceId: 'ws_a',
          prompt: '',
          status: 'completed',
          startedAt: 1_700_000_000_000,
        },
      ],
    });
    renderWithProviders(<CommandPalette />);
    openPalette();
    await screen.findByPlaceholderText(/search workspaces/i);

    await waitFor(() => expect(screen.getByText('Untitled run')).toBeDefined());
  });
});
