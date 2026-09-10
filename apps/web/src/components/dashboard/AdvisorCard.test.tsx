/**
 * The advisor's inbox: proposals render with their rationale, deciding calls
 * the API, and a viewer sees nothing — the buttons would only 403 for them.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@metaclaude/shared';
import { RevisionPayload } from '@metaclaude/shared';
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
    revertAdvisorProposal: vi.fn(async () => ({ proposal: {} as never })),
  },
}));

/**
 * A revision payload, built through the schema.
 *
 * Written from memory it would be wrong, and a wrong payload does not fail —
 * it parses to nothing, the card falls back to the generic row, and the test
 * times out on an element that was never going to appear. Five fixtures in one
 * session went that way.
 */
const revisionPayload = () =>
  RevisionPayload.parse({
    target: { kind: 'skill', id: 'skl_1', name: 'review-migrations', workspaceId: 'ws_1' },
    field: 'description',
    before: 'Reviews migrations.',
    after: 'Use when reviewing a migration.',
    beforeFingerprint: 'abc',
    diff: ['@@ -1 +1 @@', '-Reviews migrations.', '+Use when reviewing a migration.'].join('\n'),
    rationale: 'Offered fourteen times, opened none.',
  });

const revisionProposal = (over: Record<string, unknown> = {}) => ({
  id: 'prp_rev',
  workspaceId: 'ws_1',
  runId: null,
  kind: 'revision' as const,
  name: 'skill:skl_1:description',
  summary: 'Rewrite the description of review-migrations',
  rationale: 'r',
  payload: revisionPayload(),
  status: 'pending' as const,
  createdAt: 0,
  decidedAt: null,
  decidedBy: null,
  ...over,
});

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

/**
 * A revision is rendered by its own card, never by the generic row.
 *
 * It is the one proposal here that changes something the instant it is
 * accepted, so the operator has to see the diff before they decide. A summary
 * line beside an Accept button would be asking them to approve a rewrite they
 * cannot read.
 */
describe('a revision in the inbox', () => {
  beforeEach(() => {
    apiMock.advisorProposals.mockImplementation(async (_workspaceId?: string, status?: string) =>
      status === 'accepted' ? { proposals: [] } : { proposals: [revisionProposal() as never] },
    );
  });

  it('draws its diff rather than a summary line', async () => {
    renderWithProviders(<AdvisorCard />);

    expect(await screen.findByText('Use when reviewing a migration.')).toBeTruthy();
    expect(screen.getByText('Reviews migrations.')).toBeTruthy();
  });

  it('applies it through the same accept route', async () => {
    renderWithProviders(<AdvisorCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(apiMock.acceptAdvisorProposal).toHaveBeenCalledWith('prp_rev'));
  });

  /**
   * The half that makes accepting one safe. Closed by default, and asserted as
   * closed by its own `open` rather than by visibility: happy-dom does not
   * hide the children of a shut `details`, so `toBeVisible` passes just as
   * happily on a card that never folds.
   */
  it('folds the revisions already in force away, and can take one back', async () => {
    apiMock.advisorProposals.mockImplementation(async (_workspaceId?: string, status?: string) =>
      status === 'accepted'
        ? { proposals: [revisionProposal({ id: 'prp_done', status: 'accepted' }) as never] }
        : { proposals: [] },
    );
    renderWithProviders(<AdvisorCard />);

    // eslint-disable-next-line no-console
    const summary = await screen.findByText(/revision in force/);
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: /Take it back/ }));
    await waitFor(() => expect(apiMock.revertAdvisorProposal).toHaveBeenCalledWith('prp_done'));
  });

  it('says nothing about revisions in force when there are none', async () => {
    renderWithProviders(<AdvisorCard />);
    await screen.findByText('Use when reviewing a migration.');

    expect(screen.queryByText(/in force/)).toBeNull();
  });
});
