/**
 * The MCP OAuth flow.
 *
 * Everything here is driven against a fake authorization server rather than a
 * mocked client, because what is worth testing is the *protocol* — which
 * document is fetched, what is sent to the token endpoint, and above all what
 * is refused. A mock of our own client would only prove that our client does
 * what our client does.
 *
 * The refusals are the point. A flow that works is table stakes; a flow that
 * declines to downgrade PKCE, declines to redeem a code for an issuer it did
 * not start with, and declines to reuse a state is the difference between
 * "OAuth" and "OAuth done properly".
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, migrate, type Db } from '../db/index.js';
import { Vault } from '../security/vault.js';
import { McpOAuth, McpOAuthError, OAUTH_SLOTS } from './mcp-oauth.js';

const RESOURCE = 'https://mcp.example.test/mcp';
const ISSUER = 'https://auth.example.test/';
const CALLBACK = 'https://metaclaude.example.test/api/mcp/oauth/callback';

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: 'https://auth.example.test/authorize',
  token_endpoint: 'https://auth.example.test/token',
  registration_endpoint: 'https://auth.example.test/register',
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
};

let db: Db;
let vault: Vault;
let serverId: string;

/** A stand-in authorization server, answering the four documents in the cascade. */
function fakeProvider(overrides: {
  metadata?: Record<string, unknown>;
  token?: { status: number; body: unknown };
  registration?: { status: number; body: unknown };
  onToken?: (form: URLSearchParams) => void;
} = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url === RESOURCE) {
      return new Response('{}', {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    if (url.includes('/.well-known/oauth-protected-resource')) {
      return Response.json({ resource: RESOURCE, authorization_servers: [ISSUER] });
    }
    if (url.includes('/.well-known/oauth-authorization-server')) {
      return Response.json(overrides.metadata ?? METADATA);
    }
    if (url.endsWith('/register')) {
      const registration = overrides.registration ?? {
        status: 201,
        body: { client_id: 'client-abc' },
      };
      return Response.json(registration.body, { status: registration.status });
    }
    if (url.endsWith('/token')) {
      overrides.onToken?.(new URLSearchParams(String(init?.body ?? '')));
      const token = overrides.token ?? {
        status: 200,
        body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 },
      };
      return Response.json(token.body, { status: token.status });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

function makeFlow(
  provider: ReturnType<typeof fakeProvider>,
  options: { isSafeEndpoint?: (url: string) => Promise<boolean>; now?: () => number } = {},
) {
  return new McpOAuth({
    db,
    vault,
    fetch: provider.fetch,
    isSafeEndpoint: options.isSafeEndpoint ?? (async () => true),
    callbackUrl: CALLBACK,
    log: () => undefined,
    now: options.now,
  });
}

const server = () => ({
  id: serverId,
  name: 'example',
  url: RESOURCE,
  authType: 'none',
  oauthIssuer: null,
  oauthMetadata: null,
  oauthClientId: null,
  oauthExpiresAt: null,
  oauthScope: null,
});

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, Buffer.alloc(32, 7));
  serverId = `mcp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO mcp_servers (id, workspace_id, name, transport, url, enabled, created_at, updated_at)
     VALUES (?, NULL, 'example', 'http', ?, 1, ?, ?)`,
  ).run(serverId, RESOURCE, now, now);
});

