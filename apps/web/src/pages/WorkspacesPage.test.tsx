/**
 * The workspaces index.
 *
 * One thing here can destroy data that nothing else in the product touches:
 * the delete dialog's "also delete the files on disk" checkbox. It defaults
 * to off, it changes what the confirm button says, and — the part worth
 * guarding hardest — it must reset between workspaces, so that ticking it for
 * one project cannot carry over to the next dialog you open.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { WorkspacesPage } from './WorkspacesPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const workspace = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace =>
  ({
    id,
    name,
    slug: id,
    description: '',
    path: `/srv/metaclaude/workspaces/${id}`,
    color: '#6366f1',
    icon: 'folder',
    archived: false,
    settings: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...extra,
  }) as Workspace;

const openDeleteFor = async (name: string) => {
  const trigger = await screen.findByRole('button', { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
  return screen.findByRole('dialog');
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspaces.mockResolvedValue({
    workspaces: [workspace('ws_a', 'Alpha'), workspace('ws_b', 'Beta')],
  });
  apiMock.deleteWorkspace.mockResolvedValue({ ok: true });
  apiMock.updateWorkspace.mockResolvedValue({});
});

describe('the index', () => {
  it('lists what there is', async () => {
    renderWithProviders(<WorkspacesPage />);
    expect(await screen.findByText('Alpha')).toBeDefined();
    expect(screen.getByText('Beta')).toBeDefined();
  });

  it('invites a first project when there are none', async () => {
    apiMock.workspaces.mockResolvedValue({ workspaces: [] });
    renderWithProviders(<WorkspacesPage />);
    expect(await screen.findByText('No workspaces')).toBeDefined();
  });

  it('asks the server for archived ones only when asked to show them', async () => {
    renderWithProviders(<WorkspacesPage />);
    await waitFor(() => expect(apiMock.workspaces).toHaveBeenCalledWith(false));

    const toggle = screen.getByRole('button', { name: /Show archived/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() => expect(apiMock.workspaces).toHaveBeenCalledWith(true));
    expect(screen.getByRole('button', { name: /Hide archived/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('deleting a workspace', () => {
  it('keeps the files unless asked, and says so on the button', async () => {
    renderWithProviders(<WorkspacesPage />);
    const dialog = await openDeleteFor('Alpha');

    // Default: forget the workspace, leave the directory alone.
    expect(dialog.querySelector('input[type="checkbox"]')).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeDefined();

    fireEvent.click(dialog.querySelector('input[type="checkbox"]') as HTMLInputElement);
    // The button's wording is the last warning before the files go.
    expect(screen.getByRole('button', { name: 'Delete workspace and files' })).toBeDefined();
  });

  it('names the workspace and the directory that would be erased', async () => {
    renderWithProviders(<WorkspacesPage />);
    const dialog = await openDeleteFor('Alpha');
    expect(dialog.textContent).toContain('Alpha');
    expect(dialog.textContent).toContain('/srv/metaclaude/workspaces/ws_a');
  });

  it('resets the destructive checkbox between workspaces', async () => {
    // Ticking "delete the files" for one project and then opening the dialog
    // for another must not arrive pre-armed. This is the only control in the
    // product that erases a directory.
    renderWithProviders(<WorkspacesPage />);

    const first = await openDeleteFor('Alpha');
    fireEvent.click(first.querySelector('input[type="checkbox"]') as HTMLInputElement);
    expect(screen.getByRole('button', { name: 'Delete workspace and files' })).toBeDefined();

    fireEvent.keyDown(first, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const second = await openDeleteFor('Beta');
    expect(second.querySelector('input[type="checkbox"]')).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeDefined();
  });

  it('passes the purge choice through to the API', async () => {
    renderWithProviders(<WorkspacesPage />);
    const dialog = await openDeleteFor('Alpha');
    fireEvent.click(dialog.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace and files' }));

    await waitFor(() =>
      expect(apiMock.deleteWorkspace).toHaveBeenCalledWith('ws_a', true),
    );
  });

  it('deletes nothing until the dialog is confirmed', async () => {
    renderWithProviders(<WorkspacesPage />);
    await openDeleteFor('Alpha');
    expect(apiMock.deleteWorkspace).not.toHaveBeenCalled();
  });
});

describe('creating a workspace', () => {
  it('sends what the form holds', async () => {
    apiMock.createWorkspace.mockResolvedValue({ workspace: workspace('ws_c', 'Gamma') });
    renderWithProviders(<WorkspacesPage />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: /^New$/ }));
    fireEvent.change(await screen.findByPlaceholderText('Payments service'), {
      target: { value: 'Gamma' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));

    await waitFor(() =>
      expect(apiMock.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Gamma' }),
      ),
    );
  });
});
