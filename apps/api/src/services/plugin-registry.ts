/**
 * Installed Agent Plugins.
 *
 * `plugins.ts` reads one plugin directory and holds it to the 1.0.0
 * specification. This owns the rest: where an installed plugin's files live,
 * what a run receives from the installed set, and what happens when two plugins
 * disagree about a name.
 *
 * Two decisions worth stating.
 *
 * A plugin is **copied**, not referenced. The source is usually a checkout or a
 * clone the operator will delete; a plugin that stops working when a temporary
 * directory is cleaned was never installed. The copy is also what makes
 * `PLUGIN_ROOT` a path this server controls.
 *
 * The manifest is **stored whole**. The specification permits an `extensions`
 * object whose contents a client must not validate, and later versions will add
 * fields; a row that projected today's ten columns would discard both.
 */

import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { newId, type PluginRecord, type PluginSkill } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { isInside } from '../security/paths.js';
import { loadPlugin, PluginError, type LoadedPlugin } from './plugins.js';

interface PluginRow {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  source: string;
  root: string;
  manifest: string;
  enabled: number;
  installed_at: number;
  updated_at: number;
}

export interface PluginRuntime {
  /** Skills to materialise into a workspace, already de-duplicated by name. */
  skills: Array<PluginSkill & { pluginName: string }>;
  /** MCP servers, keyed `<plugin>__<server>` and ready to hand to a run. */
  mcpServers: Record<string, unknown>;
  /** Names claimed by more than one plugin. Reported rather than swallowed. */
  conflicts: string[];
}

export interface PluginRegistryDeps {
  db: Db;
  /** Root under which every plugin's code and data lives. */
  pluginsDir: string;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/**
 * A plugin's MCP servers are prefixed with its name.
 *
 * Two plugins may each ship a server called `server`, and without a namespace
 * the second would replace the first in the map handed to the run — silently,
 * and differently depending on install order.
 */
function qualify(pluginName: string, serverName: string): string {
  return `${pluginName}__${serverName}`;
}

/**
 * Refuse to copy a symlink that leaves the plugin.
 *
 * The 1.0.0 specification requires that a plugin never reaches outside its own
 * root, and `plugins.ts` enforces that on every path a manifest *declares*. A
 * symlink is the same escape by another route, and it survives the declaration
 * check because nothing declares it: copied verbatim it becomes an ordinary
 * path inside the installed plugin, and a skill directory is later copied
 * wholesale into a workspace the agent can read. Installing a plugin would then
 * be an arbitrary-file read for whoever wrote it.
 *
 * Links that stay inside are kept: sharing one file between two skills is
 * legitimate, so the rule is not "no symlinks" but "no symlinks that leave".
 *
 * The target is resolved textually first so that a *broken* link is judged by
 * where it points rather than passed through because it currently resolves to
 * nothing — that link becoming valid later must not be what grants the escape.
 */
async function assertLinkStaysInside(root: string, link: string): Promise<void> {
  const literal = resolve(dirname(link), await readlink(link));
  // `realpath` follows a chain of links; it fails on a broken one, and the
  // literal target is then the honest thing to judge.
  const target = await realpath(literal).catch(() => literal);
  if (target !== root && !isInside(root, target)) {
    throw new PluginError(
      `"${relative(root, link) || link}" is a symbolic link pointing outside the plugin. ` +
        'A plugin may not reference anything beyond its own directory.',
    );
  }
}

export class PluginRegistry {
  constructor(private readonly deps: PluginRegistryDeps) {}

  /** Where a plugin's code lives. Derived from its name, which is unique. */
  private rootFor(name: string): string {
    return join(this.deps.pluginsDir, name);
  }

  /**
   * Where a plugin's state lives — `PLUGIN_DATA`.
   *
   * Deliberately a sibling of the code rather than a directory inside it: an
   * update replaces the code wholesale, and anything the plugin had written
   * would go with it.
   */
  private dataFor(name: string): string {
    return join(this.deps.pluginsDir, `${name}.data`);
  }

  /* --------------------------------- Read -------------------------------- */

  private rows(): PluginRow[] {
    return this.deps.db
      .prepare<[], PluginRow>('SELECT * FROM plugins ORDER BY name')
      .all();
  }

