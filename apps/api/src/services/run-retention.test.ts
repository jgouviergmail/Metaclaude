/**
 * Dropping runs old enough that nobody will read them again.
 *
 * The only sweep in this system that destroys something an operator wrote, so
 * every guard is asserted rather than assumed: a run still in flight is never
 * touched, a quiet workspace is never emptied, and the files on disk go with
 * the rows.
 *
 * That last one is the trap. `attachments.run_id` is `ON DELETE CASCADE`, so a
 * plain `DELETE FROM runs` takes the attachment *rows* and leaves their bytes
 * on the volume forever — the unlink lives in application code and no SQL
 * cascade ever reaches it. Written naïvely, this feature fixes a leak of rows
 * by creating a leak of files.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunPolicy, WorkspaceSettings } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { AttachmentService } from './attachments.js';
import { RunRetention } from './run-retention.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let db: Db;
let workspaces: WorkspaceRepo;
let sessions: SessionRepo;
let runs: RunRepo;
let attachments: AttachmentService;
let root: string;
let workspaceId: string;
let sessionId: string;

/** A finished run, `ageDays` old. */
function finishedRun(ageDays: number, workspace = workspaceId, session = sessionId): string {
  const at = NOW - ageDays * DAY;
  const run = runs.create({ sessionId: session, workspaceId: workspace, prompt: 'p', policy: RunPolicy.parse({ model: 'default', effort: null, permissionMode: 'default', thinking: 'adaptive', thinkingBudgetTokens: null, agentName: null, source: 'explicit' }), triggeredBy: 'user' });
  db.prepare('UPDATE runs SET status = ?, started_at = ?, finished_at = ? WHERE id = ?')
    .run('succeeded', at, at, run.id);
  return run.id;
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  root = await mkdtemp(join(tmpdir(), 'mc-retention-'));
  workspaces = new WorkspaceRepo(db);
  sessions = new SessionRepo(db);
  runs = new RunRepo(db);
  attachments = new AttachmentService(db);

  const workspace = workspaces.create({
    name: 'Alpha',
    slug: 'alpha',
    description: '',
    path: root,
    color: 'indigo',
    icon: 'folder',
    settings: WorkspaceSettings.parse({}),
  });
  workspaceId = workspace.id;
  sessionId = sessions.create({ workspaceId, title: 'S', model: 'default', effort: null, permissionMode: 'default' }).id;
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

function retention(overrides: Partial<ConstructorParameters<typeof RunRetention>[0]> = {}) {
  return new RunRetention({
    db,
    attachments,
    retentionDays: 90,
    keepPerWorkspace: 3,
    now: () => NOW,
    ...overrides,
  });
}

describe('what it removes', () => {
  it('drops runs past the window, and the floor decides how many that is', async () => {
    // Five runs, four of them past the 90-day window. The floor keeps the
    // newest three overall — 10, 100 and 120 days — so only the two oldest
    // are actually past *both* conditions. The window alone would have taken
    // four; the floor is what makes this conservative.
    const old = [finishedRun(200), finishedRun(150), finishedRun(120), finishedRun(100)];
    const recent = finishedRun(10);

    expect(await retention().sweep()).toBe(2);
    expect(runs.get(recent)).not.toBeNull();
    expect(old.filter((id) => runs.get(id) !== null)).toHaveLength(2);
  });

  it('never empties a quiet workspace, however old everything in it is', async () => {
    const ids = [finishedRun(900), finishedRun(800), finishedRun(700)];

    expect(await retention().sweep()).toBe(0);
    expect(ids.every((id) => runs.get(id) !== null)).toBe(true);
  });

  it('counts the floor per workspace, not across the whole database', async () => {
    const other = workspaces.create({ name: 'Beta', slug: 'beta', description: '', path: root, color: 'indigo', icon: 'folder', settings: WorkspaceSettings.parse({}) });
    const otherSession = sessions.create({ workspaceId: other.id, title: 'S', model: 'default', effort: null, permissionMode: 'default' }).id;

    for (let i = 0; i < 5; i += 1) finishedRun(300);
    const quiet = finishedRun(300, other.id, otherSession);

    await retention().sweep();

    // Beta had one run and keeps it; Alpha keeps its newest three.
    expect(runs.get(quiet)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?').get(workspaceId)).toEqual({ n: 3 });
  });

  it('takes the transcript with the run', async () => {
    const doomed = finishedRun(400);
    for (let i = 0; i < 4; i += 1) finishedRun(1);
    db.prepare(
      'INSERT INTO transcript_events (id, run_id, session_id, seq, kind, at, payload) VALUES (?,?,?,?,?,?,?)',
    ).run('te_1', doomed, sessionId, 1, 'text', NOW, '{}');

    await retention().sweep();

    expect(runs.get(doomed)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_events').get()).toEqual({ n: 0 });
  });
});

describe('what it refuses to touch', () => {
  it('leaves a run that has not finished, whatever its age', async () => {
    // A queued run started long ago is a stuck run, not a historical one —
    // and deleting it would leave the kernel holding a reservation for a row
    // that no longer exists.
    for (const status of ['queued', 'running', 'waiting_approval'] as const) {
      const run = runs.create({ sessionId, workspaceId, prompt: 'p', policy: RunPolicy.parse({ model: 'default', effort: null, permissionMode: 'default', thinking: 'adaptive', thinkingBudgetTokens: null, agentName: null, source: 'explicit' }), triggeredBy: 'user' });
      db.prepare('UPDATE runs SET status = ?, started_at = ? WHERE id = ?')
        .run(status, NOW - 900 * DAY, run.id);
    }
    for (let i = 0; i < 4; i += 1) finishedRun(500);

    await retention().sweep();

    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','waiting_approval')").get())
      .toEqual({ n: 3 });
  });

  it('leaves the session standing, because it carries the id that resumes it', async () => {
    for (let i = 0; i < 5; i += 1) finishedRun(400);

    await retention().sweep();

    expect(sessions.get(sessionId)).not.toBeNull();
  });

  it('does nothing at all when retention is switched off', async () => {
    const ids = [finishedRun(900), finishedRun(900), finishedRun(900), finishedRun(900)];

    expect(await retention({ retentionDays: 0 }).sweep()).toBe(0);
    expect(ids.every((id) => runs.get(id) !== null)).toBe(true);
  });
});

describe('the attachments trap', () => {
  it('deletes the file, not only the row the cascade would take', async () => {
    const doomed = finishedRun(400);
    for (let i = 0; i < 4; i += 1) finishedRun(1);

    await writeFile(join(root, 'evidence.txt'), 'bytes');
    db.prepare(
      `INSERT INTO attachments (id, workspace_id, session_id, run_id, name, path, mime, bytes, sha256, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('att_1', workspaceId, sessionId, doomed, 'evidence.txt', 'evidence.txt', 'text/plain', 5, 'x', NOW);

    await retention().sweep();

    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
    expect(await readdir(root)).not.toContain('evidence.txt');
  });

  it('keeps a file two runs share until the last of them goes', async () => {
    // Deduplication by hash means one file can be named by several rows. The
    // unlink has to be the *last* row's business, not the first's.
    const doomed = finishedRun(400);
    const kept = finishedRun(1);
    for (let i = 0; i < 3; i += 1) finishedRun(1);

    await writeFile(join(root, 'shared.txt'), 'bytes');
    for (const [id, run] of [['att_a', doomed], ['att_b', kept]] as const) {
      db.prepare(
        `INSERT INTO attachments (id, workspace_id, session_id, run_id, name, path, mime, bytes, sha256, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, workspaceId, sessionId, run, 'shared.txt', 'shared.txt', 'text/plain', 5, 'h', NOW);
    }

    await retention().sweep();

    expect(await readdir(root)).toContain('shared.txt');
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 1 });
  });

  it('still removes the run when its file is already gone from disk', async () => {
    const doomed = finishedRun(400);
    for (let i = 0; i < 4; i += 1) finishedRun(1);
    db.prepare(
      `INSERT INTO attachments (id, workspace_id, session_id, run_id, name, path, mime, bytes, sha256, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('att_1', workspaceId, sessionId, doomed, 'missing.txt', 'missing.txt', 'text/plain', 5, 'x', NOW);

    expect(await retention().sweep()).toBe(1);
    expect(runs.get(doomed)).toBeNull();
  });
});
