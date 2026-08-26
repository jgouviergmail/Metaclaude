/**
 * Agent Plugins 1.0.0 — loading a plugin directory.
 *
 * The specification is deliberately small: a manifest, skills one level under
 * `skills/`, MCP servers in `mcp.json`. Almost all of the work here is refusing
 * things, because a plugin is code from someone else that this server will run.
 *
 * Two rules shape the whole file:
 *
 *   "Reject paths resolving outside the plugin root."
 *   "A failure isolated to a component type MUST NOT prevent the client from
 *    loading independently valid components."
 *
 * The first is why every path is resolved and checked rather than trusted. The
 * second is why nearly nothing here throws: a malformed MCP entry costs that
 * entry, not the plugin, and the operator is told which and why.
 *
 * https://github.com/agentplugins/agent-plugins-spec
 */

import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  PLUGIN_MCP_SCHEMA_URL,
  PluginManifest,
  PluginMcpServer,
  type PluginSkill,
} from '@metaclaude/shared';
import { isInside } from '../security/paths.js';

export class PluginError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  name: string;
  version: string | null;
  description: string | null;
  root: string;
  skills: PluginSkill[];
  /** Ready to merge into a run, with placeholders expanded and paths checked. */
  mcpServers: Record<string, unknown>;
  warnings: string[];
}

export interface LoadOptions {
  /**
   * The plugin's private state directory — `PLUGIN_DATA`.
   *
   * Separate from the root because the root is the plugin's code, which an
   * update replaces wholesale; this is the plugin's data, which it must not.
   */
  dataDir?: string;
}

/** The version segment of a 1.0.0-style schema URL, or null if it is not one. */
function schemaVersion(url: string): string | null {
  return /\/schemas\/(\d+\.\d+\.\d+)\//.exec(url)?.[1] ?? null;
}

/**
 * Resolve a plugin-relative path and refuse anything that escapes.
 *
 * `realpath` is what makes a symlink out of the tree fail: without it, a link
 * named `./tools/helper` pointing at `/usr/bin` resolves inside the root as a
 * string and outside it in fact. A path that does not exist yet cannot be
 * resolved, so it is checked lexically and left for the caller to run — the
 * spec bounds where a plugin may point, not whether the target exists.
 */
async function insideRoot(root: string, candidate: string): Promise<string | null> {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (!isInside(root, absolute)) return null;
  try {
    const real = await realpath(absolute);
    const realRoot = await realpath(root);
    return isInside(realRoot, real) ? absolute : null;
  } catch {
    return absolute;
  }
}

/** `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, the only two the spec defines. */
function expand(value: string, root: string, dataDir: string): string {
  return value.replaceAll('${PLUGIN_ROOT}', root).replaceAll('${PLUGIN_DATA}', dataDir);
}

/**
 * The skill's own name and description, from its YAML front matter.
 *
 * Parsed rather than assumed from the directory name: the Agent Skills format
 * puts both in the front matter, and a skill whose folder and declared name
 * disagree should show the operator what the agent will actually see.
 */
function parseSkill(body: string, fallbackName: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!match) return null;
  const front = match[1] ?? '';
  const field = (key: string): string | null =>
    new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;

  const description = field('description');
  if (!description) return null;
  return { name: field('name') ?? fallbackName, description };
}

/* -------------------------------------------------------------------------- */

