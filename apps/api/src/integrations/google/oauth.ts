/**
 * The Google OAuth dance, as much of it as belongs on the server.
 *
 * Three facts shape this file:
 *
 * **The browser never sees the client secret.** The authorisation URL is built
 * here and handed to the browser to *navigate to*; the code that comes back is
 * exchanged here, server to server. The secret exists in the vault and in this
 * process, nowhere else.
 *
 * **`access_type=offline` with `prompt=consent` is the whole point.** Without
 * the first there is no refresh token at all; without the second Google
 * *omits* the refresh token on every authorisation after the first, because it
 * assumes the caller kept the one it already issued. Metaclaude cannot have
 * kept it — the operator may be reconnecting precisely because it was revoked
 * or lost — so it asks every time. The cost is one extra consent screen; the
 * alternative is a connection that silently cannot refresh.
 *
 * **`fetch` is injected.** Tests must not reach the network, and the two calls
 * here are exactly where a wrong body or a missed error would hide. Every one
 * of Google's failure shapes (`error`, `error_description`) is surfaced
 * verbatim rather than flattened into "authentication failed" — `invalid_grant`
 * with "Token has been expired or revoked" is a *different problem* from
 * `redirect_uri_mismatch`, and telling them apart is most of the debugging.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The subset of `fetch` this module uses; the real one satisfies it. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

export interface AuthUrlInput {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  /**
   * Pre-fills the account chooser and, on a Workspace domain, keeps the
   * operator from binding a personal account by accident. Optional.
   */
  loginHint?: string;
}

export function buildAuthUrl(input: AuthUrlInput): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scope);
  url.searchParams.set('state', input.state);
  // See the header note: both are required for a refresh token that keeps
  // arriving on re-authorisation.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  // Ask Google to hand back the scopes it actually granted, so a partial
  // consent is visible instead of being discovered as a 403 mid-run.
  url.searchParams.set('include_granted_scopes', 'true');
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  /** Absent on a refresh; present on an exchange because of `prompt=consent`. */
  refreshToken: string | null;
  expiresInSeconds: number;
  /** What Google actually granted, which may be less than what was asked. */
  grantedScopes: string[];
  /** The signed identity token, when `openid` was among the scopes. */
  idToken: string | null;
}

async function postForm(
  fetchImpl: FetchLike,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    // A DNS or TLS failure here is an operational problem — egress, a proxy —
    // and saying so beats reporting it as a rejected credential.
    throw new GoogleOAuthError(
      `Could not reach Google's token endpoint: ${(error as Error).message}`,
      502,
    );
  }

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GoogleOAuthError(
      `Google's token endpoint returned ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
      502,
    );
  }

  if (!response.ok || typeof payload.error === 'string') {
    const code = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    const detail =
      typeof payload.error_description === 'string' ? `: ${payload.error_description}` : '';
    throw new GoogleOAuthError(`Google refused the request (${code}${detail}).`);
  }
  return payload;
}

function readTokens(payload: Record<string, unknown>): TokenResponse {
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new GoogleOAuthError('Google returned no access token.', 502);
  }
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresInSeconds: typeof payload.expires_in === 'number' ? payload.expires_in : 3600,
    grantedScopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    idToken: typeof payload.id_token === 'string' ? payload.id_token : null,
  };
}

/** Trade the one-time authorisation code for tokens. */
export async function exchangeCode(
  fetchImpl: FetchLike,
  input: { code: string; clientId: string; clientSecret: string; redirectUri: string },
): Promise<TokenResponse> {
  const payload = await postForm(fetchImpl, {
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    // Google requires this to be byte-identical to the one sent to the
    // authorisation endpoint — it is a signature over the flow, not a
    // destination — which is why the pending flow stores it rather than
    // recomputing it from whatever host the callback happened to arrive on.
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  const tokens = readTokens(payload);
  if (!tokens.refreshToken) {
    // With `prompt=consent` this should not happen; if it does, storing an
    // access token that dies in an hour would look like success and fail
    // silently tomorrow.
    throw new GoogleOAuthError(
      'Google returned no refresh token, so this connection could not survive an hour. ' +
        'Revoke Metaclaude at myaccount.google.com/permissions and connect again.',
    );
  }
  return tokens;
}

/** Mint a fresh access token from the stored refresh token. */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  input: { refreshToken: string; clientId: string; clientSecret: string },
): Promise<TokenResponse> {
  const payload = await postForm(fetchImpl, {
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'refresh_token',
  });
  return readTokens(payload);
}

/**
 * The email an id_token was issued for, or null.
 *
 * The signature is deliberately not verified, and that is safe *here* and
 * nowhere else: this token was received in the body of our own HTTPS request
 * to Google's token endpoint, so TLS already established who sent it — Google
 * documents this exact case as one where verification adds nothing. An
 * id_token arriving by any other route (a browser, a header, a redirect) has
 * no such provenance and must be verified properly.
 */
export function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}
