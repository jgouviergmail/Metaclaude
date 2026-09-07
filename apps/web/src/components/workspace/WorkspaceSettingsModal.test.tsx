/**
 * A workspace's settings, reachable from more than its own screen.
 *
 * The dialog was a local function inside `WorkspacePage`, so the only way to a
 * workspace's settings was through that screen — and an operator working in a
 * session of that workspace had to leave the session to change the model, the
 * permission mode or the checkpointing the session itself runs under. What is
 * pinned here is the move: it renders standalone, it saves what it was given,
 * and the system workspace's safety settings stay refused.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkspaceSettings } from '@metaclaude/shared';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    updateWorkspace: vi.fn(),
    skills: vi.fn(),
    mcpServers: vi.fn(),
    claudeCatalogue: vi.fn(),
    agents: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { WorkspaceSettingsModal } from './WorkspaceSettingsModal';

/** Parsed from the contract, so a renamed field fails here rather than at run time. */
const SETTINGS = WorkspaceSettings.parse({});

const open = (over: Record<string, unknown> = {}) =>
  renderWithProviders(
    <WorkspaceSettingsModal
      open
      onOpenChange={() => {}}
      workspaceId="ws_a"
      settings={SETTINGS}
      name="Alpha"
      description="A project"
      color="#6366f1"
      icon=""
      locked={false}
      {...over}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.updateWorkspace.mockResolvedValue({});
  apiMock.skills.mockResolvedValue({ skills: [] });
  apiMock.mcpServers.mockResolvedValue({ servers: [] });
  apiMock.agents.mockResolvedValue({ agents: [] });
  apiMock.claudeCatalogue.mockResolvedValue({ models: [], efforts: [] });
});

