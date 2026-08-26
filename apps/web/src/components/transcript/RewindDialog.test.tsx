/**
 * The dialog between an operator and overwriting their working tree.
 *
 * Rewinding is the most destructive thing the UI can ask for, and the
 * information that makes it safe to confirm — how many files, which ones, what
 * the CLI refused to touch — only exists in the preview. So the contract worth
 * pinning is not "the modal opens": it is that confirming is impossible before
 * the preview arrives, that a refusal is shown in the CLI's own words instead
 * of a generic failure, and that a partial restore never reads as a complete
 * one.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RewindResult } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { RewindDialog } from './RewindDialog';

const preview = (over: Partial<RewindResult> = {}): RewindResult => ({
  canRewind: true,
  error: null,
  filesChanged: ['src/parser.ts', 'src/lexer.ts'],
  insertions: 12,
  deletions: 40,
  skippedLinks: 0,
  applied: false,
  ...over,
});

function setup(over: { onPreview?: () => Promise<RewindResult>; onApply?: () => Promise<RewindResult> } = {}) {
  const onPreview = over.onPreview ?? vi.fn().mockResolvedValue(preview());
  const onApply = over.onApply ?? vi.fn().mockResolvedValue(preview({ applied: true }));
  const onOpenChange = vi.fn();
  render(
    <RewindDialog open onOpenChange={onOpenChange} onPreview={onPreview} onApply={onApply} />,
  );
  return { onPreview, onApply, onOpenChange };
}

describe('RewindDialog', () => {
  it('previews as soon as it opens, without touching anything', async () => {
    const { onPreview, onApply } = setup();

    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows what would be restored', async () => {
    setup();

    expect(await screen.findByText('src/parser.ts')).toBeTruthy();
    expect(screen.getByText('src/lexer.ts')).toBeTruthy();
  });

  it('cannot be confirmed until the preview has arrived', async () => {
    // Confirming against an unknown blast radius is the whole thing this
    // dialog exists to prevent.
    let release!: (value: RewindResult) => void;
    setup({ onPreview: () => new Promise<RewindResult>((resolve) => (release = resolve)) });

    const confirm = await screen.findByRole('button', { name: /restore/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    release(preview());
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  });

  it('restores only when the operator confirms', async () => {
    const { onApply } = setup();

    const confirm = await screen.findByRole('button', { name: /restore/i });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(confirm);

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });

  it('repeats the CLI’s refusal rather than a generic failure', async () => {
    // "Could not rewind" tells the operator nothing they can act on. The CLI's
    // own sentence usually names the cause.
    setup({
      onPreview: vi
        .fn()
        .mockResolvedValue(
          preview({ canRewind: false, error: 'No checkpoints found for this session.' }),
        ),
    });

    expect(await screen.findByText('No checkpoints found for this session.')).toBeTruthy();
  });

  it('offers no confirm button at all when the rewind is impossible', async () => {
    setup({ onPreview: vi.fn().mockResolvedValue(preview({ canRewind: false, error: 'nope' })) });

    await screen.findByText('nope');
    expect(screen.queryByRole('button', { name: /restore/i })).toBeNull();
  });

  it('says when a run changed nothing, instead of showing an empty list', async () => {
    setup({ onPreview: vi.fn().mockResolvedValue(preview({ filesChanged: [], insertions: 0, deletions: 0 })) });

    expect(await screen.findByText(/no file changes/i)).toBeTruthy();
  });

  it('does not claim success when the restore itself was refused', async () => {
    // The preview can succeed and the real thing still fail — the session can
    // go away in between. Reporting "restored 2 files" then would be the worst
    // possible lie: the operator stops looking for their changes.
    setup({
      onApply: vi
        .fn()
        .mockResolvedValue(preview({ canRewind: false, error: 'The session has expired.' })),
    });

    const confirm = await screen.findByRole('button', { name: /restore/i });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(confirm);

    expect(await screen.findByText('The session has expired.')).toBeTruthy();
    expect(screen.queryByText(/restored 2 files/i)).toBeNull();
  });

  it('surfaces a request that failed outright', async () => {
    // A rejected promise used to leave the dialog looking idle: the button
    // re-enabled, nothing said, and no way to tell whether the files had been
    // touched.
    setup({ onApply: vi.fn().mockRejectedValue(new Error('Network request failed')) });

    const confirm = await screen.findByRole('button', { name: /restore/i });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(confirm);

    expect(await screen.findByText(/network request failed/i)).toBeTruthy();
  });

  it('reports a partial restore as partial', async () => {
    // A restore that skipped files but reads as complete is how an operator
    // walks away believing their tree is clean when it is not.
    const { onApply } = setup({
      onApply: vi.fn().mockResolvedValue(preview({ applied: true, skippedLinks: 2 })),
    });

    const confirm = await screen.findByRole('button', { name: /restore/i });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(confirm);

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(await screen.findByText(/2 file/i)).toBeTruthy();
  });
});
