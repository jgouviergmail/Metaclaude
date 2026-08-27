/**
 * Advisor routes — asking for an analysis, and deciding on its proposals.
 *
 * Everything here is operator-level: asking starts a run (the same authority
 * as sending a message), and accepting a proposal writes a *disabled* record
 * into the registry (the same authority as creating one by hand). The
 * advisor's own writes were already graduated server-side; these routes only
 * add the human decisions and their audit lines.
 */

import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOperator } from '../http/guards.js';
import type { App } from '../http/types.js';

export function registerAdvisorRoutes(app: App, context: AppContext): void {
  app.post('/api/advisor/ask', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z.object({ workspaceId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'workspaceId is required.');

    const run = await context.advisor.ask(parsed.data.workspaceId);
    context.audit.record({
      actor: actor.username,
      action: 'advisor.ask',
      target: parsed.data.workspaceId,
      ipAddress: requestIp(context, request),
      detail: run.id,
    });
    return reply.status(202).send({ runId: run.id, sessionId: run.sessionId });
  });

  app.get('/api/advisor/proposals', async (request, reply) => {
    requireOperator(request);
    const query = z
      .object({ workspaceId: z.string().optional() })
      .safeParse(request.query);
    return reply.send({
      proposals: context.advisor.list(query.success ? query.data.workspaceId : undefined),
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/advisor/proposals/:id/accept',
    async (request, reply) => {
      const actor = requireOperator(request);
      const { proposal, appliedId } = context.advisor.accept(request.params.id, actor.username);
      context.audit.record({
        actor: actor.username,
        action: 'advisor.accept',
        target: proposal.id,
        ipAddress: requestIp(context, request),
        detail: `${proposal.kind} ${proposal.name}${appliedId ? ` → ${appliedId}` : ''}`,
      });
      return reply.send({ proposal, appliedId });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/advisor/proposals/:id/dismiss',
    async (request, reply) => {
      const actor = requireOperator(request);
      const proposal = context.advisor.dismiss(request.params.id, actor.username);
      context.audit.record({
        actor: actor.username,
        action: 'advisor.dismiss',
        target: proposal.id,
        ipAddress: requestIp(context, request),
        detail: `${proposal.kind} ${proposal.name}`,
      });
      return reply.send({ proposal });
    },
  );
}
