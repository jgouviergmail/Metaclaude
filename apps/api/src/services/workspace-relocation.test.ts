/**
 * Moving the workspaces root under a live database.
 *
 * `workspaces.path` is derived — `resolve(workspacesRoot, slug)` at creation,
 * never updated afterwards — so changing `METACLAUDE_WORKSPACES_DIR` on a
 * deployment that already has workspaces leaves every row pointing at an
 * address that no longer exists. Nothing crashes; the workspaces simply stop
 * working, one guard at a time, and the failure reads as data loss.
 *
 * That is not hypothetical: the shipped layout moved once, from
 * `/var/lib/metaclaude/workspaces` to `/srv/metaclaude/workspaces`, and the
 * named volume follows the mount while the rows do not.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { defaultWorkspaceSettings, WorkspaceRepo } from '../kernel/repositories.js';
import { relocateWorkspaces } from './workspaces.js';

let db: Db;
let repo: WorkspaceRepo;
let tmp = '';

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  repo = new WorkspaceRepo(db);
  tmp = await mkdtemp(join(tmpdir(), 'mc-relocate-'));
});

afterEach(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

function seed(slug: string, path: string) {
  return repo.create({
    name: slug,
    slug,
    description: '',
    path,
    color: '#6366f1',
    icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });
}

describe('relocateWorkspaces', () => {
  it('rewrites a row whose directory no longer sits under the configured root', async () => {
    const oldRoot = join(tmp, 'var', 'lib', 'metaclaude', 'workspaces');
    const newRoot = join(tmp, 'srv', 'metaclaude', 'workspaces');
    await mkdir(join(newRoot, 'alpha'), { recursive: true });

    const before = seed('alpha', join(oldRoot, 'alpha'));

    const report = relocateWorkspaces(repo, newRoot);

    expect(report.moved).toEqual([
      { slug: 'alpha', from: join(oldRoot, 'alpha'), to: join(newRoot, 'alpha'), present: true },
    ]);
    expect(report.skipped).toEqual([]);
    expect(repo.get(before.id)?.path).toBe(join(newRoot, 'alpha'));
  });

  it('leaves a row that is already under the root alone', () => {
    const root = join(tmp, 'workspaces');
    const before = seed('alpha', join(root, 'alpha'));

    const report = relocateWorkspaces(repo, root);

    expect(report).toEqual({ moved: [], skipped: [] });
    expect(repo.get(before.id)?.updatedAt).toBe(before.updatedAt);
  });

  /**
   * `updated_at` orders the workspace list. A relocation is not an edit anyone
   * made, so a boot that migrates four workspaces must not reshuffle the
   * sidebar into migration order.
   */
  it('does not touch updated_at', async () => {
    const newRoot = join(tmp, 'workspaces');
    await mkdir(join(newRoot, 'alpha'), { recursive: true });
    const before = seed('alpha', join(tmp, 'elsewhere', 'alpha'));

    relocateWorkspaces(repo, newRoot);

    expect(repo.get(before.id)?.updatedAt).toBe(before.updatedAt);
  });

  /**
   * The rewrite is only safe because the target is derived from the slug, which
   * is unique. A row whose directory is *not* named after its slug came from
   * somewhere this code has never written, so guessing where it moved to would
   * be inventing an answer.
   */
  it('refuses to guess for a row whose directory is not named after its slug', () => {
    const newRoot = join(tmp, 'workspaces');
    const before = seed('alpha', '/mnt/somewhere/hand-placed');

    const report = relocateWorkspaces(repo, newRoot);

    expect(report.moved).toEqual([]);
    expect(report.skipped).toEqual([{ slug: 'alpha', path: '/mnt/somewhere/hand-placed' }]);
    expect(repo.get(before.id)?.path).toBe('/mnt/somewhere/hand-placed');
  });

  /**
   * A path outside the root is unusable either way — every guard in
   * WorkspaceService refuses it — so the rewrite still happens when the files
   * were not carried across. `present: false` is what tells the operator to go
   * and look for them.
   */
  it('reports a move whose target directory is missing rather than skipping it', () => {
    const newRoot = join(tmp, 'workspaces');
    const before = seed('alpha', join(tmp, 'old', 'alpha'));

    const report = relocateWorkspaces(repo, newRoot);

    expect(report.moved).toEqual([
      { slug: 'alpha', from: join(tmp, 'old', 'alpha'), to: join(newRoot, 'alpha'), present: false },
    ]);
    expect(repo.get(before.id)?.path).toBe(join(newRoot, 'alpha'));
  });

  it('includes archived workspaces', async () => {
    const newRoot = join(tmp, 'workspaces');
    await mkdir(join(newRoot, 'alpha'), { recursive: true });
    const before = seed('alpha', join(tmp, 'old', 'alpha'));
    repo.update(before.id, { archived: true });

    const report = relocateWorkspaces(repo, newRoot);

    expect(report.moved).toHaveLength(1);
    expect(repo.get(before.id)?.path).toBe(join(newRoot, 'alpha'));
  });

  /**
   * The mixed case is the real one: a deployment that moved its root has some
   * rows to fix, and — once it has restarted a second time — some already
   * fixed. Every stale row must be reached whatever order they come back in.
   */
  it('relocates every stale row in one pass, leaving the settled ones', async () => {
    const newRoot = join(tmp, 'workspaces');
    await mkdir(join(newRoot, 'beta'), { recursive: true });

    const settled = seed('alpha', join(newRoot, 'alpha'));
    const stale = seed('beta', join(tmp, 'old', 'beta'));
    const unknown = seed('gamma', '/mnt/elsewhere/hand-placed');
    const stale2 = seed('delta', join(tmp, 'old', 'delta'));

    const report = relocateWorkspaces(repo, newRoot);

    expect(report.moved.map((m) => m.slug).sort()).toEqual(['beta', 'delta']);
    expect(report.skipped).toEqual([{ slug: 'gamma', path: '/mnt/elsewhere/hand-placed' }]);
    expect(repo.get(settled.id)?.path).toBe(join(newRoot, 'alpha'));
    expect(repo.get(stale.id)?.path).toBe(join(newRoot, 'beta'));
    expect(repo.get(stale2.id)?.path).toBe(join(newRoot, 'delta'));
    expect(repo.get(unknown.id)?.path).toBe('/mnt/elsewhere/hand-placed');
  });

  /** Restarting again must be a no-op, not a second round of writes. */
  it('is idempotent', async () => {
    const newRoot = join(tmp, 'workspaces');
    await mkdir(join(newRoot, 'alpha'), { recursive: true });
    seed('alpha', join(tmp, 'old', 'alpha'));

    expect(relocateWorkspaces(repo, newRoot).moved).toHaveLength(1);
    expect(relocateWorkspaces(repo, newRoot)).toEqual({ moved: [], skipped: [] });
  });
});