  /**
   * Every installed plugin, re-read from disk.
   *
   * Asynchronous, and deliberately so: the database holds what was installed
   * and the directory holds what is there now, and a plugin whose files were
   * edited or removed underneath must be listed with the problem attached
   * rather than from a stale cache. Listing is an operator action; `runtime()`
   * is the one on the hot path and it stays synchronous.
   */
  async list(): Promise<PluginRecord[]> {
    await this.refresh();
    return this.rows().map((row) => this.describe(row));
  }

  get(id: string): PluginRecord | null {
    const row = this.deps.db.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get(id);
    return row ? this.describe(row) : null;
  }

  private describe(row: PluginRow): PluginRecord {
    const base = {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      source: row.source,
      root: row.root,
      enabled: row.enabled === 1,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    };

    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(row.manifest) as Record<string, unknown>;
    } catch {
      // Unreachable unless the row was edited by hand; the defaults below hold.
    }

    const loaded = this.loadedCache.get(row.root);
    if (loaded) {
      return {
        ...base,
        homepage: (manifest.homepage as string) ?? null,
        license: (manifest.license as string) ?? null,
        keywords: (manifest.keywords as string[]) ?? [],
        skills: loaded.skills,
        mcpServers: Object.keys(loaded.mcpServers),
        warnings: loaded.warnings,
      };
    }

    return {
      ...base,
      homepage: (manifest.homepage as string) ?? null,
      license: (manifest.license as string) ?? null,
      keywords: (manifest.keywords as string[]) ?? [],
      skills: [],
      mcpServers: [],
      warnings: ['This plugin could not be read from disk. Its files may have been moved or removed.'],
    };
  }

  /**
   * Plugins read from disk, keyed by root.
   *
   * Refreshed by `refresh()`, which every mutation calls. Reading a dozen small
   * manifests on every list would be affordable; doing it inside `runtime()`,
   * which is on the path of every run, would not.
   */
  private loadedCache = new Map<string, LoadedPlugin>();

  /** Re-read every installed plugin from disk. */
  async refresh(): Promise<void> {
    const next = new Map<string, LoadedPlugin>();
    for (const row of this.rows()) {
      try {
        next.set(row.root, await loadPlugin(row.root, { dataDir: this.dataFor(row.name) }));
      } catch (error) {
        this.deps.log('warn', `plugin "${row.name}" could not be read`, {
          message: (error as Error).message,
        });
      }
    }
    this.loadedCache = next;
  }

  /* -------------------------------- Runtime ------------------------------ */

  /**
   * What the enabled plugins contribute to a run.
   *
   * Synchronous and cheap: it reads the cache, never the disk, because it sits
   * on the path of every run.
   */
  runtime(): PluginRuntime {
    const skills: PluginRuntime['skills'] = [];
    const mcpServers: Record<string, unknown> = {};
    const conflicts: string[] = [];
    const claimed = new Map<string, string>();

    for (const row of this.rows()) {
      if (row.enabled !== 1) continue;
      const loaded = this.loadedCache.get(row.root);
      if (!loaded) continue;

      for (const skill of loaded.skills) {
        const owner = claimed.get(skill.name);
        if (owner) {
          // First install wins, deterministically by name order, and the loser
          // is named: a plugin that appears installed and does nothing is the
          // worst of both outcomes.
          conflicts.push(
            `Both "${owner}" and "${row.name}" provide a skill called "${skill.name}"; the one from "${owner}" is in use.`,
          );
          continue;
        }
        claimed.set(skill.name, row.name);
        skills.push({ ...skill, pluginName: row.name });
      }

      for (const [name, server] of Object.entries(loaded.mcpServers)) {
        mcpServers[qualify(row.name, name)] = server;
      }
    }

    return { skills, mcpServers, conflicts };
  }

  /* -------------------------------- Mutate ------------------------------- */

