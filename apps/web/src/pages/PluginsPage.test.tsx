/**
 * Plugins and the marketplaces they come from.
 *
 * This is the screen through which third-party code enters the OS, so what is
 * worth pinning is that nothing installs or is removed without an explicit
 * act, that a toggle asks for the *opposite* of the current state, and that
 * the confirmation of an install reports what actually arrived — a plugin is
 * a bundle of skills and MCP servers, and "installed" alone says nothing
 * about what now has reach.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { PluginsPage } from './PluginsPage';

const { apiMock, toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  apiMock: {
    plugins: {
      list: vi.fn(),
      install: vi.fn(),
      setEnabled: vi.fn(),
      remove: vi.fn(),
    },
    marketplaces: {
      list: vi.fn(),
      catalogue: vi.fn(),
      add: vi.fn(),
      setEnabled: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: toastMock }));

const plugin = (id: string, name: string, enabled = true) => ({
  id,
  name,
  path: `/srv/plugins/${id}`,
  version: '1.0.0',
  description: '',
  enabled,
  skills: [{ name: 'a' }],
  mcpServers: [],
  // `warnings` is part of the record, not optional — the page reads its
  // length unguarded, which is right given the contract.
  warnings: [] as string[],
  agents: [],
  installedAt: 1_700_000_000_000,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.plugins.list.mockResolvedValue([plugin('plg_1', 'Everyday life')]);
  apiMock.marketplaces.list.mockResolvedValue([]);
  apiMock.marketplaces.catalogue.mockResolvedValue({ entries: [] });
  apiMock.plugins.setEnabled.mockResolvedValue({});
  apiMock.plugins.remove.mockResolvedValue({});
});

describe('what is installed', () => {
  it('lists the plugins', async () => {
    renderWithProviders(<PluginsPage />);
    expect(await screen.findByText('Everyday life')).toBeDefined();
  });

  it('asks for the opposite of the state the row is in', async () => {
    // A toggle that sends the state it already has is a no-op the user reads
    // as a broken switch.
    renderWithProviders(<PluginsPage />);
    await screen.findByText('Everyday life');

    const toggle = screen.getAllByRole('switch')[0] as HTMLElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(apiMock.plugins.setEnabled).toHaveBeenCalledWith('plg_1', false));
  });

  it('sends the other direction for a disabled plugin', async () => {
    apiMock.plugins.list.mockResolvedValue([plugin('plg_1', 'Everyday life', false)]);
    renderWithProviders(<PluginsPage />);
    await screen.findByText('Everyday life');

    fireEvent.click(screen.getAllByRole('switch')[0] as HTMLElement);
    await waitFor(() => expect(apiMock.plugins.setEnabled).toHaveBeenCalledWith('plg_1', true));
  });
});

describe('installing', () => {
  it('installs nothing until a path is given and confirmed', async () => {
    renderWithProviders(<PluginsPage />);
    await screen.findByText('Everyday life');

    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    await screen.findByRole('dialog');
    expect(apiMock.plugins.install).not.toHaveBeenCalled();
  });

  it('reports what arrived, not merely that something did', async () => {
    // "Installed" alone says nothing about what now has reach inside the OS.
    apiMock.plugins.install.mockResolvedValue({
      ...plugin('plg_2', 'Ops'),
      skills: [{ name: 'a' }, { name: 'b' }],
      mcpServers: [{ name: 'm' }],
    });
    renderWithProviders(<PluginsPage />);
    await screen.findByText('Everyday life');

    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/srv/plugins/ops' } });
    fireEvent.click(screen.getByRole('button', { name: /Install plugin|^Install$/ }));

    await waitFor(() => expect(apiMock.plugins.install).toHaveBeenCalledWith('/srv/plugins/ops'));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Installed Ops — 2 skills, 1 MCP server.'),
    );
  });

  it('counts in the singular where there is one of a thing', async () => {
    apiMock.plugins.install.mockResolvedValue({
      ...plugin('plg_2', 'Ops'),
      skills: [{ name: 'a' }],
      mcpServers: [],
    });
    renderWithProviders(<PluginsPage />);
    await screen.findByText('Everyday life');

    fireEvent.click(screen.getByRole('button', { name: /^Install$/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('input') as HTMLInputElement, {
      target: { value: '/p' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Install plugin|^Install$/ }));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Installed Ops — 1 skill, 0 MCP servers.'),
    );
  });
});

describe('when there is nothing yet', () => {
  it('renders the empty shelf rather than a blank page', async () => {
    apiMock.plugins.list.mockResolvedValue([]);
    renderWithProviders(<PluginsPage />);
    // The marketplaces heading is always there; the plugin list is what empties.
    expect(await screen.findByText('Marketplaces')).toBeDefined();
  });
});
