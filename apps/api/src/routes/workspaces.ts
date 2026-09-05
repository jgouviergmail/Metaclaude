/**
 * Workspace, session, run and transcript routes.
 *
 * This is the surface the chat UI drives. It is deliberately thin: validation,
 * authorisation and shaping only. All behaviour lives in the kernel and the
 * services, which keeps the same logic reachable from automations and tests.
 */

import type { App } from '../http/types.js';
import {
  ATTACHMENT_LIMITS,
  CreateWorkspaceRequest,
  EffortLevel,
  ModelSelector,
  PermissionMode,
  RewindRequest,
  ToolControls,
  WorkspaceSettings,
  patchSchema,
} from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { decideApproval } from '../http/approvals.js';
import {
  assertAdditionalDirectoriesAllowed,
  assertPermissionModeAllowed,
  HttpError,
  reviewToolSettings,
  requestIp,
  mustGetWorkspace as mustGetWorkspaceFrom,
  requireOperator,
  requireOwner,
} from '../http/guards.js';
import { spreadInt, spreadTimestamp } from '../http/query.js';

export function registerWorkspaceRoutes(app: App, context: AppContext): void {
  const mustGetWorkspace = (id: string) => mustGetWorkspaceFrom(context, id);

  const mustGetSession = (id: string) => {
    const session = context.sessionRepo.get(id);
    if (!session) throw new HttpError(404, 'Session not found.');
    return session;
  };

  /* ------------------------------ Workspaces ---------------------------- */

  app.get('/api/workspaces', async (request, reply) => {
    const includeArchived = (request.query as { archived?: string }).archived === 'true';
    return reply.send({
      workspaces: context.workspaceRepo.list(includeArchived),
      systemWorkspaceId: context.systemWorkspace.id(),
      // Sessions carrying something unread, by workspace. Here rather than on
      // the workspace entity: it is a fact about sessions, and it changes
      // every time one is opened.
      unread: context.sessionRepo.unreadCounts(),
    });
  });

  app.post('/api/workspaces', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = CreateWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    assertPermissionModeAllowed(context, parsed.data.settings?.defaultPermissionMode);
    assertAdditionalDirectoriesAllowed(context, parsed.data.settings?.additionalDirectories);
    const toolLists = reviewToolSettings(parsed.data.settings);

    const workspace = await context.workspaces.create({
      ...parsed.data,
      ...(parsed.data.settings
        ? { settings: { ...parsed.data.settings, ...toolLists } }
        : {}),
    });
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
      // So the settings dialog can lock the fixed controls up front rather
      // than let the operator discover the rule from a failed save.
      isSystem: context.systemWorkspace.isSystem(workspace.id),
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
    // `patchSchema`, not `.partial()`: the latter still fires each field's
    // default, so a patch naming one setting arrives carrying all twenty-one
    // and the repository merges every one of them over the stored row.
    settings: patchSchema(WorkspaceSettings).optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const current = mustGetWorkspace(request.params.id);

    const parsed = UpdateWorkspace.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    // The system workspace's reach is fixed. Archiving it, or touching any of
    // the four settings that decide what its agent can reach, is a 409
    // whoever asks — the guard is what keeps a persuasive agent from talking
    // an operator into handing it a shell.
    context.systemWorkspace.guard(request.params.id, parsed.data);
    assertPermissionModeAllowed(context, parsed.data.settings?.defaultPermissionMode);
    // Rejected here rather than silently dropped at run time, so the operator
    // learns the setting did not take. Both checks now run on creation too —
    // see `workspace-settings.test.ts` for the asymmetry that motivated it.
    assertAdditionalDirectoriesAllowed(context, parsed.data.settings?.additionalDirectories);
    // Against the stored settings, not against the body: a patch naming one
    // list is merged with the other, so the contradiction is a property of the
    // result rather than of the request.
    const toolLists = reviewToolSettings(parsed.data.settings, current.settings);

    const workspace = context.workspaceRepo.update(request.params.id, {
      ...parsed.data,
      ...(parsed.data.settings
        ? { settings: { ...parsed.data.settings, ...toolLists } }
        : {}),
    });
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
      context.systemWorkspace.guardDelete(workspace.id);
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
    assertPermissionModeAllowed(context, parsed.data.permissionMode);

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
    assertPermissionModeAllowed(context, parsed.data.permissionMode);

    const session = context.sessionRepo.update(request.params.id, {
      ...parsed.data,
      ...(parsed.data.model !== undefined ? { model: String(parsed.data.model) } : {}),
    });
    return reply.send({ session });
  });

  /**
   * Mark a session read up to now.
   *
   * A POST rather than a field on the PATCH above: it changes nothing the
   * operator authored, it is sent whenever a run settles under their eyes, and
   * it deliberately writes no audit line — a log of what someone looked at is
   * neither useful nor anybody's business.
   */
  app.post<{ Params: { id: string } }>('/api/sessions/:id/read', async (request, reply) => {
    requireOperator(request);
    mustGetSession(request.params.id);
    return reply.send({ session: context.sessionRepo.markRead(request.params.id) });
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
    // Per-message only, never on CreateSession: orchestration multiplies cost,
    // so nothing stored may leave it quietly on for the next prompt.
    ultracode: z.boolean().optional(),
    // Same per-message rule: tool steering never becomes a stored default.
    toolControls: ToolControls.optional(),
    attachmentIds: z.array(z.string()).max(ATTACHMENT_LIMITS.maxPerMessage).optional(),
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/runs', async (request, reply) => {
    const actor = requireOperator(request);
    const session = mustGetSession(request.params.id);

    const parsed = SubmitRun.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    assertPermissionModeAllowed(context, parsed.data.permissionMode);

    // Skills live in the database but the CLI discovers them on disk, so they
    // are written out immediately before the run that will use them.
    const workspace = mustGetWorkspace(session.workspaceId);
    await context.registry.materialiseSkills(workspace).catch((error: Error) => {
      context.log.warn({ err: error.message }, 'could not materialise skills');
    });

    // A steering directive naming something that does not exist is a typo or
    // a stale picker, and it must fail here — loudly, before the run — not as
    // a run that quietly loaded no skill at all.
    if (parsed.data.toolControls) {
      const controls = parsed.data.toolControls;
      const knownSkills = new Set([
        ...context.registry
          .listSkills(workspace.id)
          .filter((skill) => skill.enabled)
          .map((skill) => skill.name),
        ...context.plugins.runtime().skills.map((skill) => skill.name),
      ]);
      const missingSkill = controls.requiredSkills.find((name) => !knownSkills.has(name));
      if (missingSkill) {
        throw new HttpError(400, `No enabled skill named "${missingSkill}" in this workspace.`);
      }

      const knownServers = new Set(
        context.registry.listMcpServers(workspace.id).map((server) => server.name),
      );
      const missingServer = [
        ...controls.excludedMcpServers,
        ...controls.preferredMcpServers,
      ].find((name) => !knownServers.has(name));
      if (missingServer) {
        throw new HttpError(400, `No MCP server named "${missingServer}" in this workspace.`);
      }
    }

    try {
      const run = await context.kernel.submit({
        sessionId: session.id,
        prompt: parsed.data.prompt,
        ...(parsed.data.attachmentIds?.length ? { attachmentIds: parsed.data.attachmentIds } : {}),
        overrides: {
          ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
          ...(parsed.data.effort !== undefined ? { effort: parsed.data.effort } : {}),
          ...(parsed.data.permissionMode !== undefined
            ? { permissionMode: parsed.data.permissionMode }
            : {}),
          ...(parsed.data.agentName !== undefined ? { agentName: parsed.data.agentName } : {}),
          ...(parsed.data.ultracode !== undefined ? { ultracode: parsed.data.ultracode } : {}),
          ...(parsed.data.toolControls !== undefined
            ? { toolControls: parsed.data.toolControls }
            : {}),
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

  /* ------------------------------ Attachments --------------------------- */

  const UploadAttachment = z.object({
    name: z.string().min(1).max(255),
    mime: z.string().max(255).default(''),
    /** Base64 of the raw bytes; the service enforces the decoded size cap. */
    data: z.string().min(1),
  });

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/attachments',
    // The global bodyLimit (8 MB) fits prompts, not files: 20 MB of payload is
    // ~27 MB once base64-encoded and JSON-wrapped. Raised for this route only.
    { bodyLimit: 32 * 1024 * 1024 },
    async (request, reply) => {
      const actor = requireOperator(request);
      const session = mustGetSession(request.params.id);
      const workspace = mustGetWorkspace(session.workspaceId);
      const parsed = UploadAttachment.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid upload.');

      const data = Buffer.from(parsed.data.data, 'base64');
      const attachment = await context.attachments.save(workspace, session.id, {
        name: parsed.data.name,
        mime: parsed.data.mime,
        data,
      });

      context.audit.record({
        actor: actor.username,
        action: 'attachment.upload',
        target: attachment.id,
        ipAddress: requestIp(context, request),
        detail: `${workspace.name}: ${attachment.name} (${attachment.bytes} bytes)`,
      });
      return reply.status(201).send({ attachment });
    },
  );

  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    const attachment = context.attachments.get(request.params.id);
    if (!attachment) throw new HttpError(404, 'Attachment not found.');
    const workspace = mustGetWorkspace(attachment.workspaceId);

    // Only images and PDFs render inline. Everything else downloads: serving
    // an uploaded HTML file inline on this origin would execute its scripts
    // with the app's cookies — a stored XSS dressed as a feature.
    const inline = attachment.mime.startsWith('image/') || attachment.mime === 'application/pdf';
    reply
      .header('content-type', attachment.mime)
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${attachment.name.replace(/"/g, '')}"`,
      )
      // Content-hash named, so the bytes behind an id never change.
      .header('cache-control', 'private, max-age=31536000, immutable');
    // stream() checks existence synchronously and throws a 404-carrying
    // AttachmentError; a missing file surfaces before any byte is sent.
    return reply.send(context.attachments.stream(attachment, workspace.path));
  });

  app.delete<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    const actor = requireOperator(request);
    await context.attachments.remove(request.params.id);
    context.audit.record({
      actor: actor.username,
      action: 'attachment.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
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
