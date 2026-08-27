/**
 * The advisor's inbox: proposals render with their rationale, deciding calls
 * the API, and a viewer sees nothing — the buttons would only 403 for them.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';
import { AdvisorCard } from './AdvisorCard';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(async () => ({
      workspaces: [{ id: 'ws_1', name: 'Metaclaude' } as never],
    })),
    advisorProposals: vi.fn(async () => ({
      proposals: [
        {
          id: 'prp_1',
          workspaceId: 'ws_1',
          runId: 'run_1',
          kind: 'skill' as const,
          name: 'release-ritual',
          summary: 'A release checklist.',
          rationale: 'Releases keep missing the changelog step.',
          payload: {},
          status: 'pending' as const,
          createdAt: 0,
          decidedAt: null,
          decidedBy: null,
        },
      ],
    })),
    askAdvisor: vi.fn(async () => ({ runId: 'run_2', sessionId: 'session_1' })),
    acceptAdvisorProposal: vi.fn(async () => ({
      proposal: { name: 'release-ritual', kind: 'skill' } as never,
      appliedId: 'skill_1',
    })),
    dismissAdvisorProposal: vi.fn(async () => ({ proposal: {} as never })),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

const operator = { id: 'usr_1', username: 'op', displayName: 'Op', role: 'operator' } as User;

beforeEach(() => {
  useAuthStore.getState().setUser(operator);
});

describe('AdvisorCard', () => {
  it('shows a pending proposal with its rationale', async () => {
    renderWithProviders(<AdvisorCard />);
    expect(await screen.findByText('release-ritual')).toBeDefined();
    expect(screen.getByText('Releases keep missing the changelog step.')).toBeDefined();
    expect(screen.getByText('skill')).toBeDefined();
  });

  it('accepts and dismisses through the API', async () => {
    renderWithProviders(<AdvisorCard />);
    await screen.findByText('release-ritual');

    fireEvent.click(screen.getByRole('button', { name: 'Accept “release-ritual”' }));
    await waitFor(() => expect(apiMock.acceptAdvisorProposal).toHaveBeenCalledWith('prp_1'));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss “release-ritual”' }));
    await waitFor(() => expect(apiMock.dismissAdvisorProposal).toHaveBeenCalledWith('prp_1'));
  });

  it('asks the advisor for a chosen workspace', async () => {
    renderWithProviders(<AdvisorCard />);
    const trigger = await screen.findByRole('button', { name: /ask the advisor/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Metaclaude' }));
    await waitFor(() => expect(apiMock.askAdvisor).toHaveBeenCalledWith('ws_1'));
  });

  it('renders nothing for a viewer', () => {
    useAuthStore.getState().setUser({ ...operator, role: 'viewer' } as User);
    const { container } = renderWithProviders(<AdvisorCard />);
    expect(container.textContent).toBe('');
  });
});
