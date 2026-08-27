/**
 * Passkeys (WebAuthn), on top of @simplewebauthn/server.
 *
 * The library owns the cryptography; this service owns the judgement around
 * it, and each rule earns its place:
 *
 *  - **The rpID comes from the request's origin, and must be a domain.**
 *    WebAuthn scopes a credential to a *domain* — the spec has no way to bind
 *    one to an IP address, so a deployment reached at `https://203.0.113.7`
 *    cannot enrol a passkey at all. That is refused here, loudly and before
 *    any ceremony starts, with the fix in the message. Deriving from the
 *    origin rather than from configuration means a deployment reachable at
 *    two names can hold a passkey per name; the signed assertion covers the
 *    rpID hash and origin, so a forged header cannot make a credential for
 *    someone else's domain verify.
 *  - **Challenges are held in memory, single-use, five minutes.** A ceremony
 *    is a conversation with one browser tab; surviving a restart is not worth
 *    a table, and replaying a consumed challenge is refused whatever else is
 *    right about the response.
 *  - **A passkey login bypasses the password lockout** — see
 *    `AuthService.issueVerifiedSession` for why that is a feature.
 *  - **User verification is "preferred", not required**, on both sides. A
 *    platform passkey brings biometrics anyway; requiring UV would shut out
 *    PIN-less security keys, and the password+TOTP path remains for anyone
 *    who wants strictly two ceremonies. docs/SECURITY.md states the trade.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { PasskeyRecord, User } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import type { AuthService } from './auth.js';
import { generateToken } from './crypto.js';

/** How long a started ceremony stays answerable. */
const CEREMONY_TTL_MS = 5 * 60_000;

export class PasskeyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/**
 * The WebAuthn rpID for a request origin, or null when there cannot be one.
 *
 * Only https origins with a *domain name* qualify: an IP literal (v4 or v6)
 * has no registrable domain for the credential to be scoped to. The port is
 * not part of an rpID.
 */
export function rpIdFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname;
  // `URL` strips the brackets from an IPv6 literal; a v4 literal is dotted
  // digits. Neither is a domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host.includes(':')) return null;
  return host;
}

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export interface WebAuthnDeps {
  db: Db;
  auth: AuthService;
  /** Injected in tests to drive verification outcomes; defaults to the real library. */
  lib?: WebAuthnLib;
  now?: () => number;
}

export type PasskeyLoginOutcome =
  | { status: 'ok'; user: User; token: string; csrfToken: string; sessionId: string }
  | { status: 'invalid' };

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  rp_id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

interface Ceremony {
  challenge: string;
  rpId: string;
  origin: string;
  expiresAt: number;
}

const RP_NAME = 'Metaclaude';

export class WebAuthnService {
  private readonly lib: WebAuthnLib;
  private readonly now: () => number;
  /** In-flight registrations, one per user — a second begin replaces the first. */
  private readonly pendingRegistrations = new Map<string, Ceremony>();
  /** In-flight logins, keyed by an opaque ceremony id the client echoes back. */
  private readonly pendingLogins = new Map<string, Ceremony>();

  constructor(private readonly deps: WebAuthnDeps) {
    this.lib = deps.lib ?? {
      generateRegistrationOptions,
      verifyRegistrationResponse,
      generateAuthenticationOptions,
      verifyAuthenticationResponse,
    };
    this.now = deps.now ?? Date.now;
  }

  /** The refusal every passkey endpoint shares, phrased with the fix in it. */
  private requireRpId(origin: string | undefined): { rpId: string; origin: string } {
    const rpId = rpIdFromOrigin(origin);
    if (!rpId) {
      throw new PasskeyError(
        422,
        'Passkeys need a domain name: the WebAuthn standard scopes a credential to a domain, ' +
          'and this deployment is being reached by IP address. Give the server a hostname ' +
          '(METACLAUDE_SITE, docs/DEPLOYMENT.md) and enrol from there — password and ' +
          'authenticator-app sign-in are unaffected.',
      );
    }
    return { rpId, origin: origin as string };
  }

  /* ---------------------------- Enrolment ------------------------------- */

