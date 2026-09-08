/**
 * The migration that lets an extension reach several workspaces, and the one
 * property that makes it safe to run on a live deployment.
 *
 * `listSkills`, `listAgents` and `listMcpServers` decide what every run
 * mounts. Getting this migration wrong does not throw and does not fail a
 * test: it quietly gives a workspace tools it should not have, or takes away
 * tools it had, and the first symptom is an agent that cannot do something it
 * could do yesterday. So the test is not "the new tables exist" — it is that
 * **what every workspace sees is identical on both sides of the migration**,
 * checked against the old predicate spelled out here rather than remembered.
 *
 * The old rule, for the record: `workspace_id IS ? OR workspace_id IS NULL` —
 * a row belonged to one workspace, or to all of them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { MIGRATIONS } from '../db/schema.sql.js';
import { WorkspaceRepo } from '../kernel/repositories.js';
import { Registry } from './registry.js';
import { Vault } from '../security/vault.js';

/** Everything except the one under test, so the old shape can be seeded. */
const BEFORE = MIGRATIONS.filter((migration) => migration.name !== 'extension_workspace_attachments');
const ATTACHMENTS = MIGRATIONS.find(
  (migration) => migration.name === 'extension_workspace_attachments',
);

let db: Db;
let workspaces: WorkspaceRepo;

const makeWorkspace = (slug: string) =>
  workspaces.create({
    name: slug,
    slug,
    description: '',
    path: `/srv/metaclaude/workspaces/${slug}`,
    color: '#6366f1',
    icon: '',
    settings: JSON.parse('{}'),
  });

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
});

afterEach(() => db.close());

describe('the attachment migration', () => {
  it('is the last one, and is not skipped by the filter above', () => {
    // A guard on the test's own premise. If the migration were renamed, BEFORE
    // would silently be *every* migration and every case below would compare
    // the new world with itself — green, and proving nothing.
    expect(ATTACHMENTS).toBeTruthy();
    expect(BEFORE).toHaveLength(MIGRATIONS.length - 1);
  });

  /**
   * The case the whole file exists for. Seed the old shape, run the migration,
   * and require every workspace to see exactly what the old predicate said.
   */
  it('leaves every workspace seeing exactly what it saw before', () => {
    // The world as an older version wrote it.
    for (const migration of BEFORE) db.exec(migration.sql);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const beta = makeWorkspace('beta');

    const seed = (table: 'skills' | 'agents', id: string, home: string | null) =>
      table === 'skills'
        ? db
            .prepare(
              `INSERT INTO skills (id, workspace_id, name, description, body, category, enabled, auto_generated, created_at, updated_at)
               VALUES (?, ?, ?, '', '', 'general', 1, 0, 0, 0)`,
            )
            .run(id, home, id)
        : db
            .prepare(
              `INSERT INTO agents (id, workspace_id, name, description, prompt, category, tools, model, enabled, created_at, updated_at)
               VALUES (?, ?, ?, 'd', 'p', 'general', NULL, NULL, 1, 0, 0)`,
            )
            .run(id, home, id);

    const rows: Array<[string, string | null]> = [
      ['everywhere', null],
      ['alpha-only', alpha.id],
      ['beta-only', beta.id],
    ];
    for (const [id, home] of rows) {
      seed('skills', id, home);
      seed('agents', id, home);
    }

    /** The old rule, computed here rather than remembered. */
    const oldReach = (workspaceId: string) =>
      rows.filter(([, home]) => home === null || home === workspaceId).map(([id]) => id).sort();

    db.exec(ATTACHMENTS!.sql);
    const registry = new Registry(db, new Vault(db, Buffer.alloc(32)), () => {});

    for (const workspace of [alpha, beta]) {
      expect(
        registry.listSkills(workspace.id).map((one) => one.id).sort(),
        `skills for ${workspace.slug}`,
      ).toEqual(oldReach(workspace.id));
      expect(
        registry.listAgents(workspace.id).map((one) => one.id).sort(),
        `agents for ${workspace.slug}`,
      ).toEqual(oldReach(workspace.id));
    }
  });

  /**
   * The reach that the old column could not express, and the reason for the
   * lot: one extension, several workspaces, no copies.
   */
  it('lets one skill reach two workspaces and not a third', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const beta = makeWorkspace('beta');
    const gamma = makeWorkspace('gamma');

    db.prepare(
      `INSERT INTO skills (id, workspace_id, name, description, body, category, enabled, auto_generated, is_global, created_at, updated_at)
       VALUES ('shared', NULL, 'shared', '', '', 'general', 1, 0, 0, 0, 0)`,
    ).run();
    for (const id of [alpha.id, beta.id]) {
      db.prepare('INSERT INTO skill_workspaces (skill_id, workspace_id) VALUES (?, ?)').run(
        'shared',
        id,
      );
    }

    const registry = new Registry(db, new Vault(db, Buffer.alloc(32)), () => {});

    expect(registry.listSkills(alpha.id).map((one) => one.id)).toContain('shared');
    expect(registry.listSkills(beta.id).map((one) => one.id)).toContain('shared');
    expect(registry.listSkills(gamma.id).map((one) => one.id)).not.toContain('shared');
  });

  /**
   * Attached to nothing is a state of its own: it exists in the library and is
   * mounted nowhere. The old column had no way to say it — every row reached
   * at least one workspace.
   */
  it('mounts nowhere a skill attached to nothing', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');

    db.prepare(
      `INSERT INTO skills (id, workspace_id, name, description, body, category, enabled, auto_generated, is_global, created_at, updated_at)
       VALUES ('orphan', NULL, 'orphan', '', '', 'general', 1, 0, 0, 0, 0)`,
    ).run();

    const registry = new Registry(db, new Vault(db, Buffer.alloc(32)), () => {});

    expect(registry.listSkills(alpha.id).map((one) => one.id)).not.toContain('orphan');
    // Still in the library, which is the difference from having been deleted.
    expect(registry.listSkills().map((one) => one.id)).toContain('orphan');
  });

  /**
   * The bug this shape exists to make inexpressible. A token's `workspace_ids`
   * is a JSON list; it went on naming a deleted workspace, and the gateway
   * answered its caller that this Metaclaude had no workspaces at all. The fix
   * was a prune somebody has to remember to call. Two foreign keys are not.
   */
  it('forgets a deleted workspace by itself', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const doomed = makeWorkspace('doomed');

    db.prepare(
      `INSERT INTO skills (id, workspace_id, name, description, body, category, enabled, auto_generated, is_global, created_at, updated_at)
       VALUES ('s', NULL, 's', '', '', 'general', 1, 0, 0, 0, 0)`,
    ).run();
    db.prepare('INSERT INTO skill_workspaces (skill_id, workspace_id) VALUES (?, ?)').run(
      's',
      doomed.id,
    );

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(doomed.id);

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM skill_workspaces').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('forgets a deleted skill by itself, from the other side', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');

    db.prepare(
      `INSERT INTO skills (id, workspace_id, name, description, body, category, enabled, auto_generated, is_global, created_at, updated_at)
       VALUES ('s', NULL, 's', '', '', 'general', 1, 0, 0, 0, 0)`,
    ).run();
    db.prepare('INSERT INTO skill_workspaces (skill_id, workspace_id) VALUES (?, ?)').run(
      's',
      alpha.id,
    );

    db.prepare('DELETE FROM skills WHERE id = ?').run('s');

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM skill_workspaces').get() as { n: number },
    ).toEqual({ n: 0 });
  });
});

