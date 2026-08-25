import type { ServerFrame, Topic } from '@metaclaude/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus.js';

const TOPIC: Topic = 'session:s1';
const OTHER: Topic = 'session:s2';

function notification(title: string, topic: Topic = TOPIC): ServerFrame {
  return { type: 'notification', topic, level: 'info', title, message: title, href: null };
}

function delta(text: string, topic: Topic = TOPIC): ServerFrame {
  return { type: 'delta', topic, runId: 'run_1', eventId: 'ev_1', channel: 'assistant_text', text };
}

/** Titles of replayed notification frames, in order. */
function titles(entries: { frame: ServerFrame }[]): string[] {
  return entries.map((entry) => (entry.frame as { title: string }).title);
}

/** The replay buffers are private; the only way to assert on sweeping. */
function buffers(bus: EventBus): Map<Topic, unknown[]> {
  return (bus as unknown as { buffers: Map<Topic, unknown[]> }).buffers;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribe / publish', () => {
  it('delivers a published frame to every subscriber with a monotonic sequence', () => {
    const bus = new EventBus();
    const a: Array<[ServerFrame, number]> = [];
    const b: Array<[ServerFrame, number]> = [];
    bus.subscribe(TOPIC, (frame, seq) => a.push([frame, seq]));
    bus.subscribe(TOPIC, (frame, seq) => b.push([frame, seq]));

    const first = bus.publish(TOPIC, notification('one'));
    const second = bus.publish(TOPIC, notification('two'));

    expect(second).toBe(first + 1);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]![0]).toMatchObject({ type: 'notification', title: 'one' });
    expect(a[0]![1]).toBe(first);
    expect(a).toEqual(b);
    expect(bus.currentSeq).toBe(second);
  });

  it('delivers only to the topic that was published to', () => {
    const bus = new EventBus();
    const here: ServerFrame[] = [];
    const there: ServerFrame[] = [];
    bus.subscribe(TOPIC, (frame) => here.push(frame));
    bus.subscribe(OTHER, (frame) => there.push(frame));

    bus.publish(TOPIC, notification('for s1'));
    expect(here).toHaveLength(1);
    expect(there).toHaveLength(0);
  });

  it('publishing to a topic with no listeners is harmless', () => {
    const bus = new EventBus();
    expect(bus.publish(TOPIC, notification('into the void'))).toBe(1);
    expect(bus.topicCount).toBe(0);
  });

  it('shares one sequence counter across topics', () => {
    const bus = new EventBus();
    expect(bus.publish(TOPIC, notification('a'))).toBe(1);
    expect(bus.publish(OTHER, notification('b', OTHER))).toBe(2);
    expect(bus.publish(TOPIC, notification('c'))).toBe(3);
  });

  it('deduplicates a listener registered twice, as a Set does', () => {
    const bus = new EventBus();
    const seen: ServerFrame[] = [];
    const listener = (frame: ServerFrame): void => void seen.push(frame);
    bus.subscribe(TOPIC, listener);
    bus.subscribe(TOPIC, listener);
    bus.publish(TOPIC, notification('once'));
    expect(seen).toHaveLength(1);
  });
});

describe('unsubscribe', () => {
  it('stops delivery to the unsubscribed listener only', () => {
    const bus = new EventBus();
    const kept: ServerFrame[] = [];
    const dropped: ServerFrame[] = [];
    bus.subscribe(TOPIC, (frame) => kept.push(frame));
    const off = bus.subscribe(TOPIC, (frame) => dropped.push(frame));

    bus.publish(TOPIC, notification('before'));
    off();
    bus.publish(TOPIC, notification('after'));

    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });

  it('drops the topic entry once the last listener leaves', () => {
    const bus = new EventBus();
    const off = bus.subscribe(TOPIC, () => {});
    expect(bus.topicCount).toBe(1);
    off();
    expect(bus.topicCount).toBe(0);
  });

  it('is idempotent', () => {
    const bus = new EventBus();
    const seen: ServerFrame[] = [];
    const off = bus.subscribe(TOPIC, (frame) => seen.push(frame));
    off();
    expect(() => off()).not.toThrow();
    bus.publish(TOPIC, notification('after'));
    expect(seen).toHaveLength(0);
  });
});

describe('listener isolation', () => {
  it('a throwing listener neither breaks publish() nor starves the others', () => {
    const bus = new EventBus();
    const before: ServerFrame[] = [];
    const after: ServerFrame[] = [];

    bus.subscribe(TOPIC, () => before.push(notification('sentinel')));
    bus.subscribe(TOPIC, () => {
      throw new Error('this socket is broken');
    });
    bus.subscribe(TOPIC, (frame) => after.push(frame));

    let seq = 0;
    expect(() => {
      seq = bus.publish(TOPIC, notification('one'));
    }).not.toThrow();

    expect(seq).toBe(1);
    expect(before).toHaveLength(1);
    // The listener registered *after* the throwing one still received the frame.
    expect(after).toHaveLength(1);

    // And the bus keeps working on the next publish.
    expect(() => bus.publish(TOPIC, notification('two'))).not.toThrow();
    expect(after).toHaveLength(2);
  });

  it('the frame is still buffered for replay even when a listener throws', () => {
    const bus = new EventBus();
    bus.subscribe(TOPIC, () => {
      throw new Error('broken');
    });
    bus.publish(TOPIC, notification('buffered anyway'));
    expect(bus.replay(TOPIC, 0)).toHaveLength(1);
  });
});

