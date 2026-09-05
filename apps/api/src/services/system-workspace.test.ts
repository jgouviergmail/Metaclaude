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
let logged: string[];

function make(overrides: Partial<ConstructorParameters<typeof SystemWorkspace>[0]> = {}) {
  return new SystemWorkspace({
    db,
    workspaces: repo,
    workspacesRoot: root,
    docsDir: docs,
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
  logged = [];
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(docs, { recursive: true, force: true });
});

describe('ensure', () => {
  it('creates the workspace once, remembers it, and fixes its safety settings', async () => {
    const workspace = await make().ensure();

    expect(workspace.name).toBe('Metaclaude');
    expect(kvGet(db, SYSTEM_WORKSPACE_KEY, null)).toBe(workspace.id);
    expect(workspace.settings.defaultPermissionMode).toBe(SYSTEM_WORKSPACE_SAFETY.defaultPermissionMode);
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

  it('copes with no documentation shipped, as in a bare dev checkout', async () => {
    const workspace = await make({ docsDir: null }).ensure();

    expect(existsSync(join(workspace.path, 'docs'))).toBe(false);
    expect(existsSync(join(workspace.path, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(workspace.path, 'CLAUDE.md'), 'utf8')).not.toContain('docs/ARCHITECTURE.md');
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
      { defaultPermissionMode: 'auto' as const },
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
