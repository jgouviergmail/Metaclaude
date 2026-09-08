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
    bulkAutomations: vi.fn(),
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
  policy: { permissionMode: 'default', notify: false, model: 'claude-sonnet-5', effort: 'high' },
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
      {
        value: 'claude-opus-5',
        displayName: 'Opus 5',
        description: 'The deep one',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      {
        value: 'claude-sonnet-5',
        displayName: 'Sonnet 5',
        description: 'The quick one',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium'],
      },
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
        policy: { permissionMode: 'default', notify: true, model: 'default', effort: null },
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
    const trigger = await screen.findByRole('button', { name: /^Model:/ });
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

    expect(await screen.findByRole('button', { name: 'Model: claude-sonnet-5' })).toBeTruthy();
  });

  /**
   * The effort, which the schema carried and no form ever set — exactly as the
   * model did until this release, and the scheduler forwards both.
   */
  it('offers the effort levels under Auto, where nothing can be ruled out', async () => {
    /*
     * Asserted on the trigger rather than by opening the menu: Radix's menu
     * needs a pointer event and a frame, and what the contract actually says
     * is *whether there is a choice to make*. Under `Auto` the learner picks
     * the model at submit time, so every level stays possible and the control
     * is live.
     */
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');
    const open = screen.getByRole('button', { name: 'New automation' }) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByRole('dialog');

    const trigger = (await screen.findByRole('button', { name: /^Effort:/ })) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-label')).toBe('Effort: Auto');
  });

  it('drops an effort the newly chosen model does not offer', async () => {
    /*
     * Changing the model changes the list. The composer's own picker shows the
     * first entry while leaving the stored value alone — display and payload
     * disagreeing — and an automation fires unattended, so it must not carry a
     * setting nobody can see they chose.
     */
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await screen.findByRole('dialog');

    /*
     * Asserted on what is *sent*, not on what is shown.
     *
     * The first version of this checked the trigger's label and passed with
     * the reset removed: the label falls back to the first option, so it reads
     * `Auto` whether the value was dropped or merely hidden. That is the whole
     * defect — display and payload disagreeing — so the assertion has to reach
     * the payload.
     *
     * The fixture is Sonnet at `high`, and Sonnet reports low/medium only.
     */
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Diagnose it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.updateAutomation).toHaveBeenCalled());
    const [, body] = apiMock.updateAutomation.mock.calls[0] as [string, { policy?: { effort?: unknown } }];
    expect(body.policy?.effort).toBeNull();
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

    expect(await screen.findByRole('button', { name: 'Model: Sonnet 5' })).toBeTruthy();
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
    policy: { permissionMode: 'default', notify: true, model: 'claude-sonnet-5', effort: null },
  });

  it('duplicates into another workspace, paused and with no history', async () => {
    /*
     * A copy, not a second attachment. An automation carries seven fields of
     * execution state — its continuous session, its failure count, its next
     * firing — and every one is per workspace, so reaching two from one row is
     * a child table and a different subsystem.
     *
     * Paused on arrival: an automation fires unattended, and one that lands
     * already armed in a workspace it was not written for is the surprise this
     * screen's guard rails exist to prevent.
     */
    apiMock.workspaces.mockResolvedValue({
      workspaces: [
        { id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' },
        { id: 'ws_b', name: 'Beta', slug: 'beta', color: '#f59e0b' },
      ],
    });
    apiMock.automations.mockResolvedValue({
      automations: [automation({ runCount: 12, consecutiveFailures: 2, sessionId: 'ses_x' })],
    });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Beta' }));

    await waitFor(() => expect(apiMock.createAutomation).toHaveBeenCalled());
    const [body] = apiMock.createAutomation.mock.calls[0] as [Record<string, unknown>];
    expect(body.workspaceId).toBe('ws_b');
    expect(body.prompt).toBe('Résume les tickets ouverts');
    expect(body.enabled).toBe(false);
    // None of the execution state travels: it belongs to the original's life.
    expect(body).not.toHaveProperty('sessionId');
    expect(body).not.toHaveProperty('runCount');
    expect(body).not.toHaveProperty('consecutiveFailures');
  });

  it('does not offer to duplicate into the workspace it already lives in', async () => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [{ id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' }],
    });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);

    await screen.findByRole('menuitem', { name: 'Edit' });
    // The only workspace is its own, so the whole section stays away rather
    // than offering a copy that would land on top of the original.
    expect(screen.queryByText('Duplicate to')).toBeNull();
  });

  it('shows the workspace when editing, and moves the automation to another', async () => {
    // It used to appear only at creation, so an existing automation's workspace
    // was neither visible nor changeable — while a skill, a subagent and an MCP
    // server all show their reach in their editor. An automation written for
    // one project does turn out to suit another.
    apiMock.workspaces.mockResolvedValue({
      workspaces: [
        { id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' },
        { id: 'ws_b', name: 'Beta', slug: 'beta', color: '#f59e0b' },
      ],
    });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    // The current one is named, which it was not before at all.
    const picker = await screen.findByRole('button', { name: /Alpha/ });
    fireEvent.pointerDown(picker, { button: 0 });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Beta/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.updateAutomation).toHaveBeenCalled());
    // On the payload, not the label: the picker's text falls back to the first
    // entry, so it reads right whether the value travelled or was dropped.
    const [, body] = apiMock.updateAutomation.mock.calls[0] as [string, { workspaceId?: string }];
    expect(body.workspaceId).toBe('ws_b');
  });

  it('does not name the workspace in a patch that only renamed it', async () => {
    // A patch naming the workspace on every save is a patch that writes "moved"
    // into the audit log every time somebody fixes a typo.
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Revue du matin');

    const menu = screen.getByRole('button', { name: 'More actions for Revue du matin' });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Revue du soir' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.updateAutomation).toHaveBeenCalled());
    const [, body] = apiMock.updateAutomation.mock.calls[0] as [
      string,
      { name?: string; workspaceId?: string },
    ];
    expect(body.name).toBe('Revue du soir');
    expect(body.workspaceId).toBeUndefined();
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

/**
 * Filtering, and switching a screenful at once.
 *
 * The bulk buttons act on the rows *on screen*, never on a scope the server
 * would widen on its own — so what is pinned here is the arithmetic between
 * the two filters and the ids that leave: a "disable all" that sent the
 * unfiltered list would switch off automations the operator had deliberately
 * filtered away, from a button whose label says "all" and means "these".
 */
describe('filtering and switching many at once', () => {
  const two = () => [
    automation({ id: 'aut_a', name: 'Alpha nightly', workspaceId: 'ws_a', enabled: true }),
    automation({ id: 'aut_b', name: 'Beta hourly', workspaceId: 'ws_b', enabled: false }),
  ];

  const bothWorkspaces = () => ({
    workspaces: [
      { id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' },
      { id: 'ws_b', name: 'Beta', slug: 'beta', color: '#6366f1' },
    ],
  });

  beforeEach(() => {
    apiMock.automations.mockResolvedValue({ automations: two() });
    apiMock.workspaces.mockResolvedValue(bothWorkspaces());
    apiMock.bulkAutomations.mockResolvedValue({ changed: 1 });
  });

  const pick = async (label: RegExp) => {
    // Radix opens on the pointer event, not on click: `fireEvent.click` alone
    // does nothing in happy-dom and reads as a menu that never opened.
    const trigger = screen.getByRole('button', { name: /all workspaces/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const item = await screen.findByRole('menuitemcheckbox', { name: label });
    fireEvent.click(item);
  };

  it('narrows the list to one workspace', async () => {
    renderWithProviders(<AutomationsPage />);
    expect(await screen.findByText('Alpha nightly')).toBeTruthy();

    await pick(/^Beta$/);

    await waitFor(() => expect(screen.queryByText('Alpha nightly')).toBeNull());
    expect(screen.getByText('Beta hourly')).toBeTruthy();
  });

  it('narrows the list to what is switched off', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Alpha nightly');

    fireEvent.click(screen.getByRole('button', { name: /^inactive/i }));

    await waitFor(() => expect(screen.queryByText('Alpha nightly')).toBeNull());
    expect(screen.getByText('Beta hourly')).toBeTruthy();
  });

  /**
   * Which emptiness it is. "Nothing here" cannot tell "there are none" from
   * "none match", and the operator picks the wrong one — the gateway told an
   * operator their deployment had no workspaces for exactly this reason.
   */
  it('says how many its filters are hiding, and offers them back', async () => {
    apiMock.automations.mockResolvedValue({
      automations: [automation({ id: 'aut_a', name: 'Alpha nightly', enabled: true })],
    });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Alpha nightly');

    fireEvent.click(screen.getByRole('button', { name: /^inactive/i }));

    expect(await screen.findByText(/nothing matches these filters/i)).toBeTruthy();
    expect(screen.getByText(/1 automation is hidden/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Alpha nightly')).toBeTruthy();
  });

  it('switches off only the rows on screen, and says which workspace', async () => {
    // Both enabled, and in different workspaces. With one of each the two
    // filters pick the same row by coincidence, and a bulk action wired to the
    // *unfiltered* list passes the test it was written to catch — measured:
    // that sabotage stayed green until this fixture separated the two axes.
    apiMock.automations.mockResolvedValue({
      automations: [
        automation({ id: 'aut_a', name: 'Alpha nightly', workspaceId: 'ws_a', enabled: true }),
        automation({ id: 'aut_b', name: 'Beta hourly', workspaceId: 'ws_b', enabled: true }),
      ],
    });
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Alpha nightly');
    await pick(/^Alpha$/);
    await waitFor(() => expect(screen.queryByText('Beta hourly')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /disable all/i }));

    await waitFor(() => expect(apiMock.bulkAutomations).toHaveBeenCalled());
    expect(apiMock.bulkAutomations).toHaveBeenCalledWith({
      action: 'disable',
      ids: ['aut_a'],
      workspaceId: 'ws_a',
    });
  });

  it('offers no bulk delete for a schedule somebody wrote', async () => {
    renderWithProviders(<AutomationsPage />);
    await screen.findByText('Alpha nightly');

    expect(screen.queryByRole('button', { name: /delete all/i })).toBeNull();
  });
});
