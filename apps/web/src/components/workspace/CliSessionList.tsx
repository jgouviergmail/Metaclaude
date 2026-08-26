/**
 * The Claude CLI's own sessions for this workspace's directory, offered for
 * adoption — including ones that never went through Metaclaude, such as a
 * conversation held in a terminal on this machine.
 *
 * Prop-driven: the page owns the query and the mutation. Each row forks on
 * ownership — a session Metaclaude already holds offers *Open*, everything
 * else offers *Adopt* — so the UI cannot lead into the server's 409.
 */

import { GitBranch, TerminalSquare } from 'lucide-react';
import type { ClaudeCliSession } from '@metaclaude/shared';
import { Badge, Button, EmptyState } from '@/components/ui/primitives';
import { formatRelative } from '@/lib/utils';

export function CliSessionList({
  sessions,
  adoptingId,
  onAdopt,
  onOpen,
}: {
  sessions: ClaudeCliSession[];
  /** The CLI session id currently being adopted, to pin its button's spinner. */
  adoptingId: string | null;
  onAdopt: (claudeSessionId: string) => void;
  onOpen: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<TerminalSquare />}
        title="No CLI sessions here"
        description="Conversations started with the claude command in this directory will appear here."
      />
    );
  }

  return (
    <ul className="divide-y divide-[var(--mc-border)]">
      {sessions.map((session) => (
        <li key={session.sessionId} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-ink">{session.summary}</p>
            <p className="flex items-center gap-2 text-[11.5px] text-subtle">
              <span>{formatRelative(session.lastModified)}</span>
              {session.gitBranch ? (
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3" aria-hidden />
                  {session.gitBranch}
                </span>
              ) : null}
            </p>
            {session.firstPrompt ? (
              <p className="mt-0.5 truncate text-[12px] text-muted">{session.firstPrompt}</p>
            ) : null}
          </div>
          {session.adoptedBy ? (
            <>
              <Badge tone="accent">adopted</Badge>
              <Button variant="secondary" size="sm" onClick={() => onOpen(session.adoptedBy!)}>
                Open
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={adoptingId === session.sessionId}
              onClick={() => onAdopt(session.sessionId)}
            >
              Adopt
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
