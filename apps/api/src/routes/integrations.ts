/**
 * Connections Metaclaude authorises for itself — Google, so far.
 *
 * The callback is the only route in this application that is public *and*
 * writes. That is not an oversight: the session cookie is `SameSite=Strict`,
 * so Google's redirect back arrives with no cookie, and the alternative —
 * loosening the cookie — would trade the app's whole CSRF posture for one
 * feature. The `state` in the query is the credential instead: 256 random
 * bits, minted for one signed-in owner, single use, ten-minute life. The
 * handler does nothing until that state resolves to a stored flow.
 *
 * It also *redirects* rather than returning JSON, success or failure. At the
 * end of a top-level navigation a JSON body is a blank page with braces on
 * it; the operator has to land back in the interface with something readable.
 */

import { z } from 'zod';

import { GoogleGrant } from '@metaclaude/shared';

import type { AppContext } from '../context.js';
import type { App } from '../http/types.js';
import { HttpError, requestIp, requireOwner } from '../http/guards.js';
import { GoogleOAuthError } from '../integrations/google/oauth.js';
import { syncGoogleMcpServer } from '../integrations/google/registration.js';
import { GoogleConnectService } from '../integrations/google/service.js';
import { RESTRICTED_GRANTS } from '../integrations/google/scopes.js';

const ConnectRequest = z
  .object({
    clientId: z.string().min(1).max(400),
    clientSecret: z.string().min(1).max(400),
    grants: z.array(GoogleGrant).min(1).max(16),
    loginHint: z.string().max(320).optional(),
  })
  .strict();

/** Where the browser lands after the callback, with a word about what happened. */
function settleAt(origin: string, outcome: 'connected' | 'failed', detail?: string): string {
  const url = new URL('/settings', origin);
  url.searchParams.set('google', outcome);
  if (detail) url.searchParams.set('reason', detail.slice(0, 300));
  return url.toString();
}

export function registerIntegrationRoutes(app: App, context: AppContext): void {
  const google = new GoogleConnectService(context.db, context.vault);

  /**
   * The status, plus the two things the operator needs *before* connecting:
   * the exact redirect URI to register with Google, and which of the grants
   * will drag their Cloud project into Google's verification.
   */
  app.get('/api/integrations/google', async (request, reply) => {
    const origin = request.headers.origin ?? '';
    let redirectUri: string | null = null;
    try {
      if (origin) redirectUri = GoogleConnectService.redirectUriFor(origin);
    } catch {
      redirectUri = null;
    }
    return reply.send({
      connection: google.status(),
      redirectUri,
      restrictedGrants: RESTRICTED_GRANTS,
    });
  });

  /**
   * Owner only, not operator: this stores a credential that reaches a live
   * mailbox and a calendar. It is the same bar as adding a marketplace, for
   * the same reason — the blast radius is the account, not the deployment.
   */
  app.post('/api/integrations/google/connect', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = ConnectRequest.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Client id, secret and at least one grant.');

    const origin = request.headers.origin;
    if (!origin) {
      throw new HttpError(400, 'Could not determine this deployment’s address from the request.');
    }

    try {
      const { url, redirectUri } = google.begin({
        userId: actor.id,
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
        grants: parsed.data.grants,
        origin,
        ...(parsed.data.loginHint ? { loginHint: parsed.data.loginHint } : {}),
      });
      context.audit.record({
        actor: actor.username,
        action: 'google.connect.begin',
        target: 'google',
        ipAddress: requestIp(context, request),
        detail: parsed.data.grants.join(', '),
      });
      // The browser is sent here by the client rather than by a 302, so a
      // failed request can still render an error in the interface.
      return reply.send({ authorizationUrl: url, redirectUri });
    } catch (error) {
      if (error instanceof GoogleOAuthError) throw new HttpError(error.statusCode, error.message);
      throw error;
    }
  });

  app.get('/api/integrations/google/callback', async (request, reply) => {
    // Reconstructed from the request rather than taken from a header: this is
    // a cross-site navigation, so there is no Origin to trust.
    const origin = `${request.protocol}://${request.hostname}`;
    const query = request.query as { code?: string; state?: string; error?: string };

    // The consent screen's own Cancel button lands here.
    if (query.error) return reply.redirect(settleAt(origin, 'failed', query.error));
    if (!query.code || !query.state) {
      return reply.redirect(settleAt(origin, 'failed', 'The callback carried no authorisation.'));
    }

    try {
      const status = await google.complete({ state: query.state, code: query.code });
      // Only now does the connection become a thing a run could use — and it
      // arrives disabled.
      syncGoogleMcpServer({ registry: context.registry, google });
      context.audit.record({
        actor: status.connectedBy ?? 'unknown',
        action: 'google.connect.complete',
        target: 'google',
        ipAddress: requestIp(context, request),
        detail: `${status.accountEmail ?? 'unknown account'} — ${status.grants.join(', ')}`,
      });
      return reply.redirect(settleAt(origin, 'connected'));
    } catch (error) {
      context.log.warn({ err: error }, 'google callback failed');
      return reply.redirect(settleAt(origin, 'failed', (error as Error).message));
    }
  });

  app.delete('/api/integrations/google', async (request, reply) => {
    const actor = requireOwner(request);
    const removed = google.disconnect();
    // Removes the MCP server too: a Google server with no credentials is a row
    // that can only ever fail to connect.
    syncGoogleMcpServer({ registry: context.registry, google });
    if (removed) {
      context.audit.record({
        actor: actor.username,
        action: 'google.disconnect',
        target: 'google',
        ipAddress: requestIp(context, request),
      });
    }
    return reply.send({ ok: true, removed });
  });
}
