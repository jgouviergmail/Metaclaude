/**
 * The board is a page like the others: inside the shell.
 *
 * It shipped without it once — the only screen in the app with no icon rail
 * on desktop and, worse, no tab bar on a phone, leaving the browser's Back
 * button as the only way out.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { BoardPage } from './BoardPage';

vi.mock('@/lib/api', () => ({
  api: { workspaces: vi.fn(async () => ({ workspaces: [] })) },
  ApiError: class ApiError extends Error {},
}));

describe('BoardPage', () => {
  it('renders inside the shell — rail and phone tab bar included', async () => {
    renderWithProviders(<BoardPage />);

    expect(await screen.findByText(/no workspace yet/i)).toBeDefined();
    expect(screen.getAllByRole('navigation', { name: 'Sections' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'More sections' })).toBeDefined();
  });
});
