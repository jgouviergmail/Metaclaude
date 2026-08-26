/**
 * The transcript's out-of-band notes.
 *
 * These are what the CLI says about itself — a retry, a compaction, a
 * subscription limit — and until this lot they were dropped before ever
 * reaching a screen. What the rendering has to get right is the part that turns
 * a note into an action: a limit the operator has hit is only useful alongside
 * the time it lifts, and a note that quietly rendered `1970` for that would be
 * worse than one that said nothing.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { SystemNote } from './TranscriptItem';

const note = (over: Partial<Extract<TranscriptEvent, { kind: 'system' }>> = {}) =>
  ({
    kind: 'system',
    id: 'ev_1',
    runId: 'run_1',
    seq: 0,
    at: 1_000,
    level: 'info',
    message: 'Something happened.',
    ...over,
  }) as Extract<TranscriptEvent, { kind: 'system' }>;

describe('SystemNote', () => {
  it('shows the message', () => {
    render(<SystemNote event={note({ message: 'The conversation was compacted (auto).' })} />);
    expect(screen.getByText('The conversation was compacted (auto).')).toBeTruthy();
  });

  it('marks an error as an alert so it is not read as commentary', () => {
    // A subscription limit and a failed login both arrive this way. They are
    // not asides; they are the reason nothing else is going to work.
    render(<SystemNote event={note({ level: 'error', message: 'Your weekly limit is reached.' })} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('does not shout about an ordinary note', () => {
    render(<SystemNote event={note({ level: 'info' })} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when a rate limit lifts', () => {
    // The single most actionable fact when a limit bites: wait, or stop.
    const now = 1_800_000_000_000;
    render(
      <SystemNote
        event={note({
          level: 'error',
          message: 'Your five-hour limit is reached.',
          data: { resetsAt: now + 2 * 3_600_000 + 14 * 60_000 },
        })}
        now={now}
      />,
    );

    expect(screen.getByText(/resets in 2h 14m/i)).toBeTruthy();
  });

  it('says nothing about a reset that has already passed', () => {
    // A stale note must not offer "resets in -3h".
    const now = 1_800_000_000_000;
    render(<SystemNote event={note({ level: 'error', data: { resetsAt: now - 60_000 } })} now={now} />);

    expect(screen.queryByText(/resets in/i)).toBeNull();
  });

  it('ignores a data payload that carries no reset time', () => {
    // Most notes carry `data` for other reasons — token counts, model names.
    render(<SystemNote event={note({ data: { preTokens: 152_000 } })} />);
    expect(screen.queryByText(/resets in/i)).toBeNull();
  });

  it('is unbothered by a malformed reset time', () => {
    // `data` is `z.unknown()` on the wire, so this is reachable.
    render(<SystemNote event={note({ data: { resetsAt: 'soon' } })} />);
    expect(screen.queryByText(/resets in/i)).toBeNull();
  });
});