describe('discovery', () => {
  /**
   * The `resource_metadata` URL a 401 names is authoritative; the well-known
   * path is a guess. Measured against a real provider (mcp.plaud.ai), the two
   * agree only because that origin hosts one resource — an origin with several
   * would describe the wrong one.
   */
  it('follows the URL the server names before guessing a well-known path', async () => {
    const provider = fakeProvider();
    await makeFlow(provider).begin(server(), 'dev');

    const probe = provider.calls.indexOf(`POST ${RESOURCE}`);
    const named = provider.calls.findIndex((c) =>
      c.includes('/.well-known/oauth-protected-resource/mcp'),
    );
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(named).toBeGreaterThan(probe);
  });

  it('refuses a server that does not offer PKCE S256, rather than downgrading', async () => {
    const provider = fakeProvider({
      metadata: { ...METADATA, code_challenge_methods_supported: ['plain'] },
    });
    await expect(makeFlow(provider).begin(server(), 'dev')).rejects.toThrow(/PKCE/);
  });

  it('refuses a server that publishes no metadata at all', async () => {
    const silent = {
      fetch: (async () => new Response('nope', { status: 404 })) as typeof globalThis.fetch,
      calls: [],
    };
    await expect(makeFlow(silent).begin(server(), 'dev')).rejects.toThrow(/discovered/);
  });

  it('never fetches an endpoint the guard refuses', async () => {
    const provider = fakeProvider();
    const flow = makeFlow(provider, { isSafeEndpoint: async () => false });
    await expect(flow.begin(server(), 'dev')).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('starting a flow', () => {
  it('registers dynamically and builds an authorization URL the spec asks for', async () => {
    const provider = fakeProvider();
    const begun = await makeFlow(provider).begin(server(), 'dev');
    const url = new URL(begun.authorizeUrl);

    expect(url.origin + url.pathname).toBe('https://auth.example.test/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // RFC 8707: the token is minted for this resource and no other.
    expect(url.searchParams.get('resource')).toBe(RESOURCE);
    // The challenge is the hash, never the verifier.
    const challenge = url.searchParams.get('code_challenge') ?? '';
    expect(challenge).toHaveLength(43);
    expect(challenge).not.toBe(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.verifier));
  });

  it('says which setting is missing rather than registering with a bad client id', async () => {
    const provider = fakeProvider({
      metadata: { ...METADATA, registration_endpoint: undefined },
    });
    await expect(makeFlow(provider).begin(server(), 'dev')).rejects.toThrow(/client id/);
  });

  /**
   * Credentials belong to the issuer that minted them. Reusing a registration
   * against a different authorization server would send one provider's client
   * id — and possibly its secret — to another.
   */
  it('discards a stored registration when the issuer has changed', async () => {
    const provider = fakeProvider();
    const begun = await makeFlow(provider).begin(
      { ...server(), oauthClientId: 'old-client', oauthIssuer: 'https://elsewhere.test/' },
      'dev',
    );
    expect(begun.clientId).toBe('client-abc');
    expect(provider.calls.some((c) => c.endsWith('/register'))).toBe(true);
  });
});

describe('the callback', () => {
  async function start() {
    const provider = fakeProvider();
    const flow = makeFlow(provider);
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;
    return { flow, state, provider };
  }

  it('redeems the code and stores the tokens sealed', async () => {
    let sent: URLSearchParams | null = null;
    const provider = fakeProvider({ onToken: (form) => (sent = form) });
    const flow = makeFlow(provider);
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;

    const done = await flow.complete({ code: 'the-code', state, iss: ISSUER });
    expect(done.serverId).toBe(serverId);
    expect(done.actor).toBe('dev');

    expect(sent!.get('grant_type')).toBe('authorization_code');
    expect(sent!.get('code')).toBe('the-code');
    expect(sent!.get('redirect_uri')).toBe(CALLBACK);
    expect(sent!.get('code_verifier')).toBeTruthy();
    expect(sent!.get('resource')).toBe(RESOURCE);

    expect(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.access)).toBe('at-1');
    expect(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.refresh)).toBe('rt-1');
    // The verifier is single-use and gone once redeemed.
    expect(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.verifier)).toBeNull();
  });

  /**
   * RFC 9207, and the reason it is checked *before* the exchange: the code is
   * the credential. Validating the issuer after redeeming it would already
   * have handed the code to whoever sent the callback.
   */
  it('refuses a callback whose issuer is not the one the flow started with', async () => {
    const { flow, state, provider } = await start();
    const before = provider.calls.length;

    await expect(
      flow.complete({ code: 'the-code', state, iss: 'https://attacker.test/' }),
    ).rejects.toThrow(/did not come from/);

    // Nothing was sent anywhere: no token request was made at all.
    expect(provider.calls.length).toBe(before);
    expect(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.access)).toBeNull();
  });

  it('accepts a callback that carries no issuer, which many providers do not send', async () => {
    const { flow, state } = await start();
    await expect(flow.complete({ code: 'the-code', state, iss: null })).resolves.toBeTruthy();
  });

  it('refuses a state that was already used', async () => {
    const { flow, state } = await start();
    await flow.complete({ code: 'the-code', state, iss: ISSUER });
    await expect(flow.complete({ code: 'again', state, iss: ISSUER })).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it('refuses a state that has expired', async () => {
    let clock = 1_000_000;
    const provider = fakeProvider();
    const flow = makeFlow(provider, { now: () => clock });
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;

    clock += 11 * 60_000; // the window is ten minutes
    await expect(flow.complete({ code: 'the-code', state, iss: ISSUER })).rejects.toThrow(
      /expired/,
    );
  });

  it('refuses an unknown state', async () => {
    const { flow } = await start();
    await expect(
      flow.complete({ code: 'the-code', state: 'never-issued', iss: ISSUER }),
    ).rejects.toThrow(McpOAuthError);
  });

  it('does not store anything when the provider refuses the exchange', async () => {
    const provider = fakeProvider({
      token: { status: 400, body: { error: 'invalid_grant' } },
    });
    const flow = makeFlow(provider);
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;

    await expect(flow.complete({ code: 'bad', state, iss: ISSUER })).rejects.toThrow(/refused/);
    expect(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.access)).toBeNull();
  });

  /**
   * The token request carries the code, the verifier and possibly the client
   * secret. The endpoint was discovered at another point in time, so it is
   * judged again here — DNS moves.
   */
  it('refuses to send the code to a token endpoint the guard rejects at that moment', async () => {
    const provider = fakeProvider();
    let strict = false;
    const flow = makeFlow(provider, {
      isSafeEndpoint: async (url) => !(strict && url.endsWith('/token')),
    });
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;

    strict = true;
    await expect(flow.complete({ code: 'the-code', state, iss: ISSUER })).rejects.toThrow(
      /safety check/,
    );
  });
});

describe('refreshing', () => {
  async function authorised(expiresIn: number | undefined) {
    const provider = fakeProvider({
      token: {
        status: 200,
        body: { access_token: 'at-1', refresh_token: 'rt-1', ...(expiresIn ? { expires_in: expiresIn } : {}) },
      },
    });
    const flow = makeFlow(provider);
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;
    await flow.complete({ code: 'c', state, iss: ISSUER });
    const row = db
      .prepare<[string], { oauth_expires_at: number | null }>(
        'SELECT oauth_expires_at FROM mcp_servers WHERE id = ?',
      )
      .get(serverId)!;
    return { flow, provider, expiresAt: row.oauth_expires_at };
  }

  it('leaves a token alone while it has time left', async () => {
    const { flow, provider, expiresAt } = await authorised(3600);
    const before = provider.calls.length;
    const ok = await flow.refreshIfExpiring({
      ...server(),
      authType: 'oauth',
      oauthExpiresAt: expiresAt,
      oauthClientId: 'client-abc',
      oauthMetadata: JSON.stringify({ tokenEndpoint: METADATA.token_endpoint }),
    });
    expect(ok).toBe(true);
    expect(provider.calls.length).toBe(before);
  });

  it('renews one that is about to expire, with the refresh grant', async () => {
    let sent: URLSearchParams | null = null;
    const provider = fakeProvider({
      onToken: (form) => (sent = form),
      token: { status: 200, body: { access_token: 'at-2', expires_in: 3600 } },
    });
    const flow = makeFlow(provider);
    vault.set(`mcp:${serverId}`, OAUTH_SLOTS.access, 'at-1');
    vault.set(`mcp:${serverId}`, OAUTH_SLOTS.refresh, 'rt-1');

    const ok = await flow.refreshIfExpiring({
      ...server(),
      authType: 'oauth',
      // Inside the five-minute margin.
      oauthExpiresAt: Date.now() + 60_000,
      oauthClientId: 'client-abc',
      oauthMetadata: JSON.stringify({ tokenEndpoint: METADATA.token_endpoint }),
    });

    expect(ok).toBe(true);
    expect(sent!.get('grant_type')).toBe('refresh_token');
    expect(sent!.get('refresh_token')).toBe('rt-1');
    expect(vault.get(`mcp:${serverId}`, OAUTH_SLOTS.access)).toBe('at-2');
  });

  /**
   * A token with no stated lifetime is recorded as null rather than as "never
   * expires". Refreshing it on a guess would spend the refresh token for
   * nothing; a 401 is what eventually reveals the truth.
   */
  it('records no expiry when the provider stated none, and does not invent one', async () => {
    const { expiresAt } = await authorised(undefined);
    expect(expiresAt).toBeNull();
  });

  it('reports a failed renewal instead of throwing into the run', async () => {
    const provider = fakeProvider({ token: { status: 401, body: { error: 'invalid_grant' } } });
    const flow = makeFlow(provider);
    vault.set(`mcp:${serverId}`, OAUTH_SLOTS.access, 'at-1');
    vault.set(`mcp:${serverId}`, OAUTH_SLOTS.refresh, 'rt-1');

    const ok = await flow.refreshIfExpiring({
      ...server(),
      authType: 'oauth',
      oauthExpiresAt: Date.now() + 1000,
      oauthClientId: 'client-abc',
      oauthMetadata: JSON.stringify({ tokenEndpoint: METADATA.token_endpoint }),
    });
    expect(ok).toBe(false);
  });
});

describe('revoking', () => {
  it('deletes every stored secret and the registration with it', async () => {
    const provider = fakeProvider();
    const flow = makeFlow(provider);
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;
    await flow.complete({ code: 'c', state, iss: ISSUER });

    expect(flow.isAuthorised(serverId)).toBe(true);
    flow.revoke(serverId);

    expect(flow.isAuthorised(serverId)).toBe(false);
    for (const slot of Object.values(OAUTH_SLOTS)) {
      expect(vault.get(`mcp:${serverId}`, slot)).toBeNull();
    }
    const row = db
      .prepare<[string], { oauth_client_id: string | null }>(
        'SELECT oauth_client_id FROM mcp_servers WHERE id = ?',
      )
      .get(serverId)!;
    expect(row.oauth_client_id).toBeNull();
  });
});

describe('the state table', () => {
  it('drops states nobody came back for, and keeps the live ones', async () => {
    let clock = 1_000_000;
    const provider = fakeProvider();
    const flow = makeFlow(provider, { now: () => clock });
    await flow.begin(server(), 'dev');

    expect(flow.sweepStates()).toBe(0);
    clock += 11 * 60_000;
    expect(flow.sweepStates()).toBe(1);
  });
});

describe('the vault slot names', () => {
  /**
   * The registry mounts the bearer without importing this module, to avoid a
   * circular dependency, so it repeats the slot name as a constant. If the two
   * ever disagree, a token would be written where nothing reads it and every
   * run would mount unauthenticated — silently.
   */
  it('agree with the copy the registry mounts from', async () => {
    const registrySource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./registry.ts', import.meta.url), 'utf8'),
    );
    expect(registrySource).toContain(`'${OAUTH_SLOTS.access}'`);
  });
});

