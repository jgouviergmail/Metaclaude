import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/index.js';
import { migrate, openDatabase } from '../../db/index.js';
import { Vault } from '../../security/vault.js';
import type { FetchLike } from './oauth.js';
import {
  CLIENT_SECRET_KEY,
  FLOW_TTL_MS,
  GOOGLE_VAULT_SCOPE,
  GoogleConnectService,
  REFRESH_TOKEN_KEY,
} from './service.js';

let db: Db;
let vault: Vault;
let clock = 1_700_000_000_000;

/** Google's happy answer, with a hook to vary it per test. */
function googleFetch(overrides: Record<string, unknown> = {}) {
  const calls: URLSearchParams[] = [];
  const impl: FetchLike = async (_url, options) => {
    calls.push(new URLSearchParams(options?.body ?? ''));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'at-1',
          refresh_token: 'rt-secret-1',
          expires_in: 3599,
          scope:
            'openid email https://www.googleapis.com/auth/gmail.readonly ' +
            'https://www.googleapis.com/auth/calendar.events',
          id_token: `${encode({ alg: 'RS256' })}.${encode({ email: 'ops@example.com' })}.sig`,
          ...overrides,
        }),
    };
  };
  return { impl, calls };
}

function makeService(fetchImpl: FetchLike): GoogleConnectService {
  return new GoogleConnectService(db, vault, fetchImpl, () => clock);
}

