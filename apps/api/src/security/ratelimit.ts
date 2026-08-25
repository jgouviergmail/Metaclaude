/**
 * Rate limiting and brute-force protection.
 *
 * Two complementary mechanisms:
 *
 * - `TokenBucket` — smooth, in-memory throttling for high-frequency endpoints
 *   (WebSocket frames, file reads). Cheap and forgiving of bursts.
 * - `LoginThrottle` — exponential lockout for authentication, persisted on the
 *   user row so a restart does not reset an attacker's budget.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  /**
   * Consume `cost` tokens for `key`.
   * @returns `true` when allowed, `false` when the caller should be rejected.
   */
  take(key: string, cost = 1, now: number = Date.now()): boolean {
    this.sweep(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSeconds = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** Seconds until `cost` tokens would be available again. */
  retryAfter(key: string, cost = 1, now: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    const tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    if (tokens >= cost) return 0;
    return Math.ceil((cost - tokens) / this.refillPerSecond);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Evict buckets that have fully refilled — they are indistinguishable from a
   * fresh bucket, so keeping them only wastes memory. Bounded so an attacker
   * cycling keys cannot grow the map without limit.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.buckets.size < 10_000) return;
    this.lastSweep = now;
    const fullAfterMs = (this.capacity / this.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > fullAfterMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Exponential backoff for failed logins.
 *
 * Delay after n failures: 0, 0, 0, 2s, 4s, 8s, ... capped at 15 minutes. The
 * first few attempts are free so a genuine typo is not punished.
 */
export const LOGIN_FREE_ATTEMPTS = 3;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

export function lockoutDurationMs(failedAttempts: number): number {
  if (failedAttempts <= LOGIN_FREE_ATTEMPTS) return 0;
  const exponent = failedAttempts - LOGIN_FREE_ATTEMPTS;
  return Math.min(MAX_LOCKOUT_MS, 1000 * 2 ** exponent);
}

/**
 * Derive the rate-limit key for a request.
 *
 * When running behind the bundled reverse proxy we honour `x-forwarded-for`;
 * otherwise we must not, because a client could otherwise spoof its own key and
 * bypass the limiter entirely.
 */
export function clientKey(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? 'unknown';
}