  async beginRegistration(
    user: Pick<User, 'id' | 'username'>,
    originHeader: string | undefined,
    password: string,
  ) {
    const { rpId, origin } = this.requireRpId(originHeader);
    // Adding a sign-in method is the same authority as removing one.
    if (!(await this.deps.auth.checkPassword(user.id, password))) {
      throw new PasskeyError(403, 'That password is incorrect.');
    }

    const existing = this.rows(user.id);
    const options = await this.lib.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      // The same authenticator cannot be enrolled twice; the browser answers
      // "you already have a passkey here" instead of minting a duplicate.
      excludeCredentials: existing.map((row) => ({
        id: row.credential_id,
        transports: parseTransports(row.transports),
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    this.pendingRegistrations.set(user.id, {
      challenge: options.challenge,
      rpId,
      origin,
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return options;
  }

  async finishRegistration(
    user: Pick<User, 'id' | 'username'>,
    originHeader: string | undefined,
    label: string,
    response: { id: string },
  ): Promise<PasskeyRecord> {
    const pending = this.pendingRegistrations.get(user.id);
    // Consumed on sight: a failed verification does not leave a challenge
    // behind to retry against.
    this.pendingRegistrations.delete(user.id);
    if (!pending || pending.expiresAt <= this.now()) {
      throw new PasskeyError(409, 'This enrolment expired — start again.');
    }
    if (pending.origin !== originHeader) {
      throw new PasskeyError(409, 'This enrolment was started from a different address — start again there.');
    }

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await this.lib.verifyRegistrationResponse({
        // The zod contract checked only what this service reads (`id`); the
        // library parses and verifies the full structure and throws on junk.
        response: response as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        requireUserVerification: false,
      });
    } catch (error) {
      throw new PasskeyError(400, `That response did not verify: ${(error as Error).message}`);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new PasskeyError(400, 'That response did not verify.');
    }

    const { credential } = verification.registrationInfo;
    const record: PasskeyRecord = {
      id: newId('passkey'),
      label: label.trim() || 'Passkey',
      rpId: pending.rpId,
      createdAt: this.now(),
      lastUsedAt: null,
    };
    this.deps.db
      .prepare(
        `INSERT INTO webauthn_credentials
           (id, user_id, credential_id, public_key, counter, transports, rp_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        user.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        record.rpId,
        record.label,
        record.createdAt,
      );
    return record;
  }

  /* ------------------------------ Login ---------------------------------- */

  async beginLogin(originHeader: string | undefined) {
    const { rpId, origin } = this.requireRpId(originHeader);
    // No allowCredentials: the browser offers whatever discoverable
    // credentials it holds for this rpID, so the user never types a username.
    const options = await this.lib.generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'preferred',
    });
    const ceremonyId = generateToken(16);
    this.pendingLogins.set(ceremonyId, {
      challenge: options.challenge,
      rpId,
      origin,
      expiresAt: this.now() + CEREMONY_TTL_MS,
    });
    return { ceremonyId, options };
  }

  async finishLogin(
    originHeader: string | undefined,
    ceremonyId: string,
    response: { id: string },
    userAgent: string | null,
    ipAddress: string | null,
  ): Promise<PasskeyLoginOutcome> {
    const ceremony = this.pendingLogins.get(ceremonyId);
    this.pendingLogins.delete(ceremonyId);
    if (!ceremony || ceremony.expiresAt <= this.now()) return { status: 'invalid' };
    if (ceremony.origin !== originHeader) return { status: 'invalid' };

    const row = this.deps.db
      .prepare<[string], CredentialRow>(
        'SELECT * FROM webauthn_credentials WHERE credential_id = ?',
      )
      .get(response.id);
    if (!row) return { status: 'invalid' };

    try {
      const verification = await this.lib.verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ceremony.origin,
        expectedRPID: ceremony.rpId,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.counter,
          transports: parseTransports(row.transports),
        },
        requireUserVerification: false,
      });
      if (!verification.verified) return { status: 'invalid' };

      this.deps.db
        .prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, this.now(), row.id);
    } catch {
      return { status: 'invalid' };
    }

    const session = this.deps.auth.issueVerifiedSession(row.user_id, userAgent, ipAddress);
    if (!session) return { status: 'invalid' };
    return { status: 'ok', ...session };
  }

  /* --------------------------- Management -------------------------------- */

  list(userId: string): PasskeyRecord[] {
    return this.rows(userId).map((row) => ({
      id: row.id,
      label: row.label,
      rpId: row.rp_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  /** Password-gated: removing a sign-in method is a security-relevant change. */
  async remove(userId: string, id: string, password: string): Promise<boolean> {
    if (!(await this.deps.auth.checkPassword(userId, password))) return false;
    return (
      this.deps.db
        .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
        .run(id, userId).changes > 0
    );
  }

  /** Whether any user has a passkey — the login screen offers the button on it. */
  anyEnrolled(): boolean {
    return (
      (this.deps.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM webauthn_credentials')
        .get()?.n ?? 0) > 0
    );
  }

  private rows(userId: string): CredentialRow[] {
    return this.deps.db
      .prepare<[string], CredentialRow>(
        'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at',
      )
      .all(userId);
  }
}

function parseTransports(stored: string): AuthenticatorTransportFuture[] | undefined {
  try {
    const parsed = JSON.parse(stored) as AuthenticatorTransportFuture[];
    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
