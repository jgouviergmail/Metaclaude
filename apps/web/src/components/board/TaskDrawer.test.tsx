/**
 * The drawer's agent affordance.
 *
 * Three states, mutually exclusive: an idle card offers "send to the agent",
 * a card with a live run says so and links the session instead of offering a
 * second run, and an archived card offers neither.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask, Run } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { TaskDrawer } from './TaskDrawer';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    task: vi.fn(),
    runTask: vi.fn(),
    updateTask: vi.fn(),
    commentTask: vi.fn(),
    createTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    deleteTask: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

const task = (over: Partial<BoardTask> = {}): BoardTask => ({
  id: 'tsk_1',
  workspaceId: 'ws_1',
  parentId: null,
  title: 'A task',
  description: '',
  status: 'todo',
  priority: 'normal',
  assignee: null,
  runId: null,
  dueAt: null,
  orderKey: 'i',
  blockedReason: null,
  createdBy: 'user:jules',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  ...over,
});

const run = (status: Run['status']): Run =>
  ({ id: 'run_1', sessionId: 'ses_1', workspaceId: 'ws_1', status }) as Run;

const detail = (over: Partial<Awaited<ReturnType<typeof apiMock.task>>> = {}) => ({
  task: task(),
  run: null,
  comments: [],
  activity: [],
  children: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TaskDrawer — the agent affordance', () => {
  it('offers to send an idle card, and sends it', async () => {
    apiMock.task.mockResolvedValue(detail());
    apiMock.runTask.mockResolvedValue({ run: run('queued'), task: task() });
    renderWithProviders(<TaskDrawer taskId="tsk_1" onClose={() => {}} />);

    const button = await screen.findByRole('button', { name: /send to the agent/i });
    fireEvent.click(button);
    await waitFor(() => expect(apiMock.runTask).toHaveBeenCalledWith('tsk_1'));
  });

  it('warns that assigning the agent on a review card hands the work back', async () => {
    // The server treats that assignment as "take this back" and starts the
    // agent; the menu must say so before the click, not surprise after it.
    apiMock.task.mockResolvedValue(detail({ task: task({ status: 'review', assignee: 'user' }) }));
    renderWithProviders(<TaskDrawer taskId="tsk_1" onClose={() => {}} />);

    // Radix opens its menu on pointerdown, which a bare click never fires.
    fireEvent.pointerDown(await screen.findByRole('button', { name: /you/i }));
    expect(await screen.findByText(/hands the card back/i)).toBeTruthy();
  });

  it('says the agent is on it and links the session while a run lives', async () => {
    apiMock.task.mockResolvedValue(
      detail({ task: task({ runId: 'run_1', status: 'in_progress', assignee: 'agent' }), run: run('running') }),
    );
    renderWithProviders(<TaskDrawer taskId="tsk_1" onClose={() => {}} />);

    expect(await screen.findByText(/the agent is working this card/i)).toBeDefined();
    const link = screen.getByRole('link', { name: /watch the session/i });
    expect(link.getAttribute('href')).toBe('/w/ws_1/s/ses_1');
    expect(screen.queryByRole('button', { name: /send to the agent/i })).toBeNull();
  });

  it('offers a re-send with the last session in reach once the run settled', async () => {
    apiMock.task.mockResolvedValue(
      detail({ task: task({ runId: 'run_1', status: 'review' }), run: run('succeeded') }),
    );
    renderWithProviders(<TaskDrawer taskId="tsk_1" onClose={() => {}} />);

    expect(await screen.findByRole('button', { name: /send back to the agent/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /last session/i }).getAttribute('href')).toBe(
      '/w/ws_1/s/ses_1',
    );
  });

  it('offers nothing on an archived card', async () => {
    apiMock.task.mockResolvedValue(detail({ task: task({ archivedAt: 123 }) }));
    renderWithProviders(<TaskDrawer taskId="tsk_1" onClose={() => {}} />);

    expect(await screen.findByText(/archived task/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /send.*agent/i })).toBeNull();
  });
});
