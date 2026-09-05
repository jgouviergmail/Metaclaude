/**
 * Scheduled work.
 *
 * An automation runs unattended, which makes two things matter more than they
 * would elsewhere: that a *disabled* one does not advertise a next run it will
 * never take, and that consecutive failures are visible without opening
 * anything — an automation quietly failing every night is the worst outcome
 * this screen has to prevent.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { AutomationsPage } from './AutomationsPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    automations: vi.fn(),
    workspaces: vi.fn(),
    updateAutomation: vi.fn(),
    fireAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    createAutomation: vi.fn(),
    system: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const automation = (over: Record<string, unknown> = {}) => ({
  id: 'aut_1',
  workspaceId: 'ws_a',
  name: 'Revue du matin',
  prompt: 'Résume les tickets ouverts',
  trigger: { kind: 'schedule', expression: '0 9 * * 1-5' },
  enabled: true,
  runCount: 12,
  lastRunAt: 1_700_000_000_000,
  lastStatus: 'succeeded',
  nextRunAt: 1_700_000_600_000,
  consecutiveFailures: 0,
  sessionId: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.automations.mockResolvedValue({ automations: [automation()] });
  apiMock.workspaces.mockResolvedValue({
    workspaces: [{ id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' }],
  });
  apiMock.updateAutomation.mockResolvedValue({});
  apiMock.fireAutomation.mockResolvedValue({});
  apiMock.deleteAutomation.mockResolvedValue({ ok: true });
  apiMock.system.mockResolvedValue({ timezone: 'Europe/Paris' });
  apiMock.createAutomation.mockResolvedValue({});
});

describe('the list', () => {
  it('names the automation, its workspace and what it will do', async () => {
    renderWithProviders(<AutomationsPage />);
    expect(await screen.findByText('Revue du matin')).toBeDefined();
    expect(screen.getByText(/Alpha/)).toBeDefined();
    expect(screen.getByText('Résume les tickets ouverts')).toBeDefined();
  });

  it('invites a first one when there are none', async () => {
    apiMock.automations.mockResolvedValue({ automations: [] });
    renderWithProviders(<AutomationsPage />);
    // The empty state is the screen, not a blank list.
    await waitFor(() => expect(apiMock.automations).toHaveBeenCalled());
    expect(screen.queryByText('Revue du matin')).toBeNull();
  });

  it('counts the runs it has taken', async () => {
    renderWithProviders(<AutomationsPage />);
    expect(await screen.findByText('12 runs')).toBeDefined();
  });
});

describe('a schedule that will not fire', () => {
  it('does not advertise a next run for a disabled automation', async () => {
    // The server keeps `nextRunAt` on the record; showing it while the
    // automation is off promises something that will not happen.
    apiMock.automations.mockResolvedValue({
      automations: [automation({ enabled: false })],
    });
    renderWithProviders(<AutomationsPage />);

    await screen.findByText('Revue du matin');
    expect(screen.queryByText(/^next /)).toBeNull();
  });

  it('shows it while the automation is on', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');
    expect(screen.getByText(/^next /)).toBeDefined();
  });
});

describe('when it keeps failing', () => {
  it('says how many times in a row, in the singular where that is one', async () => {
    // An automation failing every night without saying so is the worst thing
    // this screen can allow.
    apiMock.automations.mockResolvedValue({
      automations: [automation({ consecutiveFailures: 1, lastStatus: 'failed' })],
    });
    const { unmount } = renderWithProviders(<AutomationsPage />);
    expect(await screen.findByText(/1 consecutive failure$/)).toBeDefined();
    unmount();

    apiMock.automations.mockResolvedValue({
      automations: [automation({ consecutiveFailures: 4, lastStatus: 'failed' })],
    });
    renderWithProviders(<AutomationsPage />);
    expect(await screen.findByText(/4 consecutive failures$/)).toBeDefined();
  });

  it('stays quiet while nothing is wrong', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');
    expect(screen.queryByText(/consecutive failure/)).toBeNull();
  });
});

describe('acting on one', () => {
  it('toggles to the opposite of the state it is in', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    // The control is a Pause/Resume button, not a switch — and its label is
    // the *action*, which is why the assertion reads the opposite state.
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(apiMock.updateAutomation).toHaveBeenCalledWith('aut_1', { enabled: false }),
    );
  });

  it('offers Resume, and turns it back on, for a paused one', async () => {
    apiMock.automations.mockResolvedValue({ automations: [automation({ enabled: false })] });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(apiMock.updateAutomation).toHaveBeenCalledWith('aut_1', { enabled: true }),
    );
  });

  it('runs one on demand without waiting for its schedule', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    // The accessible name carries the automation's own name, so a screen
    // reader hears which one is about to run rather than "run now" twice.
    fireEvent.click(screen.getByRole('button', { name: 'Run Revue du matin now' }));
    await waitFor(() => expect(apiMock.fireAutomation).toHaveBeenCalledWith('aut_1'));
  });
});

describe('the form', () => {
  /**
   * The event trigger and the notify flag both existed in the schema before
   * the form offered either: an event automation could only be created
   * through the steward or the API, and nothing on screen said which clock a
   * cron was read in. The form now posts exactly what the scheduler acts on.
   */
  it('offers an event trigger, a notify flag and names the server timezone, and posts them', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');
    const open = screen.getByRole('button', { name: 'New automation' }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByRole('dialog');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Watch failures' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Diagnose the failed run.' } });
    expect((await screen.findByText(/Europe\/Paris/)).textContent).toMatch(/server's timezone/);

    fireEvent.click(screen.getByRole('button', { name: 'Event' }));
    fireEvent.click(screen.getByRole('button', { name: 'On a succeeded run' }));
    fireEvent.change(screen.getByLabelText('Filter (optional)'), { target: { value: 'deploy' } });
    fireEvent.click(screen.getByLabelText(/Notify me when a firing ends/));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(apiMock.createAutomation).toHaveBeenCalledTimes(1));
    expect(apiMock.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { type: 'event', event: 'run_succeeded', filter: 'deploy' },
        policy: { permissionMode: 'default', notify: true },
      }),
    );
  });
});
