/**
 * The wire protocol.
 *
 * `parseWireFrame` is the only runtime validation standing between a WebSocket
 * message and the browser's state store, and it had no tests. Everything the
 * transcript renders — assistant text, tool arguments, diffs, notification
 * bodies — arrives through here. If it is too permissive, a malformed or
 * hostile frame reaches components that were written assuming the shape held.
 *
 * So the cases that matter are the rejections, and in particular the ones a
 * hand-rolled `typeof` check would wave through: a known `type` with the wrong
 * payload, a nested object that is subtly wrong, and the prototype-pollution
 * keys that JSON.parse will happily produce.
 */

import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  parseWireFrame,
  sessionTopic,
  SYSTEM_TOPIC,
  toWireFrame,
  workspaceTopic,
  type ServerFrame,
} from './protocol.js';

const pong: ServerFrame = { type: 'pong', t: 1_700_000_000_000 };

describe('parseWireFrame — what it accepts', () => {
  it('accepts a well-formed frame', () => {
    expect(parseWireFrame(pong)?.frame).toEqual(pong);
  });

  it('carries the bus sequence when there is one', () => {
    // The client keeps the highest seq it has seen and hands it back as
    // `since` after a reconnect. Losing it means the replay window is wrong.
    expect(parseWireFrame(toWireFrame(pong, 42))?.seq).toBe(42);
  });

  it('reports no sequence for a per-connection frame', () => {
    // `ready`, `pong`, `subscribed` and `error` are not published through the
    // bus. Inventing a 0 for them would move the client's cursor backwards.
    expect(parseWireFrame(pong)?.seq).toBeNull();
  });

  it('accepts a board frame — the schema every open board trusts', () => {
    const frame = {
      type: 'board_task',
      topic: 'workspace:ws_1',
      task: {
        id: 'tsk_1',
        workspaceId: 'ws_1',
        title: 'A card',
        status: 'todo',
        orderKey: 'i',
        createdBy: 'user:jules',
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const parsed = parseWireFrame(frame);
    expect(parsed?.frame.type).toBe('board_task');
    // Defaults must materialise: a card the server sent without optional
    // fields still renders as a complete object.
    expect(parsed?.frame.type === 'board_task' ? parsed.frame.task.priority : null).toBe('normal');
  });

  it('refuses a sequence that is not a safe integer', () => {
    // A float or a value past 2^53 would compare wrongly against later ones,
    // and the replay cursor is a comparison.
    for (const seq of [1.5, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, '7', null]) {
      expect(parseWireFrame({ ...pong, seq })?.seq).toBeNull();
    }
  });

  it('applies the schema defaults rather than leaving fields undefined', () => {
    // `replayed` and `href` are `.default(...)`. A component reading
    // `frame.replayed` must not get undefined because the server omitted it.
    const subscribed = parseWireFrame({ type: 'subscribed', topics: ['system'] });
    expect((subscribed?.frame as { replayed: number }).replayed).toBe(0);

    const notification = parseWireFrame({
      type: 'notification',
      topic: 'system',
      level: 'info',
      title: 't',
      message: 'm',
    });
    expect((notification?.frame as { href: string | null }).href).toBeNull();
  });
});

describe('parseWireFrame — what it rejects', () => {
  it('rejects a frame with no type', () => {
    expect(parseWireFrame({ t: 1 })).toBeNull();
  });

  it('rejects an unknown type', () => {
    // Forward compatibility cuts the other way here: an unrecognised frame must
    // not reach the store, because nothing downstream knows its shape.
    expect(parseWireFrame({ type: 'exec', payload: 'rm -rf /' })).toBeNull();
  });

  it('rejects a known type carrying the wrong payload', () => {
    // The case a `typeof raw.type === "string"` guard would wave straight
    // through, and the one that puts undefined into a render path.
    expect(parseWireFrame({ type: 'pong', t: 'soon' })).toBeNull();
    expect(parseWireFrame({ type: 'pong' })).toBeNull();
    expect(parseWireFrame({ type: 'delta', topic: 'system', text: 'hi' })).toBeNull();
  });

  it('rejects a malformed topic', () => {
    // Topics are grammar-checked, so a frame cannot claim a topic shape the
    // subscription logic does not understand.
    for (const topic of ['', 'session:', 'sess:abc', 'workspace:../etc', 'system:extra', 'SYSTEM']) {
      expect(parseWireFrame({ type: 'run', topic, run: {} })).toBeNull();
    }
  });

  it('rejects a nested entity that is subtly wrong', () => {
    // A `run` frame whose run is missing a field would otherwise reach a
    // component that reads it without checking.
    expect(
      parseWireFrame({ type: 'run', topic: 'system', run: { id: 'run_1', status: 'succeeded' } }),
    ).toBeNull();
  });

  it('rejects an out-of-range enum', () => {
    expect(
      parseWireFrame({
        type: 'notification',
        topic: 'system',
        level: 'catastrophe',
        title: 't',
        message: 'm',
      }),
    ).toBeNull();
  });

  it('rejects a files_changed list past its cap', () => {
    // The cap exists so one frame cannot make the client walk an unbounded
    // list; a frame just over it must fail rather than be truncated silently.
    const paths = Array.from({ length: 201 }, (_, i) => `f${i}.ts`);
    expect(parseWireFrame({ type: 'files_changed', topic: 'system', paths })).toBeNull();
    expect(parseWireFrame({ type: 'files_changed', topic: 'system', paths: paths.slice(0, 200) })).not.toBeNull();
  });

  it('rejects non-objects without throwing', () => {
    for (const raw of [null, undefined, 0, '', 'pong', true, [], () => {}]) {
      expect(parseWireFrame(raw)).toBeNull();
    }
  });

  it('survives a payload carrying __proto__ without polluting Object', () => {
    // `JSON.parse` produces a plain own property named __proto__, and a naive
    // merge downstream turns that into prototype pollution. Nothing here should
    // reach Object.prototype whether the frame is accepted or refused.
    const hostile = JSON.parse('{"type":"pong","t":1,"__proto__":{"polluted":true}}') as unknown;

    parseWireFrame(hostile);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not let an unknown extra key ride along into the store', () => {
    // Zod strips unknown keys by default. Worth pinning: if a schema were ever
    // switched to passthrough, arbitrary server-controlled fields would start
    // arriving in objects the UI spreads into props.
    const parsed = parseWireFrame({ type: 'pong', t: 1, evil: 'payload' });

    expect(parsed?.frame).toEqual({ type: 'pong', t: 1 });
    expect(parsed?.frame).not.toHaveProperty('evil');
  });
});

describe('topics', () => {
  it('builds the grammar the server parses', () => {
    expect(sessionTopic('ses_abc')).toBe('session:ses_abc');
    expect(workspaceTopic('ws_abc')).toBe('workspace:ws_abc');
    expect(SYSTEM_TOPIC).toBe('system');
  });

  it('round-trips through validation', () => {
    // A topic this module builds must be one the schema accepts, or a client
    // could subscribe to something the server then refuses.
    for (const topic of [sessionTopic('ses_abc'), workspaceTopic('ws_abc'), SYSTEM_TOPIC]) {
      expect(parseWireFrame({ type: 'files_changed', topic, paths: [] })).not.toBeNull();
    }
  });
});

describe('toWireFrame', () => {
  it('omits the sequence when there is none', () => {
    expect(toWireFrame(pong)).toEqual(pong);
    expect(toWireFrame(pong)).not.toHaveProperty('seq');
  });

  it('round-trips through parseWireFrame', () => {
    const wire = toWireFrame({ type: 'metrics', topic: 'system', activeRuns: 1, queuedRuns: 0, costTodayUsd: 0.5 }, 9);
    const parsed = parseWireFrame(wire);

    expect(parsed?.seq).toBe(9);
    expect(parsed?.frame.type).toBe('metrics');
  });
});

describe('CLOSE_CODES', () => {
  it('stays inside the range reserved for private use', () => {
    // 4000-4999 is the only range an application may define. A code outside it
    // is rewritten by intermediaries, and the client's reconnect logic
    // branches on the exact value.
    for (const code of Object.values(CLOSE_CODES)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it('gives every reason a distinct code', () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
