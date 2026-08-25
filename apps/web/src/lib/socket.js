/**
 * WebSocket client.
 *
 * Responsibilities beyond "open a socket":
 *  - Reconnect with exponential backoff and jitter, and re-subscribe to
 *    everything the app was watching so a dropped connection is invisible.
 *  - Keep a reference count per topic, so two components watching the same
 *    session do not unsubscribe each other.
 *  - Pause reconnection while the tab is hidden and the socket is closed, which
 *    matters on a phone where the OS suspends background tabs aggressively.
 */
import { CLOSE_CODES, ServerFrame, } from '@metaclaude/shared';
import { readCsrfToken } from './api';
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;
/** Client-side keepalive; the server also pings independently. */
const PING_INTERVAL_MS = 25_000;
export class SocketClient {
    socket = null;
    state = 'closed';
    attempts = 0;
    reconnectTimer = null;
    pingTimer = null;
    /** topic → number of components currently interested in it. */
    topicRefs = new Map();
    frameHandlers = new Set();
    stateHandlers = new Set();
    disposed = false;
    connect() {
        if (this.disposed)
            return;
        if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1))
            return;
        this.setState('connecting');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}/api/ws`;
        let socket;
        try {
            socket = new WebSocket(url);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onopen = () => {
            const csrfToken = readCsrfToken();
            if (!csrfToken) {
                // Without a CSRF token the handshake cannot succeed; the session is
                // effectively gone, so surface that rather than looping.
                this.setState('unauthorised');
                socket.close();
                return;
            }
            this.send({ type: 'hello', csrfToken });
        };
        socket.onmessage = (event) => {
            let parsed;
            try {
                parsed = JSON.parse(String(event.data));
            }
            catch {
                return;
            }
            const frame = ServerFrame.safeParse(parsed);
            if (!frame.success)
                return;
            if (frame.data.type === 'ready') {
                this.attempts = 0;
                this.setState('open');
                // Re-assert every subscription: after a reconnect the server knows
                // nothing about what this client was watching.
                const topics = [...this.topicRefs.keys()];
                if (topics.length > 0)
                    this.send({ type: 'subscribe', topics });
                this.startPing();
            }
            for (const handler of this.frameHandlers) {
                try {
                    handler(frame.data);
                }
                catch {
                    // A broken consumer must not stall the socket.
                }
            }
        };
        socket.onclose = (event) => {
            this.stopPing();
            this.socket = null;
            if (this.disposed)
                return;
            if (event.code === CLOSE_CODES.UNAUTHORIZED) {
                // Reconnecting cannot fix a missing session; the app must re-authenticate.
                this.setState('unauthorised');
                return;
            }
            this.setState('closed');
            this.scheduleReconnect();
        };
        socket.onerror = () => {
            // `onclose` always follows; handling it there keeps the logic in one place.
        };
    }
    scheduleReconnect() {
        if (this.disposed || this.reconnectTimer)
            return;
        // A hidden tab may be throttled or suspended; wait until it is visible
        // again rather than burning retries in the background.
        if (document.visibilityState === 'hidden') {
            const resume = () => {
                document.removeEventListener('visibilitychange', resume);
                this.connect();
            };
            document.addEventListener('visibilitychange', resume);
            return;
        }
        // Exponential backoff with full jitter, which avoids a thundering herd when
        // several tabs reconnect after the same server restart.
        const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts);
        const delay = Math.random() * ceiling;
        this.attempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }
    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            this.send({ type: 'ping', t: Date.now() });
        }, PING_INTERVAL_MS);
    }
    stopPing() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = null;
    }
    send(frame) {
        if (this.socket?.readyState !== 1)
            return;
        try {
            this.socket.send(JSON.stringify(frame));
        }
        catch {
            // The socket closed between the check and the write.
        }
    }
    /**
     * Subscribe to a topic. Returns an unsubscribe function.
     * Reference-counted: the server-side subscription is only dropped when the
     * last interested component releases it.
     */
    subscribe(topic) {
        const count = this.topicRefs.get(topic) ?? 0;
        this.topicRefs.set(topic, count + 1);
        if (count === 0)
            this.send({ type: 'subscribe', topics: [topic] });
        return () => {
            const current = this.topicRefs.get(topic) ?? 0;
            if (current <= 1) {
                this.topicRefs.delete(topic);
                this.send({ type: 'unsubscribe', topics: [topic] });
            }
            else {
                this.topicRefs.set(topic, current - 1);
            }
        };
    }
    onFrame(handler) {
        this.frameHandlers.add(handler);
        return () => this.frameHandlers.delete(handler);
    }
    onState(handler) {
        this.stateHandlers.add(handler);
        handler(this.state);
        return () => this.stateHandlers.delete(handler);
    }
    approve(approvalId, approved, remember = false, reason) {
        this.send({
            type: 'approval',
            decision: { approvalId, approved, remember, ...(reason ? { reason } : {}) },
        });
    }
    interrupt(sessionId) {
        this.send({ type: 'interrupt', sessionId });
    }
    setState(state) {
        if (this.state === state)
            return;
        this.state = state;
        for (const handler of this.stateHandlers)
            handler(state);
    }
    get connectionState() {
        return this.state;
    }
    /** Close permanently. Used on sign-out. */
    dispose() {
        this.disposed = true;
        this.stopPing();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.topicRefs.clear();
        this.frameHandlers.clear();
        try {
            this.socket?.close();
        }
        catch {
            // Already closed.
        }
        this.socket = null;
        this.setState('closed');
    }
    /** Re-arm after a sign-out/sign-in cycle. */
    revive() {
        this.disposed = false;
        this.attempts = 0;
        this.connect();
    }
}
export const socket = new SocketClient();
//# sourceMappingURL=socket.js.map