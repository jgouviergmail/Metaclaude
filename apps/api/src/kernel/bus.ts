/**
 * Topic-based event bus.
 *
 * Everything the OS does emits here, and the WebSocket gateway is just one
 * subscriber. Keeping the bus in-process and synchronous means an event is
 * observable the instant it happens, with no broker to operate.
 *
 * A bounded ring buffer per topic lets a client that reconnects within a few
 * seconds replay what it missed instead of refetching the whole transcript.
 */

import type { ServerFrame, Topic } from '@metaclaude/shared';

export type BusListener = (frame: ServerFrame, seq: number) => void;

interface Buffered {
  seq: number;
  frame: ServerFrame;
  at: number;
}

/** How many frames we retain per topic for reconnect replay. */
const REPLAY_BUFFER_SIZE = 256;
/** Frames older than this are never replayed — the client should refetch. */
const REPLAY_MAX_AGE_MS = 60_000;

export class EventBus {
  private readonly listeners = new Map<Topic, Set<BusListener>>();
  private readonly buffers = new Map<Topic, Buffered[]>();
  private seqCounter = 0;

  /** Subscribe to a topic. Returns an unsubscribe function. */
  subscribe(topic: Topic, listener: BusListener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(topic);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(topic);
    };
  }

  /**
   * Publish a frame to a topic.
   *
   * A throwing listener must never take down the publisher — one broken socket
   * would otherwise stall an agent run — so failures are swallowed here and
   * surfaced by the gateway's own error handling.
   */
  publish(topic: Topic, frame: ServerFrame): number {
    const seq = ++this.seqCounter;
    this.buffer(topic, frame, seq);

    const set = this.listeners.get(topic);
    if (set) {
      for (const listener of set) {
        try {
          listener(frame, seq);
        } catch {
          // Intentionally ignored; see the note above.
        }
      }
    }
    return seq;
  }

  private buffer(topic: Topic, frame: ServerFrame, seq: number): void {
    // Deltas are high-volume and superseded by the authoritative `transcript`
    // frame that follows, so replaying them adds noise without adding state.
    if (frame.type === 'delta') return;

    let buffer = this.buffers.get(topic);
    if (!buffer) {
      buffer = [];
      this.buffers.set(topic, buffer);
    }
    buffer.push({ seq, frame, at: Date.now() });
    if (buffer.length > REPLAY_BUFFER_SIZE) buffer.splice(0, buffer.length - REPLAY_BUFFER_SIZE);
  }

  /**
   * Frames published to `topic` after `afterSeq`, newest last.
   *
   * Each entry keeps its sequence number: a replayed frame has to advance the
   * client's cursor exactly as a live one does, or the next reconnect would ask
   * for — and be sent — the same window again.
   */
  replay(topic: Topic, afterSeq: number): { seq: number; frame: ServerFrame }[] {
    const buffer = this.buffers.get(topic);
    if (!buffer) return [];
    const cutoff = Date.now() - REPLAY_MAX_AGE_MS;
    return buffer
      .filter((entry) => entry.seq > afterSeq && entry.at >= cutoff)
      .map((entry) => ({ seq: entry.seq, frame: entry.frame }));
  }

  get currentSeq(): number {
    return this.seqCounter;
  }

  /** Drop buffers for topics nobody is listening to. Called by the janitor. */
  sweep(): void {
    const cutoff = Date.now() - REPLAY_MAX_AGE_MS;
    for (const [topic, buffer] of this.buffers) {
      const kept = buffer.filter((entry) => entry.at >= cutoff);
      if (kept.length === 0 && !this.listeners.has(topic)) {
        this.buffers.delete(topic);
      } else {
        this.buffers.set(topic, kept);
      }
    }
  }

  /** Number of distinct topics with at least one listener. */
  get topicCount(): number {
    return this.listeners.size;
  }
}
