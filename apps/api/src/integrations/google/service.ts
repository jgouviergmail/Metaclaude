/**
 * Metaclaude's own Google connection.
 *
 * The shape of this service is dictated by one constraint the rest of the app
 * imposed long ago: **the session cookie is `SameSite=Strict`.** Google's
 * redirect back from the consent screen is a cross-site top-level navigation,
 * so the callback arrives with no cookie and no way to ask who is signed in.
 * Loosening the cookie for this one feature would trade the app's whole CSRF
 * posture for a convenience, so instead the `state` parameter *is* the
 * identity: 256 bits from the system CSPRNG, minted for one user, valid for
 * ten minutes, and consumed by the write that reads it.
 *
 * That last part is the lesson `login()` taught: `consume` deletes the row and
 * asks SQLite how many rows it deleted, so two callbacks racing on one state
 * cannot both proceed. A read-then-delete would let both through.
 *
 * Nothing here returns a credential. The client secret and the refresh token
 * go into the vault under the `google` scope on the way in and are read back
 * only to be handed to Google or to the MCP server's environment — the status
 * this service serves carries the account's email, the grants and the client
 * id, which are what an operator needs to recognise the connection, and no
 * more.
 */

import { randomBytes } from 'node:crypto';

import { GoogleGrant, type GoogleGrant as Grant } from '@metaclaude/shared';

import type { Db } from '../../db/index.js';
import type { Vault } from '../../security/vault.js';
import {
  buildAuthUrl,
  emailFromIdToken,
  exchangeCode,
  GoogleOAuthError,
  type FetchLike,
} from './oauth.js';
import { scopeOf, scopesFor } from './scopes.js';

/** Where the vault keeps this connection's secrets. */
export const GOOGLE_VAULT_SCOPE = 'integration:google' as const;
export const CLIENT_SECRET_KEY = 'GOOGLE_CLIENT_SECRET';
export const REFRESH_TOKEN_KEY = 'GOOGLE_REFRESH_TOKEN';

/** Long enough to find the right Google account and read a consent screen. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

export interface GoogleConnectionStatus {
  connected: boolean;
  /** Which Google account the refresh token belongs to; null if unreadable. */
  accountEmail: string | null;
  grants: Grant[];
  /** Not a secret — it is in every authorisation URL the browser ever saw. */
  clientId: string | null;
  connectedAt: number | null;
  connectedBy: string | null;
}

interface FlowRow {
  state: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  grants: string;
  expires_at: number;
}

interface ConnectionRow {
  client_id: string;
  account_email: string | null;
  grants: string;
  connected_at: number;
  connected_by: string;
}