  /**
   * Install from a directory already on this server.
   *
   * Validated before anything is written: an invalid plugin must leave no
   * trace, or the next attempt at the same name fails for a reason that has
   * nothing to do with the plugin.
   */
  async install(source: string): Promise<PluginRecord> {
    const from = resolve(source);
    if (isInside(this.deps.pluginsDir, from) || from === this.deps.pluginsDir) {
      throw new PluginError('That directory is inside the plugins directory; install from elsewhere.');
    }

    // Read it where it is. Copying first would mean cleaning up after every
    // malformed plugin, and the failure paths are where cleanup is forgotten.
    const probe = await loadPlugin(from);

    const existing = this.deps.db
      .prepare<[string], { id: string }>('SELECT id FROM plugins WHERE name = ?')
      .get(probe.name);
    if (existing) {
      throw new PluginError(`"${probe.name}" is already installed. Remove it first to replace it.`, 409);
    }

    const root = this.rootFor(probe.name);
    // The name is validated by the manifest schema, but the path is checked
    // anyway: a name is the only attacker-controlled part of this path.
    if (!isInside(this.deps.pluginsDir, root)) {
      throw new PluginError('That plugin name does not produce a valid install path.');
    }

    // A plugin's state lives at `<name>.data`, beside its code — and the name
    // grammar permits periods, so `acme.data` claims the directory holding
    // plugin `acme`'s state. Installing it would `rm -rf` that state, and
    // `refresh()` would then hand `acme` a PLUGIN_DATA pointing at the other
    // plugin's *code*. The uniqueness check above cannot see it: the two names
    // differ, only the paths collide.
    //
    // Far more likely to be an unlucky name than an attack — installing is
    // owner-only, from a directory already on the server — but the failure is
    // silent data loss either way.
    if (root.endsWith('.data') || existsSync(this.dataFor(probe.name))) {
      throw new PluginError(
        `"${probe.name}" collides with another plugin's data directory. Rename it.`,
        409,
      );
    }

    await rm(root, { recursive: true, force: true });
    try {
      // `dereference: false` keeps symlinks as symlinks, which is why each one
      // has to be judged on the way past. Resolved once here rather than per
      // entry: the source itself may sit under a symlinked path, and comparing
      // a resolved target against an unresolved root rejects honest plugins.
      const sourceRoot = await realpath(from);
      await cp(from, root, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        filter: async (entry) => {
          if ((await lstat(entry)).isSymbolicLink()) {
            await assertLinkStaysInside(sourceRoot, entry);
          }
          return true;
        },
      });
      await mkdir(this.dataFor(probe.name), { recursive: true });
      // Re-read from the installed location: the copy is what will run, and its
      // resolved paths differ from the source's.
      const loaded = await loadPlugin(root, { dataDir: this.dataFor(probe.name) });

      const now = Date.now();
      const id = newId('plugin');
      this.deps.db
        .prepare(
          `INSERT INTO plugins (id, name, version, description, source, root, manifest, enabled, installed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          loaded.name,
          loaded.version,
          loaded.description,
          source,
          root,
          JSON.stringify(loaded.manifest),
          now,
          now,
        );

      this.loadedCache.set(root, loaded);
      this.deps.log('info', `installed plugin "${loaded.name}"`, {
        skills: loaded.skills.length,
        mcpServers: Object.keys(loaded.mcpServers).length,
      });
      return this.get(id) as PluginRecord;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const result = this.deps.db
      .prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return result.changes > 0;
  }

  /**
   * Uninstall, taking the code with it.
   *
   * The data directory is deliberately left: uninstalling to fix a
   * configuration and reinstalling is common, and silently destroying whatever
   * the plugin had stored is not recoverable.
   */
  async remove(id: string): Promise<boolean> {
    const row = this.deps.db.prepare<[string], PluginRow>('SELECT * FROM plugins WHERE id = ?').get(id);
    if (!row) return false;

    this.deps.db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
    this.loadedCache.delete(row.root);

    if (isInside(this.deps.pluginsDir, row.root)) {
      // Awaited, not fired and forgotten: reinstalling the same plugin is the
      // common next action, and it would otherwise race the deletion of the
      // directory it is about to write.
      await rm(row.root, { recursive: true, force: true }).catch(() => {});
    } else {
      // Refuse rather than delete: a row whose root escaped the plugins
      // directory is a bug or a tampered database, and neither is a reason to
      // recursively remove an arbitrary path.
      this.deps.log('error', 'refusing to delete a plugin root outside the plugins directory', {
        root: row.root,
      });
    }
    return true;
  }

  /** Relative path of a plugin's skill, for display. */
  static describeSkillLocation(pluginsDir: string, path: string): string {
    const rel = relative(pluginsDir, path);
    return rel.startsWith('..') ? path : rel.split(sep).join('/');
  }
}
