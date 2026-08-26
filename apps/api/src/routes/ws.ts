/**
 * WebSocket gateway.
 *
 * One socket per client, multiplexed by topic. Authentication rides on the
 * session cookie (the browser sends it on the upgrade request); the first frame
 * must then present the CSRF token, which stops a cross-origin page from opening
 * an authenticated socket even though `WebSocket` ignores CORS.
 */

import { decideApproval } from '../http/approvals.js';
import type { App } from '../http/types.js';
import type { WebSocket } from 'ws';
import {
  ClientFrame,
  CLOSE_CODES,
  APP_VERSION,
  SESSION_COOKIE,
  toWireFrame,
  type ServerFrame,
  type Topic,
} from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { TokenBucket } from '../security/ratelimit.js';

/** 120 frames burst, refilling at 20/second. Generous for a UI, tight for abuse. */
const frameBucket = new TokenBucket(120, 20);

/** Sockets that never complete the handshake are closed. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Liveness probe interval; a socket that misses two is dropped. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * How often an open socket re-checks that its session still exists.
 *
 * Separate from the heartbeat, and shorter, because they answer different
 * questions. The heartbeat asks whether the peer is still there; this asks
 * whether it is still allowed to be. A client that goes quiet after being
 * revoked sends no frame to check against, so without this the server would
 * keep pushing transcripts at it until the next ping — and "revoke my other
 * sessions" is pressed precisely when half a minute of continued delivery is
 * the thing being prevented.
 *
 * Two indexed selects per socket per interval, with `authenticate` throttling
 * its own write to once a minute. On a personal deployment that is nothing.
 */
const REVALIDATE_INTERVAL_MS = 5_000;

