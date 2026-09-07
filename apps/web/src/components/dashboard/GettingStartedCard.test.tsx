/**
 * The card's three exits: not the owner, dismissed, or nothing left to say —
 * and the one state where it earns its place: steps with doors.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useAuthStore } from '@/lib/store';
import { GettingStartedCard } from './GettingStartedCard';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    system: vi.fn(),
    workspaces: vi.fn(),
    runs: vi.fn(),
    push: { status: vi.fn() },
    updateApplyStatus: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

function signIn(role: 'owner' | 'operator', totpEnabled = false) {
  useAuthStore.setState({
    status: 'authenticated',
    user: { id: 'usr_1', username: 'o', role, totpEnabled } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signIn('owner');
  apiMock.system.mockResolvedValue({ claudeCli: { authenticated: true } });
  apiMock.workspaces.mockResolvedValue({ workspaces: [{ id: 'ws_1' }] });
  apiMock.runs.mockResolvedValue({ runs: [] });
  apiMock.push.status.mockResolvedValue({ publicKey: 'k', devices: 0 });
  apiMock.updateApplyStatus.mockResolvedValue({ available: false, state: 'idle' });
});

describe('GettingStartedCard', () => {
  it('lists what remains, each step a link to its screen', async () => {
    renderWithProviders(<GettingStartedCard />);

    expect(await screen.findByText(/getting set up/i)).toBeTruthy();
    expect(screen.getByText(/run the agent once/i).closest('a')?.getAttribute('href')).toBe(
      '/workspaces',
    );
    expect(screen.getByText(/install the host updater/i)).toBeTruthy();
  });

  /*
   * What is finished is a number, not a row.
   *
   * Six rows filled 343px at the top of the dashboard and half of them were
   * struck through — a finished step is finished, and there is nothing on it
   * to act on. The count and the bar carry the only thing those rows said,
   * which is that you are getting somewhere.
   */
  it('does not list a step that is already done', async () => {
    renderWithProviders(<GettingStartedCard />);
    await screen.findByRole('list');

    // The fixture has Claude paired and a workspace created.
    expect(screen.queryByText(/pair claude/i)).toBeNull();
    expect(screen.queryByText(/create a workspace/i)).toBeNull();
    expect(document.querySelector('.line-through')).toBeNull();
  });

  it('says how far along you are, in words and as a bar', async () => {
    renderWithProviders(<GettingStartedCard />);
    await screen.findByRole('list');

    // Two of the six are done in this fixture.
    expect(screen.getByText('2 of 6 done')).toBeTruthy();
    // `Meter` is an `img` with a label, deliberately: it is a drawn ratio, not
    // a control, and it carries its reading in the name.
    expect(screen.getByRole('img', { name: '2 of 6 done' })).toBeTruthy();
  });

  it('shows no progress line before anything is done', async () => {
    // A bar at zero reads as "you have failed at something", and the rows
    // below already say what to do first.
    apiMock.system.mockResolvedValue({ claudeCli: { authenticated: false } });
    apiMock.workspaces.mockResolvedValue({ workspaces: [] });
    renderWithProviders(<GettingStartedCard />);
    await screen.findByRole('list');

    expect(screen.queryByRole('img', { name: /done/ })).toBeNull();
  });

  it('says nothing once everything is done', async () => {
    apiMock.runs.mockResolvedValue({ runs: [{ id: 'run_1' }] });
    apiMock.push.status.mockResolvedValue({ publicKey: 'k', devices: 1 });
    apiMock.updateApplyStatus.mockResolvedValue({ available: true, state: 'idle' });
    signIn('owner', true);

    const { container } = renderWithProviders(<GettingStartedCard />);
    // Give the queries a beat; the card must never appear.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).not.toContain('Getting set up');
  });

  it('is not for operators — every step it names is an owner act', async () => {
    signIn('operator');
    const { container } = renderWithProviders(<GettingStartedCard />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
    expect(apiMock.system).not.toHaveBeenCalled();
  });

  it('stays dismissed across visits', async () => {
    renderWithProviders(<GettingStartedCard />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss the checklist/i }));
    expect(screen.queryByText(/getting set up/i)).toBeNull();

    const { container } = renderWithProviders(<GettingStartedCard />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });
});

/**
 * A checklist explains the step you are on.
 *
 * Six steps, each carrying two lines of explanation, filled four hundred and
 * forty pixels of an eight-hundred-pixel phone — the largest single block on
 * the dashboard, in front of everything the operator opened it to see. The
 * detail of a step you have not reached yet is not urgent; the detail of the
 * one you are about to do is.
 *
 * The trigger this app usually offers cannot be used here: the whole row is a
 * `<Link>`, and a button inside a link is invalid markup and unreachable by
 * keyboard. `.help-comfortable` — the CSS-only rule the memory counts already
 * use — says the same thing without adding a control.
 */
describe('how much of itself the checklist explains', () => {
  /*
   * Selected by the role its size gives it, not by `block`: which steps carry a
   * display utility is exactly what this contract decides, so a selector naming
   * one would move with the implementation instead of holding it.
   */
  const details = () =>
    [...document.querySelectorAll('li a span.text-caption')];

  it('explains the step you are on, and leaves the rest to the comfortable density', async () => {
    renderWithProviders(<GettingStartedCard />);
    await screen.findByRole('list');
    const shown = details();
    // Written structurally rather than by naming a step: which one is next
    // depends on the fixture, and the contract does not.
    expect(shown.length).toBeGreaterThan(1);
    expect(shown[0]!.className).not.toContain('help-comfortable');
    for (const later of shown.slice(1)) {
      expect(later.className).toContain('help-comfortable');
    }
  });

  it('explains only steps, never the progress line', async () => {
    // The progress line carries a caption of its own; it must not be counted
    // as a step's explanation, or the contract above would pass by accident.
    renderWithProviders(<GettingStartedCard />);
    await screen.findByRole('list');
    for (const detail of details()) {
      expect(detail.closest('a')).not.toBeNull();
    }
  });
});
