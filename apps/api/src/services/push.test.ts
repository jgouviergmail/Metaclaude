/**
 * Web push — the OS finally able to tap the owner on the shoulder.
 *
 * What matters here: the VAPID identity is generated once and sealed (a new
 * pair would orphan every subscription); the endpoint is the row's identity
 * (a re-subscribe must never duplicate); a push service saying "gone" prunes
 * the row while a transient failure does not; and the event handlers notify
 * for exactly the two things worth a phone buzz — an approval that blocks a
 * run, and the end of a run a human started — never for the machinery
 * (automations, loops, delegations) that runs while the owner sleeps.
 */

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, Run, ServerFrame } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Vault } from '../security/vault.js';
import {
  buildPushEventHandlers,
  describePushFailure,
  PushService,
  type PushSend,
} from './push.js';

let db: Db;
let vault: Vault;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, randomBytes(32));
  for (const id of ['usr_1', 'usr_2']) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, ?, 'x', 'owner', 0, 0)`,
    ).run(id, id);
  }
});

interface Sent {
  endpoint: string;
  p256dh: string;
  payload: string;
  ttlSeconds: number;
  urgency: string;
}

/**
 * A faithful `WebPushError`.
 *
 * The real one carries the bare string 'Received unexpected response code' —
 * the status and the relay's own reason live in `statusCode` and `body`. The
 * fake here used to build a message containing the status, which made every
 * assertion on `lastError` pass while the deployed code recorded a sentence
 * with no diagnosis in it at all. A fake more helpful than the thing it
 * stands for cannot show that the thing is unhelpful.
 */
function webPushError(statusCode: number, body = ''): Error {
  const error = new Error('Received unexpected response code') as Error & {
    statusCode: number;
    body: string;
    endpoint: string;
  };
  error.name = 'WebPushError';
  error.statusCode = statusCode;
  error.body = body;
  error.endpoint = 'https://web.push.apple.com/abc';
  return error;
}

function build(behave?: (endpoint: string) => number | void, body = '') {
  const sent: Sent[] = [];
  const send: PushSend = async (subscription, payload, options) => {
    const status = behave?.(subscription.endpoint);
    if (typeof status === 'number') throw webPushError(status, body);
    sent.push({
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      payload,
      ttlSeconds: options.ttlSeconds,
      urgency: options.urgency,
    });
  };
  const push = new PushService({ db, vault, send, log: () => {} });
  return { push, sent };
}

const SUB = (n: number) => ({
  endpoint: `https://push.example/device-${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
});

describe('what a refusal actually says', () => {
  /**
   * Reported from a real deployment: the test button answered "unexpected
   * response code" on iOS and nothing else. That sentence is `web-push`'s
   * whole message; everything a person could act on was being discarded.
   */
  it('names the status and the relay instead of the library’s bare sentence', async () => {
    const { push } = build(() => 503);
    push.subscribe('usr_1', SUB(1));
    const outcome = await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });

    expect(outcome.lastError).toContain('503');
    expect(outcome.lastError).not.toBe('Received unexpected response code');
  });

  it('tells the operator what to do about Apple’s 403', async () => {
    // `web.push.apple.com` answers 403 when the subscription was made with a
    // different VAPID public key than the one now signing — which is what a
    // regenerated key pair does to every device that subscribed before it.
    const { push } = build(() => 403, 'VapidPkHashMismatch');
    push.subscribe('usr_1', SUB(1));
    const outcome = await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });

    expect(outcome.lastError).toContain('403');
    expect(outcome.lastError).toContain('VapidPkHashMismatch');
    expect(outcome.lastError).toMatch(/off and on again/);
  });

  it('points at the subject for a 400, which is what usually causes one', async () => {
    const { push } = build(() => 400, 'BadJwtToken');
    push.subscribe('usr_1', SUB(1));
    const outcome = await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });

    expect(outcome.lastError).toContain('400');
    expect(outcome.lastError).toContain('BadJwtToken');
    expect(outcome.lastError).toContain('METACLAUDE_PUSH_SUBJECT');
  });

  it('keeps the relay’s own words, which are the part that identifies the fault', () => {
    expect(describePushFailure({ statusCode: 410, body: 'ExpiredToken' }, 'https://x.example/p')).toContain(
      'ExpiredToken',
    );
  });

  it('falls back to the message when there is no status at all', () => {
    // A DNS failure or a socket reset is not an HTTP answer.
    expect(describePushFailure(new Error('ECONNRESET'), 'https://x.example/p')).toBe('ECONNRESET');
  });

  it('survives an endpoint that is not a URL', () => {
    expect(describePushFailure({ statusCode: 500 }, 'not a url')).toContain('500');
  });
});

