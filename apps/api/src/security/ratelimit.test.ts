import { describe, expect, it } from 'vitest';
import { LOGIN_FREE_ATTEMPTS, TokenBucket, clientKey, lockoutDurationMs } from './ratelimit.js';

/**
 * Every test drives the clock through the explicit `now` argument. The values
 * are small compared with `Date.now()`, which also keeps the internal sweep from
 * firing and evicting buckets mid-test.
 */
describe('TokenBucket', () => {
  it('allows exactly `capacity` requests before rejecting', () => {
    const bucket = new TokenBucket(3, 1);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(false);
    expect(bucket.take('a', 1, 1000)).toBe(false);
  });

  it('keys are independent', () => {
    const bucket = new TokenBucket(1, 1);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(false);
    expect(bucket.take('b', 1, 1000)).toBe(true);
    expect(bucket.size).toBe(2);
  });

  it('charges a variable cost and refuses when the cost exceeds what is left', () => {
    const bucket = new TokenBucket(10, 1);
    expect(bucket.take('a', 7, 1000)).toBe(true);
    expect(bucket.take('a', 4, 1000)).toBe(false); // only 3 left
    expect(bucket.take('a', 3, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(false);
  });

  it('refills over time at the configured rate', () => {
    const bucket = new TokenBucket(5, 2); // 2 tokens per second
    for (let i = 0; i < 5; i += 1) expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(false);

    // Half a second later, one token is back.
    expect(bucket.take('a', 1, 1500)).toBe(true);
    expect(bucket.take('a', 1, 1500)).toBe(false);

    // A full second later, two more.
    expect(bucket.take('a', 1, 2500)).toBe(true);
    expect(bucket.take('a', 1, 2500)).toBe(true);
    expect(bucket.take('a', 1, 2500)).toBe(false);
  });

  it('never refills beyond capacity', () => {
    const bucket = new TokenBucket(3, 1);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    // An hour of idling must not grant more than the capacity.
    for (let i = 0; i < 3; i += 1) expect(bucket.take('a', 1, 3_601_000)).toBe(true);
    expect(bucket.take('a', 1, 3_601_000)).toBe(false);
  });

  it('reports how long the caller must wait', () => {
    const bucket = new TokenBucket(4, 2); // 2 tokens/second
    expect(bucket.retryAfter('never-seen', 1, 1000)).toBe(0);

    for (let i = 0; i < 4; i += 1) bucket.take('a', 1, 1000);
    expect(bucket.retryAfter('a', 1, 1000)).toBe(1); // ceil(1 / 2) === 1
    expect(bucket.retryAfter('a', 4, 1000)).toBe(2); // ceil(4 / 2)
    // Once enough time has passed, no wait is required.
    expect(bucket.retryAfter('a', 1, 3000)).toBe(0);
  });

  it('retryAfter does not itself consume or refill the bucket', () => {
    const bucket = new TokenBucket(2, 1);
    bucket.take('a', 1, 1000);
    bucket.take('a', 1, 1000);
    expect(bucket.retryAfter('a', 1, 1000)).toBe(1);
    expect(bucket.retryAfter('a', 1, 1000)).toBe(1);
    expect(bucket.take('a', 1, 1000)).toBe(false);
  });

  it('reset drops a key so the next call starts from a full bucket', () => {
    const bucket = new TokenBucket(2, 1);
    bucket.take('a', 1, 1000);
    bucket.take('a', 1, 1000);
    expect(bucket.take('a', 1, 1000)).toBe(false);
    expect(bucket.size).toBe(1);

    bucket.reset('a');
    expect(bucket.size).toBe(0);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(true);
    expect(bucket.take('a', 1, 1000)).toBe(false);
  });

  it('reset of an unknown key is a no-op', () => {
    const bucket = new TokenBucket(1, 1);
    expect(() => bucket.reset('nope')).not.toThrow();
    expect(bucket.size).toBe(0);
  });
});

describe('lockoutDurationMs', () => {
  it('gives the first attempts away for free', () => {
    for (let attempts = 0; attempts <= LOGIN_FREE_ATTEMPTS; attempts += 1) {
      expect(lockoutDurationMs(attempts)).toBe(0);
    }
    expect(LOGIN_FREE_ATTEMPTS).toBe(3);
  });

  it('grows exponentially once the free attempts are spent', () => {
    expect(lockoutDurationMs(4)).toBe(2_000);
    expect(lockoutDurationMs(5)).toBe(4_000);
    expect(lockoutDurationMs(6)).toBe(8_000);
    expect(lockoutDurationMs(7)).toBe(16_000);
    expect(lockoutDurationMs(10)).toBe(128_000);
    expect(lockoutDurationMs(12)).toBe(512_000);
  });

  it('caps at fifteen minutes so an account is never bricked', () => {
    const cap = 15 * 60 * 1000;
    expect(lockoutDurationMs(13)).toBe(cap);
    expect(lockoutDurationMs(50)).toBe(cap);
    expect(lockoutDurationMs(1_000)).toBe(cap);
  });

  it('is monotonically non-decreasing', () => {
    let previous = -1;
    for (let attempts = 0; attempts < 40; attempts += 1) {
      const current = lockoutDurationMs(attempts);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe('clientKey', () => {
  it('ignores x-forwarded-for when the proxy is not trusted', () => {
    expect(clientKey('10.0.0.1', '1.2.3.4', false)).toBe('10.0.0.1');
    expect(clientKey('10.0.0.1', '1.2.3.4, 5.6.7.8', false)).toBe('10.0.0.1');
  });

  it('takes the entry the trusted proxy appended, not the one the client sent', () => {
    expect(clientKey('10.0.0.1', '1.2.3.4', true)).toBe('1.2.3.4');
    // `1.2.3.4` here is client-supplied; `5.6.7.8` is what our proxy observed.
    expect(clientKey('10.0.0.1', '1.2.3.4, 5.6.7.8', true)).toBe('5.6.7.8');
    expect(clientKey('10.0.0.1', '  1.2.3.4  ,5.6.7.8  ', true)).toBe('5.6.7.8');
  });

  it('cannot be spoofed into a fresh bucket by prepending entries', () => {
    const honest = clientKey('10.0.0.1', '5.6.7.8', true);
    for (const forged of ['a, 5.6.7.8', 'a, b, 5.6.7.8', ' , ,5.6.7.8']) {
      expect(clientKey('10.0.0.1', forged, true)).toBe(honest);
    }
  });

  it('falls back to the socket address when the header is absent or empty', () => {
    expect(clientKey('10.0.0.1', undefined, true)).toBe('10.0.0.1');
    expect(clientKey('10.0.0.1', '', true)).toBe('10.0.0.1');
    expect(clientKey('10.0.0.1', '   ', true)).toBe('10.0.0.1');
    expect(clientKey('10.0.0.1', ',', true)).toBe('10.0.0.1');
  });

  it('falls back to "unknown" when there is no address at all', () => {
    expect(clientKey(undefined, undefined, false)).toBe('unknown');
    expect(clientKey(undefined, undefined, true)).toBe('unknown');
    expect(clientKey(undefined, '1.2.3.4', false)).toBe('unknown');
    expect(clientKey(undefined, '1.2.3.4', true)).toBe('1.2.3.4');
  });

  it('cannot be spoofed into sharing a bucket when the proxy is untrusted', () => {
    const spoofed = clientKey('10.0.0.9', 'victim-ip', false);
    const honest = clientKey('10.0.0.9', undefined, false);
    expect(spoofed).toBe(honest);
  });
});
