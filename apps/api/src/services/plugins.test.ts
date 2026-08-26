/**
 * Agent Plugins 1.0.0 — the loader.
 *
 * Each test names the clause of the specification it holds the loader to, so a
 * change that breaks conformance fails against the standard rather than against
 * one reading of it. Plugins come from other people; the ones that matter here
 * are the clauses about what a client MUST refuse.
 *
 * https://github.com/agentplugins/agent-plugins-spec
 */

import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from '@metaclaude/shared';
import { loadPlugin, PluginError } from './plugins.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mc-plugin-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a manifest, defaulting every required field to something valid. */
async function manifest(extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(root, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'example', ...extra }, null, 2),
  );
}

async function skill(name: string, body = '# Does a thing\n'): Promise<void> {
  await mkdir(join(root, 'skills', name), { recursive: true });
  await writeFile(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\n${body}`,
  );
}

async function mcp(servers: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(root, 'mcp.json'),
    JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA_URL, mcpServers: servers }, null, 2),
  );
}

/* -------------------------------------------------------------------------- */

describe('the manifest', () => {
  it('loads a plugin that is nothing but a manifest and one skill', async () => {
    await manifest({ version: '1.2.3', description: 'An example.' });
    await skill('deploy');

    const plugin = await loadPlugin(root);
    expect(plugin.name).toBe('example');
    expect(plugin.version).toBe('1.2.3');
    expect(plugin.skills.map((s) => s.name)).toEqual(['deploy']);
    expect(plugin.warnings).toEqual([]);
  });

  it('refuses a directory with no plugin.json', async () => {
    await expect(loadPlugin(root)).rejects.toBeInstanceOf(PluginError);
  });

  it('refuses a name outside the permitted character set', async () => {
    await manifest({ name: 'Not A Valid Name' });
    await expect(loadPlugin(root)).rejects.toThrow(/name/i);
  });

  it('refuses a manifest that is not JSON', async () => {
    await writeFile(join(root, 'plugin.json'), '{ not json');
    await expect(loadPlugin(root)).rejects.toThrow(/json/i);
  });

  it('reports an unknown top-level field without refusing the plugin', async () => {
    // "Unknown top-level fields are reported but non-fatal."
    await manifest({ mystery: true });
    await skill('deploy');

    const plugin = await loadPlugin(root);
    expect(plugin.name).toBe('example');
    expect(plugin.warnings.join(' ')).toMatch(/mystery/);
  });

  it('ignores extensions it does not implement, without validating them', async () => {
    // "Clients MUST ignore unimplemented members of `extensions` without
    // validating the contents."
    await manifest({ extensions: { 'com.example.client': { anything: [1, { deeply: 'nested' }] } } });
    await skill('deploy');

    const plugin = await loadPlugin(root);
    expect(plugin.warnings).toEqual([]);
  });
});

describe('skill discovery', () => {
  it('takes each immediate subdirectory of skills/ that has a SKILL.md', async () => {
    await manifest();
    await skill('deploy');
    await skill('review');
    // A directory with no SKILL.md is not a skill.
    await mkdir(join(root, 'skills', 'notaskill'), { recursive: true });

    const plugin = await loadPlugin(root);
    expect(plugin.skills.map((s) => s.name).sort()).toEqual(['deploy', 'review']);
  });

  it('does not search deeper descendants', async () => {
    // "Clients MUST NOT recursively search deeper descendants for additional
    // skills." A nested SKILL.md is a resource of its parent, not a sibling.
    await manifest();
    await skill('deploy');
    await mkdir(join(root, 'skills', 'deploy', 'nested'), { recursive: true });
    await writeFile(join(root, 'skills', 'deploy', 'nested', 'SKILL.md'), '# not a skill\n');

    const plugin = await loadPlugin(root);
    expect(plugin.skills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('is fine with a plugin that has no skills at all', async () => {
    await manifest();
    await mcp({ example: { type: 'stdio', command: 'node' } });
    const plugin = await loadPlugin(root);
    expect(plugin.skills).toEqual([]);
    expect(plugin.mcpServers.example).toBeDefined();
  });

  it('refuses a plugin that carries neither skills nor MCP servers', async () => {
    // "Support at least one component type" — a plugin with nothing in it is
    // almost always a wrong path, and silently installing it teaches nobody.
    await manifest();
    await expect(loadPlugin(root)).rejects.toThrow(/no skills and no MCP/i);
  });
});

describe('MCP servers', () => {
  it('reads the three transports the spec defines', async () => {
    await manifest();
    await mcp({
      local: { type: 'stdio', command: 'node', args: ['server.js'] },
      remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
    });

    const plugin = await loadPlugin(root);
    expect(Object.keys(plugin.mcpServers).sort()).toEqual(['legacy', 'local', 'remote']);
  });

  it('expands PLUGIN_ROOT and PLUGIN_DATA in args, env and cwd', async () => {
    // "Expand `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in args, env and cwd."
    await manifest();
    await mcp({
      local: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/server.js'],
        env: { STATE: '${PLUGIN_DATA}/state' },
        cwd: '${PLUGIN_ROOT}',
      },
    });

    const plugin = await loadPlugin(root, { dataDir: '/var/lib/metaclaude/plugins/example' });
    const server = plugin.mcpServers.local as { args: string[]; env: Record<string, string>; cwd: string };
    expect(server.args[0]).toBe(join(root, 'server.js'));
    expect(server.env.STATE).toBe('/var/lib/metaclaude/plugins/example/state');
    expect(server.cwd).toBe(root);
  });

  it('provides PLUGIN_ROOT and PLUGIN_DATA to the subprocess', async () => {
    // "Provide `PLUGIN_ROOT` and `PLUGIN_DATA` environment variables."
    await manifest();
    await mcp({ local: { type: 'stdio', command: 'node' } });

    const plugin = await loadPlugin(root, { dataDir: '/data/example' });
    const server = plugin.mcpServers.local as { env: Record<string, string> };
    expect(server.env.PLUGIN_ROOT).toBe(root);
    expect(server.env.PLUGIN_DATA).toBe('/data/example');
  });

  it('uses the plugin root as the working directory when cwd is omitted', async () => {
    await manifest();
    await mcp({ local: { type: 'stdio', command: 'node' } });
    const plugin = await loadPlugin(root);
    expect((plugin.mcpServers.local as { cwd: string }).cwd).toBe(root);
  });

  it('drops a server whose resolved path escapes the plugin root', async () => {
    // "Reject paths resolving outside the plugin root."
    await manifest();
    await skill('deploy');
    await mcp({
      escapee: { type: 'stdio', command: './../../../../usr/bin/whoami' },
      fine: { type: 'stdio', command: 'node' },
    });

    const plugin = await loadPlugin(root);
    expect(plugin.mcpServers.escapee).toBeUndefined();
    expect(plugin.mcpServers.fine).toBeDefined();
    expect(plugin.warnings.join(' ')).toMatch(/outside the plugin root/i);
  });

  it('drops a server whose cwd escapes the plugin root', async () => {
    await manifest();
    await skill('deploy');
    await mcp({ escapee: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/../..' } });

    const plugin = await loadPlugin(root);
    expect(plugin.mcpServers.escapee).toBeUndefined();
    expect(plugin.warnings.join(' ')).toMatch(/outside the plugin root/i);
  });

  it('does not follow a symlink out of the plugin root', async () => {
    await manifest();
    await skill('deploy');
    await symlink('/usr/bin', join(root, 'escape'));
    await mcp({ escapee: { type: 'stdio', command: './escape/whoami' } });

    const plugin = await loadPlugin(root);
    expect(plugin.mcpServers.escapee).toBeUndefined();
  });
});

