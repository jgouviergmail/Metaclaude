/**
 * Request guards.
 *
 * These decide whether a request is allowed to change anything, so the tests
 * are written as attempts to get through rather than as demonstrations that the
 * happy path works.
 */

import type { FastifyRequest } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { User } from '@metaclaude/shared';
import { SESSION_COOKIE } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import {
  authenticate,
  authenticateBearer,
  HttpError,
  isBearerPath,
  isPublicPath,
  requestIp,
  requireOperator,
  requireOwner,
  sendError,
  requireRole,
  verifyCsrf,
} from './guards.js';

const OWNER: User = {
  id: 'usr_1',
  username: 'jules',
  displayName: 'Jules',
  role: 'owner',
  totpEnabled: false,
  createdAt: 1,
  lastLoginAt: null,
};

/**
 * The smallest context the guards actually read. Cast rather than built,
 * because constructing a real AppContext would drag in a database and the
 * Claude CLI for a function that touches four fields.
 */
function context(options: {
  secureCookies?: boolean;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  csrfOk?: boolean;
  session?: { user: User; sessionId: string } | null;
}): AppContext {
  return {
    config: {
      secureCookies: options.secureCookies ?? true,
      allowedOrigins: options.allowedOrigins ?? [],
      trustProxy: options.trustProxy ?? false,
    },
    auth: {
      authenticate: vi.fn(() => options.session ?? null),
      verifyCsrf: vi.fn(() => options.csrfOk ?? true),
    },
  } as unknown as AppContext;
}

function request(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

/** Assert `fn` throws an HttpError with this status, and return it. */
function expectHttpError(fn: () => unknown, status: number, code?: string): HttpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.statusCode).toBe(status);
    if (code !== undefined) expect(httpError.code).toBe(code);
    return httpError;
  }
  return expect.unreachable('expected an HttpError') as never;
}

/* -------------------------------------------------------------------------- */