export function registerWebSocket(app: App, context: AppContext): void {
  app.get('/api/ws', { websocket: true }, (socket: WebSocket, request) => {
    /* -------------------- Authenticate the upgrade -------------------- */

    const token = request.cookies[SESSION_COOKIE];
    const session = token ? context.auth.authenticate(token) : null;
    if (!session) {
      socket.close(CLOSE_CODES.UNAUTHORIZED, 'Not signed in');
      return;
    }

    const clientAddress = request.ip;
    const subscriptions = new Map<Topic, () => void>();
    let handshaken = false;
    let alive = true;

    /**
     * The session as it stands *now*, re-read rather than remembered.
     *
     * The upgrade above authenticates once, and a socket then lives for hours.
     * Holding that first answer meant "log out", "revoke my other sessions" and
     * a password change all left an already-open connection fully privileged —
     * still receiving every transcript, and still able to approve the tool calls
     * the agent asks about. Those controls exist for one situation, "someone
     * else may have my session", and that is the situation in which they did the
     * least.
     *
     * `authenticate` re-reads the row and honours `revoked_at` and both expiry
     * windows, so calling it again is the revocation check. It is two indexed
     * selects and throttles its own write to once a minute, which is why this is
     * affordable on every inbound frame as well as on the heartbeat.
     *
     * Refreshing rather than merely checking also means a role change takes
     * effect on the open socket: demote someone to `viewer` and the guards below
     * start refusing them, instead of waiting for a reconnect.
     */
    let current = session;
    const stillAuthorised = (): boolean => {
      const fresh = token ? context.auth.authenticate(token) : null;
      if (!fresh) {
        fail(CLOSE_CODES.UNAUTHORIZED, 'Session ended');
        return false;
      }
      current = fresh;
      return true;
    };

    /**
     * @param seq Bus sequence for a published frame. The client records the
     *            highest one it sees and replays from there after a reconnect;
     *            connection-local frames (`ready`, `pong`, …) have none.
     */
    const send = (frame: ServerFrame, seq?: number): void => {
      // readyState 1 === OPEN. Writing to a closing socket throws.
      if (socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify(toWireFrame(frame, seq)));
      } catch {
        // The socket died between the check and the write; cleanup will follow.
      }
    };

    const fail = (code: number, message: string): void => {
      try {
        socket.close(code, message);
      } catch {
        // Already closed.
      }
    };

    // A socket that authenticates but never says hello is either a bug or a
    // probe; either way it should not hold a slot.
    const handshakeTimer = setTimeout(() => {
      if (!handshaken) fail(CLOSE_CODES.BAD_FRAME, 'Handshake timed out');
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    const heartbeat = setInterval(() => {
      if (!alive) {
        fail(CLOSE_CODES.GOING_AWAY, 'No response to heartbeat');
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        fail(CLOSE_CODES.GOING_AWAY, 'Ping failed');
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    // The confidentiality half of revocation: a silent client is cut off on
    // this timer rather than on its next frame, because a revoked client that
    // only listens has no next frame.
    const revalidation = setInterval(() => {
      stillAuthorised();
    }, REVALIDATE_INTERVAL_MS);
    revalidation.unref?.();

    socket.on('pong', () => {
      alive = true;
    });

    /* ---------------------------- Subscriptions ---------------------------- */

    /**
     * Subscribe, and replay the gap.
     *
     * `since` is the highest sequence the client has already applied. Replaying
     * from there is the whole point of the bus's ring buffer: without it a
     * reconnect silently loses every frame published while the socket was down
     * — a finished run still showing as running, a transcript missing its tail.
     *
     * The replay is emitted *before* the listener is attached, and this whole
     * loop is synchronous, so nothing can be published into the gap: the client
     * sees the buffered frames and then the live ones, in publication order.
     * Frames older than the buffer window are simply absent — the client
     * refetches on reconnect anyway, so an overrun degrades to the previous
     * behaviour rather than to a wrong ordering.
     */
    const subscribe = (topics: Topic[], since?: string): { accepted: Topic[]; replayed: number } => {
      const accepted: Topic[] = [];
      let replayed = 0;

      const cursor = since === undefined ? null : Number(since);
      const afterSeq =
        cursor !== null && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;

      for (const topic of topics) {
        if (subscriptions.has(topic)) {
          accepted.push(topic);
          continue;
        }
        // A cap on topics per socket: each one holds a listener and a buffer.
        if (subscriptions.size >= 64) break;

        if (afterSeq !== null) {
          for (const missed of context.bus.replay(topic, afterSeq)) {
            send(missed.frame, missed.seq);
            replayed += 1;
          }
        }

        const unsubscribe = context.bus.subscribe(topic, (frame, seq) => send(frame, seq));
        subscriptions.set(topic, unsubscribe);
        accepted.push(topic);
      }
      return { accepted, replayed };
    };

    const unsubscribe = (topics: Topic[]): void => {
      for (const topic of topics) {
        subscriptions.get(topic)?.();
        subscriptions.delete(topic);
      }
    };

    /* ------------------------------ Messages ------------------------------ */

    socket.on('message', (raw: Buffer) => {
      if (!frameBucket.take(clientAddress)) {
        fail(CLOSE_CODES.RATE_LIMITED, 'Too many frames');
        return;
      }
      // A single oversized frame is never legitimate on this protocol.
      //
      // A backstop, not the control: `server.ts` sets ws's own
      // `maxPayload: 64 * 1024`, which refuses the frame before it is
      // assembled and closes with the standard 1009. That is the better place
      // for it — the bytes are never buffered — so this branch only becomes
      // reachable if `maxPayload` is ever raised above the figure here. Keep
      // the two in step.
      if (raw.length > 64 * 1024) {
        fail(CLOSE_CODES.BAD_FRAME, 'Frame too large');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        send({ type: 'error', code: 'bad_json', message: 'Frame was not valid JSON.' });
        return;
      }

      const frame = ClientFrame.safeParse(parsed);
      if (!frame.success) {
        send({ type: 'error', code: 'bad_frame', message: 'Frame failed validation.' });
        return;
      }

      // Everything except `hello` requires a completed handshake.
      if (!handshaken && frame.data.type !== 'hello') {
        fail(CLOSE_CODES.UNAUTHORIZED, 'Handshake required');
        return;
      }

      // And every frame requires a session that still exists. Checked here
      // rather than per case so a new frame type cannot be added without it,
      // and before the switch so a revoked client is answered by a close rather
      // than by whatever it asked for.
      if (!stillAuthorised()) return;

      switch (frame.data.type) {
        case 'hello': {
          if (!context.auth.verifyCsrf(current.sessionId, frame.data.csrfToken)) {
            fail(CLOSE_CODES.UNAUTHORIZED, 'Invalid CSRF token');
            return;
          }
          handshaken = true;
          clearTimeout(handshakeTimer);
          send({
            type: 'ready',
            serverTime: Date.now(),
            version: APP_VERSION,
            resumeToken: String(context.bus.currentSeq),
          });
          break;
        }

        case 'subscribe': {
          const { accepted, replayed } = subscribe(frame.data.topics, frame.data.since);
          send({ type: 'subscribed', topics: accepted, replayed });
          break;
        }

        case 'unsubscribe':
          unsubscribe(frame.data.topics);
          break;

        case 'ping':
          send({ type: 'pong', t: frame.data.t });
          break;

        case 'approval': {
          // Viewers may watch, but only operators may decide.
          if (current.user.role === 'viewer') {
            send({ type: 'error', code: 'forbidden', message: 'Viewers cannot approve tools.' });
            break;
          }
          const decision = frame.data.decision;
          const resolved = decideApproval(
            context,
            {
              approvalId: decision.approvalId,
              approved: decision.approved,
              remember: decision.remember,
              ...(decision.reason ? { reason: decision.reason } : {}),
            },
            { username: current.user.username, ipAddress: clientAddress, via: 'websocket' },
          );
          if (!resolved) {
            send({
              type: 'error',
              code: 'stale_approval',
              message: 'That approval is no longer pending.',
            });
          }
          break;
        }

        case 'interrupt': {
          if (current.user.role === 'viewer') {
            send({ type: 'error', code: 'forbidden', message: 'Viewers cannot interrupt runs.' });
            break;
          }
          context.kernel.interrupt(frame.data.sessionId);
          break;
        }
      }
    });

    /* ------------------------------ Teardown ------------------------------ */

    const cleanup = (): void => {
      clearTimeout(handshakeTimer);
      clearInterval(heartbeat);
      clearInterval(revalidation);
      for (const unsub of subscriptions.values()) unsub();
      subscriptions.clear();
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
