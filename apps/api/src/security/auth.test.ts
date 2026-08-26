import type { User } from '@metaclaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { AuthService, WeakPasswordError, assertPasswordStrength } from './auth.js';
import { hashToken } from './crypto.js';

const DAY = 86_400_000;
import { totpCode } from './totp.js';

/**
 * scrypt dominates the runtime of this file, so a single database and a single
 * user are shared across the whole suite and password-hashing calls are kept to
 * the minimum each behaviour actually needs.
 */
const PASSWORD = 'a-long-enough-passphrase';
const NEXT_PASSWORD = 'another-long-passphrase';

let db: Db;
let auth: AuthService;
let user: User;

beforeAll(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  auth = new AuthService(db);
  user = await auth.createUser({
    username: 'jules',
    password: PASSWORD,
    role: 'owner',
    displayName: 'Jules',
  });
}, 60_000);

afterAll(() => {
  db.close();
});

/** Clear the brute-force counters so tests do not lock each other out. */
/**
 * Return the account to a state where the next login can succeed.
 *
 * `totp_last_step` is cleared alongside the lockout because a TOTP code is now
 * strictly single-use, per RFC 6238 §5.2 — so two logins inside one 30-second
 * period are genuinely refused, and several cases here sign in twice in a row
 * on purpose. Real operators hit the same rule and wait for the next code;
 * these tests would rather not wait thirty seconds each.
 *
 * It is *not* cleared where the point of the case is the single-use rule
 * itself.
 */
function unlock(): void {
  db.prepare(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, totp_last_step = NULL',
  ).run();
}

/**
 * A six-digit code guaranteed not to be valid for `secret` anywhere near now,
 * so the "wrong code" tests cannot flake on a one-in-a-million collision.
 */
function wrongCodeFor(secret: string, at: number = Date.now()): string {
  const valid = new Set(
    [-2, -1, 0, 1, 2].map((step) => totpCode(secret, at + step * 30_000)),
  );
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = String(i).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('unreachable');
}

describe('assertPasswordStrength', () => {
  it('accepts a good passphrase', () => {
    expect(() => assertPasswordStrength('correct horse battery staple')).not.toThrow();
    expect(() => assertPasswordStrength('Tr0ub4dor&3-xkcd-long')).not.toThrow();
  });

  it('rejects anything shorter than twelve characters', () => {
    expect(() => assertPasswordStrength('')).toThrow(WeakPasswordError);
    expect(() => assertPasswordStrength('short')).toThrow(/at least 12 characters/);
    expect(() => assertPasswordStrength('elevenchars')).toThrow(/at least 12 characters/);
    expect(() => assertPasswordStrength('twelvechars!')).not.toThrow();
  });

  it('rejects an absurdly long password', () => {
    expect(() => assertPasswordStrength('a1b2c3d4'.repeat(128))).not.toThrow();
    expect(() => assertPasswordStrength('a1b2c3d4'.repeat(129))).toThrow(/at most 1024/);
  });

  it('rejects credential-stuffing favourites, case-insensitively', () => {
    expect(() => assertPasswordStrength('administrator')).toThrow(/too common/);
    expect(() => assertPasswordStrength('ADMINISTRATOR')).toThrow(/too common/);
    expect(() => assertPasswordStrength('AdMiNiStRaToR')).toThrow(/too common/);
  });

  it('rejects low-entropy strings', () => {
    expect(() => assertPasswordStrength('aaaaaaaaaaaaaaa')).toThrow(/single repeated character/);
    expect(() => assertPasswordStrength('abababababababab')).toThrow(/5 distinct characters/);
    expect(() => assertPasswordStrength('123412341234')).toThrow(/5 distinct characters/);
    expect(() => assertPasswordStrength('12345123451234')).not.toThrow();
  });

  it('throws a WeakPasswordError with the right name, not a bare Error', () => {
    try {
      assertPasswordStrength('short');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WeakPasswordError);
      expect((error as Error).name).toBe('WeakPasswordError');
    }
  });
});

