/**
 * Filesystem and git routes, scoped to a workspace.
 *
 * Every path parameter is untrusted. It is passed verbatim to the FileService,
 * which jails it — routes must never resolve paths themselves.
 */

import type { App } from '../http/types.js';
import { z } from 'zod';
import { ConnectRepositoryRequest } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import {
  HttpError,
  mustGetWorkspace as mustGetWorkspaceFrom,
  requestIp,
  requireOperator,
} from '../http/guards.js';
import { redactUrlCredentials } from '../security/audit.js';
import { queryIntOr, spreadInt } from '../http/query.js';

export function registerFileRoutes(app: App, context: AppContext): void {
  const mustGetWorkspace = (id: string) => mustGetWorkspaceFrom(context, id);

  /* -------------------------------- Files ------------------------------- */

  app.get<{ Params: { id: string }; Querystring: { path?: string; hidden?: string } }>(
    '/api/workspaces/:id/files',
    async (request, reply) => {
      const workspace = mustGetWorkspace(request.params.id);
      const entries = await context.files.list(
        workspace.path,
        request.query.path ?? '',
        request.query.hidden === 'true',
      );
      return reply.send({ path: request.query.path ?? '', entries });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/workspaces/:id/file',
    async (request, reply) => {
      const workspace = mustGetWorkspace(request.params.id);
      if (!request.query.path) throw new HttpError(400, 'A path is required.');
      return reply.send(await context.files.read(workspace.path, request.query.path));
    },
  );

  const WriteFile = z.object({
    path: z.string().min(1).max(4096),
    content: z.string().max(2 * 1024 * 1024),
  });

  app.put<{ Params: { id: string } }>('/api/workspaces/:id/file', async (request, reply) => {
    const actor = requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);

    const parsed = WriteFile.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const entry = await context.files.write(workspace.path, parsed.data.path, parsed.data.content);
    context.audit.record({
      actor: actor.username,
      action: 'file.write',
      target: `${workspace.slug}:${parsed.data.path}`,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ entry });
  });

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/workspaces/:id/file',
    async (request, reply) => {
      const actor = requireOperator(request);
      const workspace = mustGetWorkspace(request.params.id);
      if (!request.query.path) throw new HttpError(400, 'A path is required.');

      await context.files.remove(workspace.path, request.query.path);
      context.audit.record({
        actor: actor.username,
        action: 'file.delete',
        target: `${workspace.slug}:${request.query.path}`,
        ipAddress: requestIp(context, request),
      });
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/directory', async (request, reply) => {
    requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);
    const parsed = z.object({ path: z.string().min(1).max(4096) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'A path is required.');

    await context.files.createDirectory(workspace.path, parsed.data.path);
    return reply.status(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/move', async (request, reply) => {
    requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);
    const parsed = z
      .object({ from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Both `from` and `to` are required.');

    await context.files.move(workspace.path, parsed.data.from, parsed.data.to);
    return reply.send({ ok: true });
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    '/api/workspaces/:id/search',
    async (request, reply) => {
      const workspace = mustGetWorkspace(request.params.id);
      if (!request.query.q) return reply.send({ entries: [] });

      const entries = await context.files.search(workspace.path, request.query.q, {
        ...spreadInt('limit', request.query.limit, { min: 1, max: 200 }),
      });
      return reply.send({ entries });
    },
  );

  /* --------------------------------- Git -------------------------------- */

  /**
   * Attach a repository to a workspace that already exists.
   *
   * Cloning used to be possible only while creating a workspace, in a field
   * inside a modal on one screen. A workspace that started empty could never be
   * connected to anything afterwards, and the Git panel's only suggestion was
   * to open a shell — on a deployment built so that a shell is never needed.
   */
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/git/connect', async (request, reply) => {
    const user = requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);
    const input = ConnectRepositoryRequest.parse(request.body ?? {});

    const result = await context.workspaces.connectRepository(workspace.id, input.gitUrl);
    context.audit.record({
      actor: user.username,
      action: 'workspace.git.connect',
      target: workspace.id,
      outcome: 'success',
      ipAddress: requestIp(context, request),
      detail: input.gitUrl ? redactUrlCredentials(input.gitUrl) : 'local',
    });
    return reply.send(result);
  });

  app.get<{ Params: { id: string } }>('/api/workspaces/:id/git/status', async (request, reply) => {
    const workspace = mustGetWorkspace(request.params.id);
    return reply.send(await context.git.status(workspace.path));
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; staged?: string } }>(
    '/api/workspaces/:id/git/diff',
    async (request, reply) => {
      const workspace = mustGetWorkspace(request.params.id);
      const diff = await context.git.diff(workspace.path, {
        ...(request.query.path ? { path: request.query.path } : {}),
        staged: request.query.staged === 'true',
      });
      const files = await context.git.changedFiles(
        workspace.path,
        request.query.staged === 'true',
      );
      return reply.send({ diff, files });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/workspaces/:id/git/log',
    async (request, reply) => {
      const workspace = mustGetWorkspace(request.params.id);
      const commits = await context.git.log(
        workspace.path,
        queryIntOr(request.query.limit, { min: 1, max: 500 }, 30),
      );
      return reply.send({ commits });
    },
  );

  app.get<{ Params: { id: string } }>('/api/workspaces/:id/git/branches', async (request, reply) => {
    const workspace = mustGetWorkspace(request.params.id);
    return reply.send(await context.git.branches(workspace.path));
  });

  const Paths = z.object({ paths: z.array(z.string().min(1).max(4096)).max(1000) });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/git/stage', async (request, reply) => {
    requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);
    const parsed = Paths.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'A list of paths is required.');

    await context.git.stage(workspace.path, parsed.data.paths);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/git/unstage', async (request, reply) => {
    requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);
    const parsed = Paths.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'A list of paths is required.');

    await context.git.unstage(workspace.path, parsed.data.paths);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/git/commit', async (request, reply) => {
    const actor = requireOperator(request);
    const workspace = mustGetWorkspace(request.params.id);
    const parsed = z.object({ message: z.string().min(1).max(10_000) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'A commit message is required.');

    const hash = await context.git.commit(workspace.path, parsed.data.message);
    context.audit.record({
      actor: actor.username,
      action: 'git.commit',
      target: `${workspace.slug}:${hash.slice(0, 12)}`,
      ipAddress: requestIp(context, request),
      detail: parsed.data.message.slice(0, 200),
    });
    return reply.send({ hash });
  });
}
