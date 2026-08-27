/**
 * Web push — the OS able to reach the phone it is operated from.
 *
 * Until now everything Metaclaude had to say waited for the owner to open a
 * tab. The one case where that is untenable is an approval: a run stops,
 * ten minutes tick, and the person whose decision it needs has no idea. So
 * this exists for exactly two sounds — "a run is waiting on you" and "the
 * run you started is done" — and deliberately not for the machinery.
 * Automations, loops and delegated runs work while the owner sleeps; a
 * notification channel that wakes them for those trains them to disable it.
 *
 * Self-hosted end to end: the VAPID key pair is generated once and sealed
 * in the vault (regenerating it would orphan every browser subscription,
 * which is why it lives beside the other secrets and not in a file), and
 * the only third party involved is the push relay the *browser* chose —
 * which sees an encrypted payload and nothing else. Payloads carry the
 * minimum a notification needs: title, a short body, a same-origin URL to
 * open, a tag to coalesce duplicates. No prompt text, no tool input.
 *
 * Delivery is RFC 8291 (aes128gcm) + VAPID JWTs, implemented by the
 * `web-push` library rather than here: hand-rolling that crypto to save a
 * dependency is how a subtle nonce bug ships. The transport is injectable,
 * so tests drive every outcome without a network.
 */

import webpush from 'web-push';
import { newId } from '@metaclaude/shared';
import type {
  ApprovalRequest,
  PushSubscriptionInput,
  Run,
  ServerFrame,
} from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import type { Vault } from '../security/vault.js';

/** Vault slots. Global: the identity is the deployment's. */
const VAPID_PUBLIC_KEY = 'push.vapid_public';
const VAPID_PRIVATE_KEY = 'push.vapid_private';

/**
 * The VAPID subject — who to contact about misbehaving senders. Push relays
 * require the shape (mailto: or https:), none deliver anything to it, and a
 * self-hosted single-owner box has no meaningful address to put there.
 */
const SUBJECT = 'mailto:owner@metaclaude.invalid';

export interface PushPayload {
  title: string;
  body: string;
  /** Same-origin path the notification opens, e.g. `/w/ws_1/s/ses_1`. */
  url: string;
  /** Coalesces re-sends of the same event on the device. */
  tag: string;
}

export interface PushSendOptions {
  ttlSeconds: number;
  urgency: 'high' | 'normal';
}

export type PushSend = (
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  options: PushSendOptions,
) => Promise<void>;