describe('one broken component does not take the others down', () => {
  it('keeps the skills when mcp.json is unreadable', async () => {
    // "A failure isolated to a component type MUST NOT prevent the client from
    // loading independently valid components."
    await manifest();
    await skill('deploy');
    await writeFile(join(root, 'mcp.json'), '{ broken');

    const plugin = await loadPlugin(root);
    expect(plugin.skills.map((s) => s.name)).toEqual(['deploy']);
    expect(plugin.mcpServers).toEqual({});
    expect(plugin.warnings.join(' ')).toMatch(/mcp\.json/);
  });

  it('keeps the valid servers when one entry is malformed', async () => {
    await manifest();
    await mcp({
      good: { type: 'stdio', command: 'node' },
      bad: { type: 'carrier-pigeon', url: 'nowhere' },
    });

    const plugin = await loadPlugin(root);
    expect(plugin.mcpServers.good).toBeDefined();
    expect(plugin.mcpServers.bad).toBeUndefined();
    expect(plugin.warnings.join(' ')).toMatch(/bad/);
  });

  it('keeps the other skills when one has no front matter', async () => {
    await manifest();
    await skill('deploy');
    await mkdir(join(root, 'skills', 'broken'), { recursive: true });
    await writeFile(join(root, 'skills', 'broken', 'SKILL.md'), 'no front matter at all\n');

    const plugin = await loadPlugin(root);
    expect(plugin.skills.map((s) => s.name)).toContain('deploy');
    expect(plugin.warnings.join(' ')).toMatch(/broken/);
  });
});

describe('schema versions must agree', () => {
  it('warns when mcp.json targets a different version to plugin.json', async () => {
    // "When mcp.json exists, its $schema must match plugin.json's version."
    await manifest();
    await skill('deploy');
    await writeFile(
      join(root, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
        mcpServers: { local: { type: 'stdio', command: 'node' } },
      }),
    );

    const plugin = await loadPlugin(root);
    // Names both versions, so the operator can see which side to change.
    expect(plugin.warnings.join(' ')).toContain('2.0.0');
    expect(plugin.warnings.join(' ')).toContain('1.0.0');
    expect(plugin.mcpServers).toEqual({});
  });
});
