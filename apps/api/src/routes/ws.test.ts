/**
 * WebSocket gateway — integration.
 *
 * A real server, a real socket, real cookies. The gateway is where the
 * handshake, the topic fan-out and the reconnect replay meet, and none of those
 * can be tested convincingly against a mock: the whole point of the replay is
 * what happens to a *connection* that goes away and comes back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  CLOSE_CODES,
  CSRF_COOKIE,
  SESSION_COOKIE,
  parseWireFrame,
  SYSTEM_TOPIC,
  sessionTopic,
  type ServerFrame,
  type Topic,
} from '@metaclaude/shared';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { createAppContext, type AppContext } from '../context.js';
import { buildServer } from '../server.js';

const PASSWORD = 'correct-horse-battery-staple';
const USERNAME = 'jules';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let wsUrl: string;
let cookies: string;
let csrfToken: string;

/** A frame the tests can publish on demand, distinguishable by title. */
function notice(topic: Topic, title: string): ServerFrame {
  return { type: 'notification', topic, level: 'info', title, message: title, href: null };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-ws-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
  } as NodeJS.ProcessEnv);

  context = await createAppContext(config, pino({ level: 'silent' }));
  // The bootstrap account is created by `index.ts`, not by the context, so the
  // test makes its own.
  await context.auth.createUser({ username: USERNAME, password: PASSWORD, role: 'owner' });
  app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/ws`;

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(response.status).toBe(200);

  const setCookies = response.headers.getSetCookie();
  cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');

  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
  csrfToken = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);
  expect(cookies).toContain(SESSION_COOKIE);
  expect(csrfToken.length).toBeGreaterThan(0);
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** A connected client that records everything it receives. */
class TestClient {
  readonly received: { frame: ServerFrame; seq: number | null }[] = [];
  private readonly socket: WebSocket;
  closeCode: number | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw: Buffer) => {
      const wire = parseWireFrame(JSON.parse(raw.toString('utf8')));
      if (wire) this.received.push(wire);
    });
    socket.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static async connect(headers: Record<string, string> = { cookie: cookies }): Promise<TestClient> {
    const socket = new WebSocket(wsUrl, { headers });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('close', () => resolve());
    });
    return client;
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Wait for the first frame of a given type, or fail after a moment. */
  async waitFor<T extends ServerFrame['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerFrame, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find((entry) => entry.frame.type === type);
      if (hit) return hit.frame as Extract<ServerFrame, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for a "${type}" frame`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async waitForClose(timeoutMs = 2000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the socket to close');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.closeCode;
  }

  /** Handshake and subscribe, returning the `ready` frame. */
  async start(topics: Topic[], since?: string) {
    this.send({ type: 'hello', csrfToken });
    const ready = await this.waitFor('ready');
    this.send({ type: 'subscribe', topics, ...(since ? { since } : {}) });
    await this.waitFor('subscribed');
    return ready;
  }

  titles(): string[] {
    return this.received
      .filter((entry) => entry.frame.type === 'notification')
      .map((entry) => (entry.frame as { title: string }).title);
  }

  close(): void {
    this.socket.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Handshake                                                                   */
/* -------------------------------------------------------------------------- */

describe('handshake', () => {
  it('refuses an upgrade with no session cookie', async () => {
    const client = await TestClient.connect({});
    expect(await client.waitForClose()).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it('refuses a hello with the wrong CSRF token', async () => {
    // `WebSocket` ignores CORS and the browser attaches cookies, so the cookie
    // alone cannot be the authorisation — a cross-origin page cannot read the
    // CSRF cookie, and this is what stops it.
    const client = await TestClient.connect();
    client.send({ type: 'hello', csrfToken: 'not-the-token' });
    expect(await client.waitForClose()).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it('refuses any other frame before the handshake', async () => {
    const client = await TestClient.connect();
    client.send({ type: 'subscribe', topics: ['system'] });
    expect(await client.waitForClose()).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it('completes with a valid token and answers a ping', async () => {
    const client = await TestClient.connect();
    client.send({ type: 'hello', csrfToken });

    const ready = await client.waitFor('ready');
    expect(Number(ready.resumeToken)).toBeGreaterThanOrEqual(0);

    client.send({ type: 'ping', t: 12_345 });
    expect((await client.waitFor('pong')).t).toBe(12_345);
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Fan-out                                                                     */
/* -------------------------------------------------------------------------- */

describe('subscriptions', () => {
  it('delivers only the topics a client asked for, and stamps each with its sequence', async () => {
    const topic = sessionTopic('ses_fanout');
    const client = await TestClient.connect();
    await client.start([topic]);

    const first = context.bus.publish(topic, notice(topic, 'mine'));
    context.bus.publish(sessionTopic('ses_other'), notice(sessionTopic('ses_other'), 'not mine'));
    const third = context.bus.publish(topic, notice(topic, 'mine too'));

    await client.waitFor('notification');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.titles()).toEqual(['mine', 'mine too']);
    const seqs = client.received
      .filter((entry) => entry.frame.type === 'notification')
      .map((entry) => entry.seq);
    expect(seqs).toEqual([first, third]);
    client.close();
  });

  it('stops delivering after an unsubscribe', async () => {
    const topic = sessionTopic('ses_unsub');
    const client = await TestClient.connect();
    await client.start([topic]);

    context.bus.publish(topic, notice(topic, 'before'));
    await client.waitFor('notification');

    client.send({ type: 'unsubscribe', topics: [topic] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    context.bus.publish(topic, notice(topic, 'after'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.titles()).toEqual(['before']);
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Reconnect replay                                                            */
/* -------------------------------------------------------------------------- */

describe('reconnect replay', () => {
  it('delivers what was published while the socket was away', async () => {
    // The regression: the server issued a `resumeToken` and kept a ring buffer,
    // but never accepted a cursor back — so `bus.replay` was dead code and a
    // reconnect silently dropped everything published in the gap. A run that
    // finished while the phone was locked stayed "running" until a reload.
    const topic = sessionTopic('ses_resume');

    const first = await TestClient.connect();
    await first.start([topic]);
    context.bus.publish(topic, notice(topic, 'seen'));
    const seenAt = (await first.waitFor('notification'), first.received.at(-1)!.seq);
    expect(seenAt).not.toBeNull();
    first.close();

    // Published with nobody listening.
    context.bus.publish(topic, notice(topic, 'missed one'));
    context.bus.publish(topic, notice(topic, 'missed two'));

    const second = await TestClient.connect();
    const subscribed = (await second.start([topic], String(seenAt)), await second.waitFor('subscribed'));

    expect(subscribed.replayed).toBe(2);
    expect(second.titles()).toEqual(['missed one', 'missed two']);
    second.close();
  });

  it('does not replay the same window twice', async () => {
    const topic = sessionTopic('ses_twice');
    context.bus.publish(topic, notice(topic, 'a'));
    context.bus.publish(topic, notice(topic, 'b'));

    const client = await TestClient.connect();
    await client.start([topic], '0');
    expect(client.titles()).toEqual(['a', 'b']);

    // A replayed frame carries its sequence, so the client's cursor advances
    // past it — asking again from there yields nothing.
    const cursor = client.received.at(-1)!.seq;
    client.close();

    const again = await TestClient.connect();
    const subscribed = (await again.start([topic], String(cursor)), await again.waitFor('subscribed'));
    expect(subscribed.replayed).toBe(0);
    expect(again.titles()).toEqual([]);
    again.close();
  });

  it('replays nothing when no cursor is given', async () => {
    const topic = sessionTopic('ses_nocursor');
    context.bus.publish(topic, notice(topic, 'earlier'));

    const client = await TestClient.connect();
    const subscribed = (await client.start([topic]), await client.waitFor('subscribed'));

    expect(subscribed.replayed).toBe(0);
    expect(client.titles()).toEqual([]);
    client.close();
  });

  it('ignores a malformed cursor rather than failing the subscription', async () => {
    const topic = sessionTopic('ses_badcursor');
    context.bus.publish(topic, notice(topic, 'x'));

    const client = await TestClient.connect();
    const subscribed = (await client.start([topic], 'not-a-number'), await client.waitFor('subscribed'));

    expect(subscribed.topics).toEqual([topic]);
    expect(subscribed.replayed).toBe(0);
    client.close();
  });

  it('excludes streaming deltas from the replay', async () => {
    // Deltas are superseded by the authoritative transcript frame that follows,
    // so replaying them would duplicate text that is already there.
    const topic = sessionTopic('ses_deltas');
    context.bus.publish(topic, {
      type: 'delta',
      topic,
      runId: 'run_1',
      eventId: 'ev_1',
      channel: 'assistant_text',
      text: 'hello',
    });
    context.bus.publish(topic, notice(topic, 'kept'));

    const client = await TestClient.connect();
    const subscribed = (await client.start([topic], '0'), await client.waitFor('subscribed'));

    expect(subscribed.replayed).toBe(1);
    expect(client.received.some((entry) => entry.frame.type === 'delta')).toBe(false);
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Revocation                                                                  */
/* -------------------------------------------------------------------------- */

describe('a revoked session loses its socket', () => {
  /**
   * The socket authenticated once, at the upgrade, and never again.
   *
   * So "log out", "revoke my other sessions" and a password change all left an
   * already-open socket fully privileged: still receiving every transcript, and
   * still able to approve the tool calls the agent asks about. Those controls
   * exist for exactly one situation — "someone else may have my session" — and
   * that is the situation in which they did the least.
   *
   * Its own session is used rather than a second one, because revoking the
   * connection you are holding is the strongest version of the property and the
   * cheapest to arrange.
   */
  async function loginSeparately(): Promise<{ cookie: string; csrf: string }> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    const setCookies = response.headers.getSetCookie();
    const csrf = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    return {
      cookie: setCookies.map((c) => c.split(';')[0]).join('; '),
      csrf: decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!),
    };
  }

  it('closes the socket once the session behind it is revoked', async () => {
    const { cookie, csrf } = await loginSeparately();
    const client = await TestClient.connect({ cookie });
    client.send({ type: 'hello', csrfToken: csrf });
    await client.waitFor('ready');

    // Log that session out through the ordinary route the UI uses.
    const out = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'x-metaclaude-csrf': csrf },
    });
    expect(out.status).toBe(200);

    // A frame from a session that no longer exists must not be served.
    client.send({ type: 'ping', t: 1 });
    expect(await client.waitForClose(3000)).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it('stops delivering published frames to a revoked session', async () => {
    // The confidentiality half. Even a silent client — one that sends nothing
    // after being revoked — must stop receiving the transcript.
    const { cookie, csrf } = await loginSeparately();
    const client = await TestClient.connect({ cookie });
    client.send({ type: 'hello', csrfToken: csrf });
    await client.waitFor('ready');
    client.send({ type: 'subscribe', topics: [SYSTEM_TOPIC] });
    await client.waitFor('subscribed');

    await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'x-metaclaude-csrf': csrf },
    });
    // Up to the revalidation interval, not the ping heartbeat: a listening
    // client sends nothing to be checked, so the timer is what cuts it off.
    await client.waitForClose(9000);

    context.bus.publish(SYSTEM_TOPIC, notice(SYSTEM_TOPIC, 'after-revocation'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(client.titles()).not.toContain('after-revocation');
  });

  it('leaves a live session connected', async () => {
    // The other half of the rule: revalidating must not start dropping sockets
    // whose session is perfectly good.
    const { cookie, csrf } = await loginSeparately();
    const client = await TestClient.connect({ cookie });
    client.send({ type: 'hello', csrfToken: csrf });
    await client.waitFor('ready');

    client.send({ type: 'ping', t: 7 });
    await client.waitFor('pong');
    expect(client.closeCode).toBeNull();
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * No test in this repository had ever created a second user, so every role
 * guard was unverified end to end. `guards.test.ts` covers `requireRole` as a
 * pure function, but the two checks below are inline `role === 'viewer'`
 * branches in the frame handler that the guards module cannot reach even in
 * principle — deleting either was invisible to the suite.
 */
describe('viewer role', () => {
  const VIEWER = 'watcher';
  const VIEWER_PASSWORD = 'a-long-enough-viewer-password';
  let viewerCookie: string;
  let viewerCsrf: string;

  beforeAll(async () => {
    await context.auth.createUser({
      username: VIEWER,
      password: VIEWER_PASSWORD,
      role: 'viewer',
    });
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: VIEWER, password: VIEWER_PASSWORD }),
    });
    expect(response.status).toBe(200);
    const setCookies = response.headers.getSetCookie();
    viewerCookie = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
    viewerCsrf = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);
  });

  async function viewerClient(): Promise<TestClient> {
    const client = await TestClient.connect({ cookie: viewerCookie });
    client.send({ type: 'hello', csrfToken: viewerCsrf });
    await client.waitFor('ready');
    return client;
  }

  it('may connect and watch', async () => {
    const client = await viewerClient();
    client.send({ type: 'subscribe', topics: [SYSTEM_TOPIC] });
    await client.waitFor('subscribed');
    context.bus.publish(SYSTEM_TOPIC, notice(SYSTEM_TOPIC, 'viewer-can-watch'));
    await client.waitFor('notification');
    expect(client.titles()).toContain('viewer-can-watch');
    client.close();
  });

  it('cannot decide an approval', async () => {
    const client = await viewerClient();
    client.send({
      type: 'approval',
      decision: { approvalId: 'apr_whatever', approved: true, remember: false },
    });
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
    client.close();
  });

  it('cannot interrupt a run', async () => {
    const client = await viewerClient();
    client.send({ type: 'interrupt', sessionId: 'ses_whatever' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
    client.close();
  });

  it('is refused by the HTTP approval route too, before the approval is even looked up', async () => {
    // The socket and the route must agree: a viewer who works out the REST
    // shape must not get through the door the UI does not use.
    const response = await fetch(`${baseUrl}/api/approvals/apr_whatever`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: viewerCookie,
        'x-metaclaude-csrf': viewerCsrf,
      },
      body: JSON.stringify({ approved: true }),
    });
    // 403, not the 404 an operator would get for an unknown approval id.
    expect(response.status).toBe(403);
  });
});
