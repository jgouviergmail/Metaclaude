/**
 * Workspace, session, run and transcript routes.
 *
 * This is the surface the chat UI drives. It is deliberately thin: validation,
 * authorisation and shaping only. All behaviour lives in the kernel and the
 * services, which keeps the same logic reachable from automations and tests.
 */

import type { App } from '../http/types.js';
import {
  CreateWorkspaceRequest,
  EffortLevel,
  ModelSelector,
  PermissionMode,
  RewindRequest,
  WorkspaceSettings,
} from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { decideApproval } from '../http/approvals.js';
import { HttpError, requestIp, requireOperator, requireOwner } from '../http/guards.js';
import { spreadInt, spreadTimestamp } from '../http/query.js';
import { reviewAdditionalDirectories } from '../security/directories.js';

export function registerWorkspaceRoutes(app: App, context: AppContext): void {
  /** Load a workspace or fail with 404. Used by every nested route. */
  const mustGetWorkspace = (id: string) => {
    const workspace = context.workspaceRepo.get(id);
    if (!workspace) throw new HttpError(404, 'Workspace not found.');
    return workspace;
  };

  const mustGetSession = (id: string) => {
    const session = context.sessionRepo.get(id);
    if (!session) throw new HttpError(404, 'Session not found.');
    return session;
  };

  /* ------------------------------ Workspaces ---------------------------- */

  app.get('/api/workspaces', async (request, reply) => {
    const includeArchived = (request.query as { archived?: string }).archived === 'true';
    return reply.send({ workspaces: context.workspaceRepo.list(includeArchived) });
  });

  app.post('/api/workspaces', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = CreateWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    const workspace = await context.workspaces.create(parsed.data);
    context.audit.record({
      actor: actor.username,
      action: 'workspace.create',
      target: workspace.id,
      ipAddress: requestIp(context, request),
      detail: workspace.name,
    });
    return reply.status(201).send({ workspace });
  });

  app.get<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
    const workspace = mustGetWorkspace(request.params.id);
    const gitStatus = await context.git.status(workspace.path).catch(() => null);
    return reply.send({
      workspace,
      gitStatus,
      sessions: context.sessionRepo.list(workspace.id),
      memoryStats: context.memory.stats(workspace.id),
    });
  });

  const UpdateWorkspace = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    icon: z.string().max(48).optional(),
    archived: z.boolean().optional(),
    settings: WorkspaceSettings.partial().optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
    const actor = requireOperator(request);
    mustGetWorkspace(request.params.id);

    const parsed = UpdateWorkspace.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    // `bypassPermissions` is a deployment-level decision, not a per-workspace one.
    const requestedMode = parsed.data.settings?.defaultPermissionMode;
    if (requestedMode === 'bypassPermissions' && !context.config.allowBypassPermissions) {
      throw new HttpError(
        403,
        'Bypass mode is disabled on this deployment. Set METACLAUDE_ALLOW_BYPASS_PERMISSIONS to enable it.',
      );
    }

    // Reject an out-of-bounds extra directory here rather than silently
    // dropping it at run time, so the operator learns the setting did not take.
    const extraDirectories = parsed.data.settings?.additionalDirectories;
    if (extraDirectories && extraDirectories.length > 0) {
      const review = reviewAdditionalDirectories(extraDirectories, {
        workspacesDir: context.config.workspacesDir,
        dataDir: context.config.dataDir,
      });
      const first = review.rejected[0];
      if (first) throw new HttpError(400, `"${first.path}" ${first.reason}.`);
    }

    const workspace = context.workspaceRepo.update(request.params.id, parsed.data);
    context.audit.record({
      actor: actor.username,
      action: 'workspace.update',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ workspace });
  });

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/api/workspaces/:id',
    async (request, reply) => {
      const actor = requireOperator(request);
      const workspace = mustGetWorkspace(request.params.id);
      const purge = request.query.purge === 'true';

      await context.workspaces.delete(workspace.id, purge);
      context.audit.record({
        actor: actor.username,
        action: 'workspace.delete',
        target: workspace.id,
        ipAddress: requestIp(context, request),
        detail: purge ? 'files purged' : 'record only',
      });
      return reply.send({ ok: true });
    },
  );

  /* -------------------------------- Sessions ---------------------------- */

  const CreateSession = z.object({
    workspaceId: z.string().min(1),
    title: z.string().max(200).optional(),
    model: ModelSelector.optional(),
    effort: EffortLevel.nullable().optional(),
    permissionMode: PermissionMode.optional(),
    agentName: z.string().max(64).nullable().optional(),
  });

  app.post('/api/sessions', async (request, reply) => {
    requireOperator(request);
    const parsed = CreateSession.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    const workspace = mustGetWorkspace(parsed.data.workspaceId);
    const settings = workspace.settings;

    const session = context.sessionRepo.create({
      workspaceId: workspace.id,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      model: String(parsed.data.model ?? settings.defaultModel),
      effort: parsed.data.effort ?? settings.defaultEffort,
      permissionMode: parsed.data.permissionMode ?? settings.defaultPermissionMode,
      agentName: parsed.data.agentName ?? null,
    });
    return reply.status(201).send({ session });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = mustGetSession(request.params.id);
    return reply.send({
      session,
      runs: context.runRepo.listBySession(session.id),
      events: context.transcriptRepo.bySession(session.id),
      pendingApprovals: context.kernel.broker.listPending({ sessionId: session.id }),
      isRunning: context.kernel.hasActiveRunForSession(session.id),
    });
  });

  const UpdateSession = z.object({
    title: z.string().max(200).optional(),
    model: ModelSelector.optional(),
    effort: EffortLevel.nullable().optional(),
    permissionMode: PermissionMode.optional(),
    agentName: z.string().max(64).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    requireOperator(request);
    mustGetSession(request.params.id);

    const parsed = UpdateSession.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    if (parsed.data.permissionMode === 'bypassPermissions' && !context.config.allowBypassPermissions) {
      throw new HttpError(403, 'Bypass mode is disabled on this deployment.');
    }

    const session = context.sessionRepo.update(request.params.id, {
      ...parsed.data,
      ...(parsed.data.model !== undefined ? { model: String(parsed.data.model) } : {}),
    });
    return reply.send({ session });
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const session = mustGetSession(request.params.id);

    // Deleting a session mid-run would orphan a live CLI subprocess.
    if (context.kernel.hasActiveRunForSession(session.id)) {
      throw new HttpError(409, 'This session has a run in flight. Interrupt it first.');
    }

    context.sessionRepo.delete(session.id);
    context.kernel.broker.clearSessionGrants(session.id);
    context.audit.record({
      actor: actor.username,
      action: 'session.delete',
      target: session.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /* ---------------------------------- Runs ------------------------------ */

  const SubmitRun = z.object({
    prompt: z.string().min(1).max(500_000),
    model: ModelSelector.optional(),
    effort: EffortLevel.nullable().optional(),
    permissionMode: PermissionMode.optional(),
    agentName: z.string().max(64).nullable().optional(),
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/runs', async (request, reply) => {
    const actor = requireOperator(request);
    const session = mustGetSession(request.params.id);

    const parsed = SubmitRun.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    if (parsed.data.permissionMode === 'bypassPermissions' && !context.config.allowBypassPermissions) {
      throw new HttpError(403, 'Bypass mode is disabled on this deployment.');
    }

    // Skills live in the database but the CLI discovers them on disk, so they
    // are written out immediately before the run that will use them.
    const workspace = mustGetWorkspace(session.workspaceId);
    await context.registry.materialiseSkills(workspace).catch((error: Error) => {
      context.log.warn({ err: error.message }, 'could not materialise skills');
    });

    try {
      const run = await context.kernel.submit({
        sessionId: session.id,
        prompt: parsed.data.prompt,
        overrides: {
          ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
          ...(parsed.data.effort !== undefined ? { effort: parsed.data.effort } : {}),
          ...(parsed.data.permissionMode !== undefined
            ? { permissionMode: parsed.data.permissionMode }
            : {}),
          ...(parsed.data.agentName !== undefined ? { agentName: parsed.data.agentName } : {}),
        },
      });

      context.audit.record({
        actor: actor.username,
        action: 'run.submit',
        target: run.id,
        ipAddress: requestIp(context, request),
        detail: `${workspace.name}: ${parsed.data.prompt.slice(0, 200)}`,
      });
      return reply.status(202).send({ run });
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (request, reply) => {
    requireOperator(request);
    const session = mustGetSession(request.params.id);
    const interrupted = context.kernel.interrupt(session.id);
    return reply.send({ interrupted });
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = context.runRepo.get(request.params.id);
    if (!run) throw new HttpError(404, 'Run not found.');
    return reply.send({ run, events: context.transcriptRepo.byRun(run.id) });
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/rate', async (request, reply) => {
    requireOperator(request);
    const parsed = z.object({ rating: z.number().min(-1).max(1) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Rating must be between -1 and 1.');

    const run = context.kernel.rateRun(request.params.id, parsed.data.rating);
    if (!run) throw new HttpError(404, 'Run not found, or it has not finished yet.');
    return reply.send({ run });
  });

  /**
   * Restore the files a run changed, or preview what that would restore.
   *
   * Owner-only, and deliberately stricter than rating a run: this overwrites
   * the working tree with an older copy of itself, which is the most
   * destructive thing the API can be asked to do to a workspace.
   *
   * `dryRun` defaults to true in the schema, so a request that forgets the body
   * previews rather than destroys. Only the real thing is audited — a preview
   * changes nothing, and an audit log full of previews is one nobody reads.
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/rewind', async (request, reply) => {
    const user = requireOwner(request);
    const { dryRun } = RewindRequest.parse(request.body ?? {});

    const result = await context.kernel.rewindRun(request.params.id, dryRun);

    if (!dryRun) {
      context.audit.record({
        actor: user.username,
        action: 'run.rewind',
        target: request.params.id,
        outcome: result.applied ? 'success' : 'failure',
        ipAddress: requestIp(context, request),
        detail: result.applied
          ? `${result.filesChanged.length} file(s) restored`
          : (result.error ?? 'refused'),
      });
    }

    return reply.send(result);
  });

  app.get('/api/runs', async (request, reply) => {
    const query = request.query as { workspaceId?: string; limit?: string; since?: string };
    return reply.send({
      runs: context.runRepo.listRecent({
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...spreadInt('limit', query.limit, { min: 1, max: 500 }),
        ...spreadTimestamp('since', query.since),
      }),
    });
  });

  /* ------------------------------ Approvals ----------------------------- */

  app.get('/api/approvals', async (_request, reply) => {
    return reply.send({ approvals: context.kernel.broker.listPending() });
  });

  const Decide = z.object({
    approved: z.boolean(),
    remember: z.boolean().default(false),
    reason: z.string().max(500).optional(),
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = Decide.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid decision.');

    const resolved = decideApproval(
      context,
      {
        approvalId: request.params.id,
        approved: parsed.data.approved,
        remember: parsed.data.remember,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
      { username: actor.username, ipAddress: requestIp(context, request), via: 'http' },
    );
    if (!resolved) throw new HttpError(404, 'That approval is no longer pending.');
    return reply.send({ ok: true });
  });
}
