/**
 * Waiting for MCP servers to stop connecting.
 *
 * MCP startup is non-blocking by design, so the catalogue probe used to take a
 * snapshot mid-connection and report it: measured against a server that takes
 * four seconds, the probe answered in 1.2 s with `pending` and zero tools. From
 * the operator's side that was a Test button saying "still connecting" however
 * many times it was pressed — every press asked just as early as the last one.
 *
 * The two properties worth pinning are opposites: it must wait long enough to
 * turn a slow server into a real answer, and it must refuse to wait forever for
 * one that never arrives. The second is the reason the deadline exists at all.
 */

import { describe, expect, it } from 'vitest';
import { settleMcpStatus } from './supervisor.js';

type Status = Awaited<ReturnType<typeof settleMcpStatus>>[number];

const server = (status: Status['status'], tools: Status['tools'] = []): Status =>
  ({ name: 'one', status, tools }) as Status;

/** A clock and a sleep that move together, so nothing actually waits. */
function fakeClock() {
  let at = 1_000_000;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
    get elapsed() {
      return at - 1_000_000;
    },
  };
}

describe('settleMcpStatus', () => {
  it('answers immediately when nothing is pending', async () => {
    const clock = fakeClock();
    let reads = 0;
    const status = await settleMcpStatus(
      async () => {
        reads += 1;
        return [server('connected')];
      },
      clock,
    );

    expect(reads).toBe(1);
    expect(clock.elapsed).toBe(0);
    expect(status[0]?.status).toBe('connected');
  });

  /** The case the operator hit: slow, not broken. */
  it('waits for a pending server and reports what it became', async () => {
    const clock = fakeClock();
    let reads = 0;
    const status = await settleMcpStatus(
      async () => {
        reads += 1;
        // Connects on the fourth ask, roughly a second in at a 300 ms poll.
        return [reads < 4 ? server('pending') : server('connected', [{ name: 'a' } as never])];
      },
      { ...clock, pollMs: 300 },
    );

    expect(status[0]?.status).toBe('connected');
    expect(status[0]?.tools).toHaveLength(1);
    expect(reads).toBe(4);
  });

  /**
   * The deadline is what makes waiting safe rather than optimistic. A server
   * that never connects is not a reason to hang: `pending` is the truth about
   * it, and the caller has a sentence for that.
   */
  it('gives up at the deadline and returns the pending truth', async () => {
    const clock = fakeClock();
    let reads = 0;
    const status = await settleMcpStatus(
      async () => {
        reads += 1;
        return [server('pending')];
      },
      { ...clock, timeoutMs: 1_000, pollMs: 300 },
    );

    expect(status[0]?.status).toBe('pending');
    // It stopped rather than spinning: four asks over the second, not forever.
    expect(reads).toBeLessThanOrEqual(5);
    expect(clock.elapsed).toBeGreaterThanOrEqual(1_000);
    expect(clock.elapsed).toBeLessThan(2_000);
  });

  it('does not wait for a server that already failed', async () => {
    const clock = fakeClock();
    let reads = 0;
    await settleMcpStatus(
      async () => {
        reads += 1;
        return [server('failed'), server('connected')];
      },
      clock,
    );

    // `failed` is settled. Only `pending` is worth another round trip, and
    // treating any non-connected status as "keep asking" would make every
    // broken server cost the full deadline.
    expect(reads).toBe(1);
    expect(clock.elapsed).toBe(0);
  });

  it('keeps waiting while any one of several is still pending', async () => {
    const clock = fakeClock();
    let reads = 0;
    const status = await settleMcpStatus(
      async () => {
        reads += 1;
        return [server('connected'), reads < 3 ? server('pending') : server('failed')];
      },
      { ...clock, pollMs: 300 },
    );

    expect(reads).toBe(3);
    expect(status.map((s) => s.status)).toEqual(['connected', 'failed']);
  });

  it('reports an empty list without waiting', async () => {
    const clock = fakeClock();
    expect(await settleMcpStatus(async () => [], clock)).toEqual([]);
    expect(clock.elapsed).toBe(0);
  });
});