describe('isPublicPath', () => {
  it('lists only what genuinely cannot require a session', () => {
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/bootstrap-status')).toBe(true);
    // The passkey sign-in ceremony happens before a session can exist.
    expect(isPublicPath('/api/auth/passkey/begin')).toBe(true);
    expect(isPublicPath('/api/auth/passkey/finish')).toBe(true);
  });

  /**
   * Every OAuth callback, found in the routes rather than listed here.
   *
   * A redirect back from a third party's consent screen is a cross-site
   * top-level navigation, so it carries no `SameSite=Strict` cookie and cannot
   * be authenticated the usual way — its `state` is the credential instead.
   * That reasoning was written out on the Google callback, and it still did not
   * stop the MCP one from shipping guarded: the handler's comment said
   * "deliberately outside the authenticated surface" while the path was never
   * added to the set, so the guard answered "Not signed in." before the handler
   * ran, and the flow died on the last step.
   *
   * Naming the two paths here would have the same weakness as the comment did.
   * This reads the routes instead, so a third callback is covered the day it is
   * written.
   */
  it('covers every OAuth callback the routes actually register', () => {
    const dir = new URL('../routes/', import.meta.url);
    const found: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const source = readFileSync(new URL(file, dir), 'utf8');
      // Both spellings the two routes happen to use: `/…/oauth/callback` and
      // `/…/google/callback`. Matching on the trailing `/callback` under
      // `/api/` is the property that matters — a route named for the provider
      // rather than for the protocol is the same kind of route.
      for (const match of source.matchAll(/'(\/api\/[a-z0-9/_-]*\/callback)'/g)) {
        found.push(match[1]!);
      }
    }

    // The test is worthless if it finds nothing: it would pass on a repository
    // with no callbacks at all, and that is exactly the day it stops guarding.
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const path of found) {
      expect(isPublicPath(path), `${path} must be reachable without a session`).toBe(true);
    }
  });

  it('is a closed set — anything else is guarded', () => {
    for (const path of [
      '/api/workspaces',
      '/api/auth/me',
      '/api/audit',
      '/api/health/',
      '/api/HEALTH',
      '/api/auth/login/../workspaces',
      // Managing passkeys is a credential change; only the *ceremony* is open.
      '/api/auth/passkeys',
      '/api/auth/passkeys/begin',
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});

describe('authenticate', () => {
  it('rejects a request with no session cookie', () => {
    expectHttpError(() => authenticate(context({}), request()), 401, 'unauthenticated');
  });

  it('rejects a cookie the auth service does not recognise', () => {
    const ctx = context({ session: null });
    expectHttpError(
      () => authenticate(ctx, request({ cookies: { [SESSION_COOKIE]: 'stale' } })),
      401,
      'session_expired',
    );
  });

  it('populates the request when the session is valid', () => {
    const ctx = context({ session: { user: OWNER, sessionId: 'sess_1' } });
    const req = request({ cookies: { [SESSION_COOKIE]: 'good' } });

    authenticate(ctx, req);

    expect(req.currentUser).toEqual(OWNER);
    expect(req.authSessionId).toBe('sess_1');
  });
});

describe('verifyCsrf — origin', () => {
  const withOrigin = (origin: string | undefined, host = '203.0.113.10') =>
    request({
      headers: { ...(origin ? { origin } : {}), host },
      authSessionId: 'sess_1',
    } as Partial<FastifyRequest>);

  it('lets a same-origin request through at a bare IP', () => {
    // The deployment target has no domain name, so this is the ordinary case:
    // it must work with `allowedOrigins` left empty.
    expect(() => verifyCsrf(context({}), withOrigin('https://203.0.113.10'))).not.toThrow();
  });

  it('handles a non-default port and a hostname alike', () => {
    expect(() =>
      verifyCsrf(context({}), withOrigin('https://203.0.113.10:8443', '203.0.113.10:8443')),
    ).not.toThrow();
    expect(() =>
      verifyCsrf(context({}), withOrigin('https://mc.tail1234.ts.net', 'mc.tail1234.ts.net')),
    ).not.toThrow();
  });

  it('rejects the http twin of its own host when TLS is in use', () => {
    // Nothing is served on plain http — Caddy redirects — but nothing
    // authenticates it either, so a page injected there must not read as
    // same-origin just because the host matches.
    expectHttpError(
      () => verifyCsrf(context({ secureCookies: true }), withOrigin('http://203.0.113.10')),
      403,
      'bad_origin',
    );
  });

  it('still allows http where the deployment genuinely has no TLS', () => {
    // Local development, which is the same condition that relaxes the Secure
    // cookie flag.
    expect(() =>
      verifyCsrf(context({ secureCookies: false }), withOrigin('http://localhost:5173', 'localhost:5173')),
    ).not.toThrow();
  });

  it('rejects a different origin, and a lookalike that merely contains the host', () => {
    for (const origin of [
      'https://evil.example',
      'https://203.0.113.10.evil.example',
      'https://203.0.113.100',
      'https://evil.example/203.0.113.10',
      'null',
    ]) {
      expectHttpError(() => verifyCsrf(context({}), withOrigin(origin)), 403, 'bad_origin');
    }
  });

  it('honours an explicitly allowed extra origin', () => {
    const ctx = context({ allowedOrigins: ['https://studio.example'] });
    expect(() => verifyCsrf(ctx, withOrigin('https://studio.example'))).not.toThrow();
  });

  it('cannot authorise on its own when the header is absent', () => {
    // A same-origin request need not send Origin at all, so its absence can
    // only decline to reject — the token check below still has to pass.
    expect(() => verifyCsrf(context({ csrfOk: true }), withOrigin(undefined))).not.toThrow();
    expectHttpError(() => verifyCsrf(context({ csrfOk: false }), withOrigin(undefined)), 403, 'bad_csrf');
  });
});

describe('verifyCsrf — token', () => {
  it('skips every check for a method that changes nothing', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const ctx = context({ csrfOk: false });
      expect(() =>
        verifyCsrf(ctx, request({ method, headers: { origin: 'https://evil.example' } })),
      ).not.toThrow();
    }
  });

  it('rejects a state-changing request with a bad or missing token', () => {
    expectHttpError(
      () => verifyCsrf(context({ csrfOk: false }), request({ authSessionId: 'sess_1' } as Partial<FastifyRequest>)),
      403,
      'bad_csrf',
    );
  });

  it('rejects when there is no session to bind the token to', () => {
    // `authenticate` runs first, so this is belt and braces — but a token
    // unbound from a session would be a token that authorises nothing.
    expectHttpError(() => verifyCsrf(context({ csrfOk: true }), request()), 403, 'bad_csrf');
  });
});

