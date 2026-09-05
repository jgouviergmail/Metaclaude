/**
 * Talking to Metaclaude.
 *
 * Two routes, deliberately thin. The conversation itself is an ordinary
 * session of the system workspace — the transcript, the approval cards, the
 * steering, the rewind all come for free — so all this does is find or open
 * that session, hand the prompt to the kernel and tell the client where to
 * look. The rotation and the "still answering" rule live in `Steward`, where
 * they are tested without a server.
 */

import { AskMetaclaudeRequest } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOperator } from '../http/guards.js';
import type { App } from '../http/types.js';
import { StewardError } from '../services/steward.js';

export function registerMetaclaudeRoutes(app: App, context: AppContext): void {
  /** Where the conversation stands: the standing session, whether it is busy, its last run. */
  app.get('/api/metaclaude', async (request, reply) => {
    requireOperator(request);
    return reply.send(context.steward.conversation());
  });

  app.post('/api/metaclaude/ask', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = AskMetaclaudeRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    let result: Awaited<ReturnType<typeof context.steward.converse>>;
    try {
      result = await context.steward.converse(parsed.data);
    } catch (error) {
      // The one refusal this path has: no system workspace, because preparing
      // it failed at boot. A 503 says "not now", which is what it is.
      if (error instanceof StewardError) throw new HttpError(503, error.message);
      throw error;
    }

    if (result.status === 'busy') {
      // Not an error the client should retry: the answer is to go and read.
      return reply.status(409).send({
        error: 'Metaclaude is still answering. Open the conversation to follow it.',
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
      });
    }

    context.audit.record({
      actor: actor.username,
      action: 'metaclaude.ask',
      target: result.sessionId,
      ipAddress: requestIp(context, request),
      detail: result.runId,
    });
    return reply.status(202).send(result);
  });
}