describe('the error codes that may be logged', () => {
  it('never lets a provider’s own text reach the logs', async () => {
    const lines: unknown[] = [];
    const provider = fakeProvider({
      token: {
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'SECRET-LEAK-CANARY token=abc\nInjected: line',
        },
      },
    });
    const flow = new McpOAuth({
      db,
      vault,
      fetch: provider.fetch,
      isSafeEndpoint: async () => true,
      callbackUrl: CALLBACK,
      log: (_level, message, data) => lines.push({ message, data }),
    });
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;
    await expect(flow.complete({ code: 'c', state, iss: ISSUER })).rejects.toThrow();

    const logged = JSON.stringify(lines);
    expect(logged).toContain('invalid_grant');
    expect(logged).not.toContain('SECRET-LEAK-CANARY');
  });

  it('reports an unrecognised code as such rather than echoing it', async () => {
    const lines: unknown[] = [];
    const provider = fakeProvider({
      token: { status: 400, body: { error: 'weird_vendor_code_with_data_abc123' } },
    });
    const flow = new McpOAuth({
      db,
      vault,
      fetch: provider.fetch,
      isSafeEndpoint: async () => true,
      callbackUrl: CALLBACK,
      log: (_level, message, data) => lines.push({ message, data }),
    });
    const begun = await flow.begin(server(), 'dev');
    const state = new URL(begun.authorizeUrl).searchParams.get('state')!;
    await expect(flow.complete({ code: 'c', state, iss: ISSUER })).rejects.toThrow();

    const logged = JSON.stringify(lines);
    expect(logged).toContain('unrecognised');
    expect(logged).not.toContain('weird_vendor_code_with_data_abc123');
  });
});

// Keeps the import used when the suite is filtered down to one describe.
void vi;