describe('createUser', () => {
  it('created the shared user with the requested attributes', () => {
    expect(user.username).toBe('jules');
    expect(user.displayName).toBe('Jules');
    expect(user.role).toBe('owner');
    expect(user.totpEnabled).toBe(false);
    expect(user.lastLoginAt).toBeNull();
    expect(user.id.startsWith('usr_')).toBe(true);
    expect(auth.getUser(user.id)).toEqual(user);
    expect(auth.countUsers()).toBe(1);
    expect(auth.listUsers().map((u) => u.id)).toEqual([user.id]);
  });

  it('never exposes the password hash through the domain object', () => {
    expect(Object.keys(user)).not.toContain('passwordHash');
    expect(JSON.stringify(user)).not.toContain('scrypt$');
  });

  it('rejects malformed usernames before doing any work', async () => {
    for (const username of ['ab', '', 'has space', 'has/slash', 'a'.repeat(65), 'héllo']) {
      await expect(
        auth.createUser({ username, password: PASSWORD, role: 'operator' }),
      ).rejects.toThrow(/Username must be/);
    }
    expect(auth.countUsers()).toBe(1);
  });

  it('rejects a weak password before writing a row', async () => {
    await expect(
      auth.createUser({ username: 'weakling', password: 'short', role: 'operator' }),
    ).rejects.toThrow(WeakPasswordError);
    expect(auth.countUsers()).toBe(1);
  });

  it('returns null for an unknown user id', () => {
    expect(auth.getUser('usr_does_not_exist')).toBeNull();
  });
});

