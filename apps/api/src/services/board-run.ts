/**
 * Sending a card to the agent.
 *
 * One press, one run: the card's title, description, discussion and
 * sub-tasks become the prompt, the card enters work visibly (in progress,
 * agent-assigned, unblocked), and the run is linked so the outcome hook can
 * close the loop. Re-sending a card reuses its session — the agent that
 * failed or was reviewed keeps the context it earned. The kernel refusing
 * the run leaves the board exactly as it was: the mutations happen only
 * after the submit succeeds.
 */

import type { Run, BoardTask, Session, Workspace } from '@metaclaude/shared';
import type { RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import type { BoardGateway } from './board-gateway.js';
import { BoardError } from './board.js';

export interface BoardRunDeps {
  board: Pick<BoardGateway, 'get' | 'comments' | 'children' | 'linkRun' | 'move' | 'update'>;
  runs: Pick<RunRepo, 'get'>;
  sessions: Pick<SessionRepo, 'get' | 'create'>;
  workspaces: Pick<WorkspaceRepo, 'get'>;
  /** The kernel's submit, narrowed to what a card run needs. */
  submit: (input: { sessionId: string; prompt: string }) => Promise<Run>;
}

const ACTIVE = new Set<Run['status']>(['queued', 'running', 'waiting_approval']);

/** The last comments the prompt carries — enough discussion, not the archive. */
const PROMPT_COMMENTS = 20;

export function buildTaskPrompt(
  task: BoardTask,
  comments: { author: string; body: string }[],
  children: BoardTask[],
): string {
  const lines = [
    `You are picking up the card "${task.title}" (${task.id}) from this workspace's kanban board.`,
  ];
  if (task.description.trim()) {
    lines.push('', 'Description:', task.description.trim());
  }
  if (comments.length > 0) {
    lines.push('', 'Discussion so far:');
    for (const comment of comments.slice(-PROMPT_COMMENTS)) {
      lines.push(`- ${comment.author}: ${comment.body}`);
    }
  }
  if (children.length > 0) {
    lines.push('', 'Its sub-tasks:');
    for (const child of children) {
      lines.push(`- [${child.status}] ${child.title} (${child.id})`);
    }
  }
  lines.push(
    '',
    'Work the card now, and keep the board honest with the board tools as you go:',
    'comment your progress and findings on the card, move it to review when your',
    "work is ready — never to done, done is the operator's call — and if you cannot",
    "proceed, set the card's blockedReason to say exactly why.",
  );
  return lines.join('\n');
}

export async function startTaskRun(
  deps: BoardRunDeps,
  taskId: string,
  username: string,
): Promise<{ run: Run; task: BoardTask }> {
  const task = deps.board.get(taskId);
  if (!task) throw new BoardError('Task not found.', 404);
  if (task.archivedAt !== null) {
    throw new BoardError('An archived card cannot be sent to the agent.', 409);
  }

  const workspace = deps.workspaces.get(task.workspaceId);
  if (!workspace) throw new BoardError('Workspace not found.', 404);

  const prior = task.runId ? deps.runs.get(task.runId) : null;
  if (prior && ACTIVE.has(prior.status)) {
    throw new BoardError('This card is already being worked — interrupt that run first.', 409);
  }

  const session = pickSession(deps, prior, workspace, task);
  const prompt = buildTaskPrompt(task, deps.board.comments(task.id), deps.board.children(task.id));

  let run: Run;
  try {
    run = await deps.submit({ sessionId: session.id, prompt });
  } catch (error) {
    // The kernel said no (a run in flight there, the reservation window…).
    // Nothing on the board has moved yet, which is the point.
    throw new BoardError((error as Error).message, 409);
  }

  const actor = `user:${username}`;
  deps.board.linkRun(task.id, run.id, actor);
  let updated: BoardTask;
  if (task.status !== 'in_progress') {
    // The move clears any blocked reason itself.
    updated = deps.board.move(task.id, { status: 'in_progress', afterId: null }, actor);
  } else if (task.blockedReason !== null) {
    updated = deps.board.update(task.id, { blockedReason: null }, actor);
  } else {
    updated = deps.board.get(task.id) as BoardTask;
  }
  if (updated.assignee !== 'agent') {
    updated = deps.board.update(task.id, { assignee: 'agent' }, actor);
  }

  return { run, task: updated };
}

/**
 * The card's standing session, or a fresh one named after the card.
 *
 * Continuity is deliberate: a card sent back after review resumes the agent
 * that worked it, context and all. An archived session stays archived — the
 * card simply gets a new one.
 */
function pickSession(
  deps: BoardRunDeps,
  prior: Run | null,
  workspace: Workspace,
  task: BoardTask,
): Session {
  if (prior) {
    const session = deps.sessions.get(prior.sessionId);
    if (session && !session.archived) return session;
  }
  return deps.sessions.create({
    workspaceId: workspace.id,
    title: `Board: ${task.title.slice(0, 120)}`,
    model: String(workspace.settings.defaultModel),
    effort: workspace.settings.defaultEffort,
    permissionMode: workspace.settings.defaultPermissionMode,
  });
}
