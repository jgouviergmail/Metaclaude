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
    // The status is a query rather than a second route: the Dashboard lists
    // what waits *and*, below it, the revisions already applied — one card
    // component, one client method, two lists.
    const query = z
      .object({
        workspaceId: z.string().optional(),
        status: z.enum(['pending', 'accepted', 'dismissed']).optional(),
      })
      .safeParse(request.query);
    const options = query.success ? query.data : {};
    return reply.send({
      proposals: context.advisor.list(options.workspaceId, options.status ?? 'pending'),
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

  /**
   * Put back the text a revision replaced.
   *
   * What makes accepting one safe, and therefore not optional. Every other
   * proposal in this inbox lands *disabled* — an accepted skill exists and
   * does nothing until somebody enables it — while a revision is in force on
   * the very next run. "Reversible" has to be a button, and the service
   * refuses when what stands is no longer what the revision wrote, so an
   * operator who has edited since cannot lose that edit to an undo.
   */
  app.post<{ Params: { id: string } }>(
    '/api/advisor/proposals/:id/revert',
    async (request, reply) => {
      const actor = requireOperator(request);
      const proposal = context.advisor.revert(request.params.id, actor.username);
      context.audit.record({
        actor: actor.username,
        action: 'advisor.revert',
        target: proposal.id,
        ipAddress: requestIp(context, request),
        detail: `${proposal.kind} ${proposal.name}`,
      });
      return reply.send({ proposal });
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
