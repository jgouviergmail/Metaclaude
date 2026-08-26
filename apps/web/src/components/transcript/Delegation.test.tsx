/**
 * What a run delegated, and how it went.
 *
 * The transcript recorded subagent events with a `status` field and then never
 * rendered it, so a subagent that failed looked exactly like one that
 * succeeded — and since a subagent's own output is summarised rather than
 * streamed, that failure was invisible in a run that otherwise looked fine.
 *
 * The events are also scattered through the transcript wherever the delegation
 * happened, which answers "what happened next" and never "what did this run
 * farm out". The strip answers the second question in one line.
 */

import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { DelegationStrip, SubagentEvent } from './Delegation';

type Subagent = Extract<TranscriptEvent, { kind: 'subagent' }>;

const subagent = (over: Partial<Subagent> = {}): Subagent =>
  ({
    kind: 'subagent',
    id: 'ev_1',
    runId: 'run_1',
    seq: 0,
    at: 1_000,
    agentName: 'explorer',
    description: 'Map the parser',
    status: 'ok',
    summary: null,
    ...over,
  }) as Subagent;

describe('SubagentEvent', () => {
  it('shows a failure as a failure', () => {
    // The defect this fixes: `status` was recorded and never rendered, so a
    // subagent that died looked identical to one that worked — in a run whose
    // own result was still a success.
    render(<SubagentEvent event={subagent({ status: 'error' })} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/failed/i)).toBeTruthy();
  });

  it('marks one still working as still working', () => {
    render(<SubagentEvent event={subagent({ status: 'running' })} />);

    expect(screen.getByText(/running|working/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not shout about one that succeeded', () => {
    render(<SubagentEvent event={subagent({ status: 'ok' })} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows what it was asked to do, and what it reported back', () => {
    render(
      <SubagentEvent
        event={subagent({ description: 'Map the parser', summary: 'Found three entry points.' })}
      />,
    );

    expect(screen.getByText('Map the parser')).toBeTruthy();
    expect(screen.getByText('Found three entry points.')).toBeTruthy();
  });
});

describe('DelegationStrip', () => {
  it('renders nothing when the run delegated nothing', () => {
    // Most runs do not delegate. An empty strip on every one of them is a line
    // of chrome that has to be scanned past to reach the answer.
    const { container } = render(<DelegationStrip events={[]} />);

    expect(container.textContent).toBe('');
  });

  it('names each subagent the run used', () => {
    render(
      <DelegationStrip
        events={[
          subagent({ id: 'a', agentName: 'explorer' }),
          subagent({ id: 'b', agentName: 'reviewer' }),
        ]}
      />,
    );

    expect(screen.getByText('explorer')).toBeTruthy();
    expect(screen.getByText('reviewer')).toBeTruthy();
  });

  it('counts repeats rather than listing the same name twice', () => {
    // A fan-out of eight explorers is one fact, not eight — and eight identical
    // chips is a strip nobody can read.
    render(
      <DelegationStrip
        events={[
          subagent({ id: 'a', agentName: 'explorer' }),
          subagent({ id: 'b', agentName: 'explorer' }),
          subagent({ id: 'c', agentName: 'explorer' }),
        ]}
      />,
    );

    expect(screen.getAllByText('explorer')).toHaveLength(1);
    expect(screen.getByText('×3')).toBeTruthy();
  });

  it('reports the worst status of a repeated agent, not the last', () => {
    // Seven of eight succeeding is not a success. Taking the last one would
    // report whichever finished last, which is arbitrary.
    render(
      <DelegationStrip
        events={[
          subagent({ id: 'a', agentName: 'explorer', status: 'error' }),
          subagent({ id: 'b', agentName: 'explorer', status: 'ok' }),
        ]}
      />,
    );

    expect(within(screen.getByTestId('delegation-explorer')).getByText(/failed/i)).toBeTruthy();
  });

  it('treats still-running as more urgent than done, but less than failed', () => {
    render(
      <DelegationStrip
        events={[
          subagent({ id: 'a', agentName: 'explorer', status: 'ok' }),
          subagent({ id: 'b', agentName: 'explorer', status: 'running' }),
        ]}
      />,
    );

    expect(within(screen.getByTestId('delegation-explorer')).getByText(/running/i)).toBeTruthy();
  });

  it('ignores events that are not delegations', () => {
    const other = { kind: 'assistant_text', id: 'x', runId: 'run_1', seq: 1, at: 1, text: 'hi' };
    render(<DelegationStrip events={[other as TranscriptEvent, subagent({ agentName: 'explorer' })]} />);

    expect(screen.getByText('explorer')).toBeTruthy();
    expect(screen.queryByText('hi')).toBeNull();
  });
});
