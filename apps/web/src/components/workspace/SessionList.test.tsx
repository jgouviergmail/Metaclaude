/**
 * The workspace sidebar's session list.
 *
 * The server sends the list already sorted — pinned first, then activity — and
 * the header comment promises this component never reorders it, so that a pin
 * does not make rows jump before the refetch confirms it. That promise is only
 * worth having if something checks it.
 *
 * The other load-bearing behaviour is navigation on removal: archiving or
 * deleting the session you are *looking at* must move you somewhere that still
 * exists, or the transcript points at something the sidebar no longer offers.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { SessionList } from './SessionList';

const { apiMock, navigate } = vi.hoisted(() => ({
  apiMock: { updateSession: vi.fn(), deleteSession: vi.fn() },
  navigate: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
}));

const session = (id: string, title: string, extra: Partial<Session> = {}): Session =>
  ({
    id,
    workspaceId: 'ws_a',
    title,
    pinned: false,
    archived: false,
    status: 'idle',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    ...extra,
  }) as Session;

const list = (sessions: Session[], activeSessionId = 'ses_1') =>
  renderWithProviders(
    <SessionList
      workspaceId="ws_a"
      activeSessionId={activeSessionId}
      sessions={sessions}
      onCreate={vi.fn()}
      creating={false}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.updateSession.mockResolvedValue({});
  apiMock.deleteSession.mockResolvedValue({ ok: true });
});

describe('the list', () => {
  it('invites a first session when there are none', () => {
    list([]);
    expect(screen.getByText('No sessions yet')).toBeDefined();
  });

  it('names an untitled session rather than showing a blank row', () => {
    list([session('ses_1', '')]);
    expect(screen.getByText('New session')).toBeDefined();
  });

  it('renders in the order it was given, never its own', () => {
    // The server sorts; re-sorting here would make a pin move a row before
    // the refetch confirmed it, which reads as the app guessing.
    const given = [
      session('ses_1', 'Zèbre', { pinned: true }),
      session('ses_2', 'Alpha'),
      session('ses_3', 'Bail'),
    ];
    const { container } = list(given);
    const titles = [...container.querySelectorAll('nav a')].map((a) =>
      a.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(titles[0]).toContain('Zèbre');
    expect(titles[1]).toContain('Alpha');
    expect(titles[2]).toContain('Bail');
  });

  it('counts what it holds', () => {
    list([session('ses_1', 'A'), session('ses_2', 'B')]);
    expect(screen.getByText('2')).toBeDefined();
  });
});

describe('filtering', () => {
  const many = Array.from({ length: 6 }, (_, i) => session(`ses_${i + 1}`, `Session ${i + 1}`));

  it('stays out of the way until there is enough to sift', () => {
    list([session('ses_1', 'A')]);
    expect(screen.queryByLabelText('Filter sessions')).toBeNull();
  });

  it('appears once the list is long enough to need it', () => {
    list(many);
    expect(screen.getByLabelText('Filter sessions')).toBeDefined();
  });

  it('narrows by title', () => {
    list(many);
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'Session 3' } });
    expect(screen.getByText('Session 3')).toBeDefined();
    expect(screen.queryByText('Session 4')).toBeNull();
  });

  it('says what it looked for when nothing matches', () => {
    list(many);
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No session matches/)).toBeDefined();
    expect(screen.getByText(/zzz/)).toBeDefined();
  });
});

describe('removing the session you are looking at', () => {
  it('leaves for the workspace when the active session is archived', async () => {
    // Staying would leave the transcript pointing at something the sidebar no
    // longer lists.
    list([session('ses_1', 'Bail')], 'ses_1');

    const trigger = screen.getByRole('button', { name: /Bail/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Archive/i }));

    await waitFor(() => expect(apiMock.updateSession).toHaveBeenCalledWith('ses_1', { archived: true }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/ws_a'));
  });

  it('stays put when a different session is archived', async () => {
    list([session('ses_1', 'Bail'), session('ses_2', 'Autre')], 'ses_1');

    const trigger = screen.getByRole('button', { name: /Autre/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Archive/i }));

    await waitFor(() => expect(apiMock.updateSession).toHaveBeenCalledWith('ses_2', { archived: true }));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('pinning', () => {
  it('asks for the opposite of what the row currently is', async () => {
    list([session('ses_1', 'Bail', { pinned: true })]);

    const trigger = screen.getByRole('button', { name: /Bail/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Unpin|Pin/i }));

    await waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('ses_1', { pinned: false }),
    );
  });
});

describe('deleting', () => {
  it('names the session in the confirmation, and only then deletes', async () => {
    list([session('ses_1', 'Bail — 12 rue des Lilas')], 'ses_1');

    const trigger = screen.getByRole('button', { name: /Bail/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));

    expect(apiMock.deleteSession).not.toHaveBeenCalled();
    // Scoped to the dialog: the row behind it carries the same title, and a
    // confirmation that did *not* name the session would still match there.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Bail — 12 rue des Lilas');
    expect(dialog.textContent).toContain('Files in the workspace are untouched');

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    await waitFor(() => expect(apiMock.deleteSession).toHaveBeenCalledWith('ses_1'));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/w/ws_a', { replace: true }),
    );
  });
});
