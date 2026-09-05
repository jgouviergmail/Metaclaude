/**
 * The system workspace — Metaclaude's own.
 *
 * What is worth testing is what makes it *system*: that it exists exactly once
 * however many times the server boots, that its safety settings cannot drift,
 * that the knowledge written into it is regenerated while the operator's own
 * notes are not, and that the guard the routes lean on refuses precisely the
 * changes that would let the agent widen its own reach.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kvGet, migrate, openDatabase, type Db } from '../db/index.js';
import { WorkspaceRepo } from '../kernel/repositories.js';
import {
  SYSTEM_WORKSPACE_KEY,
  SYSTEM_WORKSPACE_SAFETY,
  SystemWorkspace,
  SystemWorkspaceError,
} from './system-workspace.js';

let db: Db;
let repo: WorkspaceRepo;
let root: string;
let docs: string;
let sources: string;
let logged: string[];

function make(overrides: Partial<ConstructorParameters<typeof SystemWorkspace>[0]> = {}) {
  return new SystemWorkspace({
    db,
    workspaces: repo,
    workspacesRoot: root,
    docsDir: docs,
    sourceRoot: sources,
    version: '9.9.9',
    language: () => 'fr',
    preapproved: () => ['mcp__metaclaude_system__system_overview'],
    log: (_level, message) => logged.push(message),
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  repo = new WorkspaceRepo(db);
  root = mkdtempSync(join(tmpdir(), 'mc-sysws-'));
  docs = mkdtempSync(join(tmpdir(), 'mc-docs-'));
  writeFileSync(join(docs, 'ARCHITECTURE.md'), '# Architecture\n', 'utf8');
  mkdirSync(join(docs, 'guide'));
  writeFileSync(join(docs, 'guide', '01-getting-started.md'), '# Start\n', 'utf8');
  // A repository root the way `findSourceRoot` finds one: two of the trees
  // and the developers' CLAUDE.md; the web tree deliberately absent.
  sources = mkdtempSync(join(tmpdir(), 'mc-src-'));
  mkdirSync(join(sources, 'apps', 'api', 'src', 'kernel'), { recursive: true });
  writeFileSync(join(sources, 'apps', 'api', 'src', 'index.ts'), 'export {};\n', 'utf8');
  writeFileSync(join(sources, 'apps', 'api', 'src', 'kernel', 'kernel.ts'), '// the kernel\n', 'utf8');
  mkdirSync(join(sources, 'packages', 'shared', 'src'), { recursive: true });
  writeFileSync(join(sources, 'packages', 'shared', 'src', 'domain.ts'), '// contracts\n', 'utf8');
  writeFileSync(join(sources, 'CLAUDE.md'), '# Repo\n\nEvery push to main bumps the version.\n', 'utf8');
  mkdirSync(join(sources, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(sources, 'node_modules', 'left-pad', 'index.js'), '', 'utf8');
  logged = [];
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(docs, { recursive: true, force: true });
  rmSync(sources, { recursive: true, force: true });
});

describe('ensure', () => {
  it('creates the workspace once, remembers it, and fixes its safety settings', async () => {
    const workspace = await make().ensure();

    expect(workspace.name).toBe('Metaclaude');
    expect(kvGet(db, SYSTEM_WORKSPACE_KEY, null)).toBe(workspace.id);
    expect(workspace.settings.defaultPermissionMode).toBe('default');
    expect(workspace.settings.disallowedTools).toEqual(SYSTEM_WORKSPACE_SAFETY.disallowedTools);
    expect(workspace.settings.additionalDirectories).toEqual([]);
    expect(workspace.settings.allowedTools).toEqual(['mcp__metaclaude_system__system_overview']);
    expect(existsSync(workspace.path)).toBe(true);
  });

  it('is idempotent across boots', async () => {
    const first = await make().ensure();
    const second = await make().ensure();

    expect(second.id).toBe(first.id);
    expect(repo.list(true)).toHaveLength(1);
  });

  /**
   * A row can disappear under the recorded id — a hand edit, a restore from
   * an older backup. The next boot must recreate rather than serve a workspace
   * that does not exist to every route that asks for it.
   */
  it('recreates the workspace when the remembered row is gone', async () => {
    const first = await make().ensure();
    repo.delete(first.id);

    const second = await make().ensure();

    expect(second.id).not.toBe(first.id);
    expect(kvGet(db, SYSTEM_WORKSPACE_KEY, null)).toBe(second.id);
  });

  /** The reverse: the row is gone but its directory is still on the volume. */
  it('reuses a directory that already exists rather than refusing to boot', async () => {
    const first = await make().ensure();
    writeFileSync(join(first.path, 'leftover.txt'), 'kept', 'utf8');
    repo.delete(first.id);

    const second = await make().ensure();

    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'leftover.txt'))).toBe(true);
  });

  it('yields on the slug when an operator already owns it', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('ws_theirs', 'Their Metaclaude', 'metaclaude', resolve(root, 'metaclaude'), now, now);

    const workspace = await make().ensure();

    expect(workspace.slug).toBe('metaclaude-2');
    expect(workspace.id).not.toBe('ws_theirs');
  });

  /**
   * The safety settings are re-asserted on every boot. Two things move them
   * otherwise: an upgrade that adds tools to the pre-approved list, and a
   * write straight to the database. Neither may leave the agent with a shell.
   */
  it('re-applies drifted safety settings on the next boot', async () => {
    const workspace = await make().ensure();
    repo.update(workspace.id, {
      settings: { disallowedTools: [], defaultPermissionMode: 'bypassPermissions', allowedTools: [] },
    });

    const again = await make().ensure();

    expect(again.settings.disallowedTools).toEqual(SYSTEM_WORKSPACE_SAFETY.disallowedTools);
    expect(again.settings.defaultPermissionMode).toBe('default');
    expect(again.settings.allowedTools).toEqual(['mcp__metaclaude_system__system_overview']);
  });

  /**
   * The mode is the operator's. For three releases it was re-asserted to
   * `default` at every boot beside the tool lists, which made the steward
   * unable to be autonomous by anyone's choice: the operator's *Don't ask*
   * survived until the next restart. Only bypass is put back.
   */
  it('keeps the operator’s permission mode across boots, bypass excepted', async () => {
    const workspace = await make().ensure();
    repo.update(workspace.id, { settings: { defaultPermissionMode: 'dontAsk' } });

    const again = await make().ensure();

    expect(again.settings.defaultPermissionMode).toBe('dontAsk');
    expect(logged).not.toContain('system workspace safety settings had drifted — re-applied');
  });

  it('picks up a grown tool catalogue on the next boot', async () => {
    await make().ensure();

    const again = await make({
      preapproved: () => ['mcp__metaclaude_system__system_overview', 'mcp__metaclaude_system__system_workspaces'],
    }).ensure();

    expect(again.settings.allowedTools).toHaveLength(2);
  });

  it('leaves the settings an operator may change alone', async () => {
    const workspace = await make().ensure();
    repo.update(workspace.id, { name: 'Le Second', settings: { language: 'en', defaultModel: 'haiku' } });

    const again = await make().ensure();

    expect(again.name).toBe('Le Second');
    expect(again.settings.language).toBe('en');
    expect(again.settings.defaultModel).toBe('haiku');
  });
});

