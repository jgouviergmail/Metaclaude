/**
 * Deciding a permission prompt — one implementation, two transports.
 *
 * This existed twice: once in the WebSocket frame handler and once in
 * `POST /api/approvals/:id`. They diverged, and the transport the UI actually
 * uses got the weaker half. The HTTP route read the pending request *before*
 * resolving it, so its audit line named the tool, the risk and the session; the
 * socket recorded `target: <approvalId>` and the detail `via websocket`, and
 * the broker deletes the entry on decision, so that id resolves to nothing
 * afterwards. There is no `approvals` table and no transcript row keyed by it —
 * the audit line was the only record of what had been authorised, and on the
 * live path it recorded a dangling pointer.
 *
 * Nothing about the decision is transport-specific, so nothing here is.
 */

import type { AppContext } from '../context.js';

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  remember: boolean;
  reason?: string;
}

export interface ApprovalActor {
  username: string;
  ipAddress: string | null;
  /** How the decision arrived. Recorded, but never load-bearing. */
  via: 'http' | 'websocket';
}

/**
 * Resolve a pending approval and record it.
 *
 * Returns `false` when the approval is no longer pending — the run moved on,
 * the ten-minute timeout fired, or the same decision already arrived over the
 * other transport. That last case is ordinary, not an error: the client mirrors
 * a decision over HTTP when it cannot prove the socket carried it.
 */
export function decideApproval(
  context: AppContext,
  decision: ApprovalDecision,
  actor: ApprovalActor,
): boolean {
  // Read before resolving: `resolve` removes the entry, and an audit line
  // naming only an id that no longer exists cannot be reconstructed into what
  // was actually authorised.
  const pending = context.kernel.broker
    .listPending()
    .find((approval) => approval.id === decision.approvalId);

  const resolved = context.kernel.broker.resolve(
    decision.approvalId,
    decision.approved,
    decision.remember,
    decision.reason,
  );
  if (!resolved) return false;

  const detail = [
    pending ? `${pending.toolName} (${pending.risk} risk)` : null,
    pending?.summary ?? null,
    decision.remember ? 'remembered for the session' : null,
    `via ${actor.via}`,
  ]
    .filter(Boolean)
    .join(' — ');

  context.audit.record({
    actor: actor.username,
    action: decision.approved ? 'approval.allow' : 'approval.deny',
    target: pending?.sessionId ?? decision.approvalId,
    ipAddress: actor.ipAddress,
    detail: detail.length > 0 ? detail : null,
  });
  return true;
}
