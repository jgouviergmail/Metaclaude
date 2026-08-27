/**
 * Authentication routes.
 *
 * Login is rate-limited twice over: per client address (a token bucket, to blunt
 * distributed guessing) and per account (exponential lockout, persisted, to stop
 * targeted guessing). Every attempt lands in the audit log.
 */

import type { App } from '../http/types.js';
import {
  CSRF_COOKIE,
  LoginRequest,
  PasskeyLoginFinishRequest,
  PasskeyRegisterBeginRequest,
  PasskeyRegisterFinishRequest,
  PasskeyRemoveRequest,
  SESSION_COOKIE,
} from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOwner } from '../http/guards.js';
import { WeakPasswordError } from '../security/auth.js';
import { PasskeyError } from '../security/webauthn.js';
import { TokenBucket } from '../security/ratelimit.js';

/** 10 attempts, refilling at one per 6 seconds. */
const loginBucket = new TokenBucket(10, 1 / 6);

export function registerAuthRoutes(app: App, context: AppContext): void {
  const sessionCookieOptions = {
    httpOnly: true,
    secure: context.config.secureCookies,
    sameSite: 'strict' as const,
    path: '/',
    // Matches the session's idle timeout so the browser and the server agree.
    maxAge: 14 * 24 * 60 * 60,
  };

  // The CSRF cookie must be readable by the client so it can echo the value in
  // a header; it is worthless without the httpOnly session cookie beside it.
  const csrfCookieOptions = { ...sessionCookieOptions, httpOnly: false };

  /* ------------------------------------------------------------------ */

  app.get('/api/auth/bootstrap-status', async (_request, reply) => {
    // Lets the login screen show "create the first account" without exposing
    // whether any *particular* username exists. `passkeysEnrolled` is the same
    // class of disclosure — "this deployment has at least one passkey" — and
    // buys the login screen the right to offer the button only when pressing
    // it could work.
    return reply.send({
      needsBootstrap: context.auth.countUsers() === 0,
      passkeysEnrolled: context.webauthn.anyEnrolled(),
    });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const ip = requestIp(context, request);

    if (!loginBucket.take(ip)) {
      const retryAfter = loginBucket.retryAfter(ip);
      context.audit.record({
        actor: 'anonymous',
        action: 'auth.login.rate_limited',
        ipAddress: ip,
        outcome: 'failure',
      });
      return reply.status(429).header('retry-after', String(retryAfter)).send({
        error: 'Too many sign-in attempts. Try again shortly.',
        code: 'rate_limited',
      });
    }

    const parsed = LoginRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request.', code: 'bad_request' });
    }

    const outcome = await context.auth.login({
      username: parsed.data.username,
      password: parsed.data.password,
      ...(parsed.data.totp ? { totp: parsed.data.totp } : {}),
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: ip,
    });

    switch (outcome.status) {
      case 'ok': {
        // A successful login resets the address budget so a shared NAT does not
        // punish a legitimate user.
        loginBucket.reset(ip);
        context.audit.record({
          actor: outcome.user.username,
          action: 'auth.login',
          ipAddress: ip,
          outcome: 'success',
        });
        return reply
          .setCookie(SESSION_COOKIE, outcome.token, sessionCookieOptions)
          .setCookie(CSRF_COOKIE, outcome.csrfToken, csrfCookieOptions)
          .send({ status: 'ok', user: outcome.user, csrfToken: outcome.csrfToken });
      }

      case 'totp_required':
        return reply.send({ status: 'totp_required' });

      case 'locked':
        context.audit.record({
          actor: parsed.data.username,
          action: 'auth.login.locked',
          ipAddress: ip,
          outcome: 'failure',
        });
        return reply
          .status(429)
          .header('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)))
          .send({
            error: 'Too many failed attempts. This account is temporarily locked.',
            code: 'locked',
          });

      default:
        context.audit.record({
          actor: parsed.data.username,
          action: 'auth.login.failed',
          ipAddress: ip,
          outcome: 'failure',
        });
        // Deliberately identical for a wrong password and an unknown account.
        return reply.status(401).send({ error: 'Incorrect username or password.', code: 'invalid' });
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.authSessionId) {
      context.auth.revokeSession(request.authSessionId);
      context.audit.record({
        actor: request.currentUser?.username ?? 'unknown',
        action: 'auth.logout',
        ipAddress: requestIp(context, request),
      });
    }
    return reply
      .clearCookie(SESSION_COOKIE, { path: '/' })
      .clearCookie(CSRF_COOKIE, { path: '/' })
      .send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.currentUser || !request.authSessionId) {
      throw new HttpError(401, 'Not signed in.');
    }

    // Re-issue the CSRF token whenever the client no longer has its copy, so a
    // valid session never gets stuck unable to perform writes.
    const held = request.cookies[CSRF_COOKIE];
    const csrfToken = held ?? context.auth.rotateCsrf(request.authSessionId);
    if (!held && csrfToken) reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions);

    return reply.send({
      user: request.currentUser,
      csrfToken,
      recoveryCodesRemaining: context.auth.remainingRecoveryCodes(request.currentUser.id),
    });
  });

  app.get('/api/auth/sessions', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    return reply.send({
      sessions: context.auth.listSessions(user.id, request.authSessionId as string),
    });
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const sessions = context.auth.listSessions(user.id, request.authSessionId as string);
    // Only the owner of a session may revoke it.
    if (!sessions.some((s) => s.id === request.params.id)) {
      throw new HttpError(404, 'Session not found.');
    }
    context.auth.revokeSession(request.params.id);
    context.audit.record({
      actor: user.username,
      action: 'auth.session.revoke',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/sessions/revoke-others', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const count = context.auth.revokeAllSessions(user.id, request.authSessionId);
    context.audit.record({
      actor: user.username,
      action: 'auth.session.revoke_all',
      ipAddress: requestIp(context, request),
      detail: `${count} revoked`,
    });
    return reply.send({ revoked: count });
  });

  /* -------------------------- Password ------------------------------- */

  const ChangePassword = z.object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
  });

  app.post('/api/auth/password', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = ChangePassword.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request.');

    try {
      const ok = await context.auth.changePassword(
        user.id,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      if (!ok) {
        context.audit.record({
          actor: user.username,
          action: 'auth.password.change',
          outcome: 'failure',
          ipAddress: requestIp(context, request),
        });
        throw new HttpError(403, 'The current password is incorrect.');
      }
    } catch (error) {
      if (error instanceof WeakPasswordError) throw new HttpError(400, error.message);
      throw error;
    }

    context.audit.record({
      actor: user.username,
      action: 'auth.password.change',
      ipAddress: requestIp(context, request),
    });
    // Every session was revoked, including this one; the client must sign in again.
    return reply
      .clearCookie(SESSION_COOKIE, { path: '/' })
      .clearCookie(CSRF_COOKIE, { path: '/' })
      .send({ ok: true, reauthenticate: true });
  });

  /* ---------------------------- TOTP --------------------------------- */

  /**
   * Start enrolling a TOTP device.
   *
   * Password-gated and audited, like disabling: re-enrolling replaces the
   * second factor, so it is the same authority as removing it.
   */
  app.post('/api/auth/totp/begin', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Your password is required.');

    const enrolment = await context.auth.beginTotpEnrolment(user.id, parsed.data.password);
    if (!enrolment) {
      context.audit.record({
        actor: user.username,
        action: 'auth.totp.begin',
        outcome: 'failure',
        ipAddress: requestIp(context, request),
      });
      throw new HttpError(403, 'That password is incorrect.');
    }

    context.audit.record({
      actor: user.username,
      action: 'auth.totp.begin',
      ipAddress: requestIp(context, request),
    });
    return reply.send(enrolment);
  });

  /** Abandon an enrolment that was started but never confirmed. */
  app.post('/api/auth/totp/cancel', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    context.auth.cancelTotpEnrolment(user.id);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/totp/confirm', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Enter the six-digit code from your app.');

    const result = context.auth.confirmTotpEnrolment(user.id, parsed.data.code);
    if (!result) {
      throw new HttpError(400, 'That code is not valid. Check your device clock and try again.');
    }

    context.audit.record({
      actor: user.username,
      action: 'auth.totp.enable',
      ipAddress: requestIp(context, request),
    });
    return reply.send(result);
  });

  app.post('/api/auth/totp/disable', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Your password is required.');

    const ok = await context.auth.disableTotp(user.id, parsed.data.password);
    if (!ok) throw new HttpError(403, 'That password is incorrect.');

    context.audit.record({
      actor: user.username,
      action: 'auth.totp.disable',
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /* --------------------------- Passkeys ------------------------------ */

  /** PasskeyError carries its own status; anything else is not ours to mask. */
  const passkeyErrors = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PasskeyError) throw new HttpError(error.statusCode, error.message);
      throw error;
    }
  };

  /** Sign-in ceremony — public by necessity, throttled like password login. */
  app.post('/api/auth/passkey/begin', async (request, reply) => {
    const ip = requestIp(context, request);
    if (!loginBucket.take(ip)) {
      return reply
        .status(429)
        .header('retry-after', String(loginBucket.retryAfter(ip)))
        .send({ error: 'Too many sign-in attempts. Try again shortly.', code: 'rate_limited' });
    }
    const begun = await passkeyErrors(() =>
      context.webauthn.beginLogin(request.headers.origin),
    );
    return reply.send(begun);
  });

  app.post('/api/auth/passkey/finish', async (request, reply) => {
    const ip = requestIp(context, request);
    if (!loginBucket.take(ip)) {
      return reply
        .status(429)
        .header('retry-after', String(loginBucket.retryAfter(ip)))
        .send({ error: 'Too many sign-in attempts. Try again shortly.', code: 'rate_limited' });
    }
    const parsed = PasskeyLoginFinishRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request.', code: 'bad_request' });
    }

    const outcome = await context.webauthn.finishLogin(
      request.headers.origin,
      parsed.data.ceremonyId,
      parsed.data.response,
      request.headers['user-agent'] ?? null,
      ip,
    );

    if (outcome.status !== 'ok') {
      context.audit.record({
        actor: 'anonymous',
        action: 'auth.login.passkey',
        ipAddress: ip,
        outcome: 'failure',
      });
      return reply.status(401).send({ error: 'That passkey did not sign in.', code: 'invalid' });
    }

    loginBucket.reset(ip);
    context.audit.record({
      actor: outcome.user.username,
      action: 'auth.login.passkey',
      ipAddress: ip,
      outcome: 'success',
    });
    return reply
      .setCookie(SESSION_COOKIE, outcome.token, sessionCookieOptions)
      .setCookie(CSRF_COOKIE, outcome.csrfToken, csrfCookieOptions)
      .send({ status: 'ok', user: outcome.user, csrfToken: outcome.csrfToken });
  });

  /* Management — behind the session like every other credential change. */

  app.get('/api/auth/passkeys', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    return reply.send({ passkeys: context.webauthn.list(user.id) });
  });

  app.post('/api/auth/passkeys/begin', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = PasskeyRegisterBeginRequest.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Your password is required.');

    let options;
    try {
      options = await context.webauthn.beginRegistration(
        user,
        request.headers.origin,
        parsed.data.password,
      );
    } catch (error) {
      // A failed password re-proof is audited exactly as TOTP's is: both are
      // someone with a session cookie trying to change how sign-in works.
      if (error instanceof PasskeyError && error.statusCode === 403) {
        context.audit.record({
          actor: user.username,
          action: 'auth.passkey.begin',
          outcome: 'failure',
          ipAddress: requestIp(context, request),
        });
      }
      if (error instanceof PasskeyError) throw new HttpError(error.statusCode, error.message);
      throw error;
    }
    context.audit.record({
      actor: user.username,
      action: 'auth.passkey.begin',
      ipAddress: requestIp(context, request),
    });
    return reply.send({ options });
  });

  app.post('/api/auth/passkeys/finish', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = PasskeyRegisterFinishRequest.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request.');

    const record = await passkeyErrors(() =>
      context.webauthn.finishRegistration(
        user,
        request.headers.origin,
        parsed.data.label,
        parsed.data.response,
      ),
    );
    context.audit.record({
      actor: user.username,
      action: 'auth.passkey.enrol',
      target: record.label,
      ipAddress: requestIp(context, request),
    });
    return reply.status(201).send({ passkey: record });
  });

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', async (request, reply) => {
    const user = request.currentUser as NonNullable<typeof request.currentUser>;
    const parsed = PasskeyRemoveRequest.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Your password is required.');

    const removed = await context.webauthn.remove(user.id, request.params.id, parsed.data.password);
    if (!removed) {
      context.audit.record({
        actor: user.username,
        action: 'auth.passkey.remove',
        outcome: 'failure',
        ipAddress: requestIp(context, request),
      });
      throw new HttpError(403, 'That password is incorrect, or the passkey does not exist.');
    }
    context.audit.record({
      actor: user.username,
      action: 'auth.passkey.remove',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /* ---------------------------- Users -------------------------------- */

  app.get('/api/users', async (request, reply) => {
    requireOwner(request);
    return reply.send({ users: context.auth.listUsers() });
  });

  const CreateUser = z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(12).max(1024),
    displayName: z.string().max(120).optional(),
    role: z.enum(['owner', 'operator', 'viewer']),
  });

  app.post('/api/users', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = CreateUser.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    try {
      const user = await context.auth.createUser(parsed.data);
      context.audit.record({
        actor: actor.username,
        action: 'user.create',
        target: user.username,
        ipAddress: requestIp(context, request),
      });
      return reply.status(201).send({ user });
    } catch (error) {
      if (error instanceof WeakPasswordError) throw new HttpError(400, error.message);
      if (String(error).includes('UNIQUE')) throw new HttpError(409, 'That username is taken.');
      throw error;
    }
  });
}
