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
import { TaskPriority, TaskStatus, workspaceTopic } from '@metaclaude/shared';
import type { BoardTask, TaskComment } from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, mustGetWorkspace, requestIp, requireOperator } from '../http/guards.js';
import { spreadInt } from '../http/query.js';

const Assignee = z.enum(['user', 'agent']).nullable();

export function registerBoardRoutes(app: App, context: AppContext): void {
  const publishTask = (task: BoardTask): void => {
    const topic = workspaceTopic(task.workspaceId);
    context.bus.publish(topic, { type: 'board_task', topic, task });
  };
  const publishRemoval = (workspaceId: string, taskId: string): void => {
    const topic = workspaceTopic(workspaceId);
    context.bus.publish(topic, { type: 'board_task_removed', topic, taskId });
  };
  const publishComment = (workspaceId: string, comment: TaskComment): void => {
    const topic = workspaceTopic(workspaceId);
    context.bus.publish(topic, { type: 'board_comment', topic, comment });
  };

  /* -------------------------------- Reads ------------------------------- */

  app.get<{ Params: { id: string } }>('/api/workspaces/:id/board', async (request, reply) => {
    const workspace = mustGetWorkspace(context, request.params.id);
    return reply.send({ tasks: context.board.board(workspace.id) });
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
      tasks: context.board.list({
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
    publishTask(task);
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
    publishTask(task);
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
    publishTask(task);
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
    // An archived card leaves the board, so the frame that travels is removal.
    publishRemoval(task.workspaceId, task.id);
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
    publishTask(task);
    return reply.send({ task });
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const task = context.board.get(request.params.id);
    if (!task) throw new HttpError(404, 'Task not found.');

    context.board.delete(task.id);
    publishRemoval(task.workspaceId, task.id);
    context.audit.record({
      actor: actor.username,
      action: 'task.delete',
      target: task.id,
      ipAddress: requestIp(context, request),
      detail: task.title.slice(0, 120),
    });
    return reply.send({ ok: true });
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
    const task = context.board.get(request.params.id);
    if (task) {
      publishComment(task.workspaceId, comment);
      publishTask(task);
    }
    return reply.status(201).send({ comment });
  });
}
