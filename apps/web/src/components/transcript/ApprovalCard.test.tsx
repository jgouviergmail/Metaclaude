/**
 * The permission prompt.
 *
 * This is the one component in the app whose job is to stop something from
 * happening, and it had no tests at all — not here, and not in the Playwright
 * pass, which never mentions an approval. Three of the four behaviours below
 * have no server-side backstop whatsoever: the keyboard scoping, the focus
 * order, and clearing the submitting state. A listener moved back to `window`
 * would silently mass-approve every pending prompt, and nothing in the
 * repository would have noticed.
 *
 * The fourth — withholding "remember" on a high-risk call — *is* enforced
 * again in the broker, and is covered there. It is asserted here anyway,
 * because the UI making a promise the server happens to keep is not the same
 * as the UI keeping it.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { ApprovalCard } from './ApprovalCard';

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'apr_1',
  runId: 'run_1',
  sessionId: 'ses_1',
  workspaceId: 'ws_1',
  toolUseId: 'tu_1',
  toolName: 'Bash',
  input: { command: 'rm -rf build/' },
  summary: 'Bash: rm -rf build/',
  risk: 'medium',
  reason: null,
  createdAt: 1_000,
  expiresAt: Date.now() + 600_000,
  ...over,
});

describe('ApprovalCard', () => {
  it('shows the command verbatim rather than the summary', () => {
    // The whole point of the card: what is rendered is the literal string that
    // will run, not a paraphrase of it. A summary you cannot verify is worse
    // than no summary, so when there is a command the summary is not what the
    // operator reads.
    render(<ApprovalCard request={request()} onDecide={vi.fn()} />);
    expect(screen.getByText('rm -rf build/')).toBeDefined();
  });

  it('falls back to the summary and the raw input when there is no command', () => {
    render(
      <ApprovalCard
        request={request({ toolName: 'Grep', input: { pattern: 'TODO' }, summary: 'Grep: TODO' })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('Grep: TODO')).toBeDefined();
    expect(screen.getByText(/pattern/)).toBeDefined();
  });

  it('leaves initial focus on Deny, the safe choice', () => {
    // `autoFocus` puts it there, and the card's own focus effect used to
    // override it a tick later — so a reflexive Enter landed on a container
    // that does not handle Enter, and the file's own comment about Deny
    // holding focus described behaviour it did not have.
    render(<ApprovalCard request={request()} onDecide={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Deny/ }));
  });

  it('does not steal focus from a prompt the operator is already looking at', () => {
    // Multiple prompts can be pending at once — the broker keeps a map and the
    // stream maps over an array. The second card's mount effect used to pull
    // focus off the first, invisibly (`preventScroll: true`), so a ⌘Enter
    // meant for one prompt approved another.
    render(<ApprovalCard request={request({ id: 'apr_1' })} onDecide={vi.fn()} />);
    const first = document.activeElement;
    expect(first).not.toBe(document.body);

    render(<ApprovalCard request={request({ id: 'apr_2', summary: 'Bash: second' })} onDecide={vi.fn()} />);
    expect(document.activeElement).toBe(first);
  });

  it('withholds the remember checkbox on a high-risk call', () => {
    const { unmount } = render(<ApprovalCard request={request()} onDecide={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeDefined();
    unmount();

    render(<ApprovalCard request={request({ risk: 'high' })} onDecide={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('never reports remember on a high-risk call, even if one were somehow ticked', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request({ risk: 'high' })} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onDecide).toHaveBeenCalledWith(true, false);
  });

  it('passes the remember choice through on a lower-risk call', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onDecide).toHaveBeenCalledWith(true, true);
  });

  it('binds its accelerators to the card, not to the window', () => {
    // The regression this guards is recorded in the component: with the
    // listener on `window`, every mounted card had one, so a single ⌘Enter
    // approved *all* pending prompts — and ⌘Enter is also how the composer
    // sends a message, so typing while a prompt was open authorised the tool.
    const onDecide = vi.fn();
    render(<ApprovalCard request={request()} onDecide={onDecide} />);

    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Enter', metaKey: true });
    expect(onDecide).toHaveBeenCalledWith(true, false);
  });

  it('denies on Escape, and only from inside the card', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request()} onDecide={onDecide} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onDecide).toHaveBeenCalledWith(false, false);
  });

  it('re-enables the buttons when the decision could not be delivered', async () => {
    // Nothing else clears `submitting`: the card expects to disappear when the
    // server confirms. A decision sent over a socket that was not open is
    // dropped with no error, so without this the operator is left holding a
    // card they can no longer act on — until the server's own ten-minute
    // timeout denies the tool for them.
    const onDecide = vi.fn().mockRejectedValue(new Error('offline'));
    render(<ApprovalCard request={request()} onDecide={onDecide} />);

    const allow = screen.getByRole('button', { name: /Allow/ });
    fireEvent.click(allow);
    expect(allow.hasAttribute('disabled')).toBe(true);

    await vi.waitFor(() => expect(allow.hasAttribute('disabled')).toBe(false));
  });

  it('keeps the buttons disabled while the decision is in flight', async () => {
    // The other direction: a decision that is merely slow must not be
    // re-submittable, or one tap becomes two approvals.
    let settle: () => void = () => undefined;
    const onDecide = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    render(<ApprovalCard request={request()} onDecide={onDecide} />);

    const allow = screen.getByRole('button', { name: /Allow/ });
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(allow.hasAttribute('disabled')).toBe(true);

    settle();
    await Promise.resolve();
    expect(allow.hasAttribute('disabled')).toBe(true);
  });
});