describe('the VAPID identity', () => {
  it('is generated once, sealed, and stable across restarts', () => {
    const first = new PushService({ db, vault, send: async () => {}, log: () => {} });
    const key = first.publicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);

    // A second service over the same vault — a restart — must answer with
    // the same key, or every browser subscription would be orphaned.
    const second = new PushService({ db, vault, send: async () => {}, log: () => {} });
    expect(second.publicKey()).toBe(key);
  });
});

describe('subscriptions', () => {
  it('stores one row per endpoint, upserting on re-subscribe', async () => {
    const { push, sent } = build();
    push.subscribe('usr_1', SUB(1));
    push.subscribe('usr_1', SUB(2));
    expect(push.devices()).toBe(2);

    // The same browser re-subscribing (new keys, maybe another signed-in
    // user) replaces its row rather than ghosting the old one.
    push.subscribe('usr_2', { ...SUB(1), keys: { p256dh: 'rotated', auth: 'rotated' } });
    expect(push.devices()).toBe(2);

    await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });
    const one = sent.find((entry) => entry.endpoint.endsWith('device-1'));
    expect(one?.p256dh).toBe('rotated');
  });

  it('lets a user remove their own device, and only theirs', () => {
    const { push } = build();
    push.subscribe('usr_1', SUB(1));
    expect(push.unsubscribe('usr_2', SUB(1).endpoint)).toBe(false);
    expect(push.devices()).toBe(1);
    expect(push.unsubscribe('usr_1', SUB(1).endpoint)).toBe(true);
    expect(push.devices()).toBe(0);
  });
});

describe('delivery', () => {
  it('fans out to every device with a minimal JSON payload', async () => {
    const { push, sent } = build();
    push.subscribe('usr_1', SUB(1));
    push.subscribe('usr_2', SUB(2));

    const outcome = await push.notify(
      { title: 'Approval needed', body: 'ws · Bash', url: '/w/1/s/2', tag: 'approval-a1' },
      { ttlSeconds: 600, urgency: 'high' },
    );

    expect(outcome).toEqual({ devices: 2, sent: 2, pruned: 0, lastError: null });
    expect(sent).toHaveLength(2);
    const payload = JSON.parse(sent[0]?.payload ?? '{}') as Record<string, unknown>;
    // Exactly these keys: a push payload transits a third-party service, so
    // nothing beyond what the notification needs may ride along.
    expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
    expect(sent[0]?.ttlSeconds).toBe(600);
    expect(sent[0]?.urgency).toBe('high');
  });

  it('prunes a subscription the push service says is gone', async () => {
    const { push } = build((endpoint) => (endpoint.endsWith('device-1') ? 410 : undefined));
    push.subscribe('usr_1', SUB(1));
    push.subscribe('usr_1', SUB(2));

    const outcome = await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });
    expect(outcome).toEqual({ devices: 2, sent: 1, pruned: 1, lastError: null });
    expect(push.devices()).toBe(1);
  });

  it('tells "nobody is subscribed" apart from "every delivery failed"', async () => {
    // The test button turns this outcome into words. With only `sent` to go
    // on, a relay outage on a subscribed deployment read as "no device is
    // subscribed yet" — the one diagnosis guaranteed to send the operator
    // re-enabling a subscription that already exists.
    const empty = build();
    expect(await empty.push.notify({ title: 't', body: 'b', url: '/', tag: 'x' })).toEqual({
      devices: 0,
      sent: 0,
      pruned: 0,
      lastError: null,
    });

    const failing = build(() => 503);
    failing.push.subscribe('usr_1', SUB(1));
    const outcome = await failing.push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });
    expect(outcome.devices).toBe(1);
    expect(outcome.sent).toBe(0);
    expect(outcome.lastError).toContain('503');
  });

  it('keeps a subscription through a transient failure, recording the error', async () => {
    let fail = true;
    const { push, sent } = build(() => (fail ? 503 : undefined));
    push.subscribe('usr_1', SUB(1));

    await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });
    expect(push.devices()).toBe(1);
    const row = db
      .prepare('SELECT last_error FROM push_subscriptions')
      .get() as { last_error: string | null };
    expect(row.last_error).toContain('503');

    fail = false;
    await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' });
    expect(sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

const approval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'apr_1',
  runId: 'run_1',
  sessionId: 'ses_1',
  workspaceId: 'ws_1',
  toolUseId: 'tu_1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  summary: 'Bash: rm -rf build',
  risk: 'high',
  reason: null,
  createdAt: 0,
  expiresAt: 600_000,
  ...over,
});

const run = (over: Partial<Run>): Run =>
  ({
    id: 'run_1',
    sessionId: 'ses_1',
    workspaceId: 'ws_1',
    status: 'succeeded',
    triggeredBy: 'user',
    error: null,
    ...over,
  }) as unknown as Run;

