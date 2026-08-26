/**
 * Installing, listing and running Agent Plugins.
 *
 * The loader (plugins.test.ts) proves conformance to the 1.0.0 specification.
 * This proves the parts that are this product's own: where a plugin's files go,
 * what happens when two plugins claim the same name or the same skill, and that
 * a disabled plugin genuinely contributes nothing to a run.
 */

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { PluginRegistry } from './plugin-registry.js';
import { PluginError } from './plugins.js';

let db: Db;
let pluginsDir = '';
let sourceDir = '';
let registry: PluginRegistry;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  pluginsDir = await mkdtemp(join(tmpdir(), 'mc-plugins-'));
  sourceDir = await mkdtemp(join(tmpdir(), 'mc-src-'));
  registry = new PluginRegistry({ db, pluginsDir, log: () => {} });
});

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
});

/** Build a plugin directory to install from. */
async function build(
  name: string,
  options: { skills?: string[]; mcp?: Record<string, unknown>; version?: string } = {},
): Promise<string> {
  const dir = join(sourceDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name,
      ...(options.version ? { version: options.version } : {}),
      description: `The ${name} plugin.`,
    }),
  );
  for (const skill of options.skills ?? ['default-skill']) {
    await mkdir(join(dir, 'skills', skill), { recursive: true });
    await writeFile(
      join(dir, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Does ${skill}.\n---\n\nBody of ${skill}.\n`,
    );
  }
  if (options.mcp) {
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA_URL, mcpServers: options.mcp }),
    );
  }
  return dir;
}

/* -------------------------------------------------------------------------- */

describe('installing', () => {
  it('copies the plugin under the plugins directory and records it', async () => {
    const record = await registry.install(await build('formatter', { version: '2.0.0' }));

    expect(record.name).toBe('formatter');
    expect(record.version).toBe('2.0.0');
    expect(record.enabled).toBe(true);
    // Installed, not referenced: the source may be a checkout the operator
    // deletes, and a plugin that stops working when a temp directory is cleaned
    // is not installed at all.
    expect(record.root.startsWith(pluginsDir)).toBe(true);
    expect(existsSync(join(record.root, 'plugin.json'))).toBe(true);
    expect(existsSync(join(record.root, 'skills', 'default-skill', 'SKILL.md'))).toBe(true);
  });

  it('survives the source directory being deleted', async () => {
    const source = await build('formatter');
    await registry.install(source);
    await rm(source, { recursive: true, force: true });

    const [record] = await registry.list();
    expect(record?.skills.map((s) => s.name)).toEqual(['default-skill']);
  });

  it('refuses a second plugin with the same name', async () => {
    await registry.install(await build('formatter'));
    await expect(registry.install(await build('formatter'))).rejects.toThrow(/already installed/i);
  });

  it('refuses a directory that is not a plugin', async () => {
    const empty = join(sourceDir, 'nothing');
    await mkdir(empty, { recursive: true });
    await expect(registry.install(empty)).rejects.toBeInstanceOf(PluginError);
  });

  it('leaves nothing behind when the install fails', async () => {
    const broken = join(sourceDir, 'broken');
    await mkdir(join(broken, 'skills'), { recursive: true });
    await writeFile(join(broken, 'plugin.json'), '{ not json');

    await expect(registry.install(broken)).rejects.toThrow();
    // A half-copied directory would make the *next* install of the same name
    // fail for a reason that has nothing to do with the plugin.
    expect(await registry.list()).toEqual([]);
    await expect(readFile(join(pluginsDir, 'broken', 'plugin.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses a source path that escapes into the plugins directory itself', async () => {
    // Installing from inside the destination would copy a directory into its
    // own subtree. Cheap to refuse, and unbounded if not.
    await expect(registry.install(pluginsDir)).rejects.toThrow();
  });

  it('refuses a plugin containing a symlink that points outside it', async () => {
    // The specification requires that a plugin never reaches outside its own
    // root, and the loader enforces that on the paths a manifest *declares*.
    // A symlink smuggles the same escape past it: copied verbatim, it becomes
    // a real path inside the installed plugin, and a skill directory is copied
    // wholesale into a workspace where the agent can read it. That turns
    // installing a plugin into an arbitrary-file read.
    const dir = await build('sneaky');
    const secret = join(sourceDir, 'secret.txt');
    await writeFile(secret, 'do not copy me');
    await symlink(secret, join(dir, 'skills', 'default-skill', 'leak.txt'));

    await expect(registry.install(dir)).rejects.toBeInstanceOf(PluginError);
    expect(existsSync(join(pluginsDir, 'sneaky'))).toBe(false);
  });

  it('allows a symlink that stays inside the plugin', async () => {
    // Sharing one file between two skills is legitimate, and the check must
    // not be "no symlinks" — only "no symlinks that leave".
    const dir = await build('tidy', { skills: ['one', 'two'] });
    await symlink(
      join(dir, 'skills', 'one', 'SKILL.md'),
      join(dir, 'skills', 'two', 'SHARED.md'),
    );

    const record = await registry.install(dir);
    expect(record.skills.map((skill) => skill.name).sort()).toEqual(['one', 'two']);
  });
});

describe('what a run receives', () => {
  it('contributes skills and MCP servers from enabled plugins', async () => {
    await registry.install(
      await build('formatter', {
        skills: ['format'],
        mcp: { fmt: { type: 'stdio', command: 'node' } },
      }),
    );

    const runtime = registry.runtime();
    expect(runtime.skills.map((s) => s.name)).toEqual(['format']);
    expect(Object.keys(runtime.mcpServers)).toEqual(['formatter__fmt']);
  });

  it('namespaces MCP servers by plugin, so two plugins may both ship a "server"', async () => {
    await registry.install(await build('alpha', { mcp: { server: { type: 'stdio', command: 'a' } } }));
    await registry.install(await build('beta', { mcp: { server: { type: 'stdio', command: 'b' } } }));

    const runtime = registry.runtime();
    expect(Object.keys(runtime.mcpServers).sort()).toEqual(['alpha__server', 'beta__server']);
  });

  it('contributes nothing while disabled', async () => {
    const record = await registry.install(
      await build('formatter', { mcp: { fmt: { type: 'stdio', command: 'node' } } }),
    );
    registry.setEnabled(record.id, false);

    const runtime = registry.runtime();
    expect(runtime.skills).toEqual([]);
    expect(runtime.mcpServers).toEqual({});
    // Still installed, still listed — disabled is not uninstalled.
    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enabled).toBe(false);
  });

  it('gives each plugin its own PLUGIN_DATA, outside its code', async () => {
    const record = await registry.install(
      await build('formatter', { mcp: { fmt: { type: 'stdio', command: 'node' } } }),
    );
    const server = registry.runtime().mcpServers.formatter__fmt as { env: Record<string, string> };

    expect(server.env.PLUGIN_ROOT).toBe(record.root);
    // Separate from the root: the root is code an update replaces wholesale,
    // and the data is state that must survive it.
    const dataDir = server.env.PLUGIN_DATA;
    expect(typeof dataDir).toBe('string');
    expect(dataDir).not.toBe(record.root);
    expect(dataDir?.startsWith(pluginsDir)).toBe(true);
  });

  it('reports a skill name claimed by two plugins instead of silently dropping one', async () => {
    await registry.install(await build('alpha', { skills: ['review'] }));
    await registry.install(await build('beta', { skills: ['review'] }));

    const runtime = registry.runtime();
    // One wins — the agent sees one skill directory per name — but the operator
    // is told, because the losing plugin appears installed and does nothing.
    expect(runtime.skills).toHaveLength(1);
    expect(runtime.conflicts.join(' ')).toMatch(/review/);
  });
});

describe('removing', () => {
  it('deletes the plugin and its files', async () => {
    const record = await registry.install(await build('formatter'));
    expect(await registry.remove(record.id)).toBe(true);

    expect(await registry.list()).toEqual([]);
    await expect(readFile(join(record.root, 'plugin.json'), 'utf8')).rejects.toThrow();
  });

  it('is a no-op for a plugin that is not installed', async () => {
    expect(await registry.remove('plugin_missing')).toBe(false);
  });
});

describe('reading a plugin whose files changed underneath', () => {
  it('reports the failure without hiding the plugin', async () => {
    const record = await registry.install(await build('formatter'));
    await rm(join(record.root, 'plugin.json'), { force: true });

    const [listed] = await registry.list();
    expect(listed?.name).toBe('formatter');
    expect(listed?.warnings.join(' ')).toMatch(/could not be read/i);
    expect(listed?.skills).toEqual([]);
  });
});

describe('name collisions with the data directory', () => {
  it('refuses a plugin whose name claims another plugin’s state directory', async () => {
    // `dataFor` is `<name>.data`, a sibling of the code, and the name grammar
    // permits periods — so `acme.data` resolves to exactly the directory
    // holding plugin `acme`'s state. The uniqueness check cannot see it: the
    // names differ, only the paths collide. Installing it would `rm -rf` that
    // state, and `refresh()` would then hand `acme` a PLUGIN_DATA pointing at
    // the other plugin's code.
    await registry.install(await build('acme', {}));
    const marker = join(pluginsDir, 'acme.data', 'state.json');
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, '{"kept":true}', 'utf8');

    await expect(registry.install(await build('acme.data', {}))).rejects.toThrow(/reserved for plugin state/);
    expect(existsSync(marker)).toBe(true);
  });

  it('lets a removed plugin be reinstalled, state and all', async () => {
    // `remove()` deletes the code and deliberately keeps `<name>.data` — its
    // own comment says "reinstalling the same plugin is the common next
    // action", and `install()` tells the operator to remove first in order to
    // replace. A collision check that looked for `<name>.data` therefore fired
    // on the plugin's *own* state directory and made every plugin single-use,
    // with a 409 naming a conflict that does not exist and no way out short of
    // deleting the directory by hand on the server.
    const first = await registry.install(await build('acme', {}));
    const state = join(pluginsDir, 'acme.data', 'state.json');
    await mkdir(dirname(state), { recursive: true });
    await writeFile(state, '{"kept":true}', 'utf8');

    expect(await registry.remove(first.id)).toBe(true);
    expect(existsSync(join(pluginsDir, 'acme'))).toBe(false);
    expect(existsSync(state)).toBe(true);

    const again = await registry.install(await build('acme', { version: '2.0.0' }));
    expect(again.version).toBe('2.0.0');
    // The point of keeping the directory: an update must not lose the state.
    expect(await readFile(state, 'utf8')).toBe('{"kept":true}');
  });

  it('still allows an ordinary name containing a period', async () => {
    // The grammar permits them for reverse-DNS style names, and refusing all
    // of them would be a wider change than the collision needs.
    await expect(registry.install(await build('com.acme.tools', {}))).resolves.toBeDefined();
  });
});