function seedUser(): string {
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
     VALUES ('user_1', 'owner', 'Owner', 'x', 'owner', 0, 0)`,
  ).run();
  return 'user_1';
}

const BEGIN = {
  userId: 'user_1',
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret-xyz',
  grants: ['gmail.read', 'calendar.write'] as const,
  origin: 'https://metaclaude.example',
};

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, Buffer.alloc(32, 7));
  seedUser();
});

afterEach(() => db.close());

describe('the redirect URI', () => {
  it('is the exact string the operator must paste into Google', () => {
    // A single character of difference is `redirect_uri_mismatch`, which is
    // the most common way this whole setup fails.
    expect(GoogleConnectService.redirectUriFor('https://metaclaude.example')).toBe(
      'https://metaclaude.example/api/integrations/google/callback',
    );
  });

  it('keeps a non-standard port, because Google matches on the whole string', () => {
    expect(GoogleConnectService.redirectUriFor('https://localhost:8443')).toBe(
      'https://localhost:8443/api/integrations/google/callback',
    );
  });
});

describe('beginning an authorisation', () => {
  it('seals the client secret and never puts it in the URL', () => {
    const service = makeService(googleFetch().impl);
    const { url } = service.begin(BEGIN);

    expect(url).not.toContain('secret-xyz');
    expect(vault.get(GOOGLE_VAULT_SCOPE, CLIENT_SECRET_KEY)).toBe('secret-xyz');
  });

  it('asks Google for exactly the chosen grants', () => {
    const service = makeService(googleFetch().impl);
    const scope = new URL(service.begin(BEGIN).url).searchParams.get('scope')!.split(' ');

    expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scope).not.toContain('https://www.googleapis.com/auth/gmail.send');
  });

  it('mints an unguessable, unique state per attempt', () => {
    const service = makeService(googleFetch().impl);
    const first = service.begin(BEGIN).state;
    const second = service.begin(BEGIN).state;

    expect(first).not.toBe(second);
    // The state is the only thing authenticating the callback, because the
    // session cookie is SameSite=Strict and will not survive Google's
    // redirect. 32 random bytes, base64url — never a counter or an id.
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
  });

  it('refuses a connection that could do nothing', () => {
    const service = makeService(googleFetch().impl);
    expect(() => service.begin({ ...BEGIN, grants: [] })).toThrow(/at least one/i);
    expect(() => service.begin({ ...BEGIN, clientId: '  ' })).toThrow(/client ID/i);
    expect(() => service.begin({ ...BEGIN, clientSecret: '' })).toThrow(/client secret/i);
  });
});

describe('completing an authorisation', () => {
  it('exchanges the code and seals the refresh token', async () => {
    const { impl, calls } = googleFetch();
    const service = makeService(impl);
    const { state, redirectUri } = service.begin(BEGIN);

    const status = await service.complete({ state, code: 'auth-code' });

    // Byte-identical to what the authorisation request carried.
    expect(calls[0]!.get('redirect_uri')).toBe(redirectUri);
    expect(vault.get(GOOGLE_VAULT_SCOPE, REFRESH_TOKEN_KEY)).toBe('rt-secret-1');
    expect(status.connected).toBe(true);
    expect(status.accountEmail).toBe('ops@example.com');
    expect(status.connectedBy).toBe('user_1');
  });

  it('records what Google granted, not what was asked', async () => {
    // A consent screen lets the user untick things. Recording the request
    // would make the interface claim a power the agent does not have, which
    // surfaces later as an opaque 403 in the middle of a run.
    const { impl } = googleFetch({
      scope: 'openid email https://www.googleapis.com/auth/calendar.events',
    });
    const service = makeService(impl);
    const { state } = service.begin(BEGIN);

    const status = await service.complete({ state, code: 'auth-code' });

    expect(status.grants).toEqual(['calendar.write']);
    expect(status.grants).not.toContain('gmail.read');
  });

  it('spends a state once, so a replayed callback cannot reconnect', async () => {
    // Single use is the property. Note what this does NOT prove: with
    // synchronous SQLite and no await between the read and the delete, the
    // naive form passes this too (checked). The guard that matters is in
    // consumeFlow's comment; this test pins the behaviour a replayed
    // redirect — a bookmarked callback URL, a browser retry — would hit.
    const { impl } = googleFetch();
    const service = makeService(impl);
    const { state } = service.begin(BEGIN);

    const results = await Promise.allSettled([
      service.complete({ state, code: 'auth-code' }),
      service.complete({ state, code: 'auth-code' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('refuses a state that expired while the operator read the consent screen', async () => {
    const { impl } = googleFetch();
    const service = makeService(impl);
    const { state } = service.begin(BEGIN);

    clock += FLOW_TTL_MS + 1;

    await expect(service.complete({ state, code: 'auth-code' })).rejects.toThrow(/no longer valid/i);
  });

  it('refuses a state nobody minted', async () => {
    const { impl } = googleFetch();
    const service = makeService(impl);
    await expect(service.complete({ state: 'forged', code: 'auth-code' })).rejects.toThrow(
      /no longer valid/i,
    );
  });

  it('leaves nothing connected when Google refuses the exchange', async () => {
    const impl: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: 'redirect_uri_mismatch', error_description: 'Bad Request' }),
    });
    const service = makeService(impl);
    const { state } = service.begin(BEGIN);

    await expect(service.complete({ state, code: 'auth-code' })).rejects.toThrow(
      /redirect_uri_mismatch/,
    );
    expect(service.status().connected).toBe(false);
    expect(vault.get(GOOGLE_VAULT_SCOPE, REFRESH_TOKEN_KEY)).toBeNull();
  });
});

describe('the connection', () => {
  it('reports nothing connected on a fresh database', () => {
    const status = makeService(googleFetch().impl).status();
    expect(status).toMatchObject({ connected: false, accountEmail: null, clientId: null });
    expect(status.grants).toEqual([]);
  });

  it('never carries a secret in what it serves', async () => {
    const service = makeService(googleFetch().impl);
    const { state } = service.begin(BEGIN);
    await service.complete({ state, code: 'auth-code' });

    const serialised = JSON.stringify(service.status());
    expect(serialised).not.toContain('secret-xyz');
    expect(serialised).not.toContain('rt-secret-1');
    // The client id is not a secret — it is in every authorisation URL a
    // browser has ever seen — and the operator needs it to recognise which
    // Cloud project this is.
    expect(serialised).toContain('client-123');
  });

  it('reconnecting replaces rather than accumulates', async () => {
    const service = makeService(googleFetch({ refresh_token: 'rt-secret-2' }).impl);
    const first = service.begin(BEGIN);
    await service.complete({ state: first.state, code: 'code-1' });
    const second = service.begin({ ...BEGIN, grants: ['drive.write'] });
    await service.complete({ state: second.state, code: 'code-2' });

    expect(db.prepare('SELECT COUNT(*) AS n FROM google_connection').get()).toMatchObject({ n: 1 });
    expect(vault.get(GOOGLE_VAULT_SCOPE, REFRESH_TOKEN_KEY)).toBe('rt-secret-2');
  });

  it('hands the MCP server an environment only when it is complete', async () => {
    const service = makeService(googleFetch().impl);
    expect(service.serverEnvironment()).toBeNull();

    const { state } = service.begin(BEGIN);
    await service.complete({ state, code: 'auth-code' });

    expect(service.serverEnvironment()).toEqual({
      GOOGLE_CLIENT_ID: BEGIN.clientId,
      GOOGLE_CLIENT_SECRET: 'secret-xyz',
      GOOGLE_REFRESH_TOKEN: 'rt-secret-1',
    });
  });

  it('disconnecting erases both secrets and every flow in progress', async () => {
    const service = makeService(googleFetch().impl);
    const { state } = service.begin(BEGIN);
    await service.complete({ state, code: 'auth-code' });
    service.begin(BEGIN); // one left dangling

    expect(service.disconnect()).toBe(true);

    expect(service.status().connected).toBe(false);
    expect(vault.get(GOOGLE_VAULT_SCOPE, REFRESH_TOKEN_KEY)).toBeNull();
    expect(vault.get(GOOGLE_VAULT_SCOPE, CLIENT_SECRET_KEY)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_oauth_flows').get()).toMatchObject({ n: 0 });
    expect(service.serverEnvironment()).toBeNull();
  });

  it('sweeps stale flows rather than letting them pile up', () => {
    const service = makeService(googleFetch().impl);
    service.begin(BEGIN);
    clock += FLOW_TTL_MS + 1;
    service.begin(BEGIN);

    expect(db.prepare('SELECT COUNT(*) AS n FROM google_oauth_flows').get()).toMatchObject({ n: 1 });
  });
});