describe('what deserves a buzz', () => {
  function handlers() {
    const notify = vi.fn<
      (
        payload: { title: string; body: string; url: string; tag: string },
        options?: object,
      ) => Promise<{ devices: number; sent: number; pruned: number; lastError: string | null }>
    >(async () => ({ devices: 1, sent: 1, pruned: 0, lastError: null }));
    const built = buildPushEventHandlers({
      push: { notify },
      sessions: { get: (id) => (id === 'ses_1' ? { title: 'Fix the parser' } : null) },
      workspaces: { get: (id) => (id === 'ws_1' ? { name: 'Metaclaude' } : null) },
      log: () => {},
    });
    return { notify, ...built };
  }

  it('pushes a blocking approval, urgent and short-lived', () => {
    const { notify, onSystemFrame } = handlers();
    onSystemFrame({
      type: 'approval_request',
      topic: 'system',
      request: approval(),
    } as unknown as ServerFrame);

    expect(notify).toHaveBeenCalledTimes(1);
    const [payload, options] = notify.mock.calls[0] as [
      { title: string; body: string; url: string; tag: string },
      { ttlSeconds: number; urgency: string },
    ];
    expect(payload.title).toBe('Approval needed');
    expect(payload.body).toContain('Metaclaude');
    expect(payload.body).toContain('Bash');
    expect(payload.url).toBe('/w/ws_1/s/ses_1');
    expect(payload.tag).toBe('approval-apr_1');
    // An approval expires in ten minutes; a push that outlives it is a lie
    // waiting on a lock screen.
    expect(options.ttlSeconds).toBeLessThanOrEqual(600);
    expect(options.urgency).toBe('high');
  });

  it('ignores every other system frame', () => {
    const { notify, onSystemFrame } = handlers();
    onSystemFrame({
      type: 'notification',
      topic: 'system',
      level: 'success',
      title: 'Run finished',
      message: 'x',
    } as unknown as ServerFrame);
    onSystemFrame({
      type: 'approval_resolved',
      topic: 'system',
      approvalId: 'apr_1',
      approved: true,
    } as unknown as ServerFrame);
    expect(notify).not.toHaveBeenCalled();
  });

  it('pushes the end of a run a human started — and only those', () => {
    const { notify, onRunFinished } = handlers();

    onRunFinished(run({ status: 'failed', error: 'boom' }));
    expect(notify).toHaveBeenCalledTimes(1);
    const [payload, options] = notify.mock.calls[0] as unknown as [
      { title: string; body: string },
      { urgency: string },
    ];
    expect(payload.title).toBe('Run failed');
    expect(payload.body).toContain('Fix the parser');
    expect(options.urgency).toBe('high');

    onRunFinished(run({ status: 'succeeded' }));
    expect(notify).toHaveBeenCalledTimes(2);
    expect((notify.mock.calls[1]?.[0] as { title: string }).title).toBe('Run finished');

    // The machinery works while the owner sleeps; it must not wake them.
    for (const triggeredBy of ['automation', 'loop', 'system', 'delegation'] as const) {
      onRunFinished({ ...run({}), triggeredBy });
    }
    expect(notify).toHaveBeenCalledTimes(2);
  });

  /**
   * The one exception: an automation whose policy asked. A brief nobody
   * hears about is a brief read ten hours late — the steward said so of its
   * own morning review. Announced under the automation's name, and only for
   * the session its firings run in.
   */
  it('pushes the end of an automation firing that asked to notify, under its name', () => {
    const notify = vi.fn<
      (
        payload: { title: string; body: string; url: string; tag: string },
        options?: object,
      ) => Promise<{ devices: number; sent: number; pruned: number; lastError: string | null }>
    >(async () => ({ devices: 1, sent: 1, pruned: 0, lastError: null }));
    const built = buildPushEventHandlers({
      push: { notify },
      sessions: { get: () => ({ title: 'Conversation' }) },
      workspaces: { get: () => ({ name: 'Metaclaude' }) },
      automations: { notifying: (sessionId) => (sessionId === 'ses_brief' ? 'Morning review' : null) },
      log: () => {},
    });

    built.onRunFinished({ ...run({ status: 'succeeded' }), triggeredBy: 'automation', sessionId: 'ses_brief' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0]?.[0] as { title: string }).title).toBe('Morning review finished');

    built.onRunFinished({ ...run({}), triggeredBy: 'automation', sessionId: 'ses_quiet' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps bodies short whatever the summary drags in', () => {
    const { notify, onSystemFrame } = handlers();
    onSystemFrame({
      type: 'approval_request',
      topic: 'system',
      request: approval({ summary: 'x'.repeat(2000) }),
    } as unknown as ServerFrame);
    const [payload] = notify.mock.calls[0] as unknown as [{ body: string }];
    expect(payload.body.length).toBeLessThanOrEqual(200);
  });
});
