/**
 * OAuth 2.1 for remote MCP servers.
 *
 * The agent SDK's HTTP and SSE server configs accept `headers` and nothing
 * else — checked against the shipped `sdk.d.ts`, there is no OAuth field to
 * hand it. So the CLI cannot perform this flow on our behalf: Metaclaude runs
 * it, keeps the tokens, and injects `Authorization: Bearer …` at mount like any
 * other header. That is the whole architecture, and its one consequence worth
 * stating is that a token has to be *fresh at mount*, which is why refreshing
 * happens before a run rather than in response to a 401 nobody would see.
 *
 * What the specification asks for, and why each part is here rather than
 * simplified away:
 *
 *  - **RFC 9728** — the protected resource names its authorization servers.
 *    Preferred through the `resource_metadata` URL the server itself puts in
 *    `WWW-Authenticate`, not the guessed well-known path. Measured against
 *    mcp.plaud.ai: it names `/.well-known/oauth-protected-resource/mcp`, the
 *    path-scoped form, and the unsuffixed guess happens to answer the same
 *    document only because that origin hosts one resource.
 *  - **RFC 8414** — the authorization server's own metadata.
 *  - **RFC 7636** — PKCE with S256, and a server that does not offer S256 is
 *    refused rather than downgraded.
 *  - **RFC 7591** — dynamic client registration, so a server that supports it
 *    needs nothing from the operator. One that does not needs a client id
 *    pasted in, and says so.
 *  - **RFC 8707** — the `resource` parameter, so a token minted for this MCP
 *    server cannot be replayed against another resource of the same issuer.
 *  - **RFC 9207** — the `iss` returned to the callback is checked against the
 *    issuer recorded at initiation *before* the authorization code is redeemed.
 *
 * Two rules about what leaves this module. A third-party authorization server
 * controls its own response bodies, so none of them is ever logged: only an
 * error *code* from the RFC 6749 §5.2 allowlist below. And every outbound URL
 * is revalidated at the moment it is used rather than at the moment it was
 * discovered — DNS moves, and the token request carries the authorization code
 * and the PKCE verifier.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Vault } from '../security/vault.js';

/** How long an operator has to complete the redirect before the state expires. */
const STATE_TTL_MS = 10 * 60_000;

/** Refresh this far ahead of expiry, so a run never starts on a dying token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Every network call this module makes. */
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Vault slots, prefixed so they cannot collide with an operator's own env or
 * header secrets in the same scope — the same reason `header:` exists.
 */
const SLOT = {
  access: 'oauth:access_token',
  refresh: 'oauth:refresh_token',
  clientSecret: 'oauth:client_secret',
  verifier: 'oauth:code_verifier',
} as const;

/**
 * The only error codes that may be logged from a third party's response.
 *
 * RFC 6749 §5.2 plus RFC 8628 §3.5. A provider's `error_description` is
 * arbitrary text we do not control: it can echo a token, personal data, or a
 * CRLF-injected line into the log, and no generic redaction can be trusted to
 * catch that. An unrecognised code is reported as `unrecognised`.
 */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'unsupported_response_type',
  'server_error',
  'temporarily_unavailable',
  'authorization_pending',
  'slow_down',
  'expired_token',
]);

export class McpOAuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

export interface AuthServerMetadata {
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
  supportsPkceS256: boolean;
}

export interface McpOAuthDeps {
  db: Db;
  vault: Vault;
  /** Injected so the tests never reach the network. */
  fetch: typeof globalThis.fetch;
  /**
   * Refuses an endpoint that must not be reached — private ranges, loopback,
   * anything the deployment forbids. Called immediately before each use rather
   * than once at registration: DNS can move between the two.
   */
  isSafeEndpoint: (url: string) => Promise<boolean>;
  /** Where the provider sends the browser back. Public, and one per deployment. */
  callbackUrl: string;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now?: () => number;
}

interface StateRow {
  state: string;
  server_id: string;
  actor: string;
  issuer: string | null;
  token_url: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  created_at: number;
  expires_at: number;
}