describe('replay', () => {
  it('returns only frames after the given sequence number, oldest first', () => {
    const bus = new EventBus();
    const first = bus.publish(TOPIC, notification('one'));
    bus.publish(TOPIC, notification('two'));
    bus.publish(TOPIC, notification('three'));

    expect(titles(bus.replay(TOPIC, 0))).toEqual(['one', 'two', 'three']);
    expect(titles(bus.replay(TOPIC, first))).toEqual(['two', 'three']);
    expect(bus.replay(TOPIC, bus.currentSeq)).toEqual([]);

    // Each entry carries the sequence it was published at, so a replayed frame
    // advances the client's cursor exactly as a live one does.
    expect(bus.replay(TOPIC, 0).map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('returns an empty array for a topic that never saw a frame', () => {
    const bus = new EventBus();
    expect(bus.replay(TOPIC, 0)).toEqual([]);
  });

  it('excludes streaming deltas, which are superseded by the transcript frame', () => {
    const bus = new EventBus();
    bus.publish(TOPIC, notification('kept'));
    bus.publish(TOPIC, delta('tok'));
    bus.publish(TOPIC, delta('en'));
    bus.publish(TOPIC, notification('also kept'));

    const replayed = bus.replay(TOPIC, 0);
    expect(replayed).toHaveLength(2);
    expect(replayed.every((entry) => entry.frame.type !== 'delta')).toBe(true);
    // Deltas still consume sequence numbers and still reach live listeners.
    expect(bus.currentSeq).toBe(4);
  });

  it('still delivers deltas to live subscribers', () => {
    const bus = new EventBus();
    const seen: ServerFrame[] = [];
    bus.subscribe(TOPIC, (frame) => seen.push(frame));
    bus.publish(TOPIC, delta('hello'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('delta');
  });

  it('keeps the buffer bounded to the most recent frames', () => {
    const bus = new EventBus();
    for (let i = 0; i < 300; i += 1) bus.publish(TOPIC, notification(`n${i}`));

    const replayed = bus.replay(TOPIC, 0);
    expect(replayed).toHaveLength(256);
    expect(titles(replayed)).toEqual(
      Array.from({ length: 256 }, (_, i) => `n${i + 44}`),
    );
  });

  it('does not replay frames older than the replay window', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_700_000_000_000));

    const bus = new EventBus();
    bus.publish(TOPIC, notification('stale'));
    vi.setSystemTime(new Date(1_700_000_000_000 + 61_000));
    bus.publish(TOPIC, notification('fresh'));

    const replayed = bus.replay(TOPIC, 0);
    expect(replayed).toHaveLength(1);
    expect(titles(replayed)).toEqual(['fresh']);
  });
});

describe('sweep', () => {
  it('drops the buffer of a topic nobody is listening to', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_700_000_000_000));

    const bus = new EventBus();
    bus.subscribe(TOPIC, () => {});
    bus.publish(TOPIC, notification('watched'));
    bus.publish(OTHER, notification('unwatched', OTHER));

    expect(buffers(bus).has(TOPIC)).toBe(true);
    expect(buffers(bus).has(OTHER)).toBe(true);

    // Nothing is stale yet, so nothing is dropped.
    bus.sweep();
    expect(buffers(bus).has(TOPIC)).toBe(true);
    expect(buffers(bus).has(OTHER)).toBe(true);

    vi.setSystemTime(new Date(1_700_000_000_000 + 61_000));
    bus.sweep();

    // The unlistened topic is gone entirely; the watched one is kept (empty)
    // so a reconnecting client keeps its buffer slot.
    expect(buffers(bus).has(OTHER)).toBe(false);
    expect(buffers(bus).has(TOPIC)).toBe(true);
    expect(buffers(bus).get(TOPIC)).toHaveLength(0);
  });

  it('keeps entries that are still inside the replay window', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_700_000_000_000));

    const bus = new EventBus();
    bus.publish(OTHER, notification('old', OTHER));
    vi.setSystemTime(new Date(1_700_000_000_000 + 61_000));
    bus.publish(OTHER, notification('new', OTHER));

    bus.sweep();
    expect(buffers(bus).has(OTHER)).toBe(true);
    expect(titles(bus.replay(OTHER, 0))).toEqual(['new']);
  });

  it('is safe to call on an empty bus', () => {
    const bus = new EventBus();
    expect(() => bus.sweep()).not.toThrow();
    expect(bus.topicCount).toBe(0);
  });
});
