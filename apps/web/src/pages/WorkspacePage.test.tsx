/**
 * A workspace's landing screen.
 *
 * The behaviour worth guarding is the one that runs without being asked: a
 * workspace with no sessions creates one and lands the operator inside it,
 * rather than showing an empty room. That effect is guarded against firing
 * twice — a double-create would leave a stray empty session behind on every
 * visit — and the guard is exactly the kind that a refactor quietly loses.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSettings } from '@metaclaude/shared';

import { renderInFrench, renderWithProviders } from '@/test/render';

import { WorkspacePage } from './WorkspacePage';

const { apiMock, navigate, setLastWorkspace } = vi.hoisted(() => ({
  apiMock: {
    workspace: vi.fn(),
    createSession: vi.fn(),
    claudeCliSessions: vi.fn(),
    adoptCliSession: vi.fn(),
    updateWorkspace: vi.fn(),
    marketplaces: { list: vi.fn(), catalogue: vi.fn() },
  },
  navigate: vi.fn(),
  setLastWorkspace: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: 'ws_a' }),
}));
vi.mock('@/components/workspace/SessionList', () => ({ SessionList: () => null }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return {
    ...actual,
    useUiStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { setLastWorkspace, theme: 'dark', showThinking: false, expandTools: false };
      return selector ? selector(state) : state;
    },
  };
});

const workspace = {
  id: 'ws_a',
  name: 'Alpha',
  slug: 'alpha',
  description: '',
  path: '/srv/a',
  color: '#6366f1',
  icon: 'folder',
  archived: false,
  // Parsed from the schema rather than hand-written: every field carries a
  // default, so the server never sends a partial object and the page reads
  // `settings.defaultPermissionMode` unguarded — correctly.
  settings: WorkspaceSettings.parse({}),
  createdAt: 0,
  updatedAt: 0,
};

const session = {
  id: 'ses_1',
  workspaceId: 'ws_a',
  title: 'Bail',
  pinned: false,
  archived: false,
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspace.mockResolvedValue({
    workspace,
    isSystem: false,
    sessions: [session],
    gitStatus: null,
    memoryStats: { episodic: 1, semantic: 2, procedural: 3 },
  });
  apiMock.claudeCliSessions.mockResolvedValue({ sessions: [] });
  apiMock.createSession.mockResolvedValue({ session: { ...session, id: 'ses_new' } });
  apiMock.updateWorkspace.mockResolvedValue({ workspace });
  apiMock.marketplaces.list.mockResolvedValue({ marketplaces: [] });
  apiMock.marketplaces.catalogue.mockResolvedValue({ plugins: [] });
});

describe('a workspace that exists', () => {
  it('shows it, and counts what it remembers', async () => {
    renderWithProviders(<WorkspacePage />);
    expect(await screen.findByText('Alpha')).toBeDefined();
    // 1 + 2 + 3 across the three memory kinds.
    await waitFor(() => expect(screen.getByText('6')).toBeDefined());
  });

  it('remembers which workspace was last opened', async () => {
    renderWithProviders(<WorkspacePage />);
    await waitFor(() => expect(setLastWorkspace).toHaveBeenCalledWith('ws_a'));
  });

  it('creates nothing when there is already a session', async () => {
    renderWithProviders(<WorkspacePage />);
    await screen.findByText('Alpha');
    expect(apiMock.createSession).not.toHaveBeenCalled();
  });
});

describe('a workspace with no sessions yet', () => {
  it('opens one instead of showing an empty room', async () => {
    apiMock.workspace.mockResolvedValue({
      workspace,
      sessions: [],
      gitStatus: null,
      memoryStats: { episodic: 0, semantic: 0, procedural: 0 },
    });
    renderWithProviders(<WorkspacePage />);

    await waitFor(() => expect(apiMock.createSession).toHaveBeenCalledWith({ workspaceId: 'ws_a' }));
  });

  it('creates exactly one, however many times it re-renders', async () => {
    // The effect keys off "no sessions", which stays true until the refetch
    // lands. Without the pending/success guard every render would open
    // another empty session.
    apiMock.workspace.mockResolvedValue({
      workspace,
      sessions: [],
      gitStatus: null,
      memoryStats: { episodic: 0, semantic: 0, procedural: 0 },
    });
    const { rerender } = renderWithProviders(<WorkspacePage />);
    await waitFor(() => expect(apiMock.createSession).toHaveBeenCalled());

    rerender(<WorkspacePage />);
    rerender(<WorkspacePage />);
    await waitFor(() => expect(apiMock.createSession).toHaveBeenCalledTimes(1));
  });
});

describe('a workspace that cannot be loaded', () => {
  it('says so and offers a way out rather than a blank screen', async () => {
    apiMock.workspace.mockRejectedValue(new Error('gone'));
    renderWithProviders(<WorkspacePage />);

    expect(await screen.findByText('That workspace could not be loaded.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'All workspaces' })).toBeDefined();
  });
});

/**
 * The settings dialog is where a workspace says what its runs may do without
 * asking. Two things are guarded here.
 *
 * **The copy is translated at the render site.** `PERMISSION_MODE_INFO` lives
 * in `packages/shared`, so its twelve strings escape every i18n measure that
 * scans `apps/web` — the catalogue carries them, and the measures ask the
 * catalogue. Three render sites call `t()` on them and this file's two did
 * not, so the workspace's own mode chip and its mode picker stayed English on
 * a French screen. `LANGUAGE_INFO`, a table in this very file, had the same
 * hole.
 *
 * **The pre-approval says what it costs.** Ticking a tool here removes its
 * approval card, which is the point — but a switch that only advertises what
 * it buys is a switch nobody can consent to.
 */