export class GoogleConnectService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The exact redirect URI Google must be told about, for a browser standing
   * on `origin`.
   *
   * Exposed because the operator has to paste it into the Google Cloud console
   * *before* the first attempt, and a single character of difference produces
   * `redirect_uri_mismatch` — the most common way this setup fails. Showing
   * the string the server will actually send removes the guesswork.
   */
  static redirectUriFor(origin: string): string {
    return new URL('/api/integrations/google/callback', origin).toString();
  }

  status(): GoogleConnectionStatus {
    const row = this.db
      .prepare<[], ConnectionRow>(
        `SELECT client_id, account_email, grants, connected_at, connected_by
           FROM google_connection WHERE id = 'default'`,
      )
      .get();
    if (!row) {
      return {
        connected: false,
        accountEmail: null,
        grants: [],
        clientId: null,
        connectedAt: null,
        connectedBy: null,
      };
    }
    return {
      connected: true,
      accountEmail: row.account_email,
      grants: parseGrants(row.grants),
      clientId: row.client_id,
      connectedAt: row.connected_at,
      connectedBy: row.connected_by,
    };
  }

  /**
   * Start an authorisation: stash the flow, return the URL to send the browser
   * to. The secret is sealed here rather than at the callback, because by then
   * there is no authenticated operator to have supplied it.
   */
  begin(input: {
    userId: string;
    clientId: string;
    clientSecret: string;
    grants: readonly Grant[];
    origin: string;
    loginHint?: string;
  }): { url: string; state: string; redirectUri: string } {
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId) throw new GoogleOAuthError('The OAuth client ID is required.');
    if (!clientSecret) throw new GoogleOAuthError('The OAuth client secret is required.');
    if (input.grants.length === 0) {
      // A connection with identity scopes alone can do nothing at all, and
      // would sit in the interface looking like it works.
      throw new GoogleOAuthError('Choose at least one thing the agent may do with your account.');
    }

    let redirectUri: string;
    try {
      redirectUri = GoogleConnectService.redirectUriFor(input.origin);
    } catch {
      throw new GoogleOAuthError('Could not work out this deployment’s own address.');
    }

    const state = randomBytes(32).toString('base64url');
    const at = this.now();
    this.sweepExpiredFlows(at);
    this.db
      .prepare(
        `INSERT INTO google_oauth_flows
           (state, user_id, client_id, redirect_uri, grants, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state,
        input.userId,
        clientId,
        redirectUri,
        JSON.stringify([...input.grants]),
        at,
        at + FLOW_TTL_MS,
      );

    // Sealed now, under the client id it belongs to. If the operator abandons
    // the flow the secret is simply overwritten by the next attempt.
    this.vault.set(GOOGLE_VAULT_SCOPE, CLIENT_SECRET_KEY, clientSecret);

    return {
      url: buildAuthUrl({
        clientId,
        redirectUri,
        scope: scopesFor([...input.grants]),
        state,
        ...(input.loginHint ? { loginHint: input.loginHint } : {}),
      }),
      state,
      redirectUri,
    };
  }

  /**
   * Finish an authorisation from the callback's query string.
   *
   * Returns the connected account rather than throwing on Google's own
   * refusals so the route can redirect the browser back to a screen that
   * explains what happened — a JSON error body is useless at the end of a
   * top-level navigation.
   */
  async complete(input: { state: string; code: string }): Promise<GoogleConnectionStatus> {
    const flow = this.consumeFlow(input.state, this.now());
    if (!flow) {
      throw new GoogleOAuthError(
        'That authorisation is no longer valid — it was already used, or it expired. Start again.',
      );
    }

    const clientSecret = this.vault.get(GOOGLE_VAULT_SCOPE, CLIENT_SECRET_KEY);
    if (!clientSecret) {
      throw new GoogleOAuthError('The stored OAuth client secret is gone. Start again.');
    }

    const tokens = await exchangeCode(this.fetchImpl, {
      code: input.code,
      clientId: flow.client_id,
      clientSecret,
      redirectUri: flow.redirect_uri,
    });

    // What Google *granted*, intersected with what was asked for. A consent
    // screen lets the user untick things, and recording the request rather
    // than the grant would make the interface claim a power the agent does
    // not have — which surfaces later as an opaque 403 mid-run.
    const asked = parseGrants(flow.grants);
    const granted =
      tokens.grantedScopes.length > 0
        ? asked.filter((grant) => tokens.grantedScopes.includes(scopeOf(grant)))
        : asked;

    this.vault.set(GOOGLE_VAULT_SCOPE, REFRESH_TOKEN_KEY, tokens.refreshToken!);

    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO google_connection
           (id, client_id, account_email, grants, connected_at, connected_by)
         VALUES ('default', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           client_id = excluded.client_id,
           account_email = excluded.account_email,
           grants = excluded.grants,
           connected_at = excluded.connected_at,
           connected_by = excluded.connected_by`,
      )
      .run(
        flow.client_id,
        emailFromIdToken(tokens.idToken),
        JSON.stringify(granted),
        at,
        flow.user_id,
      );

    return this.status();
  }

  /**
   * Forget the connection.
   *
   * Local only, and the interface says so: deleting the refresh token stops
   * Metaclaude using it but does not tell Google to revoke it. The honest
   * instruction — revoke at myaccount.google.com/permissions — belongs beside
   * the button, not in a comment.
   */
  disconnect(): boolean {
    this.vault.deleteScope(GOOGLE_VAULT_SCOPE);
    this.db.prepare('DELETE FROM google_oauth_flows').run();
    return this.db.prepare(`DELETE FROM google_connection WHERE id = 'default'`).run().changes > 0;
  }

  /** The environment the MCP server needs, or null when nothing is connected. */
  serverEnvironment(): Record<string, string> | null {
    const status = this.status();
    if (!status.connected || !status.clientId) return null;
    const secret = this.vault.get(GOOGLE_VAULT_SCOPE, CLIENT_SECRET_KEY);
    const refresh = this.vault.get(GOOGLE_VAULT_SCOPE, REFRESH_TOKEN_KEY);
    if (!secret || !refresh) return null;
    return {
      GOOGLE_CLIENT_ID: status.clientId,
      GOOGLE_CLIENT_SECRET: secret,
      GOOGLE_REFRESH_TOKEN: refresh,
    };
  }

  /**
   * Take a flow: return it and spend it, or return null.
   *
   * The expiry lives in the DELETE rather than in a branch above it, so the
   * statement that *takes* the row is the same one that decides it was still
   * valid — the two cannot disagree, and `changes` says whether this caller
   * is the one that got it.
   *
   * Worth being precise about what this does and does not buy, because the
   * obvious claim is wrong: better-sqlite3 is synchronous and nothing here
   * awaits between the SELECT and the DELETE, so a read-then-delete would be
   * just as single-use today — measured, by writing it that way and watching
   * the test still pass. What the single statement buys is that it stays
   * correct if an await is ever introduced ahead of it, which is exactly how
   * `login()` acquired its race: scrypt landed between the read and the
   * write, and a check that had always held stopped holding.
   */
  private consumeFlow(state: string, at: number): FlowRow | null {
    const row = this.db
      .prepare<[string], FlowRow>(
        `SELECT state, user_id, client_id, redirect_uri, grants, expires_at
           FROM google_oauth_flows WHERE state = ?`,
      )
      .get(state);
    if (!row) return null;

    const taken = this.db
      .prepare('DELETE FROM google_oauth_flows WHERE state = ? AND expires_at > ?')
      .run(state, at).changes;
    return taken === 1 ? row : null;
  }

  private sweepExpiredFlows(at: number): void {
    this.db.prepare('DELETE FROM google_oauth_flows WHERE expires_at <= ?').run(at);
  }
}

function parseGrants(raw: string): Grant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Validate rather than cast: this column outlives the vocabulary that wrote
  // it, and a grant removed from the enum must not reappear as a live power.
  return parsed.filter((value): value is Grant => GoogleGrant.safeParse(value).success);
}

