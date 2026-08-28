/**
 * An access token, kept alive from the refresh token.
 *
 * Google's access tokens last an hour; the MCP server outlives many of them,
 * so something has to notice. Three details decide whether this works:
 *
 *  - **A skew.** Renewing at the stated expiry means a token that was valid
 *    when the request was built is expired when Google reads it. Sixty seconds
 *    of margin costs one extra refresh an hour and removes the whole class of
 *    failure.
 *  - **One refresh in flight.** Three tool calls arriving together must not
 *    become three refreshes: Google rate-limits them, and two of the three
 *    results would be thrown away. The pending promise is shared.
 *  - **A failed refresh is not cached.** Clearing the in-flight promise in a
 *    `finally` is what lets the next call try again rather than awaiting a
 *    promise that already rejected.
 */

import { refreshAccessToken, type FetchLike } from './oauth.js';

/** Renew this long before Google would call the token expired. */
export const EXPIRY_SKEW_MS = 60_000;

export interface TokenCacheDeps {
  fetchImpl: FetchLike;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now?: () => number;
}

export class TokenCache {
  private token: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TokenCacheDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAt) return this.token;
    // Everyone who arrives while a refresh is running waits for that one.
    this.inFlight ??= this.renew().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async renew(): Promise<string> {
    const tokens = await refreshAccessToken(this.deps.fetchImpl, {
      refreshToken: this.deps.refreshToken,
      clientId: this.deps.clientId,
      clientSecret: this.deps.clientSecret,
    });
    this.token = tokens.accessToken;
    this.expiresAt = this.now() + tokens.expiresInSeconds * 1000 - EXPIRY_SKEW_MS;
    return tokens.accessToken;
  }

  /**
   * Forget the current token, so the next call mints a fresh one.
   *
   * Called when Google answers 401: an access token can die before its stated
   * expiry — a password change, a revoked session — and retrying once with a
   * new token turns an unexplained failure into a hiccup.
   */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}