describe('the workspace settings dialog', () => {
  async function openSettings(french = false): Promise<void> {
    if (french) await renderInFrench(<WorkspacePage />);
    else renderWithProviders(<WorkspacePage />);
    await screen.findByText('Alpha');
    fireEvent.click(
      screen.getByRole('button', { name: french ? 'Réglages du workspace' : 'Workspace settings' }),
    );
    await screen.findByRole('dialog');
  }

  /**
   * The server answers 409 to a change of the system workspace's permission
   * mode or tool lists. The dialog says so up front and locks those two
   * controls; everything else stays editable, because it is.
   */
  it('locks the fixed controls of the system workspace, and says why', async () => {
    apiMock.workspace.mockResolvedValue({
      workspace,
      isSystem: true,
      sessions: [session],
      gitStatus: null,
      memoryStats: { episodic: 0, semantic: 0, procedural: 0 },
    });
    await openSettings();

    expect(screen.getByRole('note').textContent).toMatch(/never gets a shell/);
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    const tools = within(screen.getByRole('group', { name: 'Pre-approved tools' }));
    const boxes = tools.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => box.disabled)).toBe(true);
    // Narrow, deliberately: the learning switches and the name stay the operator's.
    const learning = within(screen.getByRole('group', { name: 'Learning' }));
    expect((learning.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(false);
  });

  it('locks nothing on an ordinary workspace', async () => {
    await openSettings();

    expect(screen.queryByRole('note')).toBeNull();
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('translates the permission mode on the workspace card and in the picker', async () => {
    await openSettings(true);
    // 'Ask' is `PERMISSION_MODE_INFO.default.label`; the French catalogue
    // carries it. Swap either render site back to a bare read and this fails.
    expect(screen.getAllByText('Demander').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ask')).toBeNull();
  });

  it('translates the answer-language table it declares itself', async () => {
    await openSettings(true);
    expect(screen.getByText('Suivre la demande')).toBeDefined();
    expect(screen.queryByText('Follow the request')).toBeNull();
  });

  it('offers one switch per tool that can raise a prompt, and no others', async () => {
    await openSettings();
    const group = screen.getByRole('group', { name: /pre-approved tools/i });

    for (const tool of ['WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit']) {
      // Exact names: `/Edit/` also matches `NotebookEdit`, and a loose matcher
      // that happens to find two elements fails for a reason unrelated to the
      // property under test.
      expect(within(group).getByRole('checkbox', { name: tool })).toBeDefined();
    }
    // Read-only tools never prompt, so a switch for them would do nothing.
    expect(within(group).queryByRole('checkbox', { name: 'Read' })).toBeNull();
    expect(within(group).queryByRole('checkbox', { name: 'Grep' })).toBeNull();
  });

  it('says that ticking one removes its approval card, not only that it saves time', async () => {
    await openSettings();
    const group = screen.getByRole('group', { name: /pre-approved tools/i });
    expect(within(group).getByText(/approval card/i)).toBeDefined();
  });

  it('saves the tools that are ticked, and drops the ones that are not', async () => {
    await openSettings();
    const group = screen.getByRole('group', { name: /pre-approved tools/i });

    fireEvent.click(within(group).getByRole('checkbox', { name: 'WebSearch' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'WebFetch' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'WebFetch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.updateWorkspace).toHaveBeenCalled());
    const [, payload] = apiMock.updateWorkspace.mock.calls[0] as [
      string,
      { settings: { allowedTools: string[] } },
    ];
    expect(payload.settings.allowedTools).toEqual(['WebSearch']);
  });

  it('reflects what is already stored rather than starting blank', async () => {
    apiMock.workspace.mockResolvedValue({
      workspace: {
        ...workspace,
        settings: { ...workspace.settings, allowedTools: ['WebFetch'] },
      },
      sessions: [session],
      gitStatus: null,
      memoryStats: { episodic: 1, semantic: 2, procedural: 3 },
    });
    await openSettings();
    const group = screen.getByRole('group', { name: /pre-approved tools/i });

    // A native checkbox exposes `checked`, not `aria-checked` — asserting the
    // attribute would pass on `null` for both and prove nothing.
    expect(
      (within(group).getByRole('checkbox', { name: 'WebFetch' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(group).getByRole('checkbox', { name: 'WebSearch' }) as HTMLInputElement).checked,
    ).toBe(false);
  });
});
