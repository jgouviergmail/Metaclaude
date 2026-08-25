/**
 * Request guards.
 *
 * Authentication, CSRF and role checks live here so every route enforces them
 * the same way. The default posture is closed: a route without a guard reaches
 * no handler, because the guards are installed as a global `onRequest` hook and
 * only an explicit allow-list of paths is public.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User, UserRole } from '@metaclaude/shared';
import { CSRF_HEADER, SESSION_COOKIE } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { clientKey } from '../security/ratelimit.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the authentication hook for every non-public route. */
    currentUser?: User;
    authSessionId?: string;
  }
}

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/bootstrap-status',
]);

/** Methods that cannot change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

/**
 * Resolve the session cookie into `request.currentUser`.
 * Throws 401 when the route is protected and no valid session exists.
 */
export function authenticate(context: AppContext, request: FastifyRequest): void {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'Not signed in.', 'unauthenticated');

  const session = context.auth.authenticate(token);
  if (!session) throw new HttpError(401, 'Your session has expired.', 'session_expired');

  request.currentUser = session.user;
  request.authSessionId = session.sessionId;
}

/**
 * CSRF defence for state-changing requests.
 *
 * Three independent checks, because each one has a known failure mode:
 *  - `SameSite=Strict` on the cookie (browser-enforced, but bypassed by some
 *    legacy clients and irrelevant to non-browser callers).
 *  - `Origin` verification (absent on some same-origin requests, so it can only
 *    reject, never authorise).
 *  - A double-submit token in a custom header, which a cross-origin form post
 *    cannot set without a successful CORS preflight.
 */
export function verifyCsrf(context: AppContext, request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.origin;
  if (origin) {
    const allowed = context.config.allowedOrigins;
    const host = request.headers.host;

    // The scheme is part of the origin, so a deployment that terminates TLS
    // must not accept the `http://` twin of its own host. Otherwise a page an
    // active network attacker injects on plain HTTP — nothing is served there,
    // but nothing authenticates it either — passes as same-origin.
    //
    // `http://` stays acceptable only where the deployment genuinely runs
    // without TLS, which is the same condition that already relaxes the Secure
    // cookie flag: local development.
    const schemes = context.config.secureCookies ? ['https'] : ['https', 'http'];
    const sameOrigin =
      host !== undefined && schemes.some((scheme) => origin === `${scheme}://${host}`);

    if (!sameOrigin && !allowed.includes(origin)) {
      throw new HttpError(403, 'Cross-origin request rejected.', 'bad_origin');
    }
  }

  const submitted = request.headers[CSRF_HEADER] as string | undefined;
  if (!request.authSessionId || !context.auth.verifyCsrf(request.authSessionId, submitted)) {
    throw new HttpError(403, 'Missing or invalid CSRF token.', 'bad_csrf');
  }
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, owner: 2 };

/** Require at least the given role. */
export function requireRole(request: FastifyRequest, minimum: UserRole): User {
  const user = request.currentUser;
  if (!user) throw new HttpError(401, 'Not signed in.', 'unauthenticated');
  if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
    throw new HttpError(403, `This action requires the ${minimum} role.`, 'insufficient_role');
  }
  return user;
}

/** Anything that mutates the OS requires at least `operator`. */
export function requireOperator(request: FastifyRequest): User {
  return requireRole(request, 'operator');
}

export function requireOwner(request: FastifyRequest): User {
  return requireRole(request, 'owner');
}

/** Best-effort client address, honouring proxies only when configured to. */
export function requestIp(context: AppContext, request: FastifyRequest): string {
  return clientKey(
    request.ip,
    request.headers['x-forwarded-for'] as string | undefined,
    context.config.trustProxy,
  );
}

/** Consistent JSON error body. */
export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HttpError) {
    return reply
      .status(error.statusCode)
      .send({ error: error.message, code: error.code ?? 'error' });
  }

  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
    return reply.status(statusCode).send({
      error: (error as Error).message,
      code: (error as { code?: string }).code ?? 'error',
    });
  }

  return reply.status(500).send({ error: 'Internal server error.', code: 'internal' });
}
