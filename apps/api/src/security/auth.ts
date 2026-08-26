/**
 * Authentication service.
 *
 * Design notes:
 * - Session tokens are opaque random strings; only their SHA-256 is stored, so
 *   a database leak does not yield usable sessions.
 * - Each session carries an independent CSRF token (double-submit). The cookie
 *   is `SameSite=Strict` *and* we check Origin *and* we require the header, so
 *   an attacker needs three independent failures to forge a request.
 * - Login always performs a password hash comparison, even for an unknown user,
 *   so response timing does not disclose which usernames exist.
 */

import type { User, UserRole } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { toBool, toInt, tx } from '../db/index.js';
import {
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  timingSafeEqual,
  verifyPassword,
} from './crypto.js';
import { LOGIN_FREE_ATTEMPTS, lockoutDurationMs } from './ratelimit.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  matchTotpCounter,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  totpUri,
  verifyTotp,
} from './totp.js';

/** Idle timeout: a session unused for this long is dead. */
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/** Absolute cap regardless of activity, forcing periodic re-authentication. */
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A pre-computed hash of a random string, used as the comparison target when
 * the requested username does not exist. Keeps the failure path as slow as the
 * success path.
 */
let decoyHash: string | null = null;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  totp_secret: string | null;
  totp_last_step: number | null;
  totp_pending_secret: string | null;
  totp_enabled: number;
  recovery_codes: string;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export type LoginOutcome =
  | { status: 'ok'; user: User; token: string; csrfToken: string; sessionId: string }
  | { status: 'totp_required' }
  | { status: 'invalid' }
  | { status: 'locked'; retryAfterMs: number };

export interface AuthenticatedSession {
  user: User;
  sessionId: string;
  /**
   * The *hash* of the session's CSRF token, not the token itself — the
   * plaintext is only ever returned once, at login or from `rotateCsrf`.
   * Named explicitly so it cannot be mistaken for something safe to send to a
   * client: doing so would both leak the stored hash and break every write.
   */
  csrfHash: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    totpEnabled: toBool(row.totp_enabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export class AuthService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------------- */
  /* Users                                                                   */
  /* ---------------------------------------------------------------------- */

  async createUser(input: {
    username: string;
    password: string;
    role: UserRole;
    displayName?: string;
  }): Promise<User> {
    const username = input.username.trim();
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      throw new Error('Username must be 3-64 characters of letters, digits, dot, dash, underscore.');
    }
    assertPasswordStrength(input.password);

    const passwordHash = await hashPassword(input.password);
    const now = Date.now();
    const id = newId('user');

    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, username, input.displayName ?? username, passwordHash, input.role, now, now);

