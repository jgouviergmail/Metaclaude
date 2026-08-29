/**
 * Request guards.
 *
 * Authentication, CSRF and role checks live here so every route enforces them
 * the same way. The default posture is closed: a route without a guard reaches
 * no handler, because the guards are installed as a global `onRequest` hook and
 * only an explicit allow-list of paths is public.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type {
  ApiTokenRecord,
  PermissionMode,
  User,
  UserRole,
  Workspace,
} from '@metaclaude/shared';
import { CSRF_HEADER, SESSION_COOKIE, reviewToolNames } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { reviewAdditionalDirectories } from '../security/directories.js';
import { clientKey } from '../security/ratelimit.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the authentication hook for every non-public route. */
    currentUser?: User;
    authSessionId?: string;
    /**
     * Populated instead of `currentUser` on a bearer route.
     *
     * Deliberately a *different* field. A token is not a user, and the role
     * helpers must not accidentally accept one: `requireOperator` reads
     * `currentUser`, finds nothing, and answers 401 — which is the right
     * answer for a token that wandered onto a human's route.
     */
    apiToken?: ApiTokenRecord;
  }
}

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/bootstrap-status',
  // The passkey sign-in ceremony: by definition it happens before a session
  // exists. Both are rate-limited with the same bucket as password login.
  '/api/auth/passkey/begin',
  '/api/auth/passkey/finish',
  // Google's redirect back from its consent screen. A cross-site top-level
  // navigation carries no `SameSite=Strict` cookie, so this route cannot be
  // authenticated the usual way; the `state` in its query is the credential
  // instead — 256 random bits, minted for one owner, single use, ten minutes.
  // See routes/integrations.ts.
  '/api/integrations/google/callback',
  // An MCP server's authorization server, redirecting back for the same
  // reason and with the same credential. The route above had this comment and
  // it still did not stop the second one from shipping guarded: the handler
  // said "deliberately outside the authenticated surface" while the path was
  // never added here, so the guard answered "Not signed in." before it ran.
  // `guards.test.ts` now asserts the pair rather than trusting a comment.
  '/api/mcp/oauth/callback',
]);

/**
 * Routes authenticated by a machine token instead of a session cookie.
 *
 * Deliberately its own set rather than an entry in `PUBLIC_PATHS`: public
 * means *unauthenticated*, and a gateway that executes tools is the last place
 * that should be. A path listed here is still closed — it simply presents a
 * different credential.
 *
 * The cookie is not merely unnecessary on these routes, it is refused: see
 * `authenticateBearer`.
 */
const BEARER_PATHS = new Set(['/api/gateway/mcp']);

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

export function isBearerPath(path: string): boolean {
  return BEARER_PATHS.has(path);
}

/**
 * Authenticate a machine token, and refuse everything a browser would send.
 *
 * Three refusals, each closing a hole that would otherwise be invisible:
 *
 *  - **No `Authorization` header, no access.** A session cookie is ignored
 *    here even when it is valid and even when it belongs to the owner. This is
 *    the confused-deputy defence: these routes carry no CSRF token, so a route
 *    that honoured ambient cookie authority would let any page on the internet
 *    POST a tool call into a signed-in operator's session.
 *
 *  - **No `Origin`.** A real MCP client is a server or a CLI and sends none.
 *    Its presence means a browser is calling, which is either an attack or a
 *    mistake — and refusing it also closes DNS rebinding, which the MCP
 *    specification calls out for HTTP servers specifically.
 *
 *  - **One 401 for every failure.** Malformed, unknown, revoked and expired
 *    are indistinguishable from outside; telling them apart is how a caller
 *    learns which ids exist.
 */
export function authenticateBearer(context: AppContext, request: FastifyRequest): void {
  if (request.headers.origin !== undefined) {
    throw new HttpError(403, 'Cross-origin request rejected.', 'bad_origin');
  }

  const header = request.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  if (!presented) {
    throw new HttpError(401, 'A bearer token is required.', 'unauthenticated');
  }

  const token = context.apiTokens.verify(presented);
  if (!token) throw new HttpError(401, 'That token is not valid.', 'unauthenticated');

  request.apiToken = token;
}

