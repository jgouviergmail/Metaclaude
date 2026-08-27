/**
 * The Library tab: the shelf renders with kind and category, chips filter it,
 * install goes through the API, and the editors send the category they show.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AgentsPage } from './AgentsPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(async () => ({ workspaces: [] })),
    skills: vi.fn(async () => ({ skills: [] })),
    agents: vi.fn(async () => ({ agents: [] })),
    mcpServers: vi.fn(async () => ({ servers: [] })),
    library: vi.fn(async () => ({
      entries: [
        {
          kind: 'agent' as const,
          name: 'code-reviewer',
          category: 'engineering' as const,
          description: 'Reviews a diff for real defects.',
          prompt: 'You are a code reviewer.',
          installed: false,
        },
        {
          kind: 'skill' as const,
          name: 'postmortem',
          category: 'general' as const,
          description: 'Write a blameless postmortem.',
          body: '# Postmortems',
          installed: true,
        },
      ],
    })),
    installLibraryEntry: vi.fn(async (name: string) => ({
      id: 'skill_1',
      entry: {
        kind: 'agent' as const,
        name,
        category: 'engineering' as const,
        description: 'Reviews a diff for real defects.',
        prompt: 'You are a code reviewer.',
        installed: true,
      },
    })),
    saveSkill: vi.fn(async () => ({
      skill: { id: 'skill_2', name: 'sql-review' },
    })),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

async function openLibraryTab(): Promise<void> {
  // Radix tabs activate on mousedown, not click — same jsdom trap as its menus.
  const trigger = await screen.findByRole('tab', { name: /library/i });
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await screen.findByText('code-reviewer');
}

describe('the Library tab', () => {
  it('lists the shelf with kind, category, and installed state', async () => {
    renderWithProviders(<AgentsPage />);
    await openLibraryTab();

    expect(screen.getByText('subagent')).toBeDefined();
    // Twice: once as the filter chip, once as the entry's own badge.
    expect(screen.getAllByText('Engineering')).toHaveLength(2);
    // The installed entry shows its state instead of a button.
    expect(screen.getByText('Installed')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Install “postmortem”' })).toBeNull();
  });

  it('installs an entry through the API on a click', async () => {
    renderWithProviders(<AgentsPage />);
    await openLibraryTab();

    fireEvent.click(screen.getByRole('button', { name: 'Install “code-reviewer”' }));
    await waitFor(() => expect(apiMock.installLibraryEntry).toHaveBeenCalledWith('code-reviewer'));
  });

  it('filters the shelf by category chip', async () => {
    renderWithProviders(<AgentsPage />);
    await openLibraryTab();

    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.queryByText('code-reviewer')).toBeNull();
    expect(screen.getByText('postmortem')).toBeDefined();

    // Back to everything.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('code-reviewer')).toBeDefined();
  });
});

describe('the skill editor', () => {
  it('sends the category it shows', async () => {
    renderWithProviders(<AgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /new skill/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'sql-review' } });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Review SQL before it reaches data.' },
    });
    fireEvent.change(screen.getByLabelText(/^Category/), { target: { value: 'data' } });
    fireEvent.click(screen.getByRole('button', { name: /save skill/i }));

    await waitFor(() =>
      expect(apiMock.saveSkill).toHaveBeenCalledWith(expect.objectContaining({ category: 'data' })),
    );
  });
});