export async function loadPlugin(root: string, options: LoadOptions = {}): Promise<LoadedPlugin> {
  const warnings: string[] = [];

  /* -- The manifest. The only part whose failure is fatal. ---------------- */

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'has no plugin.json' : 'has a plugin.json that is not valid JSON';
    throw new PluginError(`That directory ${reason}.`);
  }

  const parsed = PluginManifest.safeParse(raw);
  let manifest: PluginManifest;
  if (parsed.success) {
    manifest = parsed.data;
  } else {
    // An unknown top-level field is reported, not fatal — but anything else is
    // a manifest this client cannot honour.
    const unknown = parsed.error.issues.filter((i) => i.code === 'unrecognized_keys');
    const fatal = parsed.error.issues.filter((i) => i.code !== 'unrecognized_keys');
    if (fatal.length > 0) {
      throw new PluginError(`plugin.json is not valid: ${fatal.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    for (const issue of unknown) {
      const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
      warnings.push(`plugin.json has fields this version does not define: ${keys.join(', ')}. They were ignored.`);
    }
    manifest = PluginManifest.strip().parse(raw) as PluginManifest;
  }

  const dataDir = options.dataDir ?? join(root, '.data');

  /* -- Skills: immediate subdirectories of skills/ carrying a SKILL.md ---- */

  const skills: PluginSkill[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await readdir(join(root, 'skills'), { withFileTypes: true });
  } catch {
    // No skills directory is ordinary: a plugin may be MCP servers alone.
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, 'skills', entry.name, 'SKILL.md');
    // The spec says a *regular file*, and only at this depth: a nested
    // SKILL.md is a resource belonging to its parent skill, not a sibling.
    let body: string;
    try {
      body = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const parsedSkill = parseSkill(body, entry.name);
    if (!parsedSkill) {
      warnings.push(`skills/${entry.name} has no name/description front matter, so it was skipped.`);
      continue;
    }
    skills.push({ name: parsedSkill.name, description: parsedSkill.description, path });
  }

  /* -- MCP servers -------------------------------------------------------- */

  const mcpServers: Record<string, unknown> = {};
  let mcpRaw: unknown = null;
  try {
    mcpRaw = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push('mcp.json could not be read, so no MCP servers were loaded from it.');
    }
  }

  if (mcpRaw && typeof mcpRaw === 'object') {
    const file = mcpRaw as { $schema?: unknown; mcpServers?: unknown };
    const declared = typeof file.$schema === 'string' ? schemaVersion(file.$schema) : null;
    const expected = schemaVersion(PLUGIN_MCP_SCHEMA_URL);

    if (declared !== expected) {
      // "When mcp.json exists, its $schema must match plugin.json's version."
      warnings.push(
        `mcp.json targets Agent Plugins ${declared ?? 'an unknown version'}, but this client implements ${expected}. Its servers were not loaded.`,
      );
    } else if (!file.mcpServers || typeof file.mcpServers !== 'object') {
      warnings.push('mcp.json has no mcpServers object.');
    } else {
      for (const [name, value] of Object.entries(file.mcpServers as Record<string, unknown>)) {
        const server = PluginMcpServer.safeParse(value);
        if (!server.success) {
          warnings.push(`The MCP server "${name}" is not a shape this version understands, so it was skipped.`);
          continue;
        }

        if (server.data.type !== 'stdio') {
          mcpServers[name] = server.data;
          continue;
        }

        const command = expand(server.data.command, root, dataDir);
        // A bare name is looked up on PATH and is not a plugin-relative path;
        // only something that looks like a path is bounded by the root.
        if (command.includes('/')) {
          const checked = await insideRoot(root, command);
          if (!checked) {
            warnings.push(`The MCP server "${name}" points at ${server.data.command}, outside the plugin root. It was skipped.`);
            continue;
          }
        }

        const cwd = server.data.cwd ? expand(server.data.cwd, root, dataDir) : root;
        const checkedCwd = await insideRoot(root, cwd);
        if (!checkedCwd) {
          warnings.push(`The MCP server "${name}" would run in ${server.data.cwd}, outside the plugin root. It was skipped.`);
          continue;
        }

        mcpServers[name] = {
          ...server.data,
          command,
          ...(server.data.args ? { args: server.data.args.map((a) => expand(a, root, dataDir)) } : {}),
          // The two variables the spec requires a client to provide, after the
          // plugin's own env so a plugin cannot overwrite its own root.
          env: {
            ...Object.fromEntries(
              Object.entries(server.data.env ?? {}).map(([k, v]) => [k, expand(v, root, dataDir)]),
            ),
            PLUGIN_ROOT: root,
            PLUGIN_DATA: dataDir,
          },
          cwd: checkedCwd,
        };
      }
    }
  }

  if (skills.length === 0 && Object.keys(mcpServers).length === 0) {
    throw new PluginError(
      `"${manifest.name}" has no skills and no MCP servers, so there is nothing to install. ` +
        (warnings.length > 0 ? warnings.join(' ') : 'Check that it is an Agent Plugins directory.'),
    );
  }

  return {
    manifest,
    name: manifest.name,
    version: manifest.version ?? null,
    description: manifest.description ?? null,
    root,
    skills,
    mcpServers,
    warnings,
  };
}
