import type { User } from '@metaclaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { AuthService, WeakPasswordError, assertPasswordStrength } from './auth.js';
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
function unlock(): void {
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL').run();
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

  it('begins enrolment without enabling the factor yet', () => {
    const enrolment = auth.beginTotpEnrolment(user.id);
    secret = enrolment.secret;

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrolment.uri.startsWith('otpauth://totp/Metaclaude:jules?')).toBe(true);
    expect(enrolment.uri).toContain(`secret=${secret}`);
    // Not enabled until a code is proven — a mis-scanned QR must not lock anyone out.
    expect(auth.getUser(user.id)!.totpEnabled).toBe(false);
  });

  it('refuses to enrol an unknown user', () => {
    expect(() => auth.beginTotpEnrolment('usr_nope')).toThrow(/User not found/);
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