/** The subset of a server row this module needs; the registry owns the rest. */
export interface OAuthServer {
  id: string;
  name: string;
  url: string | null;
  authType: string;
  oauthIssuer: string | null;
  oauthMetadata: string | null;
  oauthClientId: string | null;
  oauthExpiresAt: number | null;
  oauthScope: string | null;
}

/* -------------------------------------------------------------------------- */

/** RFC 7636: 43–128 characters from the unreserved set. */
function codeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The error code a provider returned, or a word saying we would not repeat it.
 *
 * Never the description, never the body. See the note at the top of the file.
 */
function safeErrorCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'unparseable';
  const code = (body as { error?: unknown }).error;
  if (typeof code !== 'string') return 'absent';
  return OAUTH_ERROR_CODES.has(code) ? code : 'unrecognised';
}

/** Hosts only: both sides of an issuer comparison are attacker-influenced URLs. */
function hostOf(url: string | null): string {
  if (!url) return 'absent';
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}

/** A constant-time comparison for the state token, which is a credential. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class McpOAuth {
  private readonly now: () => number;

  constructor(private readonly deps: McpOAuthDeps) {
    this.now = deps.now ?? Date.now;
  }

  /* ------------------------------ discovery ----------------------------- */

  private async getJson(url: string, phase: string): Promise<Record<string, unknown> | null> {
    if (!(await this.deps.isSafeEndpoint(url))) {
      this.deps.log('warn', 'MCP OAuth: refusing an unsafe endpoint', { phase, host: hostOf(url) });
      return null;
    }
    try {
      const response = await this.deps.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      // A discovery step that does not answer is a step that does not apply;
      // the cascade continues and only its exhaustion is an error.
      return null;
    }
  }

  /**
   * The `resource_metadata` URL a 401 names, which is the authoritative one.
   *
   * Preferred over guessing `/.well-known/oauth-protected-resource` because
   * RFC 9728's path-scoped form is what a server hosting several resources on
   * one origin uses, and the guess would then describe the wrong resource.
   */
  private async resourceMetadataUrl(mcpUrl: string): Promise<string | null> {
    if (!(await this.deps.isSafeEndpoint(mcpUrl))) return null;
    try {
      const response = await this.deps.fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (response.status !== 401) return null;
      const header = response.headers.get('www-authenticate') ?? '';
      return /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async discover(mcpUrl: string): Promise<AuthServerMetadata> {
    const origin = new URL(mcpUrl).origin;

    // 1. What the server itself points at.
    const named = await this.resourceMetadataUrl(mcpUrl);
    const candidates = [
      ...(named ? [named] : []),
      `${origin}/.well-known/oauth-protected-resource${new URL(mcpUrl).pathname}`,
      `${origin}/.well-known/oauth-protected-resource`,
    ];
    for (const candidate of candidates) {
      const resource = await this.getJson(candidate, 'protected-resource');
      const servers = resource?.['authorization_servers'];
      if (Array.isArray(servers) && typeof servers[0] === 'string') {
        return await this.authServerMetadata(servers[0]);
      }
    }

    // 2. The origin itself, for a server that publishes no resource metadata.
    for (const suffix of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const metadata = await this.getJson(`${origin}${suffix}`, 'auth-server');
      if (metadata && typeof metadata['authorization_endpoint'] === 'string') {
        return this.readMetadata(metadata);
      }
    }

    throw new McpOAuthError(
      'No OAuth authorization server could be discovered for this MCP server. It may not use OAuth, or it may not publish the metadata the protocol asks for.',
    );
  }

  private async authServerMetadata(issuer: string): Promise<AuthServerMetadata> {
    const base = issuer.replace(/\/$/, '');
    for (const suffix of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const metadata = await this.getJson(`${base}${suffix}`, 'auth-server');
      if (metadata && typeof metadata['authorization_endpoint'] === 'string') {
        return this.readMetadata(metadata);
      }
    }
    throw new McpOAuthError(
      `The authorization server at ${hostOf(issuer)} published no usable metadata.`,
    );
  }

  private readMetadata(raw: Record<string, unknown>): AuthServerMetadata {
    const str = (key: string): string | null =>
      typeof raw[key] === 'string' ? (raw[key] as string) : null;
    const methods = Array.isArray(raw['code_challenge_methods_supported'])
      ? (raw['code_challenge_methods_supported'] as unknown[])
      : [];
    const scopes = Array.isArray(raw['scopes_supported'])
      ? (raw['scopes_supported'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    const authorizationEndpoint = str('authorization_endpoint');
    const tokenEndpoint = str('token_endpoint');
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new McpOAuthError('The authorization server named no authorization or token endpoint.');
    }

    return {
      issuer: str('issuer'),
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: str('registration_endpoint'),
      scopesSupported: scopes,
      supportsPkceS256: methods.includes('S256'),
    };
  }

  /* --------------------------- registration ----------------------------- */

  /**
   * Register this deployment as a client (RFC 7591).
   *
   * Public client: no secret is requested, `token_endpoint_auth_method` is
   * `none`, and PKCE is what binds the code to this client. A provider that
   * insists on a confidential client answers with a secret, which is stored
   * sealed like any other.
   */
  private async register(
    endpoint: string,
    redirectUri: string,
  ): Promise<{ clientId: string; clientSecret: string | null }> {
    if (!(await this.deps.isSafeEndpoint(endpoint))) {
      throw new McpOAuthError('Refusing to register with an endpoint that failed the safety check.');
    }
    const response = await this.deps.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Metaclaude',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      this.deps.log('warn', 'MCP OAuth: dynamic client registration refused', {
        host: hostOf(endpoint),
        status: response.status,
        code: safeErrorCode(body),
      });
      throw new McpOAuthError(
        'The authorization server refused to register Metaclaude as a client. Paste a client id issued by that server instead.',
      );
    }

    const clientId = (body as { client_id?: unknown } | null)?.client_id;
    if (typeof clientId !== 'string') {
      throw new McpOAuthError('The registration response carried no client id.');
    }
    const secret = (body as { client_secret?: unknown }).client_secret;
    return { clientId, clientSecret: typeof secret === 'string' ? secret : null };
  }

  /* ------------------------------- start -------------------------------- */

  /**
   * Everything up to the redirect: discover, register if needed, mint PKCE and
   * a state, and return the URL the operator's browser should visit.
   */
  async begin(
    server: OAuthServer,
    actor: string,
  ): Promise<{ authorizeUrl: string; metadata: AuthServerMetadata; clientId: string }> {
    if (!server.url) {
      throw new McpOAuthError('An OAuth server needs a URL; this one has none.');
    }

    const cached = server.oauthMetadata
      ? (JSON.parse(server.oauthMetadata) as AuthServerMetadata)
      : null;
    const metadata = cached?.authorizationEndpoint ? cached : await this.discover(server.url);

    if (!metadata.supportsPkceS256) {
      throw new McpOAuthError(
        'This authorization server does not offer PKCE with S256, which the MCP specification requires. Refusing to continue rather than downgrading.',
      );
    }

    // Credentials are bound to the issuer that minted them. A changed issuer
    // means the stored registration belongs to somebody else.
    let clientId = server.oauthClientId;
    let clientSecret = this.deps.vault.get(`mcp:${server.id}`, SLOT.clientSecret);
    const issuerChanged = Boolean(
      server.oauthIssuer && metadata.issuer && server.oauthIssuer !== metadata.issuer,
    );
    if (issuerChanged) {
      this.deps.log('warn', 'MCP OAuth: the authorization server changed', {
        server: server.name,
        was: hostOf(server.oauthIssuer),
        now: hostOf(metadata.issuer),
      });
      clientId = null;
      clientSecret = null;
    }

    if (!clientId) {
      if (!metadata.registrationEndpoint) {
        throw new McpOAuthError(
          'This authorization server does not offer dynamic registration, so it needs a client id issued by it. Paste one into the server and try again.',
        );
      }
      const registered = await this.register(metadata.registrationEndpoint, this.deps.callbackUrl);
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
      if (clientSecret) this.deps.vault.set(`mcp:${server.id}`, SLOT.clientSecret, clientSecret);
    }

    const verifier = codeVerifier();
    const state = randomBytes(32).toString('base64url');
    this.deps.vault.set(`mcp:${server.id}`, SLOT.verifier, verifier);

    const at = this.now();
    this.deps.db
      .prepare(
        `INSERT INTO mcp_oauth_states
           (state, server_id, actor, issuer, token_url, client_id, redirect_uri, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state,
        server.id,
        actor,
        metadata.issuer,
        metadata.tokenEndpoint,
        clientId,
        this.deps.callbackUrl,
        server.url,
        at,
        at + STATE_TTL_MS,
      );

    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.deps.callbackUrl);
    url.searchParams.set('code_challenge', codeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    // RFC 8707: the token is minted for this MCP server and no other.
    url.searchParams.set('resource', server.url);
    const scope = server.oauthScope ?? metadata.scopesSupported.join(' ');
    if (scope) url.searchParams.set('scope', scope);

    return { authorizeUrl: url.toString(), metadata, clientId };
  }

  /* ------------------------------ callback ------------------------------ */

  /** Consume a state, single use. Returns null when unknown or expired. */
  private takeState(state: string): StateRow | null {
    const row = this.deps.db
      .prepare<[string], StateRow>('SELECT * FROM mcp_oauth_states WHERE state = ?')
      .get(state);
    if (!row) return null;
    // The row was found by primary key, so this compare is belt and braces —
    // it costs nothing and keeps the credential handling uniform.
    if (!sameToken(row.state, state)) return null;
    this.deps.db.prepare('DELETE FROM mcp_oauth_states WHERE state = ?').run(state);
    return row.expires_at < this.now() ? null : row;
  }

  /**
   * Redeem the authorization code.
   *
   * Returns the server the tokens belong to, so the caller can audit it and
   * send the operator back to the right screen.
   */
  async complete(params: {
    code: string;
    state: string;
    iss?: string | null;
  }): Promise<{ serverId: string; actor: string }> {
    const row = this.takeState(params.state);
    if (!row) {
      throw new McpOAuthError(
        'This authorization link has expired or was already used. Start it again from the server.',
        410,
      );
    }

    // RFC 9207, before the code goes anywhere: a response from an issuer other
    // than the one we sent the operator to is not one we redeem.
    if (params.iss && row.issuer && params.iss !== row.issuer) {
      this.deps.log('error', 'MCP OAuth: the callback came from another issuer', {
        expected: hostOf(row.issuer),
        received: hostOf(params.iss),
      });
      throw new McpOAuthError(
        'The authorization response did not come from the authorization server this flow started with. Refusing to redeem the code.',
      );
    }

    const verifier = this.deps.vault.get(`mcp:${row.server_id}`, SLOT.verifier);
    if (!verifier) {
      throw new McpOAuthError('The PKCE verifier for this flow is gone; start the authorization again.');
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: row.redirect_uri,
      code_verifier: verifier,
      client_id: row.client_id,
      resource: row.resource,
    });

    await this.exchange(row.server_id, row.token_url, form);
    this.deps.vault.delete(`mcp:${row.server_id}`, SLOT.verifier);
    return { serverId: row.server_id, actor: row.actor };
  }

  /* ------------------------------ tokens -------------------------------- */

  /**
   * POST to the token endpoint and store what comes back.
   *
   * The endpoint is revalidated here rather than trusted from discovery: this
   * request carries the authorization code, the PKCE verifier and possibly the
   * client secret, and the name was resolved at another point in time.
   */
  private async exchange(serverId: string, tokenUrl: string, form: URLSearchParams): Promise<void> {
    const secret = this.deps.vault.get(`mcp:${serverId}`, SLOT.clientSecret);
    if (secret) form.set('client_secret', secret);

    if (!(await this.deps.isSafeEndpoint(tokenUrl))) {
      throw new McpOAuthError(
        'Refusing to send the authorization code to a token endpoint that failed the safety check.',
      );
    }

    let response: Response;
    try {
      response = await this.deps.fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new McpOAuthError(
        `The token endpoint could not be reached: ${(error as Error).message}`,
        502,
      );
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      this.deps.log('warn', 'MCP OAuth: token exchange refused', {
        host: hostOf(tokenUrl),
        status: response.status,
        code: safeErrorCode(body),
      });
      throw new McpOAuthError(
        `The authorization server refused the token request (HTTP ${response.status}).`,
        502,
      );
    }

    const access = body?.['access_token'];
    if (typeof access !== 'string' || access.length === 0) {
      throw new McpOAuthError('The token response carried no access token.');
    }
    const refresh = body?.['refresh_token'];
    const expiresIn = body?.['expires_in'];

    this.deps.vault.set(`mcp:${serverId}`, SLOT.access, access);
    if (typeof refresh === 'string' && refresh.length > 0) {
      this.deps.vault.set(`mcp:${serverId}`, SLOT.refresh, refresh);
    }

    // A response without `expires_in` is a token with no stated lifetime. It
    // is recorded as null rather than as "never expires": the refresh pass
    // then leaves it alone and a 401 is what eventually reveals the truth,
    // which is better than inventing an expiry the server never promised.
    const expiresAt =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? this.now() + expiresIn * 1000
        : null;

    this.deps.db
      .prepare('UPDATE mcp_servers SET oauth_expires_at = ?, updated_at = ? WHERE id = ?')
      .run(expiresAt, this.now(), serverId);
  }

  /** The bearer token to mount with, or null when there is none. */
  accessToken(serverId: string): string | null {
    return this.deps.vault.get(`mcp:${serverId}`, SLOT.access);
  }

  /** True when this server has been authorised at least once. */
  isAuthorised(serverId: string): boolean {
    return this.accessToken(serverId) !== null;
  }

  /**
   * Refresh a token that is about to expire, ahead of a run.
   *
   * Returns whether the server is mountable afterwards. A failure is a warning
   * rather than a throw: a run that cannot refresh one server's token still
   * runs, the server answers `needs-auth`, and the operator sees that on the
   * card — which is a better outcome than a run refusing to start.
   */
  async refreshIfExpiring(server: OAuthServer): Promise<boolean> {
    if (server.authType !== 'oauth') return true;
    if (!this.isAuthorised(server.id)) return false;
    if (server.oauthExpiresAt === null) return true;
    if (server.oauthExpiresAt - REFRESH_MARGIN_MS > this.now()) return true;

    const refresh = this.deps.vault.get(`mcp:${server.id}`, SLOT.refresh);
    const metadata = server.oauthMetadata
      ? (JSON.parse(server.oauthMetadata) as AuthServerMetadata)
      : null;
    if (!refresh || !metadata?.tokenEndpoint || !server.oauthClientId) return false;

    try {
      await this.exchange(
        server.id,
        metadata.tokenEndpoint,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: server.oauthClientId,
          ...(server.url ? { resource: server.url } : {}),
        }),
      );
      return true;
    } catch (error) {
      this.deps.log('warn', 'MCP OAuth: could not refresh a token before the run', {
        server: server.name,
        message: (error as Error).message,
      });
      return false;
    }
  }

  /** Forget an authorization entirely: tokens, secret, and the recorded expiry. */
  revoke(serverId: string): void {
    for (const slot of Object.values(SLOT)) this.deps.vault.delete(`mcp:${serverId}`, slot);
    this.deps.db
      .prepare(
        `UPDATE mcp_servers
            SET oauth_expires_at = NULL, oauth_client_id = NULL, oauth_metadata = NULL,
                oauth_issuer = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(this.now(), serverId);
  }

  /** Drop states nobody came back for. Called by the janitor. */
  sweepStates(): number {
    return this.deps.db
      .prepare('DELETE FROM mcp_oauth_states WHERE expires_at < ?')
      .run(this.now()).changes;
  }
}

/** Exported for the tests, which assert the slot names do not drift. */
export const OAUTH_SLOTS = SLOT;
