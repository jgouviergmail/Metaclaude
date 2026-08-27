/**
 * The board's rules, and the fractional ordering they stand on.
 *
 * The ordering is the part that must be right beyond doubt: every key the
 * board ever assigns comes from `orderKeyBetween`, and a wrong midpoint is
 * cards silently swapping places under someone's cursor.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { BoardError, BoardService, orderKeyBetween } from './board.js';

let db: Db;
let board: BoardService;
const WS = 'ws_board';

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
     VALUES (?, 'Board', 'board', '', '/tmp/metaclaude-board', '#000000', 'folder', '{}', 0, 0)`,
  ).run(WS);
  board = new BoardService(db);
});

afterEach(() => db.close());

const make = (title = 'A task', over: Record<string, unknown> = {}) =>
  board.create({ workspaceId: WS, title, createdBy: 'user:jules', ...over }, 'user:jules');

/* ------------------------------------------------------------------------ */
/* orderKeyBetween                                                           */
/* ------------------------------------------------------------------------ */

describe('orderKeyBetween', () => {
  it('always lands strictly between its bounds', () => {
    expect(orderKeyBetween(null, null)).toBe('i');
    const mid = orderKeyBetween('1', '2');
    expect(mid > '1' && mid < '2').toBe(true);
    const tight = orderKeyBetween('1i', '1i1');
    expect(tight > '1i' && tight < '1i1').toBe(true);
  });

  it('survives a thousand insertions at the same point without collapsing', () => {
    // Repeatedly inserting between the same neighbours is the worst case:
    // every new key must stay strictly ordered, however long they grow.
    let lower = orderKeyBetween(null, null);
    const upper = orderKeyBetween(lower, null);
    const keys = [lower, upper];
    for (let i = 0; i < 1000; i += 1) {
      const key = orderKeyBetween(lower, upper);
      expect(key > lower && key < upper).toBe(true);
      keys.push(key);
      lower = key;
    }
    const sorted = [...keys].sort();
    expect(sorted).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('appends upward forever without a ceiling', () => {
    let key = orderKeyBetween(null, null);
    for (let i = 0; i < 200; i += 1) {
      const next = orderKeyBetween(key, null);
      expect(next > key).toBe(true);
      key = next;
    }
  });

  it('refuses inverted bounds', () => {
    expect(() => orderKeyBetween('5', '3')).toThrow(BoardError);
    expect(() => orderKeyBetween('5', '5')).toThrow(BoardError);
  });
});

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------ */

describe('create', () => {
  it('lands new cards on top of their column, with a created event', () => {
    const first = make('first');
    const second = make('second');

    expect(second.orderKey < first.orderKey).toBe(true);
    expect(board.board(WS).map((task) => task.title)).toEqual(['second', 'first']);
    expect(board.activity(first.id).map((event) => event.kind)).toEqual(['created']);
  });

  it('refuses an unknown workspace, a foreign parent, and over-deep nesting', () => {
    expect(() =>
      board.create({ workspaceId: 'ws_ghost', title: 'x', createdBy: 'user:jules' }, 'user:jules'),
    ).toThrow(BoardError);

    const a = make('root');
    const b = make('child', { parentId: a.id });
    const c = make('grandchild', { parentId: b.id });
    expect(() => make('too deep', { parentId: c.id })).toThrow(/deep/i);

    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
       VALUES ('ws_other', 'Other', 'other', '', '/tmp/metaclaude-other', '#000000', 'folder', '{}', 0, 0)`,
    ).run();
    expect(() =>
      board.create(
        { workspaceId: 'ws_other', title: 'x', parentId: a.id, createdBy: 'user:jules' },
        'user:jules',
      ),
    ).toThrow(/parent/i);
  });
});

describe('move', () => {
  it('places a card after another and re-reads neighbours at move time', () => {
    const a = make('a');
    const b = make('b');
    const c = make('c');
    // Column order is [c, b, a] (new cards land on top).

    board.move(a.id, { status: 'todo', afterId: c.id }, 'user:jules');
    expect(board.board(WS).map((task) => task.title)).toEqual(['c', 'a', 'b']);

    board.move(b.id, { status: 'in_progress', afterId: null }, 'user:jules');
    const moved = board.get(b.id);
    expect(moved?.status).toBe('in_progress');
    expect(board.activity(b.id).at(-1)).toMatchObject({ kind: 'moved', detail: 'todo → in_progress' });
  });

  it('clears a block on movement — the reason described where it was stuck', () => {
    const task = make('stuck');
    board.update(task.id, { blockedReason: 'waiting on credentials' }, 'user:jules');

    const moved = board.move(task.id, { status: 'in_progress', afterId: null }, 'user:jules');
    expect(moved.blockedReason).toBeNull();
  });

  it('refuses a stale afterId and an archived card', () => {
    const a = make('a');
    const b = make('b');
    board.archive(b.id, 'user:jules');

    expect(() => board.move(a.id, { status: 'todo', afterId: b.id }, 'user:jules')).toThrow(/not in that column/i);
    expect(() => board.move(b.id, { status: 'done', afterId: null }, 'user:jules')).toThrow(/archived/i);
  });
});

describe('archive, restore, delete', () => {
  it('archives out of the board, restores into the same column, deletes only from the archive', () => {
    const task = make('ephemeral');
    board.move(task.id, { status: 'review', afterId: null }, 'user:jules');

    board.archive(task.id, 'user:jules');
    expect(board.board(WS)).toHaveLength(0);
    expect(() => board.delete(make('alive').id)).toThrow(/archive/i);

    const restored = board.restore(task.id, 'user:jules');
    expect(restored.status).toBe('review');
    expect(restored.archivedAt).toBeNull();

    board.archive(task.id, 'user:jules');
    board.delete(task.id);
    expect(board.get(task.id)).toBeNull();
  });
});

describe('comments and the trail', () => {
  it('records a comment, its event, and bumps the card', () => {
    const task = make('discussed');
    const before = board.get(task.id)?.updatedAt ?? 0;
    const comment = board.comment(task.id, 'agent:run_1', 'On it.');

    expect(board.comments(task.id)).toEqual([comment]);
    expect(board.activity(task.id).at(-1)).toMatchObject({ kind: 'commented', actor: 'agent:run_1' });
    expect((board.get(task.id)?.updatedAt ?? 0) >= before).toBe(true);
  });
});

describe('cascade', () => {
  it('a deleted workspace takes its whole board along', () => {
    const task = make('doomed');
    board.comment(task.id, 'user:jules', 'note');

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(WS);
    expect(board.get(task.id)).toBeNull();
    expect(board.comments(task.id)).toHaveLength(0);
    expect(board.activity(task.id)).toHaveLength(0);
  });
});