describe('what it writes into the workspace', () => {
  it('generates CLAUDE.md and SYSTEM-MAP.md, and copies the documentation', async () => {
    const workspace = await make().ensure();

    const claude = readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('9.9.9');
    expect(claude).toContain('mcp__metaclaude_system__system_overview');
    expect(claude).toContain('French');
    // What it may remember, and that a changed fact is replaced rather than annotated.
    expect(claude).toContain('## What you remember');
    expect(claude).toContain('supersedes');
    expect(existsSync(join(workspace.path, 'SYSTEM-MAP.md'))).toBe(true);
    expect(readFileSync(join(workspace.path, 'docs', 'ARCHITECTURE.md'), 'utf8')).toContain('Architecture');
    expect(existsSync(join(workspace.path, 'docs', 'guide', '01-getting-started.md'))).toBe(true);
  });

  /**
   * CLAUDE.md is the system's and is rewritten on every boot; NOTES.md is the
   * operator's and is never touched once it exists. The first is what makes
   * "updated with every release" true by construction; the second is what
   * makes it safe to write anything down in there.
   */
  it('rewrites CLAUDE.md every boot and never touches NOTES.md', async () => {
    const workspace = await make().ensure();
    writeFileSync(join(workspace.path, 'CLAUDE.md'), 'stale', 'utf8');
    writeFileSync(join(workspace.path, 'NOTES.md'), 'my own notes', 'utf8');

    await make({ version: '10.0.0' }).ensure();

    expect(readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8')).toContain('10.0.0');
    expect(readFileSync(join(workspace.path, 'NOTES.md'), 'utf8')).toBe('my own notes');
  });

  it('creates an empty NOTES.md the first time so the import has something to find', async () => {
    const workspace = await make().ensure();

    expect(existsSync(join(workspace.path, 'NOTES.md'))).toBe(true);
    expect(readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8')).toContain('@NOTES.md');
  });

  /**
   * The instructions and the pre-approval list come from one table. Listed
   * by ring with a line each, so the agent reads what a tool does — and
   * whether calling it is a read or a change — without a probe call.
   */
  it('lists the tools by ring with their descriptions when the catalogue is known', async () => {
    const workspace = await make({
      preapproved: () => ['mcp__metaclaude_system__system_overview', 'mcp__metaclaude_system__system_run_start'],
      tools: () => [
        { name: 'mcp__metaclaude_system__system_overview', ring: 1, description: 'Where things stand.' },
        { name: 'mcp__metaclaude_system__system_run_start', ring: 2, description: 'Start a run elsewhere.' },
      ],
    }).ensure();

    const claude = readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8');
    const ring1 = claude.indexOf('### Ring 1');
    const ring2 = claude.indexOf('### Ring 2');
    expect(ring1).toBeGreaterThan(0);
    expect(ring2).toBeGreaterThan(ring1);
    expect(claude.indexOf('system_overview` — Where things stand.')).toBeGreaterThan(ring1);
    expect(claude.indexOf('system_run_start` — Start a run elsewhere.')).toBeGreaterThan(ring2);
    expect(readFileSync(join(workspace.path, 'SYSTEM-MAP.md'), 'utf8')).toContain('2 (1 read, 1 reversible)');
  });

  /**
   * The catalogue is not one server's: the board and proposal tools are
   * pre-approved beside the system ones, and the instructions must say so in
   * the same list — a tool the agent believes opens a card is a tool it
   * asks the operator about instead of using.
   */
  it('lists tools from several servers in the same rings, and tells the agent what still asks', async () => {
    const workspace = await make({
      preapproved: () => [
        'mcp__metaclaude_system__system_overview',
        'mcp__metaclaude_board__board_list',
        'mcp__metaclaude_board__board_create',
        'mcp__metaclaude_advisor__advisor_propose_skill',
      ],
      tools: () => [
        { name: 'mcp__metaclaude_system__system_overview', ring: 1, description: 'Where things stand.' },
        { name: 'mcp__metaclaude_board__board_list', ring: 1, description: 'The cards.' },
        { name: 'mcp__metaclaude_board__board_create', ring: 2, description: 'Add a card.' },
        { name: 'mcp__metaclaude_advisor__advisor_propose_skill', ring: 2, description: 'Propose a skill.' },
      ],
    }).ensure();

    const claude = readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8');
    const ring1 = claude.indexOf('### Ring 1');
    const ring2 = claude.indexOf('### Ring 2');
    expect(claude.indexOf('board_list` — The cards.')).toBeGreaterThan(ring1);
    expect(claude.indexOf('board_list` — The cards.')).toBeLessThan(ring2);
    expect(claude.indexOf('board_create` — Add a card.')).toBeGreaterThan(ring2);
    expect(claude.indexOf('advisor_propose_skill` — Propose a skill.')).toBeGreaterThan(ring2);
    expect(claude).toContain('`WebFetch`');
    expect(claude).toContain('filing, moving, annotating or breaking down a card');
    expect(readFileSync(join(workspace.path, 'SYSTEM-MAP.md'), 'utf8')).toContain('4 (2 read, 2 reversible)');
  });

  it('copes with no documentation and no sources shipped, as in a bare image', async () => {
    const workspace = await make({ docsDir: null, sourceRoot: null }).ensure();

    expect(existsSync(join(workspace.path, 'docs'))).toBe(false);
    expect(existsSync(join(workspace.path, 'code'))).toBe(false);
    expect(existsSync(join(workspace.path, 'CLAUDE.md'))).toBe(true);
    const claude = readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8');
    expect(claude).not.toContain('docs/ARCHITECTURE.md');
    // No invented path either: a pointer to code that is not there is worse than none.
    expect(claude).not.toContain('`code/`');
  });

  /**
   * The steward cannot be granted an extra directory — its reach is bounded
   * to the workspaces root like everyone's — so the code it runs is copied
   * *into* its workspace, the trees `SOURCE_TREES` names and nothing around
   * them. The repository's CLAUDE.md comes along renamed: under its own name
   * the CLI would load it as instructions.
   */
  it('copies the source trees into code/, renames the developers’ CLAUDE.md, and skips what is not there', async () => {
    const workspace = await make().ensure();

    const code = join(workspace.path, 'code');
    expect(readFileSync(join(code, 'apps', 'api', 'src', 'kernel', 'kernel.ts'), 'utf8')).toBe('// the kernel\n');
    expect(existsSync(join(code, 'packages', 'shared', 'src', 'domain.ts'))).toBe(true);
    expect(existsSync(join(code, 'apps', 'web'))).toBe(false);
    expect(existsSync(join(code, 'node_modules'))).toBe(false);
    expect(existsSync(join(code, 'CLAUDE.md'))).toBe(false);
    expect(readFileSync(join(code, 'REPOSITORY-CLAUDE.md'), 'utf8')).toContain('bumps the version');

    const claude = readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('`code/` — the TypeScript sources');
    expect(claude).toContain('REPOSITORY-CLAUDE.md');
  });

  it('replaces code/ whole at every boot, so a file a release removed is gone', async () => {
    const first = await make().ensure();
    const stale = join(first.path, 'code', 'apps', 'api', 'src', 'removed.ts');
    writeFileSync(stale, 'gone next release', 'utf8');

    await make().ensure();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(first.path, 'code', 'apps', 'api', 'src', 'index.ts'))).toBe(true);
  });

  it('writes nothing under code/ when the root holds none of the trees, and removes a previous copy', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mc-nosrc-'));
    try {
      const first = await make().ensure();
      expect(existsSync(join(first.path, 'code', 'apps', 'api', 'src', 'index.ts'))).toBe(true);

      const workspace = await make({ sourceRoot: empty }).ensure();

      // Last release's code is not this release's code: gone, not left to be read as current.
      expect(existsSync(join(workspace.path, 'code'))).toBe(false);
      expect(readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8')).not.toContain('`code/`');

      await make({ sourceRoot: null }).ensure();
      expect(existsSync(join(workspace.path, 'code'))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('says nothing about language when neither setting has an opinion', async () => {
    const workspace = await make({ language: () => null }).ensure();

    expect(readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8')).not.toMatch(/French|English/);
  });

  /**
   * Same rule as `materialiseSkills`: a symlinked workspace directory would
   * point every write here at the link's target. Declining, not throwing — a
   * system workspace that cannot be furnished must not stop the boot.
   */
  it('refuses to write through a symlink, and still returns the workspace', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'mc-elsewhere-'));
    try {
      const first = await make().ensure();
      rmSync(first.path, { recursive: true, force: true });
      symlinkSync(elsewhere, first.path, 'dir');

      const again = await make().ensure();

      expect(again.id).toBe(first.id);
      expect(existsSync(join(elsewhere, 'CLAUDE.md'))).toBe(false);
      expect(logged.some((line) => /symlink/i.test(line))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('the guard the routes lean on', () => {
  it('knows its own workspace', async () => {
    const system = make();
    const workspace = await system.ensure();
    const other = repo.create({
      name: 'Other', slug: 'other', description: '', path: resolve(root, 'other'),
      color: '#000000', icon: 'folder', settings: workspace.settings,
    });

    expect(system.isSystem(workspace.id)).toBe(true);
    expect(system.isSystem(other.id)).toBe(false);
    expect(system.id()).toBe(workspace.id);
  });

  it('refuses to archive or delete the system workspace', async () => {
    const system = make();
    const workspace = await system.ensure();

    expect(() => system.guard(workspace.id, { archived: true })).toThrow(SystemWorkspaceError);
    expect(() => system.guardDelete(workspace.id)).toThrow(SystemWorkspaceError);
    // Un-archiving is harmless and never reachable anyway.
    expect(() => system.guard(workspace.id, { archived: false })).not.toThrow();
  });

  /**
   * The four settings that decide what the agent can reach. Changing any of
   * them from the interface would let a compromised or merely confused agent
   * talk the operator into handing it a shell; changing them from the agent's
   * own tools is refused one layer down for the same reason.
   */
  it('refuses the safety settings and allows everything else', async () => {
    const system = make();
    const workspace = await system.ensure();

    for (const settings of [
      { defaultPermissionMode: 'bypassPermissions' as const },
      { allowedTools: ['Bash'] },
      { disallowedTools: [] },
      { additionalDirectories: ['/srv/metaclaude/workspaces/other'] },
    ]) {
      expect(() => system.guard(workspace.id, { settings })).toThrow(SystemWorkspaceError);
    }

    expect(() =>
      system.guard(workspace.id, {
        name: 'Renamed',
        description: 'x',
        settings: { language: 'en', memoryEnabled: false, defaultModel: 'sonnet' },
      }),
    ).not.toThrow();
    // Every mode short of bypass is the operator's to choose: it decides how
    // much they are asked, never what the agent can reach.
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'] as const) {
      expect(() => system.guard(workspace.id, { settings: { defaultPermissionMode: mode } })).not.toThrow();
    }
  });

  /**
   * The settings form sends every setting back, changed or not. A guard on
   * presence would refuse the operator's language change because the fixed
   * lists rode along with it; only a *different* value is a change.
   */
  it('lets the fixed settings through unchanged, as a form that round-trips them does', async () => {
    const system = make();
    const workspace = await system.ensure();

    expect(() =>
      system.guard(workspace.id, { settings: { ...workspace.settings, language: 'en' } }),
    ).not.toThrow();
    expect(() =>
      system.guard(workspace.id, { settings: { ...workspace.settings, disallowedTools: ['Bash'] } }),
    ).toThrow(SystemWorkspaceError);
  });

  it('never interferes with an ordinary workspace', async () => {
    const system = make();
    await system.ensure();

    expect(() => system.guard('ws_other', { archived: true, settings: { allowedTools: ['Bash'] } })).not.toThrow();
    expect(() => system.guardDelete('ws_other')).not.toThrow();
  });

  it('answers 409, the status a refused change deserves', async () => {
    const system = make();
    const workspace = await system.ensure();

    try {
      system.guardDelete(workspace.id);
    } catch (error) {
      expect((error as SystemWorkspaceError).statusCode).toBe(409);
    }
  });
});
