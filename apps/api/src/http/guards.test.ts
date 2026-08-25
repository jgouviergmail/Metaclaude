/**
 * Request guards.
 *
 * These decide whether a request is allowed to change anything, so the tests
 * are written as attempts to get through rather than as demonstrations that the
 * happy path works.
 */

import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@metaclaude/shared';
import { SESSION_COOKIE } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import {
  authenticate,
  HttpError,
  isPublicPath,
  requestIp,
  requireOperator,
  requireOwner,
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
  updatedAt: 1,
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
  });

  it('is a closed set — anything else is guarded', () => {
    for (const path of [
      '/api/workspaces',
      '/api/auth/me',
      '/api/audit',
      '/api/health/',
      '/api/HEALTH',
      '/api/auth/login/../workspaces',
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