describe('login', () => {
  it('succeeds with the right password and issues a session plus a CSRF token', async () => {
    unlock();
    const outcome = await auth.login({ username: 'jules', password: PASSWORD });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    expect(outcome.user.id).toBe(user.id);
    expect(outcome.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(outcome.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(outcome.token).not.toBe(outcome.csrfToken);
    expect(outcome.sessionId.startsWith('as_')).toBe(true);
    expect(outcome.user.lastLoginAt).not.toBeNull();

    // The raw token is never stored; only its hash is.
    const stored = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash = ?')
      .get(outcome.token);
    expect(stored?.n).toBe(0);

    auth.revokeSession(outcome.sessionId);
  }, 30_000);

  it('is case-insensitive on the username and trims it', async () => {
    unlock();
    const outcome = await auth.login({ username: '  JULES ', password: PASSWORD });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') auth.revokeSession(outcome.sessionId);
  }, 30_000);

  it('rejects a wrong password and counts the failure', async () => {
    unlock();
    const outcome = await auth.login({ username: 'jules', password: 'not-the-password' });
    expect(outcome).toEqual({ status: 'invalid' });

    const row = db
      .prepare<[string], { failed_logins: number }>('SELECT failed_logins FROM users WHERE id = ?')
      .get(user.id);
    expect(row?.failed_logins).toBe(1);
    unlock();
  }, 30_000);

  it('rejects an unknown user with the same opaque outcome', async () => {
    const outcome = await auth.login({ username: 'nobody-here', password: PASSWORD });
    expect(outcome).toEqual({ status: 'invalid' });
  }, 30_000);

  it('locks the account once the free attempts are exhausted', async () => {
    unlock();
    // Drive the counter straight to the lockout threshold without paying for
    // four more scrypt derivations.
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(
      4,
      Date.now() + 2000,
      user.id,
    );

    const outcome = await auth.login({ username: 'jules', password: PASSWORD });
    expect(outcome.status).toBe('locked');
    if (outcome.status === 'locked') {
      expect(outcome.retryAfterMs).toBeGreaterThan(0);
      expect(outcome.retryAfterMs).toBeLessThanOrEqual(2000);
    }
    unlock();
  });

  it('clears the failure counter on a successful login', async () => {
    unlock();
    db.prepare('UPDATE users SET failed_logins = 2 WHERE id = ?').run(user.id);
    const outcome = await auth.login({ username: 'jules', password: PASSWORD });
    expect(outcome.status).toBe('ok');

    const row = db
      .prepare<[string], { failed_logins: number; locked_until: number | null }>(
        'SELECT failed_logins, locked_until FROM users WHERE id = ?',
      )
      .get(user.id);
    expect(row?.failed_logins).toBe(0);
    expect(row?.locked_until).toBeNull();
    if (outcome.status === 'ok') auth.revokeSession(outcome.sessionId);
  }, 30_000);
});

describe('sessions', () => {
  let token: string;
  let csrfToken: string;
  let sessionId: string;

  beforeAll(async () => {
    unlock();
    const outcome = await auth.login({
      username: 'jules',
      password: PASSWORD,
      userAgent: 'vitest/1.0',
      ipAddress: '10.0.0.7',
    });
    if (outcome.status !== 'ok') throw new Error(`login failed: ${outcome.status}`);
    token = outcome.token;
    csrfToken = outcome.csrfToken;
    sessionId = outcome.sessionId;
  }, 30_000);

  it('authenticates a valid token back to its user', () => {
    const session = auth.authenticate(token);
    expect(session).not.toBeNull();
    expect(session!.user.id).toBe(user.id);
    expect(session!.sessionId).toBe(sessionId);
  });

  it('returns null for an unknown, empty or truncated token', () => {
    expect(auth.authenticate('nonsense')).toBeNull();
    expect(auth.authenticate('')).toBeNull();
    expect(auth.authenticate(token.slice(0, -1))).toBeNull();
  });

  it('records the user agent and address on the session listing', () => {
    const sessions = auth.listSessions(user.id, sessionId);
    const current = sessions.find((s) => s.id === sessionId);
    expect(current).toBeDefined();
    expect(current!.current).toBe(true);
    expect(current!.userAgent).toBe('vitest/1.0');
    expect(current!.ipAddress).toBe('10.0.0.7');
  });

  it('verifies the CSRF token by double submit', () => {
    expect(auth.verifyCsrf(sessionId, csrfToken)).toBe(true);
    expect(auth.verifyCsrf(sessionId, `${csrfToken}x`)).toBe(false);
    expect(auth.verifyCsrf(sessionId, '')).toBe(false);
    expect(auth.verifyCsrf(sessionId, undefined)).toBe(false);
    expect(auth.verifyCsrf('as_unknown', csrfToken)).toBe(false);
  });

  it('rejects the session token when submitted as a CSRF token', () => {
    // The two are independent secrets; one must never satisfy the other.
    expect(auth.verifyCsrf(sessionId, token)).toBe(false);
  });

  it('rotateCsrf issues a fresh token and retires the previous one', () => {
    const rotated = auth.rotateCsrf(sessionId);
    expect(rotated).not.toBeNull();
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(rotated).not.toBe(csrfToken);

    expect(auth.verifyCsrf(sessionId, rotated!)).toBe(true);
    expect(auth.verifyCsrf(sessionId, csrfToken)).toBe(false);

    // Only the hash is stored, so the plaintext is never recoverable from the row.
    const stored = db
      .prepare<[string], { csrf_hash: string }>('SELECT csrf_hash FROM auth_sessions WHERE id = ?')
      .get(sessionId)!;
    expect(stored.csrf_hash).not.toBe(rotated);

    // Keep the rest of this describe working against a known token.
    csrfToken = rotated!;
  });

  it('rotateCsrf refuses an unknown session', () => {
    expect(auth.rotateCsrf('as_unknown')).toBeNull();
  });

  it('treats an expired session as dead and revokes it', () => {
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, sessionId);
    expect(auth.authenticate(token)).toBeNull();

    const row = db
      .prepare<[string], { revoked_at: number | null }>(
        'SELECT revoked_at FROM auth_sessions WHERE id = ?',
      )
      .get(sessionId);
    expect(row?.revoked_at).not.toBeNull();
  });

  it('revokeSession invalidates the token', async () => {
    unlock();
    const outcome = await auth.login({ username: 'jules', password: PASSWORD });
    if (outcome.status !== 'ok') throw new Error('login failed');
    expect(auth.authenticate(outcome.token)).not.toBeNull();

    auth.revokeSession(outcome.sessionId);
    expect(auth.authenticate(outcome.token)).toBeNull();
    // Revoking twice is harmless.
    expect(() => auth.revokeSession(outcome.sessionId)).not.toThrow();
  }, 30_000);

  it('refuses a session past the 90-day absolute cap, however recently it was used', () => {
    // Two windows guard a session: a sliding 14-day idle timeout, and a hard
    // 90-day ceiling from creation that no amount of activity extends. Every
    // session test wrote `created_at = now`, so `now - created_at` was ~0 and
    // the ceiling clause was never entered — deleting it was invisible to the
    // suite, on code that `authenticate` runs for every request.
    const now = Date.now();
    db.prepare(
      `INSERT INTO auth_sessions
         (id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'as_ancient',
      user.id,
      hashToken('ancient-token'),
      'csrf-ancient',
      now - 91 * DAY,
      // Used a minute ago and good for another hour: only the ceiling can
      // refuse this one.
      now - 60_000,
      now + 3_600_000,
    );

    expect(auth.authenticate('ancient-token')).toBeNull();

    // And it is revoked, not merely refused — otherwise every later request
    // pays the same lookup to reach the same answer.
    const row = db
      .prepare<[string], { revoked_at: number | null }>(
        'SELECT revoked_at FROM auth_sessions WHERE id = ?',
      )
      .get('as_ancient');
    expect(row?.revoked_at).not.toBeNull();
  });

  it('slides the idle window at most once a minute', () => {
    // The write is throttled because `authenticate` runs on every authenticated
    // request and a write per request would dominate the WAL. Both halves were
    // untested: sessions were always written with `last_seen_at = now`, so the
    // `> 60_000` branch was never entered either.
    const now = Date.now();
    db.prepare(
      `INSERT INTO auth_sessions
         (id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'as_sliding',
      user.id,
      hashToken('sliding-token'),
      'csrf-sliding',
      now - DAY,
      now - 120_000,
      now + 3_600_000,
    );

    expect(auth.authenticate('sliding-token')).not.toBeNull();

    const read = () =>
      db
        .prepare<[string], { last_seen_at: number; expires_at: number }>(
          'SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?',
        )
        .get('as_sliding')!;

    const slid = read();
    expect(slid.last_seen_at).toBeGreaterThan(now - 60_000);
    // Pushed out to a fresh idle window, not left at the hour it had.
    expect(slid.expires_at).toBeGreaterThan(now + 13 * DAY);

    // Immediately again: inside the minute, so nothing is written.
    expect(auth.authenticate('sliding-token')).not.toBeNull();
    expect(read()).toEqual(slid);
  });

  it('revokeAllSessions can spare the current session', () => {
    const create = db.prepare(
      `INSERT INTO auth_sessions
         (id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    create.run('as_keep', user.id, 'hash-keep', 'csrf-keep', now, now, now + 60_000);
    create.run('as_drop_1', user.id, 'hash-drop-1', 'csrf-drop-1', now, now, now + 60_000);
    create.run('as_drop_2', user.id, 'hash-drop-2', 'csrf-drop-2', now, now, now + 60_000);

    const revoked = auth.revokeAllSessions(user.id, 'as_keep');
    expect(revoked).toBeGreaterThanOrEqual(2);

    const kept = db
      .prepare<[string], { revoked_at: number | null }>(
        'SELECT revoked_at FROM auth_sessions WHERE id = ?',
      )
      .get('as_keep');
    expect(kept?.revoked_at).toBeNull();

    expect(auth.listSessions(user.id, 'as_keep').map((s) => s.id)).toEqual(['as_keep']);
  });

  it('pruneSessions deletes expired and revoked rows', () => {
    const before = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM auth_sessions').get()!.n;
    expect(before).toBeGreaterThan(0);

    const removed = auth.pruneSessions();
    expect(removed).toBeGreaterThan(0);

    const survivors = db
      .prepare<[], { revoked_at: number | null; expires_at: number }>(
        'SELECT revoked_at, expires_at FROM auth_sessions',
      )
      .all();
    for (const row of survivors) {
      expect(row.revoked_at).toBeNull();
      expect(row.expires_at).toBeGreaterThanOrEqual(Date.now() - 1000);
    }
  });
});

describe('TOTP enrolment and second-factor login', () => {
  let secret: string;
  let recoveryCodes: string[];

  it('begins enrolment without enabling the factor yet', async () => {
    const enrolment = await auth.beginTotpEnrolment(user.id, PASSWORD);
    expect(enrolment).not.toBeNull();
    secret = enrolment!.secret;

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrolment!.uri.startsWith('otpauth://totp/Metaclaude:jules?')).toBe(true);
    expect(enrolment!.uri).toContain(`secret=${secret}`);
    // Not enabled until a code is proven — a mis-scanned QR must not lock anyone out.
    expect(auth.getUser(user.id)!.totpEnabled).toBe(false);
  });

  it('refuses to enrol without the password, or for an unknown user', async () => {
    expect(await auth.beginTotpEnrolment(user.id, 'not-the-password')).toBeNull();
    expect(await auth.beginTotpEnrolment(user.id, '')).toBeNull();
    expect(await auth.beginTotpEnrolment('usr_nope', PASSWORD)).toBeNull();
  });

  it('refuses to confirm with a wrong code', () => {
    expect(auth.confirmTotpEnrolment(user.id, wrongCodeFor(secret))).toBeNull();
    expect(auth.confirmTotpEnrolment(user.id, 'abcdef')).toBeNull();
    expect(auth.confirmTotpEnrolment(user.id, '')).toBeNull();
    expect(auth.getUser(user.id)!.totpEnabled).toBe(false);
  });

  it('confirms with a real code and hands back recovery codes', () => {
    const result = auth.confirmTotpEnrolment(user.id, totpCode(secret, Date.now()));
    expect(result).not.toBeNull();
    recoveryCodes = result!.recoveryCodes;

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(auth.getUser(user.id)!.totpEnabled).toBe(true);
    expect(auth.remainingRecoveryCodes(user.id)).toBe(10);
  });

  it('does not weaken a working enrolment when a new one is started', async () => {
    // The regression this guards: enrolment used to overwrite `totp_secret` and
    // clear `totp_enabled` up front, so POSTing "begin" — reachable with only a
    // session cookie — silently turned 2FA off and stepped around the password
    // that `disableTotp` demands.
    const replacement = await auth.beginTotpEnrolment(user.id, PASSWORD);
    expect(replacement).not.toBeNull();
    expect(replacement!.secret).not.toBe(secret);

    // Still on, and still the *original* device that signs in.
    expect(auth.getUser(user.id)!.totpEnabled).toBe(true);
    unlock();
    const outcome = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: totpCode(secret, Date.now()),
    });
    expect(outcome.status).toBe('ok');

    // A wrong confirmation must not promote the candidate either.
    expect(auth.confirmTotpEnrolment(user.id, wrongCodeFor(replacement!.secret))).toBeNull();
    expect(auth.getUser(user.id)!.totpEnabled).toBe(true);

    auth.cancelTotpEnrolment(user.id);
    expect(auth.confirmTotpEnrolment(user.id, totpCode(replacement!.secret, Date.now()))).toBeNull();
    expect(auth.getUser(user.id)!.totpEnabled).toBe(true);
  });

  it('now requires a second factor at login', async () => {
    unlock();
    const outcome = await auth.login({ username: 'jules', password: PASSWORD });
    expect(outcome).toEqual({ status: 'totp_required' });
    // Asking for the second factor is not a failed attempt.
    const row = db
      .prepare<[string], { failed_logins: number }>('SELECT failed_logins FROM users WHERE id = ?')
      .get(user.id);
    expect(row?.failed_logins).toBe(0);
  }, 30_000);

  it('accepts a valid TOTP code', async () => {
    unlock();
    const outcome = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: totpCode(secret, Date.now()),
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') auth.revokeSession(outcome.sessionId);
  }, 30_000);

  it('rejects a wrong TOTP code even with the right password', async () => {
    unlock();
    const outcome = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: wrongCodeFor(secret),
    });
    expect(outcome).toEqual({ status: 'invalid' });
    unlock();
  }, 30_000);

  it('accepts a recovery code exactly once', async () => {
    unlock();
    const code = recoveryCodes[0]!;

    const first = await auth.login({ username: 'jules', password: PASSWORD, totp: code });
    expect(first.status).toBe('ok');
    if (first.status === 'ok') auth.revokeSession(first.sessionId);
    expect(auth.remainingRecoveryCodes(user.id)).toBe(9);

    unlock();
    const second = await auth.login({ username: 'jules', password: PASSWORD, totp: code });
    expect(second).toEqual({ status: 'invalid' });
    expect(auth.remainingRecoveryCodes(user.id)).toBe(9);
    unlock();
  }, 30_000);

  it('accepts a TOTP code exactly once, like the recovery codes beside it', async () => {
    // `verifyTotp` returns a bare boolean and `consumeSecondFactor` writes
    // nothing, so the same six digits stayed valid for the whole ±1 window —
    // up to ~90 seconds. Anyone who observed one valid (username, password,
    // code) triple could replay it for a second, independent 14-day session:
    // a phishing proxy, or a glance at the keyboard. The password is a
    // precondition, which is what makes this low rather than worse, but a
    // second factor that survives its own use is not a second factor for that
    // window — and the single-use recovery codes three lines down show the
    // intent.
    unlock();
    const code = totpCode(secret, Date.now());

    const first = await auth.login({ username: 'jules', password: PASSWORD, totp: code });
    expect(first.status).toBe('ok');
    if (first.status === 'ok') auth.revokeSession(first.sessionId);

    // Only the lockout is cleared here — clearing the consumed counter would
    // erase the very thing under test.
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL').run();
    const replay = await auth.login({ username: 'jules', password: PASSWORD, totp: code });
    expect(replay).toEqual({ status: 'invalid' });
    unlock();
  }, 30_000);

  it('accepts the next code after one has been used', async () => {
    // The other direction, and the reason the check records a step rather than
    // a code: burning one code must not lock the account out of the next.
    unlock();
    const now = Date.now();
    const first = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: totpCode(secret, now),
    });
    expect(first.status).toBe('ok');
    if (first.status === 'ok') auth.revokeSession(first.sessionId);

    // Again, the consumed counter stays: a later period must be accepted on
    // its own merits, not because the record was wiped.
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL').run();
    const next = await auth.login({
      username: 'jules',
      password: PASSWORD,
      // One period ahead: the next code an authenticator would show, and the
      // furthest the ±1 drift window reaches.
      totp: totpCode(secret, now + 30_000),
    });
    expect(next.status).toBe('ok');
    if (next.status === 'ok') auth.revokeSession(next.sessionId);
    unlock();
  }, 30_000);

  it('accepts a recovery code in lower case', async () => {
    unlock();
    const outcome = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: recoveryCodes[1]!.toLowerCase(),
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') auth.revokeSession(outcome.sessionId);
    expect(auth.remainingRecoveryCodes(user.id)).toBe(8);
  }, 30_000);

  it('survives a clock that jumped forward and was then corrected', async () => {
    // `totp_last_step` is a wall-clock counter, and `matchTotpCounter` can only
    // ever return `floor(now/period) + 1` at most. So a login accepted while
    // the host's clock was two hours fast writes a step 240 periods into the
    // future, and once chrony steps the clock back *every* code is at or below
    // it — the account is locked out for the whole skew, with no way back
    // through the product.
    //
    // A stored step beyond what this clock can reach is therefore evidence of a
    // clock change, not of a replay, and is ignored rather than obeyed.
    unlock();
    const now = Date.now();
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(
      Math.floor((now + 2 * 3_600_000) / 30_000),
      user.id,
    );

    const outcome = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: totpCode(secret, now),
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') auth.revokeSession(outcome.sessionId);
    unlock();
  }, 30_000);

  it('forgets the consumed counter when 2FA is turned off', async () => {
    // Otherwise a fresh enrolment — a new secret, new recovery codes — inherits
    // the old counter and the first code the authenticator shows is refused.
    unlock();
    const now = Date.now();
    const first = await auth.login({
      username: 'jules',
      password: PASSWORD,
      totp: totpCode(secret, now),
    });
    expect(first.status).toBe('ok');
    if (first.status === 'ok') auth.revokeSession(first.sessionId);

    expect(await auth.disableTotp(user.id, PASSWORD)).toBe(true);
    const step = db
      .prepare<[string], { totp_last_step: number | null }>(
        'SELECT totp_last_step FROM users WHERE id = ?',
      )
      .get(user.id)!.totp_last_step;
    expect(step).toBeNull();

    // Put the original enrolment back for the cases that follow.
    const again = await auth.beginTotpEnrolment(user.id, PASSWORD);
    secret = again!.secret;
    const confirmed = auth.confirmTotpEnrolment(user.id, totpCode(secret, Date.now()));
    expect(confirmed).not.toBeNull();
    recoveryCodes = confirmed!.recoveryCodes;
    unlock();
  }, 30_000);

  it('burns the code that confirmed the enrolment', async () => {
    // `confirmTotpEnrolment` accepted a code and wrote no counter, so the very
    // first code an operator types — into the enrolment screen, in front of
    // whoever is watching — stayed valid for a login for the rest of its
    // window. The property the migration comment claims is "strictly
    // single-use", and this was the one code it did not cover.
    unlock();
    const fresh = await auth.beginTotpEnrolment(user.id, PASSWORD);
    const enrolCode = totpCode(fresh!.secret, Date.now());
    const confirmed = auth.confirmTotpEnrolment(user.id, enrolCode);
    expect(confirmed).not.toBeNull();

    secret = fresh!.secret;
    recoveryCodes = confirmed!.recoveryCodes;

    const replay = await auth.login({ username: 'jules', password: PASSWORD, totp: enrolCode });
    expect(replay).toEqual({ status: 'invalid' });
    unlock();
  }, 30_000);

  it('disableTotp requires the password and clears the secret and codes', async () => {
    unlock();
    await expect(auth.disableTotp(user.id, 'wrong-password-entirely')).resolves.toBe(false);
    expect(auth.getUser(user.id)!.totpEnabled).toBe(true);

    await expect(auth.disableTotp(user.id, PASSWORD)).resolves.toBe(true);
    expect(auth.getUser(user.id)!.totpEnabled).toBe(false);
    expect(auth.remainingRecoveryCodes(user.id)).toBe(0);

    const row = db
      .prepare<[string], { totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = ?')
      .get(user.id);
    expect(row?.totp_secret).toBeNull();
  }, 30_000);

  it('reports zero remaining recovery codes for an unknown user', () => {
    expect(auth.remainingRecoveryCodes('usr_nope')).toBe(0);
  });
});

describe('changePassword', () => {
  it('rejects the wrong current password and an unknown user', async () => {
    await expect(auth.changePassword(user.id, 'wrong', NEXT_PASSWORD)).resolves.toBe(false);
    await expect(auth.changePassword('usr_nope', PASSWORD, NEXT_PASSWORD)).resolves.toBe(false);
  }, 30_000);

  it('rejects a weak replacement without touching the stored hash', async () => {
    const before = db
      .prepare<[string], { password_hash: string }>('SELECT password_hash FROM users WHERE id = ?')
      .get(user.id)!.password_hash;

    await expect(auth.changePassword(user.id, PASSWORD, 'short')).rejects.toThrow(WeakPasswordError);

    const after = db
      .prepare<[string], { password_hash: string }>('SELECT password_hash FROM users WHERE id = ?')
      .get(user.id)!.password_hash;
    expect(after).toBe(before);
  }, 30_000);

  it('changes the password and revokes every existing session', async () => {
    unlock();
    const first = await auth.login({ username: 'jules', password: PASSWORD });
    const second = await auth.login({ username: 'jules', password: PASSWORD });
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('login failed');

    expect(auth.authenticate(first.token)).not.toBeNull();
    expect(auth.authenticate(second.token)).not.toBeNull();

    await expect(auth.changePassword(user.id, PASSWORD, NEXT_PASSWORD)).resolves.toBe(true);

    // Both sessions are dead — that is the point of changing a password.
    expect(auth.authenticate(first.token)).toBeNull();
    expect(auth.authenticate(second.token)).toBeNull();

    unlock();
    await expect(auth.login({ username: 'jules', password: PASSWORD })).resolves.toEqual({
      status: 'invalid',
    });

    unlock();
    const outcome = await auth.login({ username: 'jules', password: NEXT_PASSWORD });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') auth.revokeSession(outcome.sessionId);
  }, 60_000);
});
