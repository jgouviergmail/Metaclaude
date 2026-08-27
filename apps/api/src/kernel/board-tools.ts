/**
 * The agent's hands on the board — an in-process MCP server, one per run.
 *
 * Scope is the whole design: every handler resolves its task id against the
 * run's own workspace, and a card from anywhere else gets the same "no such
 * task" as a card that does not exist — the tools must not even confirm that
 * another board has it. Writes go through the gateway, so the agent's moves
 * reach every open board exactly as the operator's do.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { BoardTask, TaskComment } from '@metaclaude/shared';
import { TaskPriority, TaskStatus } from '@metaclaude/shared';
import { z } from 'zod';
import type { CreateTaskInput, UpdateTaskInput } from '../services/board.js';

/** What the tools need from the board — the gateway satisfies it. */
export interface BoardFacade {
  get(id: string): BoardTask | null;
  list(workspaceId: string): BoardTask[];
  comments(taskId: string): TaskComment[];
  children(taskId: string): BoardTask[];
  create(input: CreateTaskInput, actor: string): BoardTask;
  update(id: string, patch: UpdateTaskInput, actor: string): BoardTask;
  move(id: string, to: { status: TaskStatus; afterId?: string | null }, actor: string): BoardTask;
  comment(taskId: string, author: string, body: string): TaskComment;
}

export interface BoardToolScope {
  workspaceId: string;
  runId: string;
}

/**
 * The card as the agent sees it. Deliberately compact: a board of a hundred
 * cards must fit in a tool result without drowning the run's context.
 */
const compact = (task: BoardTask) => ({
  id: task.id,
  title: task.title,
  status: task.status,
  priority: task.priority,
  assignee: task.assignee,
  parentId: task.parentId,
  blockedReason: task.blockedReason,
  dueAt: task.dueAt,
});

export function createBoardHandlers(board: BoardFacade, scope: BoardToolScope) {
  const actor = `agent:${scope.runId}`;

  const onThisBoard = (taskId: string): BoardTask => {
    const task = board.get(taskId);
    if (!task || task.workspaceId !== scope.workspaceId) {
      // One message for "missing" and "elsewhere": confirming a foreign card
      // exists would already be a leak.
      throw new Error(`No such task on this board: ${taskId}`);
    }
    return task;
  };

  return {
    list() {
      return board.list(scope.workspaceId).map(compact);
    },

    get(args: { taskId: string }) {
      const task = onThisBoard(args.taskId);
      return {
        task: { ...compact(task), description: task.description },
        comments: board
          .comments(task.id)
          .map(({ author, body, createdAt }) => ({ author, body, createdAt })),
        children: board.children(task.id).map(compact),
      };
    },

    create(args: {
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      parentId?: string;
      assignee?: 'user' | 'agent';
    }) {
      if (args.parentId) onThisBoard(args.parentId);
      return compact(
        board.create(
          {
            workspaceId: scope.workspaceId,
            title: args.title,
            createdBy: actor,
            ...(args.description !== undefined ? { description: args.description } : {}),
            status: args.status ?? 'todo',
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
            ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          },
          actor,
        ),
      );
    },

    update(args: {
      taskId: string;
      title?: string;
      description?: string;
      priority?: TaskPriority;
      blockedReason?: string | null;
    }) {
      const task = onThisBoard(args.taskId);
      const { taskId: _taskId, ...patch } = args;
      return compact(board.update(task.id, patch, actor));
    },

    move(args: { taskId: string; status: TaskStatus }) {
      const task = onThisBoard(args.taskId);
      return compact(board.move(task.id, { status: args.status, afterId: null }, actor));
    },

    comment(args: { taskId: string; body: string }) {
      const task = onThisBoard(args.taskId);
      const { author, body, createdAt } = board.comment(task.id, actor, args.body);
      return { author, body, createdAt };
    },

    decompose(args: { taskId: string; subtasks: { title: string; description?: string }[] }) {
      const parent = onThisBoard(args.taskId);
      return args.subtasks.map((subtask) =>
        compact(
          board.create(
            {
              workspaceId: scope.workspaceId,
              title: subtask.title,
              createdBy: actor,
              parentId: parent.id,
              status: 'todo',
              ...(subtask.description !== undefined ? { description: subtask.description } : {}),
            },
            actor,
          ),
        ),
      );
    },
  };
}

/* ------------------------------- MCP server ------------------------------ */

const asToolResult = (fn: () => unknown) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(fn(), null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: (error as Error).message }],
      isError: true,
    };
  }
};

/** Zod shapes for the tool inputs — the SDK builds the JSON schema from them. */
const TITLE = z.string().min(1).max(300);
const DESCRIPTION = z.string().max(20_000);
const TASK_ID = z.string().describe('The task id, as returned by the other board tools.');

export function buildBoardServer(
  board: BoardFacade,
  scope: BoardToolScope,
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createBoardHandlers(board, scope);

  return createSdkMcpServer({
    name: 'metaclaude_board',
    version: '1.0.0',
    tools: [
      sdkTool(
        'board_list',
        "This workspace's kanban board: every active card with its id, column and priority. " +
          'Start here before touching any card.',
        {},
        async () => asToolResult(() => handlers.list()),
      ),
      sdkTool(
        'board_get',
        'One card in full: description, comment thread and sub-tasks.',
        { taskId: TASK_ID },
        async (args) => asToolResult(() => handlers.get(args)),
      ),
      sdkTool(
        'board_create',
        'Add a card to this board. Use parentId to file it under an existing card as a sub-task.',
        {
          title: TITLE,
          description: DESCRIPTION.optional(),
          status: TaskStatus.optional().describe('Column; defaults to todo.'),
          priority: TaskPriority.optional(),
          parentId: TASK_ID.optional(),
          assignee: z.enum(['user', 'agent']).optional(),
        },
        async (args) => asToolResult(() => handlers.create(args)),
      ),
      sdkTool(
        'board_update',
        'Edit a card: title, description, priority, or set/clear its blocked reason ' +
          '(null clears it). Prefer a comment for progress notes.',
        {
          taskId: TASK_ID,
          title: TITLE.optional(),
          description: DESCRIPTION.optional(),
          priority: TaskPriority.optional(),
          blockedReason: z.string().max(500).nullable().optional(),
        },
        async (args) => asToolResult(() => handlers.update(args)),
      ),
      sdkTool(
        'board_move',
        'Move a card to another column. Move a card you are working to in_progress, and to ' +
          'review when your work on it is ready — done is the operator\'s call, not yours.',
        { taskId: TASK_ID, status: TaskStatus },
        async (args) => asToolResult(() => handlers.move(args)),
      ),
      sdkTool(
        'board_comment',
        'Leave a note on a card: progress, findings, questions for the operator.',
        { taskId: TASK_ID, body: z.string().min(1).max(10_000) },
        async (args) => asToolResult(() => handlers.comment(args)),
      ),
      sdkTool(
        'board_decompose',
        'Break a card into sub-tasks in one call. Each lands in todo under the parent.',
        {
          taskId: TASK_ID,
          subtasks: z
            .array(z.object({ title: TITLE, description: DESCRIPTION.optional() }))
            .min(1)
            .max(20),
        },
        async (args) => asToolResult(() => handlers.decompose(args)),
      ),
    ],
  });
}
