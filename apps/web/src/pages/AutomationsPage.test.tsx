/**
 * Scheduled work.
 *
 * An automation runs unattended, which makes two things matter more than they
 * would elsewhere: that a *disabled* one does not advertise a next run it will
 * never take, and that consecutive failures are visible without opening
 * anything — an automation quietly failing every night is the worst outcome
 * this screen has to prevent.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    claudeCatalogue: vi.fn(),
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
  policy: { permissionMode: 'default', notify: false, model: 'claude-sonnet-5' },
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
  // The picker offers what the workspace can reach, so the test has to say
  // what that is — an empty catalogue would offer nothing to choose.
  apiMock.claudeCatalogue.mockResolvedValue({
    models: [
      { value: 'claude-opus-5', displayName: 'Opus 5', description: 'The deep one' },
      { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'The quick one' },
    ],
    efforts: [],
  });
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
        policy: { permissionMode: 'default', notify: true, model: 'default' },
      }),
    );
  });

  /**
   * The model an unattended run uses.
   *
   * `AutomationPolicy.model` shipped with the feature and no form ever set it,
   * so every automation ran on whatever `default` resolves to — including the
   * nightly briefs, where the choice matters most and nobody could make it.
   * The scheduler has always forwarded the field; only the picker was missing,
   * which is the same shape as the `notify` flag above and as the event
   * trigger before it. A schema field nothing writes is a promise on screen
   * and silence underneath.
   */
  it('offers the workspace’s models, from the catalogue rather than a fixed list', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');
    const open = screen.getByRole('button', { name: 'New automation' }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByRole('dialog');

    // `Auto` is `modelOptions`' own first entry - what a run gets when nobody
    // chose. Its presence is what says the picker is wired to the catalogue.
    const trigger = await screen.findByRole('button', { name: 'Auto' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    expect(await screen.findByRole('menuitemcheckbox', { name: /Opus 5/ })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: /Sonnet 5/ })).toBeTruthy();
  });

  it('shows the stored model even when the catalogue does not list it', async () => {
    /*
     * The catalogue follows the workspace picker, so a model chosen under one
     * workspace can be absent from another's list — and an automation created
     * before a credential changed can name a model the CLI no longer reports.
     * Falling back to `Auto` there would show a choice nobody made while
     * posting a different one. The raw value is what will be sent, so the raw
     * value is what the button says.
     */
    apiMock.claudeCatalogue.mockResolvedValue({ models: [], efforts: [] });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('dialog');

    expect(await screen.findByRole('button', { name: 'claude-sonnet-5' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
  });

  it('starts from the automation’s own model when editing, not from the default', async () => {
    // The editor edits a snapshot; a picker that always opened on `Auto` would
    // quietly rewrite the choice on the next save of any other field - the
    // trigger-overwriting bug this file already covers, on another field.
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('dialog');

    expect(await screen.findByRole('button', { name: 'Sonnet 5' })).toBeTruthy();
  });
});

/**
 * The editor edits a snapshot, and a snapshot is not the record.
 *
 * Reported from use on `Alerte échec`: its trigger had become
 * `event/run_failed` — the card said so, and so did the server — while the
 * open edit form still held the cron it was created with. The form sent every
 * field it holds, so changing the prompt would have written `0 9 * * *` back
 * over a trigger nobody had touched. A field this form has no opinion about
 * must not be in what it sends.
 */
describe('editing an automation', () => {
  const eventAutomation = automation({
    description: '',
    trigger: { type: 'event', event: 'run_failed' },
    continuous: false,
    maxConsecutiveFailures: 3,
    // A model, as Zod guarantees one in production: `AutomationPolicy.model`
    // has `.default('default')`, so a stored policy always carries it. A
    // fixture without one made the form report a change nobody made.
    policy: { permissionMode: 'default', notify: true, model: 'claude-sonnet-5' },
  });

  /**
   * The four trigger buttons must fit a phone.
   *
   * Reported from a phone: the event trigger could not be seen or chosen. Four
   * `flex-1` cells in one flex row cannot shrink below their own text, so the
   * row overflowed the dialog with no wrap and no scroll — in French, where
   * the labels are longest, the fourth was off-screen. jsdom has no layout, so
   * what can be asserted is the contract that prevents it: the row wraps to
   * two columns before it reaches four.
   */
  it('lays the trigger buttons out two by two before four across', async () => {
    apiMock.automations.mockResolvedValue({ automations: [eventAutomation] });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const row = await screen.findByRole('group', { name: 'Trigger' });
    expect(row.className).toMatch(/grid-cols-2/);
    expect(row.className).not.toMatch(/^flex /);
    // All four reachable, and the event one selected because that is what is stored.
    expect(within(row).getAllByRole('button')).toHaveLength(4);
    expect(within(row).getByRole('button', { name: 'Event' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('sends only what was changed, leaving an untouched trigger alone', async () => {
    apiMock.automations.mockResolvedValue({ automations: [eventAutomation] });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const promptField = await screen.findByLabelText(/Prompt/i);
    fireEvent.change(promptField, { target: { value: 'Diagnose the failure.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.updateAutomation).toHaveBeenCalledTimes(1));
    expect(apiMock.updateAutomation).toHaveBeenCalledWith('aut_1', {
      prompt: 'Diagnose the failure.',
    });
  });
});