describe('setting the reach', () => {
  const registry = () => new Registry(db, new Vault(db, Buffer.alloc(32)), () => {});

  const aSkill = (workspaceId: string | null) =>
    registry().upsertSkill({
      workspaceId,
      name: 'thing',
      description: 'does a thing',
      body: '# thing',
    });

  it('replaces the set rather than adding to it', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const beta = makeWorkspace('beta');
    const skill = aSkill(alpha.id);

    registry().setReach('skills', skill.id, { global: false, workspaceIds: [beta.id] });

    const after = registry().getSkill(skill.id)!;
    // Replaced: alpha is gone. An add-only verb would leave a reach the
    // operator thought they had narrowed, which is the worst way to be wrong
    // about who can see a tool.
    expect(after.workspaceIds).toEqual([beta.id]);
    expect(after.isGlobal).toBe(false);
    expect(registry().listSkills(alpha.id).map((one) => one.id)).not.toContain(skill.id);
    expect(registry().listSkills(beta.id).map((one) => one.id)).toContain(skill.id);
  });

  it('makes it global, and drops the attachments that no longer decide anything', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const beta = makeWorkspace('beta');
    const skill = aSkill(alpha.id);

    registry().setReach('skills', skill.id, { global: true, workspaceIds: [alpha.id] });

    const after = registry().getSkill(skill.id)!;
    expect(after.isGlobal).toBe(true);
    // Kept would be a second source of truth for a question already answered.
    expect(after.workspaceIds).toEqual([]);
    expect(registry().listSkills(beta.id).map((one) => one.id)).toContain(skill.id);
  });

  it('accepts the empty set, which means nowhere', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const skill = aSkill(alpha.id);

    registry().setReach('skills', skill.id, { global: false, workspaceIds: [] });

    expect(registry().listSkills(alpha.id).map((one) => one.id)).not.toContain(skill.id);
    expect(registry().listSkills().map((one) => one.id)).toContain(skill.id);
  });

  it('ignores a workspace that does not exist rather than failing the save', () => {
    // The ids come from a form the operator had open while somebody else
    // deleted a workspace. Refusing the whole save would lose their edit over
    // a row that is already gone.
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const skill = aSkill(null);

    registry().setReach('skills', skill.id, {
      global: false,
      workspaceIds: [alpha.id, 'ws_vanished'],
    });

    expect(registry().getSkill(skill.id)!.workspaceIds).toEqual([alpha.id]);
  });

  it('reaches agents and MCP servers the same way', () => {
    migrate(db);
    workspaces = new WorkspaceRepo(db);
    const alpha = makeWorkspace('alpha');
    const beta = makeWorkspace('beta');

    const agent = registry().upsertAgent({
      workspaceId: null,
      name: 'helper',
      description: 'helps',
      prompt: 'help',
    });
    registry().setReach('agents', agent.id, { global: false, workspaceIds: [beta.id] });

    expect(registry().listAgents(alpha.id).map((one) => one.id)).not.toContain(agent.id);
    expect(registry().listAgents(beta.id).map((one) => one.id)).toContain(agent.id);
  });
});
