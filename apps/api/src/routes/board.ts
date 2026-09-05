/**
 * Board routes — validation, authorisation, publication.
 *
 * The rules live in BoardService; this layer shapes requests, records the
 * audit trail, and publishes one frame per changed card on the workspace
 * topic so every open board converges without polling. Reads are open to any
 * authenticated role, like the rest of the product's reads; mutations are
 * operator actions.
 */

import type { App } from '../http/types.js';
import { TaskKind, TaskPriority, TaskStatus } from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, mustGetWorkspace, requestIp, requireOperator } from '../http/guards.js';
import { spreadInt } from '../http/query.js';
import { startTaskRun } from '../services/board-run.js';

const Assignee = z.enum(['user', 'agent']).nullable();

export function registerBoardRoutes(app: App, context: AppContext): void {

  /* -------------------------------- Reads ------------------------------- */

  app.get<{ Params: { id: string } }>('/api/workspaces/:id/board', async (request, reply) => {
    const workspace = mustGetWorkspace(context, request.params.id);
    return reply.send({ tasks: context.board.list(workspace.id) });
  });

  app.get<{
    Querystring: {
      workspaceId?: string;
      status?: string;
      assignee?: string;
      archived?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/tasks', async (request, reply) => {
    const status = TaskStatus.safeParse(request.query.status);
    const assignee = z.enum(['user', 'agent']).safeParse(request.query.assignee);
    return reply.send({
      tasks: context.board.listAll({
        ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
        ...(status.success ? { status: status.data } : {}),
        ...(assignee.success ? { assignee: assignee.data } : {}),
        includeArchived: request.query.archived === 'true',
        ...spreadInt('limit', request.query.limit, { min: 1, max: 500 }),
        ...spreadInt('offset', request.query.offset, { min: 0, max: 1_000_000 }),
      }),
    });
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = context.board.get(request.params.id);
    if (!task) throw new HttpError(404, 'Task not found.');
    return reply.send({
      task,
      // The linked run in full, so the drawer can tell "being worked right
      // now" from "was worked once" without a second round trip.
      run: task.runId ? context.runRepo.get(task.runId) : null,
      comments: context.board.comments(task.id),
      activity: context.board.activity(task.id),
      children: context.board.children(task.id),
    });
  });

  /* ------------------------------ Mutations ----------------------------- */

  const CreateTask = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(20_000).optional(),
    status: TaskStatus.optional(),
    kind: TaskKind.optional(),
    priority: TaskPriority.optional(),
    parentId: z.string().nullable().optional(),
    assignee: Assignee.optional(),
    dueAt: z.number().int().nullable().optional(),
  });

  app.post<{ Params: { id: string } }>('/api/workspaces/:id/tasks', async (request, reply) => {
    const actor = requireOperator(request);
    const workspace = mustGetWorkspace(context, request.params.id);
    const parsed = CreateTask.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid task.');
    }

    const task = context.board.create(
      { workspaceId: workspace.id, createdBy: `user:${actor.username}`, ...parsed.data },
      `user:${actor.username}`,
    );
    context.audit.record({
      actor: actor.username,
      action: 'task.create',
      target: task.id,
      ipAddress: requestIp(context, request),
      detail: `${workspace.name}: ${task.title.slice(0, 120)}`,
    });
    return reply.status(201).send({ task });
  });

  const UpdateTask = z.object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20_000).optional(),
    kind: TaskKind.optional(),
    priority: TaskPriority.optional(),
    assignee: Assignee.optional(),
    dueAt: z.number().int().nullable().optional(),
    blockedReason: z.string().max(500).nullable().optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = UpdateTask.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid update.');

    const task = context.board.update(request.params.id, parsed.data, `user:${actor.username}`);
    return reply.send({ task });
  });

  const MoveTask = z.object({
    status: TaskStatus,
    afterId: z.string().nullable().default(null),
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/move', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = MoveTask.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid move.');

    const task = context.board.move(request.params.id, parsed.data, `user:${actor.username}`);
    context.audit.record({
      actor: actor.username,
      action: 'task.move',
      target: task.id,
      ipAddress: requestIp(context, request),
      detail: `→ ${task.status}`,
    });
    return reply.send({ task });
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/archive', async (request, reply) => {
    const actor = requireOperator(request);
    const task = context.board.archive(request.params.id, `user:${actor.username}`);
    context.audit.record({
      actor: actor.username,
      action: 'task.archive',
      target: task.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ task });
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/restore', async (request, reply) => {
    const actor = requireOperator(request);
    const task = context.board.restore(request.params.id, `user:${actor.username}`);
    return reply.send({ task });
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const task = context.board.delete(request.params.id);
    context.audit.record({
      actor: actor.username,
      action: 'task.delete',
      target: task.id,
      ipAddress: requestIp(context, request),
      detail: task.title.slice(0, 120),
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/run', async (request, reply) => {
    const actor = requireOperator(request);
    const task = context.board.get(request.params.id);
    if (!task) throw new HttpError(404, 'Task not found.');
    const workspace = mustGetWorkspace(context, task.workspaceId);

    // Skills live in the database but the CLI discovers them on disk, so they
    // are written out immediately before the run that will use them.
    await context.registry.materialiseSkills(workspace).catch((error: Error) => {
      context.log.warn({ err: error.message }, 'could not materialise skills');
    });

    const started = await startTaskRun(
      {
        board: context.board,
        runs: context.runRepo,
        sessions: context.sessionRepo,
        workspaces: context.workspaceRepo,
        submit: (input) => context.kernel.submit(input),
      },
      task.id,
      actor.username,
    );

    context.audit.record({
      actor: actor.username,
      action: 'task.run',
      target: task.id,
      ipAddress: requestIp(context, request),
      detail: `${workspace.name}: ${task.title.slice(0, 120)}`,
    });
    return reply.status(202).send({ run: started.run, task: started.task });
  });

  /**
   * The autopilot's button: start the top To do card now. Manual, so it
   * bypasses the opt-in and the quota guard — never the one-card-at-a-time
   * rule — and the board history signs it with the presser's name.
   */
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/board/work', async (request, reply) => {
    const actor = requireOperator(request);
    const workspace = mustGetWorkspace(context, request.params.id);

    const outcome = await context.autopilot.workNext(workspace.id, {
      manual: true,
      username: actor.username,
    });
    if (outcome.started) {
      context.audit.record({
        actor: actor.username,
        action: 'task.run',
        target: outcome.started.id,
        ipAddress: requestIp(context, request),
        detail: `${workspace.name}: ${outcome.started.title.slice(0, 120)} (work the board)`,
      });
    }
    return reply.status(outcome.started ? 202 : 200).send(outcome);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/comments', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z.object({ body: z.string().min(1).max(10_000) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'A comment needs a body.');

    const comment = context.board.comment(
      request.params.id,
      `user:${actor.username}`,
      parsed.data.body,
    );
    return reply.status(201).send({ comment });
  });
}