describe('roles', () => {
  const as = (role: User['role']) =>
    request({ currentUser: { ...OWNER, role } } as Partial<FastifyRequest>);

  it('ranks viewer below operator below owner', () => {
    expect(() => requireRole(as('viewer'), 'viewer')).not.toThrow();
    expectHttpError(() => requireRole(as('viewer'), 'operator'), 403, 'insufficient_role');
    expectHttpError(() => requireRole(as('viewer'), 'owner'), 403, 'insufficient_role');

    expect(() => requireRole(as('operator'), 'operator')).not.toThrow();
    expectHttpError(() => requireRole(as('operator'), 'owner'), 403, 'insufficient_role');

    expect(() => requireRole(as('owner'), 'owner')).not.toThrow();
  });

  it('refuses an unauthenticated request rather than reading a missing role', () => {
    expectHttpError(() => requireOperator(request()), 401, 'unauthenticated');
    expectHttpError(() => requireOwner(request()), 401, 'unauthenticated');
  });

  it('returns the user so a caller can attribute the action', () => {
    expect(requireOwner(as('owner')).username).toBe('jules');
  });
});

describe('requestIp', () => {
  const from = (ip: string, forwarded?: string) =>
    request({ ip, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} } as Partial<FastifyRequest>);

  it('ignores x-forwarded-for when no proxy is trusted', () => {
    expect(requestIp(context({ trustProxy: false }), from('10.0.0.1', '1.2.3.4'))).toBe('10.0.0.1');
  });

  it('takes the entry the trusted proxy appended, not the one the client sent', () => {
    // The header grows left to right and each proxy appends, so the leftmost
    // entry is attacker-controlled: keying the rate limiter on it would hand
    // out a fresh bucket per request.
    expect(requestIp(context({ trustProxy: true }), from('10.0.0.1', '1.2.3.4, 5.6.7.8'))).toBe('5.6.7.8');
  });
});

