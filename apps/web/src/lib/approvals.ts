/**
 * Deciding a permission prompt, from the client side.
 *
 * The socket is the fast path and HTTP is what makes the decision durable.
 * Both exist already; what was missing was anything that noticed when the
 * first one silently dropped the frame.
 *
 * `SocketClient.send` discards a frame whenever `readyState` is not OPEN — no
 * queue, no throw, no return value — and `approve()` was a bare call to it, so
 * no caller could observe the loss. That is not an exotic state for this app:
 * reconnection is deliberately paused while the tab is hidden, so the canonical
 * flow — phone wakes, operator opens the standalone PWA to answer a prompt,
 * taps Allow — begins with the socket closed and passes through CONNECTING
 * before `ready` arrives. A tap in that window went nowhere, the card stayed
 * disabled, and ten minutes later the server's approval timeout denied the
 * tool. Fail-safe in direction, wrong in outcome, and invisible except for an
 * 8px connection badge.
 */

import { api } from '@/lib/api';
import { socket } from '@/lib/socket';

/**
 * Send a decision, falling back to HTTP when the socket could not carry it.
 *
 * Rejects when neither transport got through, which is the caller's cue to
 * re-enable the buttons rather than leaving the operator with a dead card.
 */
export async function decideApproval(
  approvalId: string,
  approved: boolean,
  remember = false,
): Promise<void> {
  if (socket.approve(approvalId, approved, remember)) return;
  await api.decideApproval(approvalId, { approved, remember });
}
