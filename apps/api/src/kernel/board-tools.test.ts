/**
 * The agent's hands on the board.
 *
 * The one property that must hold everywhere: a run acts on its own
 * workspace's board and nothing else — a task id from another workspace is
 * "no such task", not a cross-workspace grant. Handlers are exercised against
 * the real gateway so what the agent does is exactly what the routes do,
 * frames included.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { ServerFrame } from '@metaclaude/shared';
import { workspaceTopic } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { BoardGateway } from '../services/board-gateway.js';
import { BoardService } from '../services/board.js';
import { EventBus } from './bus.js';
import { buildBoardServer, createBoardHandlers } from './board-tools.js';

let db: Db;
let gateway: BoardGateway;
let frames: ServerFrame[];
let handlers: ReturnType<typeof createBoardHandlers>;

const WS = 'ws_mine';
const OTHER = 'ws_other';
const RUN = 'run_board';

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  for (const [id, slug] of [
    [WS, 'mine'],
    [OTHER, 'other'],
  ] as const) {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, '#000000', 'folder', '{}', 0, 0)`,
    ).run(id, slug, slug, `/tmp/metaclaude-${slug}`);
  }
  const bus = new EventBus();
  frames = [];
  bus.subscribe(workspaceTopic(WS), (frame) => frames.push(frame));
  gateway = new BoardGateway(new BoardService(db), bus);
  handlers = createBoardHandlers(gateway, { workspaceId: WS, runId: RUN });
});

afterEach(() => db.close());

const seed = (workspaceId: string, title: string) =>
  gateway.create({ workspaceId, title, createdBy: 'user:jules' }, 'user:jules');

describe('scope', () => {
  it('refuses a task from another workspace with the same words as a missing one', () => {
    const foreign = seed(OTHER, 'Not yours');
    const messageFor = (taskId: string): string | null => {
      try {
        handlers.get({ taskId });
        return null;
      } catch (error) {
        // The echoed id is the caller's own input — strip it before comparing,
        // the leak to guard against is any *other* difference in the answer.
        return (error as Error).message.replace(taskId, '<id>');
      }
    };
    const missing = messageFor('tsk_missing');
    expect(missing).not.toBeNull();
    expect(messageFor(foreign.id)).toBe(missing);
  });

  it('lists only this workspace, and never archived cards', () => {
    seed(WS, 'Mine');
    seed(OTHER, 'Not mine');
    const archived = seed(WS, 'Archived');
    gateway.archive(archived.id, 'user:jules');

    const listed = handlers.list();
    expect(listed.map((task) => task.title)).toEqual(['Mine']);
  });

  it('refuses to decompose or parent under a foreign card', () => {
    const foreign = seed(OTHER, 'Not yours');
    expect(() => handlers.create({ title: 'Child', parentId: foreign.id })).toThrow(/no such task/i);
    expect(() => handlers.decompose({ taskId: foreign.id, subtasks: [{ title: 'X' }] })).toThrow(
      /no such task/i,
    );
  });
});

describe('acting as the agent', () => {
  it('creates, signed agent:<runId>, and the frame goes out', () => {
    const created = handlers.create({ title: 'From the run', priority: 'high' });
    expect(created.status).toBe('todo');
    expect(created.priority).toBe('high');

    const task = gateway.get(created.id);
    expect(task?.createdBy).toBe(`agent:${RUN}`);
    expect(frames.some((frame) => frame.type === 'board_task')).toBe(true);
  });

  it('updates, moves and comments under the agent actor', () => {
    const card = seed(WS, 'Work me');
    handlers.update({ taskId: card.id, description: 'Now described.' });
    handlers.move({ taskId: card.id, status: 'in_progress' });
    handlers.comment({ taskId: card.id, body: 'Starting.' });

    const after = gateway.get(card.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.description).toBe('Now described.');
    expect(gateway.comments(card.id).at(-1)).toMatchObject({
      author: `agent:${RUN}`,
      body: 'Starting.',
    });
    const actors = gateway.activity(card.id).map((event) => event.actor);
    expect(actors).toContain(`agent:${RUN}`);
  });

  it('get returns the card with its comments and children', () => {
    const card = seed(WS, 'Parent');
    gateway.comment(card.id, 'user:jules', 'Context here.');
    gateway.create(
      { workspaceId: WS, title: 'Child', parentId: card.id, createdBy: 'user:jules' },
      'user:jules',
    );

    const detail = handlers.get({ taskId: card.id });
    expect(detail.task.title).toBe('Parent');
    expect(detail.comments.map((comment) => comment.body)).toEqual(['Context here.']);
    expect(detail.children.map((child) => child.title)).toEqual(['Child']);
  });

  it('decomposes into sub-tasks and surfaces the depth ceiling', () => {
    const card = seed(WS, 'Big one');
    const children = handlers.decompose({
      taskId: card.id,
      subtasks: [{ title: 'Part 1' }, { title: 'Part 2', description: 'The tricky half.' }],
    });
    expect(children.map((child) => child.title)).toEqual(['Part 1', 'Part 2']);
    expect(gateway.children(card.id)).toHaveLength(2);

    // Two levels down is the floor of the ceiling: a third must refuse.
    const level2 = handlers.decompose({
      taskId: children[0]!.id,
      subtasks: [{ title: 'Part 1.1' }],
    });
    expect(() =>
      handlers.decompose({ taskId: level2[0]!.id, subtasks: [{ title: 'Too deep' }] }),
    ).toThrow(/deep|levels/i);
  });
});

describe('the server wrapper', () => {
  it('names the server metaclaude_board', () => {
    const server = buildBoardServer(gateway, { workspaceId: WS, runId: RUN });
    expect(server.name).toBe('metaclaude_board');
    expect(server.type).toBe('sdk');
  });
});