describe('sendError', () => {
  /** A minimal reply that records what it was told to send. */
  const reply = () => {
    const captured = { status: 200, body: undefined as unknown };
    const self = {
      status(code: number) {
        captured.status = code;
        return self;
      },
      send(body: unknown) {
        captured.body = body;
        return self;
      },
      captured,
    };
    return self;
  };

  it('answers a schema violation with 400 and the reason', () => {
    // Zod throws rather than returning, and a ZodError carries no statusCode —
    // so it used to land in the 500 branch. The operator was told "internal
    // server error" for their own malformed request, which sends them looking
    // at the server logs for a bug that is not there.
    const target = reply();
    try {
      z.object({ dryRun: z.boolean() }).parse({ dryRun: 'yes' });
    } catch (error) {
      sendError(target as never, error);
    }

    expect(target.captured.status).toBe(400);
    expect((target.captured.body as { code: string }).code).toBe('invalid_request');
    expect((target.captured.body as { error: string }).error).toBeTruthy();
  });

  it('still hides an unexpected failure behind a 500', () => {
    // The other half of the same rule: a real bug must not leak its message,
    // its stack, or a path from inside the server to the client.
    const target = reply();
    sendError(target as never, new Error('ENOENT /var/lib/metaclaude/master.key'));

    expect(target.captured.status).toBe(500);
    expect((target.captured.body as { error: string }).error).toBe('Internal server error.');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The gateway's credential.
 *
 * This is the newest way into the application and the only one that executes
 * tools for a caller nobody is watching, so the tests are written as attempts
 * to get in with the wrong thing — including with the *right* thing presented
 * the wrong way, which is where the interesting failures live.
 */
describe('authenticateBearer', () => {
  const TOKEN = {
    id: 'tok_1',
    name: 'n8n',
    scopes: ['run'],
    workspaceIds: ['ws_1'],
    ceiling: 'dontAsk',
    createdBy: 'jules',
    createdAt: 1,
    expiresAt: 2,
    lastUsedAt: null,
    revokedAt: null,
    hint: 'mck_tok_01',
  } as const;

  const withTokens = (verify: (presented: string) => unknown): AppContext =>
    ({ apiTokens: { verify: vi.fn(verify) } }) as unknown as AppContext;

  it('accepts a valid token and hangs it on the request, not on currentUser', () => {
    const req = request({ headers: { authorization: 'Bearer mck_tok_1_secret' } });

    authenticateBearer(withTokens(() => TOKEN), req);

    expect(req.apiToken?.id).toBe('tok_1');
    // A token is not a user. `requireOperator` reads `currentUser`, so leaving
    // it unset is what keeps a token off every human route in the application.
    expect(req.currentUser).toBeUndefined();
    expectHttpError(() => requireOperator(req), 401);
  });

  it('refuses a request with no Authorization header', () => {
    expectHttpError(
      () => authenticateBearer(withTokens(() => TOKEN), request()),
      401,
      'unauthenticated',
    );
  });

  /**
   * The confused-deputy case, and the reason this guard exists at all.
   *
   * A bearer route carries no CSRF token. If it also honoured the session
   * cookie, any page on the internet could POST a tool call and it would run
   * with a signed-in operator's authority — a cross-site request that needs no
   * token to forge, because the browser attaches the credential itself.
   */
  it('ignores a session cookie entirely, however valid it is', () => {
    const context = withTokens(() => TOKEN);
    const req = request({ cookies: { [SESSION_COOKIE]: 'a-perfectly-good-session' } });

    expectHttpError(() => authenticateBearer(context, req), 401);
    expect(req.currentUser).toBeUndefined();
  });

  /**
   * A real MCP client is a server or a CLI and sends no Origin. Its presence
   * means a browser is calling — which also closes DNS rebinding, the attack
   * the MCP specification singles out for HTTP servers.
   */
  it('refuses anything that arrives with an Origin, valid token or not', () => {
    expectHttpError(
      () =>
        authenticateBearer(
          withTokens(() => TOKEN),
          request({
            headers: { authorization: 'Bearer mck_tok_1_secret', origin: 'https://example.test' },
          }),
        ),
      403,
      'bad_origin',
    );
  });

  it('refuses a token the service rejects, without saying why', () => {
    const error = expectHttpError(
      () =>
        authenticateBearer(
          withTokens(() => null),
          request({ headers: { authorization: 'Bearer mck_tok_1_wrong' } }),
        ),
      401,
    );
    // Revoked, expired, unknown and malformed are one answer from outside.
    expect(error.message).not.toMatch(/revoked|expired|unknown|malformed/i);
  });

  it('refuses a header that is not a Bearer scheme', () => {
    for (const authorization of ['mck_tok_1_secret', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer  ']) {
      expectHttpError(
        () => authenticateBearer(withTokens(() => TOKEN), request({ headers: { authorization } })),
        401,
      );
    }
  });
});

describe('isBearerPath', () => {
  it('names the gateway, and the gateway is not also public', () => {
    expect(isBearerPath('/api/gateway/mcp')).toBe(true);
    // The distinction the whole design rests on: authenticated differently is
    // not the same as unauthenticated.
    expect(isPublicPath('/api/gateway/mcp')).toBe(false);
  });

  it('is a closed set', () => {
    for (const path of ['/api/workspaces', '/api/gateway', '/api/gateway/mcp/', '/api/health']) {
      expect(isBearerPath(path), path).toBe(false);
    }
  });

  /**
   * Same shape as the OAuth-callback test above, and for the same reason: a
   * route registered under `/api/gateway/` that nobody adds to the set would
   * be authenticated as a *human* route — which means every call fails with
   * "Not signed in" rather than silently opening, but the failure would be
   * blamed on the token. The inverse mistake is worse and this catches it too:
   * a gateway route left out of both sets reaches `authenticate`, and a
   * gateway route added to `PUBLIC_PATHS` would be open to the world.
   */
  it('covers every gateway route the routes actually register', () => {
    const dir = new URL('../routes/', import.meta.url);
    const found: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const match of source.matchAll(/'(\/api\/gateway\/[a-z0-9/_-]*)'/g)) {
        found.push(match[1]!);
      }
    }

    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const path of found) {
      expect(isBearerPath(path), `${path} must authenticate a token`).toBe(true);
      expect(isPublicPath(path), `${path} must never be public`).toBe(false);
    }
  });
});
