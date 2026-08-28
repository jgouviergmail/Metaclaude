import { describe, expect, it, vi } from 'vitest';

import { GOOGLE_GRANTS } from '@metaclaude/shared';

import {
  buildAuthUrl,
  emailFromIdToken,
  exchangeCode,
  GoogleOAuthError,
  refreshAccessToken,
  type FetchLike,
} from './oauth.js';
import { RESTRICTED_GRANTS, scopeOf, scopesFor } from './scopes.js';

/** A fetch that answers one canned JSON body and records what it was sent. */
function fakeFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: Array<{ url: string; body: URLSearchParams; headers?: Record<string, string> }> = [];
  const impl: FetchLike = async (url, options) => {
    calls.push({
      url,
      body: new URLSearchParams(options?.body ?? ''),
      headers: options?.headers,
    });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { impl, calls };
}

function idTokenFor(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature-not-checked`;
}

describe('scopes', () => {
  it('maps every grant in the shared vocabulary', () => {
    // The compiler checks the map is total; this checks the vocabulary and the
    // map cannot drift apart at run time after a cast or an enum edit.
    for (const grant of GOOGLE_GRANTS) {
      expect(scopeOf(grant), grant).toMatch(/^https:\/\/www\.googleapis\.com\/auth\//);
    }
  });

  it('asks for the narrow scope where a broad one exists', () => {
    // The two choices worth pinning: `drive.file` reaches only what this app
    // made, and `calendar.events` cannot touch calendar settings. Widening
    // either is a decision, not a typo.
    expect(scopeOf('drive.write')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(scopeOf('calendar.write')).toBe('https://www.googleapis.com/auth/calendar.events');
  });

  it('always requests identity, so a connection can say which account it bound', () => {
    const scope = scopesFor([]);
    expect(scope.split(' ')).toContain('openid');
    expect(scope.split(' ')).toContain('email');
  });

  it('builds a stable scope string whatever order the boxes were ticked in', () => {
    const a = scopesFor(['drive.read', 'gmail.read', 'calendar.write']);
    const b = scopesFor(['calendar.write', 'drive.read', 'gmail.read']);
    expect(a).toBe(b);
  });

  it('includes exactly the granted scopes and no others', () => {
    const scope = scopesFor(['gmail.read']).split(' ');
    expect(scope).toContain(scopeOf('gmail.read'));
    expect(scope).not.toContain(scopeOf('gmail.send'));
    expect(scope).not.toContain(scopeOf('drive.read'));
  });

  it('names the grants that drag a project into Google verification', () => {
    // Not decoration: on a consent screen still in "Testing" these are what
    // makes the refresh token expire after seven days, and a connection that
    // dies next Tuesday for no visible reason is the worst possible failure.
    expect(RESTRICTED_GRANTS).toContain('gmail.read');
    expect(RESTRICTED_GRANTS).toContain('drive.read');
    expect(RESTRICTED_GRANTS).not.toContain('drive.write');
  });
});

describe('the authorisation URL', () => {
  const base = {
    clientId: 'client-123.apps.googleusercontent.com',
    redirectUri: 'https://metaclaude.example/api/integrations/google/callback',
    scope: 'openid email',
    state: 'state-abc',
  };

  it('asks for offline access and forces the consent screen', () => {
    // Both or nothing: without access_type there is never a refresh token, and
    // without prompt=consent Google omits it on every re-authorisation — which
    // is exactly when an operator is reconnecting a broken connection.
    const url = new URL(buildAuthUrl(base));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('carries the client, redirect, scope and state to Google', () => {
    const url = new URL(buildAuthUrl(base));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(base.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri);
    expect(url.searchParams.get('scope')).toBe(base.scope);
    expect(url.searchParams.get('state')).toBe(base.state);
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('omits the login hint unless one was given', () => {
    expect(new URL(buildAuthUrl(base)).searchParams.has('login_hint')).toBe(false);
    const hinted = new URL(buildAuthUrl({ ...base, loginHint: 'someone@example.com' }));
    expect(hinted.searchParams.get('login_hint')).toBe('someone@example.com');
  });
});

describe('exchanging the code', () => {
  const input = {
    code: 'auth-code',
    clientId: 'client-123',
    clientSecret: 'secret-xyz',
    redirectUri: 'https://metaclaude.example/api/integrations/google/callback',
  };

  it('posts the form Google expects and reads the tokens back', async () => {
    const { impl, calls } = fakeFetch({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3599,
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      id_token: idTokenFor({ email: 'operator@example.com' }),
    });

    const tokens = await exchangeCode(impl, input);

    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]!.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.body.get('grant_type')).toBe('authorization_code');
    expect(calls[0]!.body.get('code')).toBe('auth-code');
    expect(calls[0]!.body.get('client_secret')).toBe('secret-xyz');
    // Byte-identical to the authorisation request or Google refuses: it is
    // part of what the code is signed over, not a destination.
    expect(calls[0]!.body.get('redirect_uri')).toBe(input.redirectUri);

    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.expiresInSeconds).toBe(3599);
    expect(tokens.grantedScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });

  it('refuses an exchange that came back without a refresh token', async () => {
    // Storing the access token would look like success and stop working in an
    // hour, which is the hardest kind of failure to attribute.
    const { impl } = fakeFetch({ access_token: 'at-1', expires_in: 3599 });
    await expect(exchangeCode(impl, input)).rejects.toThrow(/no refresh token/i);
  });

  it("repeats Google's own error rather than flattening it", async () => {
    // redirect_uri_mismatch and invalid_grant are different problems with
    // different fixes; "authentication failed" sends the operator nowhere.
    const { impl } = fakeFetch(
      { error: 'redirect_uri_mismatch', error_description: 'Bad Request' },
      { ok: false, status: 400 },
    );
    await expect(exchangeCode(impl, input)).rejects.toThrow(/redirect_uri_mismatch: Bad Request/);
  });

  it('reports an unreachable endpoint as an operational failure, not a bad credential', async () => {
    const impl: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com');
    };
    await expect(exchangeCode(impl, input)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('survives a non-JSON body from a proxy that intercepted the call', async () => {
    const { impl } = fakeFetch('<html>502 Bad Gateway</html>', { ok: false, status: 502 });
    await expect(exchangeCode(impl, input)).rejects.toThrow(/not JSON/);
  });
});

describe('refreshing', () => {
  it('posts the refresh grant and tolerates the absent refresh token', async () => {
    // Google does not re-issue one on a refresh, and treating that as an error
    // would break every token renewal.
    const { impl, calls } = fakeFetch({ access_token: 'at-2', expires_in: 3599 });
    const tokens = await refreshAccessToken(impl, {
      refreshToken: 'rt-1',
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });
    expect(calls[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(calls[0]!.body.get('refresh_token')).toBe('rt-1');
    expect(tokens.accessToken).toBe('at-2');
    expect(tokens.refreshToken).toBeNull();
  });

  it('surfaces a revoked grant in the words Google used', async () => {
    const { impl } = fakeFetch(
      { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      { ok: false, status: 400 },
    );
    await expect(
      refreshAccessToken(impl, { refreshToken: 'rt-1', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(/expired or revoked/i);
  });

  it('rejects a 200 that carries no access token', async () => {
    const { impl } = fakeFetch({ token_type: 'Bearer' });
    await expect(
      refreshAccessToken(impl, { refreshToken: 'rt-1', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(GoogleOAuthError);
  });
});

describe('the identity token', () => {
  it('reads the email the connection bound to', () => {
    expect(emailFromIdToken(idTokenFor({ email: 'operator@example.com' }))).toBe(
      'operator@example.com',
    );
  });

  it('returns null rather than throwing on anything malformed', () => {
    // A connection that works must never fail because the display name for it
    // could not be read.
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
    expect(emailFromIdToken('a.b')).toBeNull();
    expect(emailFromIdToken('a.!!!not-base64!!!.c')).toBeNull();
    expect(emailFromIdToken(idTokenFor({ sub: '123' }))).toBeNull();
  });
});

describe('what never leaves this module', () => {
  it('keeps the client secret out of the authorisation URL', async () => {
    // The URL is handed to a browser. The secret is not the browser's business
    // and a leak here is permanent — it lands in history and in logs.
    const url = buildAuthUrl({
      clientId: 'client-123',
      redirectUri: 'https://metaclaude.example/cb',
      scope: 'openid email',
      state: 'state-abc',
    });
    expect(url).not.toContain('secret');
    vi.resetAllMocks();
  });
});
