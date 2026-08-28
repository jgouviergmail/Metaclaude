/**
 * The management buttons, and the two things that make them safe: they act on
 * the ids they were shown, and the destructive one says what it removes.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { api } from '@/lib/api';
import { BulkActions } from './BulkActions';

const items = [
  { id: 'a', enabled: true },
  { id: 'b', enabled: false },
  { id: 'c', enabled: true },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BulkActions', () => {
  it('enables only what is off, and disables only what is on', async () => {
    const bulk = vi.spyOn(api, 'bulkSkills').mockResolvedValue({ changed: 1 });
    renderWithProviders(<BulkActions kind="skill" items={items} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => expect(bulk).toHaveBeenCalled());
    expect(bulk.mock.calls[0]![0]).toEqual({ action: 'enable', ids: ['b'] });

    fireEvent.click(screen.getByRole('button', { name: /Disable all/ }));
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(2));
    expect(bulk.mock.calls[1]![0]).toEqual({ action: 'disable', ids: ['a', 'c'] });
  });

  it('offers no action that could only report "0 changed"', () => {
    renderWithProviders(
      <BulkActions kind="skill" items={[{ id: 'a', enabled: true }]} onChanged={() => {}} />,
    );

    expect(screen.getByRole('button', { name: /Enable all/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Disable all/ }).hasAttribute('disabled')).toBe(false);
  });

  it('asks before deleting, and names the count in both the title and the button', async () => {
    const bulk = vi.spyOn(api, 'bulkSkills').mockResolvedValue({ changed: 3 });
    renderWithProviders(<BulkActions kind="skill" items={items} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Delete all/ }));

    expect(await screen.findByText('Delete 3 skills?')).toBeDefined();
    expect(bulk).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }));
    await waitFor(() => expect(bulk).toHaveBeenCalled());
    expect(bulk.mock.calls[0]![0]).toEqual({ action: 'delete', ids: ['a', 'b', 'c'] });
  });

  it('warns that a workspace listing carries the global entries too', async () => {
    renderWithProviders(
      <BulkActions kind="skill" items={items} workspaceId="ws_1" onChanged={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete all/ }));

    expect(await screen.findByText(/including the global entries/)).toBeDefined();
  });

  it('sends the scope it was given, and omits it when there is none', async () => {
    const bulk = vi.spyOn(api, 'bulkSkills').mockResolvedValue({ changed: 1 });
    const { rerender } = renderWithProviders(
      <BulkActions kind="skill" items={items} workspaceId={null} onChanged={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => expect(bulk).toHaveBeenCalled());
    // null travels: "global only" is a real scope, distinct from "every scope".
    expect(bulk.mock.calls[0]![0]).toEqual({ action: 'enable', ids: ['b'], workspaceId: null });

    rerender(<BulkActions kind="skill" items={items} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(2));
    expect(bulk.mock.calls[1]![0]).not.toHaveProperty('workspaceId');
  });

  it('routes subagents to their own endpoint', async () => {
    const skills = vi.spyOn(api, 'bulkSkills').mockResolvedValue({ changed: 0 });
    const agents = vi.spyOn(api, 'bulkAgents').mockResolvedValue({ changed: 1 });
    renderWithProviders(<BulkActions kind="agent" items={items} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => expect(agents).toHaveBeenCalled());
    expect(skills).not.toHaveBeenCalled();
  });

  it('renders nothing at all when the listing is empty', () => {
    const { container } = renderWithProviders(
      <BulkActions kind="skill" items={[]} onChanged={() => {}} />,
    );

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('reports a failure and leaves the listing alone', async () => {
    vi.spyOn(api, 'bulkSkills').mockRejectedValue(new Error('nope'));
    const onChanged = vi.fn();
    renderWithProviders(<BulkActions kind="skill" items={items} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));

    await waitFor(() => expect(onChanged).not.toHaveBeenCalled());
  });
});
