/**
 * The CLI-session import list.
 *
 * What matters here is the fork per row: a session Metaclaude already owns
 * must offer *Open* — never a second Adopt, which the server would refuse
 * with a 409 — and everything else offers Adopt. The rest is presentation.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeCliSession } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { CliSessionList } from './CliSessionList';

const cliSession = (over: Partial<ClaudeCliSession> = {}): ClaudeCliSession => ({
  sessionId: 'cli-1',
  summary: 'Refactor the parser',
  lastModified: Date.now() - 60_000,
  firstPrompt: 'refactor the parser to a pratt design',
  gitBranch: 'main',
  cwd: '/workspaces/alpha',
  createdAt: null,
  adoptedBy: null,
  ...over,
});

describe('CliSessionList', () => {
  it('offers Adopt for a session Metaclaude does not own, and reports the click', () => {
    const onAdopt = vi.fn();
    render(
      <CliSessionList
        sessions={[cliSession()]}
        adoptingId={null}
        onAdopt={onAdopt}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('Refactor the parser')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /adopt/i }));
    expect(onAdopt).toHaveBeenCalledWith('cli-1');
  });

  it('offers Open — not Adopt — for a session already adopted', () => {
    // Server-side the double adoption is a 409; the UI must not lead into it.
    const onOpen = vi.fn();
    render(
      <CliSessionList
        sessions={[cliSession({ adoptedBy: 'ses_9' })]}
        adoptingId={null}
        onAdopt={vi.fn()}
        onOpen={onOpen}
      />,
    );

    expect(screen.queryByRole('button', { name: /adopt/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(onOpen).toHaveBeenCalledWith('ses_9');
  });

  it('explains an empty listing instead of rendering nothing', () => {
    render(
      <CliSessionList sessions={[]} adoptingId={null} onAdopt={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.getByText(/no cli sessions/i)).toBeDefined();
  });
});
