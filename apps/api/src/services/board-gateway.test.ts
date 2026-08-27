/**
 * The gateway's two promises: every mutation reaches the workspace topic as a
 * frame, and a finished run lands on its card without overriding what the
 * agent already did to it.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Run, ServerFrame } from '@metaclaude/shared';
import { workspaceTopic } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { EventBus } from '../kernel/bus.js';
import { BoardGateway } from './board-gateway.js';
import { BoardError, BoardService } from './board.js';

let db: Db;
let bus: EventBus;
let gateway: BoardGateway;
let frames: ServerFrame[];
const WS = 'ws_gateway';

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
     VALUES (?, 'Gateway', 'gateway', '', '/tmp/metaclaude-gateway', '#000000', 'folder', '{}', 0, 0)`,
  ).run(WS);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at)
     VALUES ('ses_gateway', ?, 0, 0, 0)`,
  ).run(WS);
  bus = new EventBus();
  frames = [];
  bus.subscribe(workspaceTopic(WS), (frame) => frames.push(frame));
  gateway = new BoardGateway(new BoardService(db), bus);
});

afterEach(() => db.close());

const make = (title = 'A card', over: Record<string, unknown> = {}) =>
  gateway.create({ workspaceId: WS, title, createdBy: 'user:jules', ...over }, 'user:jules');

/** `tasks.run_id` is a real foreign key — a linked run must exist as a row. */
const seedRun = (id: string): void => {
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
     VALUES (?, 'ses_gateway', ?, 'Work the card.', 'running', 0)`,
  ).run(id, WS);
};

/** Only id, status and error are read by `applyRunOutcome`. */
const runShape = (over: Partial<Run>): Run =>
  ({ id: 'run_x', status: 'succeeded', error: null, ...over }) as Run;

/* ------------------------------------------------------------------------ */
/* Publication                                                               */
/* ------------------------------------------------------------------------ */

describe('publication', () => {
  it('publishes a board_task frame for create, update, move, restore and linkRun', () => {
    const task = make();
    seedRun('run_1');
    gateway.update(task.id, { priority: 'high' }, 'user:jules');
    gateway.move(task.id, { status: 'in_progress', afterId: null }, 'user:jules');
    gateway.archive(task.id, 'user:jules');
    gateway.restore(task.id, 'user:jules');
    gateway.linkRun(task.id, 'run_1', 'user:jules');

    const types = frames.map((frame) => frame.type);
    expect(types).toEqual([
      'board_task', // create
      'board_task', // update
      'board_task', // move
      'board_task_removed', // archive
      'board_task', // restore
      'board_task', // linkRun
    ]);
    const last = frames.at(-1);
    expect(last?.type === 'board_task' && last.task.runId).toBe('run_1');
  });

  it('publishes the removal for archive and delete, carrying the task id', () => {
    const task = make();
    gateway.archive(task.id, 'user:jules');
    const removed = frames.at(-1);
    expect(removed?.type === 'board_task_removed' && removed.taskId).toBe(task.id);

    gateway.delete(task.id);
    const deleted = frames.at(-1);
    expect(deleted?.type === 'board_task_removed' && deleted.taskId).toBe(task.id);
    expect(gateway.get(task.id)).toBeNull();
  });

  it('announces every descendant a delete cascades away, not just the root', () => {
    // The rows die by ON DELETE CASCADE; without a frame per card, every open
    // board keeps the children as ghosts until someone refetches.
    const parent = make('Parent');
    const child = make('Child', { parentId: parent.id });
    const grandchild = make('Grandchild', { parentId: child.id });
    gateway.archive(parent.id, 'user:jules');
    frames.length = 0;

    gateway.delete(parent.id);

    const removedIds = frames
      .filter((frame) => frame.type === 'board_task_removed')
      .map((frame) => (frame as { taskId: string }).taskId)
      .sort();
    expect(removedIds).toEqual([parent.id, child.id, grandchild.id].sort());
    expect(gateway.get(grandchild.id)).toBeNull();
  });

  it('publishes both the comment and a task refresh for comment', () => {
    const task = make();
    frames.length = 0;
    const comment = gateway.comment(task.id, 'user:jules', 'A note.');

    expect(frames.map((frame) => frame.type)).toEqual(['board_comment', 'board_task']);
    const first = frames[0];
    expect(first?.type === 'board_comment' && first.comment.id).toBe(comment.id);
  });

  it('publishes nothing when the service refuses the mutation', () => {
    const task = make();
    frames.length = 0;
    // Deleting an active card is refused (archive first), and a missing card 404s.
    expect(() => gateway.delete(task.id)).toThrow(BoardError);
    expect(() => gateway.update('tsk_missing', { title: 'X' }, 'user:jules')).toThrow(BoardError);
    expect(frames).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* applyRunOutcome                                                           */
/* ------------------------------------------------------------------------ */

describe('delegating a review back to the agent', () => {
  it('fires the hook when a review card is assigned to the agent, with task and actor', () => {
    const card = make('reviewed work');
    gateway.move(card.id, { status: 'review' }, 'user:jules');

    const calls: { taskId: string; actor: string }[] = [];
    gateway.onReviewDelegated = (task, actor) => calls.push({ taskId: task.id, actor });

    gateway.update(card.id, { assignee: 'agent' }, 'user:jules');
    expect(calls).toEqual([{ taskId: card.id, actor: 'user:jules' }]);
  });

  it('stays silent for every non-delegation update', () => {
    const calls: string[] = [];
    gateway.onReviewDelegated = (task) => calls.push(task.id);

    // Assigning the agent outside review is the ordinary Send-to-agent state.
    const todo = make('still to do');
    gateway.update(todo.id, { assignee: 'agent' }, 'user:jules');

    // A review card edited without touching the assignee.
    const review = make('in review');
    gateway.move(review.id, { status: 'review' }, 'user:jules');
    gateway.update(review.id, { title: 'renamed' }, 'user:jules');
    // Re-stating the current assignee is not a new delegation.
    gateway.update(review.id, { assignee: 'user' }, 'user:jules');

    expect(calls).toEqual([]);
  });

  it('does not re-fire when the assignee is already the agent', () => {
    const card = make('delegated once');
    gateway.move(card.id, { status: 'review' }, 'user:jules');
    const calls: string[] = [];
    gateway.onReviewDelegated = (task) => calls.push(task.id);

    gateway.update(card.id, { assignee: 'agent' }, 'user:jules');
    gateway.update(card.id, { assignee: 'agent' }, 'user:jules');
    expect(calls).toHaveLength(1);
  });

  it('entering review always hands the card to the user first', () => {
    // The composition of the two rules: an agent-assigned card dragged into
    // review is the user's again; delegation is the explicit act afterwards.
    const card = make('agent-held', { assignee: 'agent' });
    const calls: string[] = [];
    gateway.onReviewDelegated = (task) => calls.push(task.id);

    const moved = gateway.move(card.id, { status: 'review' }, 'user:jules');
    expect(moved.assignee).toBe('user');
    expect(calls).toEqual([]);
  });
});

describe('applyRunOutcome', () => {
  const linkInProgress = (runId: string) => {
    seedRun(runId);
    const task = make('Worked by the agent');
    gateway.move(task.id, { status: 'in_progress', afterId: null }, 'user:jules');
    gateway.linkRun(task.id, runId, 'user:jules');
    return task;
  };

  it('moves a card still in progress to review on success, with a comment', () => {
    const task = linkInProgress('run_ok');
    const moved = gateway.applyRunOutcome(runShape({ id: 'run_ok' }));

    expect(moved?.status).toBe('review');
    // The review rule reaches this path too: the finished card is the
    // operator's to judge, not the agent's to keep.
    expect(moved?.assignee).toBe('user');
    const comments = gateway.comments(task.id);
    expect(comments.at(-1)?.author).toBe('agent:run_ok');
    expect(comments.at(-1)?.body).toContain('review');
    // The move went out as a frame like any other mutation.
    expect(frames.some((frame) => frame.type === 'board_task' && frame.task.status === 'review')).toBe(true);
  });

  it('never moves a card to done, and leaves a card the agent already moved', () => {
    const task = linkInProgress('run_done');
    gateway.move(task.id, { status: 'done', afterId: null }, 'agent:run_done');
    frames.length = 0;

    const untouched = gateway.applyRunOutcome(runShape({ id: 'run_done' }));
    expect(untouched?.status).toBe('done');
    expect(gateway.comments(task.id)).toEqual([]);
    expect(frames).toEqual([]);
  });

  it('blocks the card with the error on failure', () => {
    const task = linkInProgress('run_bad');
    const blocked = gateway.applyRunOutcome(
      runShape({ id: 'run_bad', status: 'failed', error: 'The tool exploded.' }),
    );

    expect(blocked?.blockedReason).toContain('The tool exploded.');
    expect(gateway.comments(task.id).at(-1)?.body).toContain('The tool exploded.');
  });

  it('only comments a failure on a card the agent already moved on', () => {
    // The agent's own move wins on failure exactly as on success: a card put
    // in review holds its place, with the failure on record beside it.
    const task = linkInProgress('run_late');
    gateway.move(task.id, { status: 'review', afterId: null }, 'agent:run_late');

    const after = gateway.applyRunOutcome(
      runShape({ id: 'run_late', status: 'failed', error: 'Timed out at the end.' }),
    );
    expect(after?.status).toBe('review');
    expect(after?.blockedReason).toBeNull();
    expect(gateway.comments(task.id).at(-1)?.body).toContain('Timed out at the end.');
  });

  it('blocks the card with a dedicated reason on interruption', () => {
    linkInProgress('run_stop');
    const blocked = gateway.applyRunOutcome(runShape({ id: 'run_stop', status: 'interrupted' }));
    expect(blocked?.blockedReason).toBe('The run was interrupted.');
  });

  it('does nothing for a run with no card, or a card since archived', () => {
    expect(gateway.applyRunOutcome(runShape({ id: 'run_unlinked' }))).toBeNull();

    const task = linkInProgress('run_arch');
    gateway.archive(task.id, 'user:jules');
    frames.length = 0;
    expect(gateway.applyRunOutcome(runShape({ id: 'run_arch' }))).toBeNull();
    expect(frames).toEqual([]);
  });

  it('records the agent as the actor in the card history', () => {
    const task = linkInProgress('run_hist');
    gateway.applyRunOutcome(runShape({ id: 'run_hist' }));
    const actors = gateway.activity(task.id).map((event) => event.actor);
    expect(actors).toContain('agent:run_hist');
  });
});
