/**
 * Plugins reaching an actual run.
 *
 * A plugin that is installed, listed and contributes nothing is a database
 * row. These are the two seams where it becomes real: the MCP servers handed
 * to the CLI, and the skill directories written into the workspace before the
 * run that will use them.
 *
 * They go through the existing Registry rather than a second path of their
 * own — one materialiser, one resolver, plugins as another source feeding both.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL, type Workspace } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { defaultWorkspaceSettings, WorkspaceRepo } from '../kernel/repositories.js';
import { Vault } from '../security/vault.js';
import { randomBytes } from 'node:crypto';
import { PluginRegistry } from './plugin-registry.js';
import { Registry } from './registry.js';

let db: Db;
let plugins: PluginRegistry;
let registry: Registry;
let workspace: Workspace;
let pluginsDir = '';
let sourceDir = '';
let workspacesDir = '';

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  pluginsDir = await mkdtemp(join(tmpdir(), 'mc-plugins-'));
  sourceDir = await mkdtemp(join(tmpdir(), 'mc-src-'));
  workspacesDir = await mkdtemp(join(tmpdir(), 'mc-ws-'));

  plugins = new PluginRegistry({ db, pluginsDir, log: () => {} });
  registry = new Registry(db, new Vault(db, randomBytes(32)), () => {}, plugins);

  workspace = new WorkspaceRepo(db).create({
    name: 'Test',
    slug: 'test',
    description: '',
    path: join(workspacesDir, 'test'),
    color: '#6366f1',
    icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });
  await mkdir(workspace.path, { recursive: true });
});

afterEach(async () => {
  for (const dir of [pluginsDir, sourceDir, workspacesDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function installPlugin(
  name: string,
  options: { skills?: string[]; mcp?: Record<string, unknown>; resource?: boolean } = {},
): Promise<void> {
  const dir = join(sourceDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name, description: `${name}.` }),
  );
  for (const skill of options.skills ?? []) {
    await mkdir(join(dir, 'skills', skill), { recursive: true });
    await writeFile(
      join(dir, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Does ${skill}.\n---\n\nBody of ${skill}.\n`,
    );
    if (options.resource) {
      await writeFile(join(dir, 'skills', skill, 'reference.md'), 'Extra material.\n');
    }
  }
  if (options.mcp) {
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA_URL, mcpServers: options.mcp }),
    );
  }
  await plugins.install(dir);
}

/* -------------------------------------------------------------------------- */

describe('MCP servers reach the run', () => {
  it('merges plugin servers with the workspace’s own', async () => {
    registry.upsertMcpServer({
      workspaceId: workspace.id,
      name: 'local',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    await installPlugin('formatter', { mcp: { fmt: { type: 'stdio', command: 'fmt' } } });

    const runtime = registry.resolve(workspace);
    expect(Object.keys(runtime.mcpServers).sort()).toEqual(['formatter__fmt', 'local']);
  });

  it('cannot let a plugin shadow a workspace server', async () => {
    // The workspace's own configuration is the operator's; a plugin must not be
    // able to replace it by choosing a colliding name. The namespace prefix
    // makes that structurally impossible, and this is the test that says so.
    registry.upsertMcpServer({
      workspaceId: workspace.id,
      name: 'fmt',
      transport: 'stdio',
      command: 'the-operators-own',
      args: [],
      env: {},
    });
    await installPlugin('formatter', { mcp: { fmt: { type: 'stdio', command: 'the-plugins' } } });

    const runtime = registry.resolve(workspace);
    expect((runtime.mcpServers.fmt as { command: string }).command).toBe('the-operators-own');
    expect(runtime.mcpServers.formatter__fmt).toBeDefined();
  });

  it('contributes nothing once the plugin is disabled', async () => {
    await installPlugin('formatter', { mcp: { fmt: { type: 'stdio', command: 'fmt' } } });
    const [record] = await plugins.list();
    plugins.setEnabled(record!.id, false);

    expect(registry.resolve(workspace).mcpServers).toEqual({});
  });
});

describe('skills reach the workspace', () => {
  it('writes plugin skills beside the workspace’s own', async () => {
    registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'house-style',
      description: 'The house style.',
      body: 'Follow it.',
    });
    await installPlugin('reviewer', { skills: ['review'] });

    await registry.materialiseSkills(workspace);
    const root = join(workspace.path, '.claude', 'skills');
    expect(existsSync(join(root, 'house-style', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'review', 'SKILL.md'))).toBe(true);
  });

  it('copies a skill’s whole directory, not only its SKILL.md', async () => {
    // A plugin skill may ship references and scripts beside it. Rewriting only
    // the markdown would hand the agent a skill whose own instructions point at
    // files that are not there.
    await installPlugin('reviewer', { skills: ['review'], resource: true });

    await registry.materialiseSkills(workspace);
    const dir = join(workspace.path, '.claude', 'skills', 'review');
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
    expect(await readFile(join(dir, 'reference.md'), 'utf8')).toContain('Extra material.');
  });

  it('lets the workspace’s own skill win a name collision', async () => {
    // The operator's own definition is more specific than a plugin's, and the
    // one they can edit — so it is the one that must survive.
    registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'review',
      description: 'Mine.',
      body: 'MINE',
    });
    await installPlugin('reviewer', { skills: ['review'] });

    await registry.materialiseSkills(workspace);
    const body = await readFile(
      join(workspace.path, '.claude', 'skills', 'review', 'SKILL.md'),
      'utf8',
    );
    expect(body).toContain('MINE');
  });

  it('leaves nothing from a disabled plugin on disk', async () => {
    await installPlugin('reviewer', { skills: ['review'] });
    await registry.materialiseSkills(workspace);
    expect(existsSync(join(workspace.path, '.claude', 'skills', 'review'))).toBe(true);

    const [record] = await plugins.list();
    plugins.setEnabled(record!.id, false);
    await registry.materialiseSkills(workspace);

    // Disabling must remove it, not merely stop refreshing it: a stale skill
    // directory would keep working and look like the toggle did nothing.
    expect(existsSync(join(workspace.path, '.claude', 'skills', 'review'))).toBe(false);
  });
});