export interface PushDeps {
  db: Db;
  vault: Vault;
  /** Injectable transport; the default wraps `web-push`. */
  send?: PushSend;
  now?: () => number;
  log: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushService {
  private readonly send: PushSend;
  private readonly now: () => number;

  constructor(private readonly deps: PushDeps) {
    this.send = deps.send ?? this.defaultSend.bind(this);
    this.now = deps.now ?? Date.now;
  }

  /** The public half browsers subscribe with; generates the pair on first ask. */
  publicKey(): string {
    return this.keys().publicKey;
  }

  private keys(): { publicKey: string; privateKey: string } {
    const publicKey = this.deps.vault.get('global', VAPID_PUBLIC_KEY);
    const privateKey = this.deps.vault.get('global', VAPID_PRIVATE_KEY);
    if (publicKey && privateKey) return { publicKey, privateKey };

    const generated = webpush.generateVAPIDKeys();
    this.deps.vault.set('global', VAPID_PUBLIC_KEY, generated.publicKey);
    this.deps.vault.set('global', VAPID_PRIVATE_KEY, generated.privateKey);
    this.deps.log('info', 'generated the deployment VAPID key pair');
    return generated;
  }

  /**
   * Store a browser subscription. The endpoint is the identity: the same
   * browser re-subscribing (rotated keys, another signed-in user) replaces
   * its row, so a device is never counted twice.
   */
  subscribe(userId: string, input: PushSubscriptionInput): void {
    this.deps.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           last_error = NULL`,
      )
      .run(newId('pushSub'), userId, input.endpoint, input.keys.p256dh, input.keys.auth, this.now());
  }

  /** Remove one of the caller's own devices. Someone else's is not theirs to remove. */
  unsubscribe(userId: string, endpoint: string): boolean {
    return (
      this.deps.db
        .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
        .run(endpoint, userId).changes > 0
    );
  }

  devices(): number {
    const row = this.deps.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions')
      .get();
    return row?.n ?? 0;
  }

  /**
   * Fan a notification out to every device.
   *
   * A relay answering 404 or 410 means the subscription no longer exists —
   * the browser unsubscribed, or the endpoint rotated — and keeping the row
   * would fail forever; it is deleted. Anything else is weather: the row
   * stays, the error is recorded where the operator can see it.
   */
  async notify(
    payload: PushPayload,
    options: PushSendOptions = { ttlSeconds: 3600, urgency: 'normal' },
  ): Promise<{ devices: number; sent: number; pruned: number; lastError: string | null }> {
    const rows = this.deps.db
      .prepare<[], SubscriptionRow>('SELECT * FROM push_subscriptions')
      .all();
    if (rows.length === 0) return { devices: 0, sent: 0, pruned: 0, lastError: null };

    const body = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;
    // `devices` and `lastError` exist so a caller can tell "nobody is
    // subscribed" apart from "every delivery failed" — with only `sent`,
    // the test button diagnosed a relay outage as an absent subscription.
    let lastError: string | null = null;

    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.send({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, body, options);
          sent += 1;
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            this.deps.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
            pruned += 1;
            return;
          }
          lastError = (error as Error).message.slice(0, 300);
          this.deps.db
            .prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?')
            .run(lastError, row.id);
          this.deps.log('warn', 'a push delivery failed', {
            endpoint: new URL(row.endpoint).host,
            message: (error as Error).message,
          });
        }
      }),
    );

    return { devices: rows.length, sent, pruned, lastError };
  }

  private async defaultSend(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: string,
    options: PushSendOptions,
  ): Promise<void> {
    const keys = this.keys();
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      {
        vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: options.ttlSeconds,
        urgency: options.urgency,
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* What deserves a buzz                                                        */
/* -------------------------------------------------------------------------- */

export interface PushEventDeps {
  push: Pick<PushService, 'notify'>;
  sessions: { get(id: string): { title: string } | null };
  workspaces: { get(id: string): { name: string } | null };
  log: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

const BODY_LIMIT = 160;

/**
 * The two event streams worth interrupting a person for, as bus/kernel
 * listeners. Fire-and-forget by design: a push that cannot be delivered
 * must never slow the run that caused it.
 */
export function buildPushEventHandlers(deps: PushEventDeps): {
  onSystemFrame: (frame: ServerFrame) => void;
  onRunFinished: (run: Run) => void;
} {
  const dispatch = (payload: PushPayload, options: PushSendOptions): void => {
    deps.push.notify(payload, options).catch((error: Error) => {
      deps.log('warn', 'push fan-out failed', { message: error.message });
    });
  };

  return {
    onSystemFrame: (frame) => {
      if (frame.type !== 'approval_request') return;
      const request = frame.request as ApprovalRequest;
      const workspace = deps.workspaces.get(request.workspaceId);
      dispatch(
        {
          title: 'Approval needed',
          body: clip(
            `${workspace?.name ?? 'A workspace'} · ${request.toolName} (${request.risk} risk) — ${request.summary}`,
          ),
          url: `/w/${request.workspaceId}/s/${request.sessionId}`,
          tag: `approval-${request.id}`,
        },
        // An approval expires after ten minutes; a push delivered later
        // would be a lie waiting on a lock screen.
        { ttlSeconds: 600, urgency: 'high' },
      );
    },

    onRunFinished: (run) => {
      // Only runs a human started. The machinery — automations, loops,
      // delegations, system runs — works while the owner sleeps, and a
      // channel that wakes them for it gets disabled within a week.
      if (run.triggeredBy !== 'user') return;

      const workspace = deps.workspaces.get(run.workspaceId);
      const session = deps.sessions.get(run.sessionId);
      const title =
        run.status === 'succeeded'
          ? 'Run finished'
          : run.status === 'failed'
            ? 'Run failed'
            : 'Run interrupted';
      dispatch(
        {
          title,
          body: clip(
            `${workspace?.name ?? 'A workspace'} · ${session?.title || 'Untitled session'}${
              run.error ? ` — ${run.error}` : ''
            }`,
          ),
          url: `/w/${run.workspaceId}/s/${run.sessionId}`,
          tag: `run-${run.id}`,
        },
        { ttlSeconds: 3600, urgency: run.status === 'failed' ? 'high' : 'normal' },
      );
    },
  };
}

function clip(text: string): string {
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT - 1)}…` : text;
}