/** The token behind a gateway request, or a 401 if the guard did not run. */
export function requireApiToken(request: FastifyRequest): ApiTokenRecord {
  const token = request.apiToken;
  if (!token) throw new HttpError(401, 'A bearer token is required.', 'unauthenticated');
  return token;
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

/**
 * Load a workspace, or fail with 404.
 *
 * Here rather than in each registrar because two of them defined it byte for
 * byte — the same four lines, sixteen call sites in one file and six in the
 * other. Both were correct, which is the point: two correct copies is a
 * standing invitation for a third that is not.
 */
export function mustGetWorkspace(context: AppContext, id: string): Workspace {
  const workspace = context.workspaceRepo.get(id);
  if (!workspace) throw new HttpError(404, 'Workspace not found.');
  return workspace;
}

/**
 * Refuse `bypassPermissions` unless the deployment enabled it.
 *
 * A deployment-level decision, not a per-workspace one: with it, every write,
 * delete, shell command and network call runs unprompted. The check existed
 * verbatim in five places and was missing from the two that create a workspace
 * or a session — so a workspace could be born with
 * `defaultPermissionMode: 'bypassPermissions'` on a deployment that forbids it.
 *
 * The runtime is fail-safe either way: `AgentSupervisor.buildOptions` resolves
 * the mode again and downgrades. But the settings screen would have shown a
 * safety claim the deployment does not honour, and a stored mode that only one
 * backstop refuses is a mode one refactor away from being real.
 *
 * Centralised here rather than repeated, because five copies of a rule is five
 * chances for the sixth caller to forget it — which is exactly what happened.
 */
export function assertPermissionModeAllowed(
  context: AppContext,
  mode: PermissionMode | undefined,
): void {
  if (mode === 'bypassPermissions' && !context.config.allowBypassPermissions) {
    throw new HttpError(
      403,
      'Bypass mode is disabled on this deployment. Set METACLAUDE_ALLOW_BYPASS_PERMISSIONS to enable it.',
    );
  }
}

/** The two settings fields that say what a workspace's runs may reach. */
type ToolSettings = { allowedTools?: string[]; disallowedTools?: string[] };

/**
 * Vet and normalise a workspace's tool lists, or fail with 400.
 *
 * Rejecting here rather than dropping at run time is the same choice
 * `additionalDirectories` makes: the operator learns the setting did not take,
 * instead of reading a saved screen whose value never reaches a run.
 *
 * The contradiction is refused rather than resolved. `AgentSupervisor` already
 * settles it safely — forbidding wins — but a form that accepts a tool on both
 * lists and then honours one of them is a form that lies about what it stored.
 *
 * `stored` is what the workspace already carries, and leaving it out was a
 * hole in the first version of this function: a PATCH naming one list is
 * merged with the other, so comparing within the request alone accepted
 * exactly the contradiction the check exists to refuse. The dialog always
 * sends both lists, which is why nothing caught it — the gap is only
 * reachable through the API, and that is reason to close it rather than not.
 *
 * Returns the normalised lists to store: trimmed and de-duplicated, so the
 * value read back is the value that will be matched against a tool call.
 */
export function reviewToolSettings(
  settings: ToolSettings | undefined,
  stored: ToolSettings = {},
): ToolSettings {
  if (!settings) return {};
  const patch: ToolSettings = {};

  for (const field of ['allowedTools', 'disallowedTools'] as const) {
    const names = settings[field];
    if (!names) continue;
    const review = reviewToolNames(names);
    const first = review.rejected[0];
    if (first) throw new HttpError(400, `"${first.name}" ${first.reason}.`);
    patch[field] = review.allowed;
  }

  // The merged state, exactly as the repository will store it.
  const allowed = patch.allowedTools ?? stored.allowedTools ?? [];
  const forbidden = new Set(patch.disallowedTools ?? stored.disallowedTools ?? []);
  const both = allowed.find((name) => forbidden.has(name));
  if (both) {
    throw new HttpError(400, `"${both}" cannot be both pre-approved and forbidden.`);
  }

  return patch;
}

/**
 * Refuse an additional directory the server would not grant, or fail with 400.
 *
 * Ran on update and not on creation, so a workspace could be born naming a
 * directory every run then dropped in silence — the operator was shown a saved
 * setting that did nothing. Centralised here for the reason the mode check
 * above was: a rule written at one of two call sites is a rule missing from
 * the other.
 */
export function assertAdditionalDirectoriesAllowed(
  context: AppContext,
  directories: string[] | undefined,
): void {
  if (!directories || directories.length === 0) return;
  const review = reviewAdditionalDirectories(directories, {
    workspacesDir: context.config.workspacesDir,
    dataDir: context.config.dataDir,
  });
  const first = review.rejected[0];
  if (first) throw new HttpError(400, `"${first.path}" ${first.reason}.`);
}

/** Consistent JSON error body. */
export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HttpError) {
    return reply
      .status(error.statusCode)
      .send({ error: error.message, code: error.code ?? 'error' });
  }

  // A schema violation is the client's fault, and Zod's own error carries no
  // statusCode — so without this it fell through to the 500 below and told the
  // operator "internal server error" for their own malformed request, sending
  // them to the server logs to look for a bug that is not there. Only the first
  // issue is returned: the rest are usually the same mistake seen from
  // different angles, and the field path is what they need.
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.join('.');
    return reply.status(400).send({
      error: issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'Invalid request.',
      code: 'invalid_request',
    });
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
