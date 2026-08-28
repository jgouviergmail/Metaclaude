/**
 * Source control in the workspace sidebar.
 *
 * The rule that keeps this honest is `canCommit`: a commit needs a message
 * *and* something staged. Either half alone produces a git error the operator
 * has to go read, so the button says no first — and the two halves are easy
 * to get wrong independently, which is exactly why they are pinned here.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { GitPanel } from './GitPanel';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    gitStatus: vi.fn(),
    gitLog: vi.fn(),
    gitDiff: vi.fn(),
    gitStage: vi.fn(),
    gitUnstage: vi.fn(),
    gitCommit: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// `isRepo` gates the whole panel — omitting it renders the unavailable
// state, which is the component reading its contract correctly.
const status = (over: Record<string, unknown> = {}) => ({
  isRepo: true,
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: [],
  modified: [],
  untracked: [],
  conflicted: [],
  ...over,
});

const panel = (onClose = vi.fn()) =>
  renderWithProviders(<GitPanel workspaceId="ws_a" onClose={onClose} />);

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.gitStatus.mockResolvedValue(status());
  apiMock.gitLog.mockResolvedValue({ commits: [] });
  apiMock.gitDiff.mockResolvedValue({ diff: '', files: [] });
  apiMock.gitStage.mockResolvedValue({});
  apiMock.gitUnstage.mockResolvedValue({});
  apiMock.gitCommit.mockResolvedValue({});
});

describe('when git is not available', () => {
  it('says so instead of rendering an empty panel', async () => {
    apiMock.gitStatus.mockRejectedValue(new Error('not a repository'));
    panel();
    expect(await screen.findByText('Git status is unavailable')).toBeDefined();
  });
});

describe('the working tree', () => {
  it('shows what is staged and what is not, under their own headings', async () => {
    apiMock.gitStatus.mockResolvedValue(
      status({ staged: ['src/a.ts'], modified: ['src/b.ts'], untracked: ['src/c.ts'] }),
    );
    panel();

    expect(await screen.findByText('Staged')).toBeDefined();
    expect(screen.getByText('Modified')).toBeDefined();
    expect(screen.getByText('Untracked')).toBeDefined();
  });

  it('counts how far the branch has drifted from its remote', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ ahead: 3, behind: 2 }));
    panel();
    expect(await screen.findByLabelText('3 commits ahead')).toBeDefined();
    expect(screen.getByLabelText('2 commits behind')).toBeDefined();
  });

  it('stages everything unstaged in one call, conflicts included', async () => {
    // "Stage all" means the whole unstaged set — modified, untracked and
    // conflicted — not just the modified list.
    apiMock.gitStatus.mockResolvedValue(
      status({ modified: ['a'], untracked: ['b'], conflicted: ['c'] }),
    );
    panel();

    fireEvent.click(await screen.findByRole('button', { name: /Stage all/ }));
    await waitFor(() => expect(apiMock.gitStage).toHaveBeenCalledWith('ws_a', ['a', 'b', 'c']));
  });
});

describe('committing', () => {
  it('refuses with a message but nothing staged', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ modified: ['a'] }));
    panel();

    fireEvent.change(await screen.findByLabelText('Commit message'), {
      target: { value: 'Corrige le bail' },
    });
    expect(screen.getByRole('button', { name: /Commit/ })).toHaveProperty('disabled', true);
  });

  it('refuses with something staged but no message', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ staged: ['a'] }));
    panel();
    await screen.findByText('Staged');
    expect(screen.getByRole('button', { name: /Commit/ })).toHaveProperty('disabled', true);
  });

  it('refuses a message that is only whitespace', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ staged: ['a'] }));
    panel();

    fireEvent.change(await screen.findByLabelText('Commit message'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /Commit/ })).toHaveProperty('disabled', true);
  });

  it('commits the trimmed message once both halves are there', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ staged: ['a'] }));
    panel();

    fireEvent.change(await screen.findByLabelText('Commit message'), {
      target: { value: '  Corrige le bail  ' },
    });
    const button = screen.getByRole('button', { name: /Commit/ });
    expect(button).toHaveProperty('disabled', false);

    fireEvent.click(button);
    await waitFor(() => expect(apiMock.gitCommit).toHaveBeenCalledWith('ws_a', 'Corrige le bail'));
  });

  it('says how many files are staged', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ staged: ['a', 'b'] }));
    panel();
    expect(await screen.findByText('2 staged')).toBeDefined();
  });
});

describe('the panel itself', () => {
  it('closes on demand', async () => {
    const onClose = vi.fn();
    panel(onClose);
    fireEvent.click(await screen.findByRole('button', { name: 'Close source control' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('asks for nothing it does not need: no diff until a file is chosen', async () => {
    apiMock.gitStatus.mockResolvedValue(status({ modified: ['a'] }));
    panel();
    await screen.findByText('Modified');
    expect(apiMock.gitDiff).not.toHaveBeenCalledWith('ws_a', expect.anything());
  });
});
