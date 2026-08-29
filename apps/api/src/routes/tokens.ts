/**
 * Managing the machine identities that reach the MCP gateway.
 *
 * Owner-only, every one of them. Minting a token creates a credential that can
 * make this deployment execute things for a year without anyone present; that
 * is a decision of the same weight as adding a user, and the application's
 * `operator` role deliberately does not carry it.
 *
 * The secret is returned by exactly one route, exactly once. Everything else
 * — listing, editing, revoking — works from the record, which carries a hint
 * and never the value.
 */

import { CreateApiTokenRequest, UpdateApiTokenRequest } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOwner } from '../http/guards.js';
import type { App } from '../http/types.js';

export function registerTokenRoutes(app: App, context: AppContext): void {
  app.get('/api/tokens', async (request, reply) => {
    requireOwner(request);
    return reply.send({ tokens: context.apiTokens.list() });
  });

  app.post('/api/tokens', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = CreateApiTokenRequest.safeParse(request.body);
    if (!parsed.success) throw parsed.error;

    // Every named workspace must exist. A token pointing at a deleted
    // workspace is a token whose reach nobody can read back correctly, and the
    // gateway would answer "no such workspace" for a scope the screen shows as
    // granted.
    for (const workspaceId of parsed.data.workspaceIds) {
      if (!context.workspaceRepo.get(workspaceId)) {
        throw new HttpError(400, 'That workspace does not exist.');
      }
    }

    const { token, secret } = context.apiTokens.create(parsed.data, actor.username);

    context.audit.record({
      actor: actor.username,
      action: 'token.create',
      target: token.id,
      ipAddress: requestIp(context, request),
      // What it can do and for how long — never the value, and never a hint
      // long enough to be one.
      detail: `${token.name}: ${token.scopes.join('+')} on ${token.workspaceIds.length} workspace(s), ceiling ${token.ceiling}`,
    });

    return reply.status(201).send({ token, secret });
  });

  app.patch<{ Params: { id: string } }>('/api/tokens/:id', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = UpdateApiTokenRequest.safeParse(request.body);
    if (!parsed.success) throw parsed.error;

    for (const workspaceId of parsed.data.workspaceIds ?? []) {
      if (!context.workspaceRepo.get(workspaceId)) {
        throw new HttpError(400, 'That workspace does not exist.');
      }
    }

    const token = context.apiTokens.update(request.params.id, parsed.data);
    if (!token) throw new HttpError(404, 'Token not found.');

    context.audit.record({
      actor: actor.username,
      action: 'token.update',
      target: token.id,
      ipAddress: requestIp(context, request),
      detail: `${token.name}: ${token.scopes.join('+')} on ${token.workspaceIds.length} workspace(s), ceiling ${token.ceiling}`,
    });

    return reply.send({ token });
  });

  /**
   * Revocation is a DELETE that keeps the row.
   *
   * The row is the only record that this credential ever existed, and the
   * audit trail refers to it by id. Deleting it would erase the answer to
   * "what was that token allowed to do?" precisely when someone is asking
   * because it leaked.
   */
  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (request, reply) => {
    const actor = requireOwner(request);
    const token = context.apiTokens.get(request.params.id);
    if (!token) throw new HttpError(404, 'Token not found.');

    context.apiTokens.revoke(token.id);

    context.audit.record({
      actor: actor.username,
      action: 'token.revoke',
      target: token.id,
      ipAddress: requestIp(context, request),
      detail: token.name,
    });

    return reply.send({ token: context.apiTokens.get(token.id) });
  });

  /**
   * What to paste into the other application.
   *
   * The endpoint is not guessable from the browser's own address when the
   * deployment sits behind a proxy under a different name, and getting it
   * wrong produces a connection error that reads like a broken token — so the
   * server, which knows its public URL, says it.
   */
  app.get('/api/tokens/endpoint', async (request, reply) => {
    requireOwner(request);
    return reply.send({
      url: context.config.publicUrl ? `${context.config.publicUrl}/api/gateway/mcp` : null,
    });
  });
}
