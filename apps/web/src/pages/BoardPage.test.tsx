/**
 * The board is a page like the others: inside the shell.
 *
 * It shipped without it once — the only screen in the app with no icon rail
 * on desktop and, worse, no tab bar on a phone, leaving the browser's Back
 * button as the only way out.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { BoardPage } from './BoardPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(async () => ({ workspaces: [] })),
    board: vi.fn(async () => ({ tasks: [] })),
    workBoard: vi.fn(async () => ({
      started: null as { id: string; title: string } | null,
      reason: 'empty' as 'started' | 'busy' | 'empty' | 'quota' | 'off',
    })),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

describe('BoardPage', () => {
  it('renders inside the shell — rail and phone tab bar included', async () => {
    renderWithProviders(<BoardPage />);

    expect(await screen.findByText(/no workspace yet/i)).toBeDefined();
    expect(screen.getAllByRole('navigation', { name: 'Sections' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'More sections' })).toBeDefined();
  });

  it('offers Work the board, disabled until a workspace exists', async () => {
    renderWithProviders(<BoardPage />);
    const button = await screen.findByRole('button', { name: /work the board/i });
    // No workspace: pressing it could only fail, so it must not be pressable.
    expect(button.getAttribute('disabled')).not.toBeNull();
  });

  it('starts the top card from the header once a workspace is there', async () => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [{ id: 'ws_1', name: 'Metaclaude' } as never],
    });
    apiMock.workBoard.mockResolvedValue({
      started: { id: 'tsk_1', title: 'Ship it' },
      reason: 'started',
    });
    renderWithProviders(<BoardPage />);

    const button = await screen.findByRole('button', { name: /work the board/i });
    await waitFor(() => expect(button.getAttribute('disabled')).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(apiMock.workBoard).toHaveBeenCalledWith('ws_1'));
  });
});