describe('the workspace settings dialog', () => {
  it('renders on its own, outside the workspace screen', async () => {
    // The whole point of the extraction: it no longer needs the page around it.
    open();
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByDisplayValue('Alpha')).toBeTruthy();
  });

  it('saves the name it was given back', async () => {
    open();
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'Beta' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.updateWorkspace).toHaveBeenCalled());
    const [id, body] = apiMock.updateWorkspace.mock.calls[0] as [string, { name?: string }];
    expect(id).toBe('ws_a');
    expect(body.name).toBe('Beta');
  });

  /**
   * Every boolean setting, not just the one this release added.
   *
   * A checkbox wired to a literal, or to its neighbour's field, renders and
   * saves and looks perfect - and shows the operator the opposite of what is
   * stored. Nothing in the suite could see that: each control was covered by
   * the test for the feature that introduced it, if at all.
   *
   * One field true at a time, and exactly one box checked. Counting rather
   * than naming keeps this free of a label table that would drift and would
   * have to be translated - with the tool and plugin lists empty, every
   * checked box in the dialog is a boolean setting. Turning them all on
   * together was the first version and it was weaker than it looked: it
   * catches a literal, and a control reading its neighbour's field passes it,
   * because with every field alike no arrangement can be told from another.
   */
  const BOOLEAN_SETTINGS = Object.entries(WorkspaceSettings.parse({}))
    .filter(([, value]) => typeof value === 'boolean')
    .map(([key]) => key);

  const allBooleans = (on: boolean) =>
    Object.fromEntries(BOOLEAN_SETTINGS.map((key) => [key, on]));

  it('shows nothing checked when every boolean setting is off', async () => {
    open({ settings: WorkspaceSettings.parse(allBooleans(false)) });
    await screen.findByRole('dialog');

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThanOrEqual(BOOLEAN_SETTINGS.length);
    expect(boxes.filter((box) => box.checked)).toHaveLength(0);
  });

  it.each(BOOLEAN_SETTINGS)('gives %s a checkbox of its own', async (key) => {
    open({ settings: WorkspaceSettings.parse({ ...allBooleans(false), [key]: true }) });
    await screen.findByRole('dialog');

    const checked = (screen.getAllByRole('checkbox') as HTMLInputElement[]).filter(
      (box) => box.checked,
    );
    expect(checked).toHaveLength(1);
  });

  it('shows a workspace that already opted out as opted out', async () => {
    // Asserting only the default would pass on a box wired to a literal, and
    // the failure that hides is the worst one this control can have: a
    // workspace stored as unreachable, displayed as reachable, with the
    // operator reading the opposite of the truth off the screen.
    open({ settings: WorkspaceSettings.parse({ delegable: false }) });
    await screen.findByRole('dialog');

    const box = screen.getByLabelText(/let other workspaces consult this one/i);
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  /**
   * The opt-out an operator actually presses.
   *
   * The default is on, and it has to be: settings are reparsed on every read,
   * so every workspace written before the field existed takes the default. A
   * test that only asserted the box exists would pass on a control wired to
   * nothing, so this one turns it off and follows the value to the request.
   */
  it('sends the delegation opt-out it was toggled to', async () => {
    open();
    await screen.findByRole('dialog');

    const box = screen.getByLabelText(/let other workspaces consult this one/i);
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.updateWorkspace).toHaveBeenCalled());
    const [, body] = apiMock.updateWorkspace.mock.calls[0] as [
      string,
      { settings?: { delegable?: boolean } },
    ];
    expect(body.settings?.delegable).toBe(false);
  });

  /**
   * The description gained a second reader — other workspaces' agents — and
   * the field has to say so, or nobody writes one and the directory stays
   * empty. The hint sits outside the `<label>`, because text inside one joins
   * the accessible name, so the control has to point at it to be announced.
   */
  it('tells the operator who reads a description, and says it to a screen reader too', async () => {
    open();
    await screen.findByRole('dialog');

    const field = screen.getByDisplayValue('A project');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBe('ws-edit-description-hint');
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/other workspaces/i);
  });

  /**
   * The colour was choosable at creation and never again, and the icon was a
   * field nothing ever set. Both have to reach the request, or the controls
   * are decoration — the failure this dialog has already had once, on a
   * checkbox wired to a literal.
   */
  it('saves a colour and an icon the operator picked', async () => {
    open();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByLabelText('rocket'));
    fireEvent.click(screen.getByRole('button', { name: /use colour #ec4899/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.updateWorkspace).toHaveBeenCalled());
    const [, body] = apiMock.updateWorkspace.mock.calls[0] as [
      string,
      { color?: string; icon?: string },
    ];
    expect(body.icon).toBe('rocket');
    expect(body.color).toBe('#ec4899');
  });

  it('sends an icon back to nothing when it is taken off', async () => {
    open({ icon: 'rocket' });
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByLabelText(/no icon/i));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(apiMock.updateWorkspace).toHaveBeenCalled());
    const [, body] = apiMock.updateWorkspace.mock.calls[0] as [string, { icon?: string }];
    expect(body.icon).toBe('');
  });

  it('fixes the system workspace’s tool lists, and says why', async () => {
    /*
     * What `locked` actually holds — read from the component rather than
     * assumed. The server fixes the *tool lists* of Metaclaude's own workspace
     * and answers 409 to a change; the name and the language are the
     * operator's, and a guard that refused those turned every save into a 409
     * once already (see the note in CLAUDE.md). So this asserts the tools are
     * disabled and the explanation is shown — and that the name is not locked.
     */
    open({ locked: true });
    await screen.findByRole('dialog');

    expect(screen.getByRole('note')).toBeTruthy();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.some((box) => box.disabled)).toBe(true);
    expect((screen.getByDisplayValue('Alpha') as HTMLInputElement).disabled).toBe(false);
  });

  it('leaves an ordinary workspace’s tools alone', async () => {
    open({ locked: false });
    await screen.findByRole('dialog');
    expect(screen.queryByRole('note')).toBeNull();
  });
});
