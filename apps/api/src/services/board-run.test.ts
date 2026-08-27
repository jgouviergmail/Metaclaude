/**
 * Sending a card to the agent.
 *
 * The contract: one press starts one run carrying the card's whole context,
 * the card visibly enters work (in progress, agent-assigned, unblocked), and
 * a second press while that run lives is refused. Failure to start must
 * leave the board untouched — a card marked "being worked" with no run
 * behind it would be a lie the operator acts on.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Run, Workspace } from '@metaclaude/shared';
import { WorkspaceSettings } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { EventBus } from '../kernel/bus.js';
import { BoardGateway } from './board-gateway.js';
import { BoardError, BoardService } from './board.js';
import { startTaskRun, type BoardRunDeps } from './board-run.js';

let db: Db;
let board: BoardGateway;
let runs: RunRepo;
let sessions: SessionRepo;
let workspaces: WorkspaceRepo;
let workspace: Workspace;
let submitted: { sessionId: string; prompt: string }[];
let submitError: string | null;
let deps: BoardRunDeps;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  workspaces = new WorkspaceRepo(db);
  sessions = new SessionRepo(db);
  runs = new RunRepo(db);
  workspace = workspaces.create({
    name: 'Board',
    slug: 'board',
    description: '',
    path: '/tmp/metaclaude-board-run',
    color: '#000000',
    icon: 'folder',
    settings: WorkspaceSettings.parse({}),
  });
  board = new BoardGateway(new BoardService(db), new EventBus());
  submitted = [];
  submitError = null;
  deps = {
    board,
    runs,
    sessions,
    workspaces,
    submit: async (input) => {
      if (submitError) throw new Error(submitError);
      submitted.push(input);
      return runs.create({
        sessionId: input.sessionId,
        workspaceId: workspace.id,
        prompt: input.prompt,
        policy: {
          model: 'default',
          effort: null,
          permissionMode: 'default',
          thinking: 'adaptive',
          thinkingBudgetTokens: null,
          agentName: null,
          ultracode: false,
          source: 'workspace',
        },
        triggeredBy: 'user',
      });
    },
  };
});

afterEach(() => db.close());

const seed = (over: Record<string, unknown> = {}) =>
  board.create(
    { workspaceId: workspace.id, title: 'Ship the widget', createdBy: 'user:jules', ...over },
    'user:jules',
  );

describe('starting a run from a card', () => {
  it('creates a card session, submits the card as prompt, and marks the card worked', async () => {
    const card = seed({ description: 'Steps:\n1. Widget.' });
    board.comment(card.id, 'user:jules', 'Mind the API contract.');
    board.create(
      { workspaceId: workspace.id, title: 'Sub-piece', parentId: card.id, createdBy: 'user:jules' },
      'user:jules',
    );

    const { run, task } = await startTaskRun(deps, card.id, 'jules');

    const session = sessions.get(run.sessionId);
    expect(session?.title).toContain('Ship the widget');
    expect(session?.workspaceId).toBe(workspace.id);

    const prompt = submitted[0]!.prompt;
    expect(prompt).toContain('Ship the widget');
    expect(prompt).toContain('Steps:\n1. Widget.');
    expect(prompt).toContain('Mind the API contract.');
    expect(prompt).toContain('Sub-piece');
    expect(prompt).toContain(card.id);
    // The standing instruction: review is the agent's ceiling.
    expect(prompt).toMatch(/review/);
    expect(prompt).toMatch(/operator/);

    expect(task.runId).toBe(run.id);
    expect(task.status).toBe('in_progress');
    expect(task.assignee).toBe('agent');
  });

  it('tells the agent when a card comes back from review, and only then', async () => {
    // A card started from review was handed back — by a delegation or a
    // re-send — and the prompt must say so: "pick up the card" alone reads
    // as fresh work, and the agent would redo instead of verify.
    const fresh = seed({ title: 'Fresh work' });
    await startTaskRun(deps, fresh.id, 'jules');
    expect(submitted[0]!.prompt).not.toMatch(/handed back/i);

    const reviewed = seed({ title: 'Reviewed work' });
    board.move(reviewed.id, { status: 'review' }, 'user:jules');
    await startTaskRun(deps, reviewed.id, 'jules');
    expect(submitted[1]!.prompt).toMatch(/handed back/i);
    expect(submitted[1]!.prompt).toMatch(/verify/i);
  });

  it('reuses the previous card session so the agent keeps its context', async () => {
    const card = seed();
    const first = await startTaskRun(deps, card.id, 'jules');
    runs.setStatus(first.run.id, 'failed');

    const second = await startTaskRun(deps, card.id, 'jules');
    expect(second.run.sessionId).toBe(first.run.sessionId);
  });

  it('clears the blocked flag when a blocked card is sent back', async () => {
    const card = seed();
    const first = await startTaskRun(deps, card.id, 'jules');
    runs.setStatus(first.run.id, 'failed');
    board.update(card.id, { blockedReason: 'It failed.' }, 'user:jules');

    const { task } = await startTaskRun(deps, card.id, 'jules');
    expect(task.blockedReason).toBeNull();
    expect(task.status).toBe('in_progress');
  });

  it('refuses while the card already has a live run', async () => {
    const card = seed();
    await startTaskRun(deps, card.id, 'jules');

    await expect(startTaskRun(deps, card.id, 'jules')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(submitted).toHaveLength(1);
  });

  it('refuses an archived card and a missing one', async () => {
    const card = seed();
    board.archive(card.id, 'user:jules');
    await expect(startTaskRun(deps, card.id, 'jules')).rejects.toMatchObject({ statusCode: 409 });
    await expect(startTaskRun(deps, 'tsk_missing', 'jules')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('leaves the board untouched when the kernel refuses the run', async () => {
    const card = seed();
    submitError = 'The session already has a run in flight.';

    await expect(startTaskRun(deps, card.id, 'jules')).rejects.toBeInstanceOf(BoardError);
    const after = board.get(card.id);
    expect(after?.runId).toBeNull();
    expect(after?.status).toBe(card.status);
    expect(after?.assignee).toBeNull();
  });
});
