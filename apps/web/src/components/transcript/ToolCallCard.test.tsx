/**
 * The tool-call card.
 *
 * A tool call reaches the client twice under one event id: once as `running`
 * when the `tool_use` block arrives, and once again when the result comes back.
 * The store maps the second into the same slot and the stream keys on the id,
 * so this component re-renders rather than remounting — which is what made a
 * `useState` initialiser the wrong place to decide whether a failure is open.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { ToolCallCard } from './ToolCallCard';

type ToolCall = Extract<TranscriptEvent, { kind: 'tool_call' }>;

const call = (over: Partial<ToolCall> = {}): ToolCall =>
  ({
    kind: 'tool_call',
    id: 'ev_1',
    runId: 'run_1',
    seq: 0,
    at: 1_000,
    toolUseId: 'tu_1',
    name: 'Bash',
    input: { command: 'pnpm test:run' },
    status: 'running',
    result: null,
    resultIsError: false,
    durationMs: null,
    ...over,
  }) as ToolCall;

describe('ToolCallCard', () => {
  it('stays collapsed for a call that is merely running', () => {
    // The command itself appears in the collapsed header summary too, so the
    // "Input" section heading is what distinguishes open from closed.
    render(<ToolCallCard call={call()} />);
    expect(screen.queryByText('Input')).toBeNull();
  });

  it('opens a call that already failed', () => {
    render(
      <ToolCallCard
        call={call({ status: 'error', resultIsError: true, result: 'command not found' })}
      />,
    );
    expect(screen.getByText('command not found')).toBeDefined();
  });

  it('opens when a running call turns into a failure under the same id', () => {
    // The regression: this is a re-render, not a remount, so anything decided
    // in a `useState` initialiser was decided while `resultIsError` was false.
    const { rerender } = render(<ToolCallCard call={call()} />);
    expect(screen.queryByText('command not found')).toBeNull();

    rerender(
      <ToolCallCard
        call={call({ status: 'error', resultIsError: true, result: 'command not found' })}
      />,
    );
    expect(screen.getByText('command not found')).toBeDefined();
  });

  it('respects the expand-tool-calls preference on a re-render, not just on mount', () => {
    // Toggling the preference in the user menu used to change nothing already
    // on screen, for the same reason: it only fed the dead mount initialiser.
    const { rerender } = render(<ToolCallCard call={call()} defaultExpanded={false} />);
    expect(screen.queryByText('Input')).toBeNull();

    rerender(<ToolCallCard call={call()} defaultExpanded />);
    expect(screen.getByText('Input')).toBeDefined();
  });

  it('keeps a deliberate collapse of a failed call', () => {
    // Derivation must not override the operator: having closed it, it stays
    // closed through the re-renders that follow.
    const failed = call({ status: 'error', resultIsError: true, result: 'command not found' });
    const { rerender } = render(<ToolCallCard call={failed} />);
    expect(screen.getByText('command not found')).toBeDefined();

    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.queryByText('command not found')).toBeNull();

    rerender(<ToolCallCard call={{ ...failed, durationMs: 42 }} />);
    expect(screen.queryByText('command not found')).toBeNull();
  });
});