    return this.getUser(id) as User;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
    return row ? toUser(row) : null;
  }

  countUsers(): number {
    return (
      this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0
    );
  }

  listUsers(): User[] {
    return this.db
      .prepare<[], UserRow>('SELECT * FROM users ORDER BY created_at')
      .all()
      .map(toUser);
  }

  async changePassword(userId: string, current: string, next: string): Promise<boolean> {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) return false;
    if (!(await verifyPassword(current, row.password_hash))) return false;

    assertPasswordStrength(next);
    const hash = await hashPassword(next);

    tx(this.db, () => {
      this.db
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(hash, Date.now(), userId);
      // Changing a password must invalidate every other session: that is the
      // whole point of changing it after a suspected compromise.
      this.db
        .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(Date.now(), userId);
    });
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Login                                                                   */
  /* ---------------------------------------------------------------------- */

  async login(input: {
    username: string;
    password: string;
    totp?: string;
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<LoginOutcome> {
    const row = this.db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(input.username.trim());

    if (!row) {
      // Burn equivalent CPU so an absent user is indistinguishable from a wrong
      // password by timing.
      decoyHash ??= await hashPassword(generateToken(16));
      await verifyPassword(input.password, decoyHash);
      return { status: 'invalid' };
    }

    const now = Date.now();
    if (row.locked_until !== null && row.locked_until > now) {
      // Burn the same scrypt an unknown user does. Returning here without it
      // made a locked account ~100 ms *faster* than a non-existent one, which
      // is precisely the timing channel the decoy hash above exists to close —
      // the guarantee is meant to hold on every path, not only the one it was
      // written for.
      //
      // The 429 itself remains distinguishable from the 401 an unknown name
      // gets, and that is a deliberate trade rather than an oversight: on a
      // self-hosted single-operator tool, an owner locked out of their own box
      // needs to be told so and told when it lifts. What that channel discloses
      // is one username on a deployment that already answers
      // /api/auth/bootstrap-status, at five requests per candidate against a
      // 10-token bucket refilling at one per six seconds, writing an audit line
      // per probe and locking the real account where the owner will see it.
      // docs/SECURITY.md says so rather than leaving it implied.
      decoyHash ??= await hashPassword(generateToken(16));
      await verifyPassword(input.password, decoyHash);
      return { status: 'locked', retryAfterMs: row.locked_until - now };
    }

    const passwordOk = await verifyPassword(input.password, row.password_hash);
    if (!passwordOk) {
      this.recordFailure(row, now);
      return { status: 'invalid' };
    }

    if (toBool(row.totp_enabled)) {
      if (!input.totp) return { status: 'totp_required' };
      if (!this.consumeSecondFactor(row, input.totp)) {
        this.recordFailure(row, now);
        return { status: 'invalid' };
      }
    }

    // Opportunistically upgrade a hash produced with older scrypt parameters.
    if (needsRehash(row.password_hash)) {
      const upgraded = await hashPassword(input.password);
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgraded, row.id);
    }

    const session = this.createSession(row.id, input.userAgent ?? null, input.ipAddress ?? null);

    this.db
      .prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(now, row.id);

    return {
      status: 'ok',
      user: toUser({ ...row, last_login_at: now }),
      token: session.token,
      csrfToken: session.csrfToken,
      sessionId: session.id,
    };
  }

  private recordFailure(row: UserRow, now: number): void {
    const failed = row.failed_logins + 1;
    const lockMs = lockoutDurationMs(failed);
    this.db
      .prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
      .run(failed, lockMs > 0 ? now + lockMs : null, row.id);
  }

  /**
   * Check a TOTP code, falling back to single-use recovery codes.
   * A consumed recovery code is removed from the stored list immediately.
   */
  private consumeSecondFactor(row: UserRow, code: string): boolean {
    if (row.totp_secret) {
      // The matched counter, not just "did it match": verification allows ±1
      // period of drift, so one code is valid for around ninety seconds, and
      // nothing recorded that it had been spent. An observed
      // (username, password, code) triple could be replayed inside that window
      // for a second, independent session — while the recovery codes below have
      // always been strictly single-use.
      const step = matchTotpCounter(row.totp_secret, code);
      if (step !== null) {
        // A stored step this clock cannot reach is evidence of a clock change,
        // not of a replay, so it is ignored rather than obeyed. Without this, a
        // login accepted while the host's clock ran fast — a wrong RTC, a
        // restored snapshot, the hours before chrony steps it back — wrote a
        // counter far in the future and locked the account out for the whole
        // skew, with no route back through the product. `matchTotpCounter`
        // never returns more than `floor(now/period) + window`, so anything
        // above that came from a different clock.
        const reachable = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000)) + TOTP_WINDOW;
        const consumed =
          row.totp_last_step !== null && row.totp_last_step <= reachable ? row.totp_last_step : null;
        if (consumed !== null && step <= consumed) return false;
        this.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
        return true;
      }
    }

    const normalised = code.trim().toUpperCase();
    const codes = JSON.parse(row.recovery_codes) as string[];
    const index = codes.findIndex((candidate) => timingSafeEqual(candidate, normalised));
    if (index < 0) return false;

    codes.splice(index, 1);
    this.db
      .prepare('UPDATE users SET recovery_codes = ? WHERE id = ?')
      .run(JSON.stringify(codes), row.id);
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Sessions                                                                */
  /* ---------------------------------------------------------------------- */

  private createSession(
    userId: string,
    userAgent: string | null,
    ipAddress: string | null,
  ): { id: string; token: string; csrfToken: string } {
    const token = generateToken(32);
    const csrfToken = generateToken(32);
    const id = newId('authSession');
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO auth_sessions
           (id, user_id, token_hash, csrf_hash, user_agent, ip_address, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        hashToken(token),
        hashToken(csrfToken),
        userAgent?.slice(0, 400) ?? null,
        ipAddress,
        now,
        now,
        now + SESSION_IDLE_MS,
      );

    return { id, token, csrfToken };
  }

  /**
   * Resolve a session cookie to its user, sliding the idle expiry forward.
   * Returns `null` for anything not currently valid.
   */
  authenticate(token: string): AuthenticatedSession | null {
    const row = this.db
      .prepare<[string], AuthSessionRow>(
        'SELECT * FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .get(hashToken(token));
    if (!row) return null;

    const now = Date.now();
    if (row.expires_at <= now || now - row.created_at > SESSION_ABSOLUTE_MS) {
      this.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, row.id);
      return null;
    }

    const userRow = this.db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?')
      .get(row.user_id);
    if (!userRow) return null;

    // Slide the idle window, but write at most once a minute: this runs on every
    // authenticated request and a write per request would dominate the WAL.
    if (now - row.last_seen_at > 60_000) {
      this.db
        .prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(now, now + SESSION_IDLE_MS, row.id);
    }

    return { user: toUser(userRow), sessionId: row.id, csrfHash: row.csrf_hash };
  }

  /**
   * Issue a fresh CSRF token for an existing session.
   *
   * Needed when the client no longer holds its copy — a cleared cookie jar, a
   * restored tab — so a valid session does not become unusable for writes. Only
   * the hash is stored, so the plaintext is returned exactly once.
   */
  rotateCsrf(sessionId: string): string | null {
    const csrfToken = generateToken(32);
    const info = this.db
      .prepare('UPDATE auth_sessions SET csrf_hash = ? WHERE id = ? AND revoked_at IS NULL')
      .run(hashToken(csrfToken), sessionId);
    return info.changes > 0 ? csrfToken : null;
  }

  /** Compare a submitted CSRF token against the session's stored hash. */
  verifyCsrf(sessionId: string, submitted: string | undefined): boolean {
    if (!submitted) return false;
    const row = this.db
      .prepare<[string], { csrf_hash: string }>('SELECT csrf_hash FROM auth_sessions WHERE id = ?')
      .get(sessionId);
    if (!row) return false;
    return timingSafeEqual(row.csrf_hash, hashToken(submitted));
  }

  revokeSession(sessionId: string): void {
    this.db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(Date.now(), sessionId);
  }

  revokeAllSessions(userId: string, exceptSessionId?: string): number {
    return this.db
      .prepare(
        `UPDATE auth_sessions SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
      )
      .run(Date.now(), userId, exceptSessionId ?? null).changes;
  }

  listSessions(userId: string, currentSessionId: string) {
    return this.db
      .prepare<[string, number], AuthSessionRow>(
        `SELECT * FROM auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY last_seen_at DESC`,
      )
      .all(userId, Date.now())
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
        current: row.id === currentSessionId,
      }));
  }

  /** Remove expired and revoked rows. Called periodically by the janitor. */
  pruneSessions(): number {
    return this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL')
      .run(Date.now()).changes;
  }

  /* ---------------------------------------------------------------------- */
  /* Two-factor enrolment                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Begin TOTP enrolment.
   *
   * Two properties this has to hold, both of which the obvious implementation
   * gets wrong:
   *
   *  - **It must not weaken an enrolment that already works.** Writing the new
   *    secret over `totp_secret` and clearing `totp_enabled` turns beginning an
   *    enrolment into *silently disabling 2FA* — reachable with nothing but a
   *    stolen session cookie, and a neat way around the password `disableTotp`
   *    demands. The candidate is therefore staged in `totp_pending_secret` and
   *    the live secret is left alone until `confirmTotpEnrolment` promotes it.
   *  - **It must re-prove the first factor.** Re-enrolling is how you replace
   *    the second factor, so it is worth exactly as much as disabling it and
   *    carries the same password check.
   *
   * `totp_enabled` stays false through enrolment so a mis-scanned QR code
   * cannot lock anyone out.
   *
   * @returns `null` when the password is wrong.
   */
  async beginTotpEnrolment(
    userId: string,
    password: string,
  ): Promise<{ secret: string; uri: string } | null> {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) return null;
    if (!(await verifyPassword(password, row.password_hash))) return null;

    const secret = generateTotpSecret();
    this.db
      .prepare('UPDATE users SET totp_pending_secret = ?, updated_at = ? WHERE id = ?')
      .run(secret, Date.now(), userId);

    return { secret, uri: totpUri({ secret, account: row.username }) };
  }

  /**
   * Confirm enrolment and hand back one-time recovery codes.
   *
   * The code is checked against the *pending* secret, and only a correct code
   * promotes it. A failed confirmation leaves any existing enrolment intact.
   */
  confirmTotpEnrolment(userId: string, code: string): { recoveryCodes: string[] } | null {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row?.totp_pending_secret) return null;
    // The matched counter, not just "did it match": this code has now been
    // used, and it is typed into an enrolment screen in front of whoever is
    // watching. Leaving the counter unset let it be replayed into a login for
    // the rest of its window — the one code the single-use rule did not cover.
    const step = matchTotpCounter(row.totp_pending_secret, code);
    if (step === null) return null;

    const recoveryCodes = generateRecoveryCodes();
    this.db
      .prepare(
        `UPDATE users SET
           totp_secret = totp_pending_secret, totp_pending_secret = NULL,
           totp_enabled = 1, recovery_codes = ?, totp_last_step = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(recoveryCodes), step, Date.now(), userId);

    return { recoveryCodes };
  }

  /** Discard a started-but-unconfirmed enrolment. */
  cancelTotpEnrolment(userId: string): void {
    this.db
      .prepare('UPDATE users SET totp_pending_secret = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), userId);
  }

  async disableTotp(userId: string, password: string): Promise<boolean> {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) return false;
    // Disabling a second factor is a security downgrade; re-prove the first one.
    if (!(await verifyPassword(password, row.password_hash))) return false;

    this.db
      .prepare(
        // `totp_last_step` goes with the secret it counted. Left behind, the
        // next enrolment — a brand-new secret, new recovery codes — inherits
        // it, and the first code the authenticator shows is refused as a
        // replay of a code from a factor that no longer exists.
        `UPDATE users SET
           totp_enabled = 0, totp_secret = NULL, totp_pending_secret = NULL,
           recovery_codes = '[]', totp_last_step = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), userId);
    return true;
  }

  remainingRecoveryCodes(userId: string): number {
    const row = this.db
      .prepare<[string], { recovery_codes: string }>('SELECT recovery_codes FROM users WHERE id = ?')
      .get(userId);
    if (!row) return 0;
    try {
      return (JSON.parse(row.recovery_codes) as string[]).length;
    } catch {
      return 0;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Password policy                                                             */
/* -------------------------------------------------------------------------- */

/** Passwords that show up in every credential-stuffing list. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein', 'welcome', 'admin', 'administrator', 'changeme',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'trustno1', 'passw0rd', 'azertyuiop', 'motdepasse', 'secret',
]);

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Length-first policy, per current NIST guidance: 12 characters minimum, block
 * known-bad and trivially repetitive strings, and do not impose composition
 * rules that push people toward `P@ssw0rd1!`.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < 12) {
    throw new WeakPasswordError('Password must be at least 12 characters long.');
  }
  if (password.length > 1024) {
    throw new WeakPasswordError('Password must be at most 1024 characters long.');
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    throw new WeakPasswordError('This password is too common. Choose something unique.');
  }
  if (/^(.)\1+$/.test(password)) {
    throw new WeakPasswordError('Password cannot be a single repeated character.');
  }
  if (new Set(password).size < 5) {
    throw new WeakPasswordError('Password must use at least 5 distinct characters.');
  }
}
