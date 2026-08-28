/**
 * The transcript container.
 *
 * Its own logic is two things, and both are about not fighting the reader:
 * grouping events into exchanges, and following new output *only* while the
 * reader is already at the bottom. The children are stubbed — they have their
 * own tests, and rendering them here would test them instead of this.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run, TranscriptEvent } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { MessageStream } from './MessageStream';

vi.mock('./TranscriptItem', () => ({
  TranscriptItem: ({ event }: { event: TranscriptEvent }) => (
    <div data-testid="item" data-run={event.runId} />
  ),
  AssistantText: ({ text }: { text: string }) => <div data-testid="assistant">{text}</div>,
  ThinkingBlock: ({ text }: { text: string }) => <div data-testid="thinking">{text}</div>,
}));
vi.mock('./ApprovalCard', () => ({
  ApprovalCard: () => <div data-testid="approval" />,
}));
vi.mock('./RunGenesis', () => ({ RunGenesis: () => <div data-testid="genesis" /> }));
vi.mock('./Delegation', () => ({ DelegationStrip: () => null }));

const event = (id: string, runId: string, kind = 'assistant_message'): TranscriptEvent =>
  ({ id, runId, kind, at: 1, text: id }) as unknown as TranscriptEvent;

const run = (id: string): Run => ({ id, rating: null, rewindPoint: null }) as unknown as Run;

const base = {
  runs: [run('run_1'), run('run_2')],
  streaming: new Map(),
  approvals: [],
  isRunning: false,
  onRate: vi.fn(),
  onRewind: vi.fn(),
  onDecideApproval: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe('when there is nothing yet', () => {
  it('invites a first prompt instead of showing an empty column', () => {
    renderWithProviders(<MessageStream {...base} events={[]} />);
    expect(screen.getByText('Nothing here yet')).toBeDefined();
  });

  it('still says nothing-yet while a run is merely pending', () => {
    // `isRunning` with no events and no stream is the gap between submitting
    // and the first token; the empty state is what fills it.
    renderWithProviders(<MessageStream {...base} events={[]} isRunning />);
    expect(screen.getByText('Nothing here yet')).toBeDefined();
  });
});

describe('grouping into exchanges', () => {
  it('puts consecutive events from one run in a single exchange', () => {
    renderWithProviders(
      <MessageStream
        {...base}
        events={[event('e1', 'run_1'), event('e2', 'run_1'), event('e3', 'run_2')]}
      />,
    );
    const exchanges = screen.getAllByLabelText('Exchange');
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.querySelectorAll('[data-testid="item"]')).toHaveLength(2);
  });

  it('starts a new exchange when a run’s events resume after another’s', () => {
    // Chronology wins over identity: a transcript reads in the order things
    // happened, so the same run appearing twice is two exchanges.
    renderWithProviders(
      <MessageStream
        {...base}
        events={[event('e1', 'run_1'), event('e2', 'run_2'), event('e3', 'run_1')]}
      />,
    );
    expect(screen.getAllByLabelText('Exchange')).toHaveLength(3);
  });

  it('narrates the loop once, under the prompt that opened the run', () => {
    renderWithProviders(
      <MessageStream
        {...base}
        events={[event('e1', 'run_1', 'user_message'), event('e2', 'run_1')]}
      />,
    );
    expect(screen.getAllByTestId('genesis')).toHaveLength(1);
  });

  it('shows no genesis for an exchange that does not open with a prompt', () => {
    renderWithProviders(<MessageStream {...base} events={[event('e1', 'run_1')]} />);
    expect(screen.queryByTestId('genesis')).toBeNull();
  });
});

describe('what sits at the bottom', () => {
  it('puts pending approvals last, because they are what blocks progress', () => {
    renderWithProviders(
      <MessageStream
        {...base}
        events={[event('e1', 'run_1')]}
        approvals={[{ id: 'apr_1' }] as never}
      />,
    );
    expect(screen.getByTestId('approval')).toBeDefined();
  });

  it('shows a working indicator only when nothing else is arriving', () => {
    const { rerender } = renderWithProviders(
      <MessageStream {...base} events={[event('e1', 'run_1')]} isRunning />,
    );
    expect(screen.getByRole('status')).toBeDefined();

    // Once tokens arrive the indicator is noise beside them.
    rerender(
      <MessageStream
        {...base}
        events={[event('e1', 'run_1')]}
        isRunning
        streaming={new Map([['e2', { eventId: 'e2', channel: 'assistant', text: 'Bonjour' }]]) as never}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('assistant')).toBeDefined();
  });

  it('renders reasoning on its own channel', () => {
    renderWithProviders(
      <MessageStream
        {...base}
        events={[event('e1', 'run_1')]}
        streaming={new Map([['e2', { eventId: 'e2', channel: 'thinking', text: 'Hmm' }]]) as never}
      />,
    );
    expect(screen.getByTestId('thinking')).toBeDefined();
  });
});

describe('following the newest output', () => {
  it('offers a way back down only once the reader has scrolled away', () => {
    // jsdom performs no layout, so the scroll geometry is supplied here; the
    // component's rule is `distance > 120px means the reader left the bottom`.
    const { container } = renderWithProviders(
      <MessageStream {...base} events={[event('e1', 'run_1')]} />,
    );
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true });
    fireEvent.scroll(scroller);

    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeDefined();
  });

  it('hides it again when the reader returns to the bottom', () => {
    const { container } = renderWithProviders(
      <MessageStream {...base} events={[event('e1', 'run_1')]} />,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });

    Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true });
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeDefined();

    // Within the sticky threshold: 2000 − 1450 − 500 = 50px from the bottom.
    Object.defineProperty(scroller, 'scrollTop', { value: 1450, configurable: true });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });
});
