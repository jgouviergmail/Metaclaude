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
