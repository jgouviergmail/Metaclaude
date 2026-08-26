/**
 * Workspace service.
 *
 * A workspace is a directory plus a policy. Creating one provisions the
 * directory (optionally seeded from a git clone) and writes a starter
 * `CLAUDE.md` so the agent has project context from the first run.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CreateWorkspaceRequest, Workspace, WorkspaceSettings } from '@metaclaude/shared';
import { WorkspaceSettings as WorkspaceSettingsSchema } from '@metaclaude/shared';
import { isInside, slugify } from '../security/paths.js';
import { defaultWorkspaceSettings, type WorkspaceRepo } from '../kernel/repositories.js';

const execFileAsync = promisify(execFile);

/**
 * The environment every git subprocess here gets — a replacement, never a
 * spread of `process.env`.
 *
 * git talks to a URL the caller chose, over transports that run helper
 * programs. Handing that process METACLAUDE_MASTER_KEY and the Claude token
 * costs nothing to avoid and everything to get wrong.
 */
const CLONE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  // Never block on an interactive credential or host-key prompt inside a
  // container with no TTY: it would hang until the timeout with no explanation.
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'Metaclaude',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'metaclaude@localhost',
  GIT_COMMITTER_NAME: process.env.GIT_AUTHOR_NAME || 'Metaclaude',
  GIT_COMMITTER_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'metaclaude@localhost',
};

export class WorkspaceServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'WorkspaceServiceError';
  }
}

export interface WorkspaceServiceDeps {
  repo: WorkspaceRepo;
  workspacesRoot: string;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

const STARTER_CLAUDE_MD = (name: string) => `# ${name}

<!--
This file is read automatically by Claude at the start of every session in this
workspace. Use it for the things you would otherwise repeat in every prompt:
build and test commands, architectural conventions, things to avoid.

Metaclaude also maintains its own learned memory alongside this file. This file
is yours — it is never rewritten automatically.
-->

## Commands

<!-- e.g. \`pnpm test\`, \`make build\` -->

## Conventions

<!-- e.g. "prefer composition over inheritance", "no default exports" -->
`;

export class WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  async create(input: CreateWorkspaceRequest): Promise<Workspace> {
    const name = input.name.trim();
    if (!name) throw new WorkspaceServiceError('A workspace needs a name.');

    const slug = this.uniqueSlug(slugify(name));
    const path = resolve(this.deps.workspacesRoot, slug);

    // Defence in depth: the slug is already sanitised, but a workspace
    // directory must never be able to land outside the root.
    if (!isInside(this.deps.workspacesRoot, path)) {
      throw new WorkspaceServiceError('Invalid workspace name.');
    }
    if (existsSync(path)) {
      throw new WorkspaceServiceError(`A directory already exists at ${slug}.`, 409);
    }

    const settings: WorkspaceSettings = WorkspaceSettingsSchema.parse({
      ...defaultWorkspaceSettings(),
      ...(input.settings ?? {}),
    });

    await mkdir(path, { recursive: true });

    try {
      if (input.gitUrl) {
        await this.cloneInto(path, input.gitUrl);
      } else {
        await writeFile(resolve(path, 'CLAUDE.md'), STARTER_CLAUDE_MD(name), 'utf8');
      }
    } catch (error) {
      // Never leave a half-provisioned directory behind.
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return this.deps.repo.create({
      name,
      slug,
      description: input.description,
      path,
      color: input.color,
      icon: input.icon,
      settings,
    });
  }

  /**
   * Clone a repository into an existing directory.
   *
   * The URL is validated to an allow-list of schemes: a `file://` or
   * `ext::` URL would let a caller read arbitrary host paths or execute a
   * helper command through git's transport layer.
   */
  private assertCloneableUrl(gitUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(gitUrl);
    } catch {
      throw new WorkspaceServiceError('The repository URL is not a valid URL.');
    }
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) {
      throw new WorkspaceServiceError(
        `Unsupported repository scheme "${parsed.protocol}". Use https or ssh.`,
      );
    }
  }

  private async cloneInto(path: string, gitUrl: string): Promise<void> {
    this.assertCloneableUrl(gitUrl);
    try {
      await execFileAsync('git', ['clone', '--depth', '50', '--', gitUrl, path], {
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        // A replacement, not a spread. `...process.env` here would hand
        // METACLAUDE_MASTER_KEY and the Claude token to a process talking to a
        // URL the caller chose, over a transport that runs helper programs.
        env: CLONE_ENV,
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
      throw new WorkspaceServiceError(`Clone failed: ${stderr.slice(0, 500)}`, 422);
    }
  }

  /**
   * Attach a repository to a workspace that already exists.
   *
   * Cloning was only ever possible at creation, through a field in a modal on
   * one screen, so a workspace that started empty could never be connected to
   * anything and the Git panel's only advice was to open a shell — on a
   * deployment whose whole point is not needing one.
   *
   * Two paths, because the directory's state decides what is safe:
   *
   *   empty      — clone into it. The ordinary case, and the one people mean.
   *   not empty  — init, add the remote, fetch, and stop. Checking out over
   *                files the owner already has would silently overwrite work,
   *                so the merge is left to them with the history in place.
   */
  async connectRepository(
    id: string,
    gitUrl: string | null,
  ): Promise<{ mode: 'cloned' | 'fetched' | 'initialised'; branch: string | null }> {
    const workspace = this.deps.repo.get(id);
    if (!workspace) throw new WorkspaceServiceError('That workspace does not exist.', 404);
    if (!isInside(this.deps.workspacesRoot, workspace.path)) {
      throw new WorkspaceServiceError('That workspace is outside the workspaces root.', 400);
    }
    if (existsSync(join(workspace.path, '.git'))) {
      throw new WorkspaceServiceError('This workspace already tracks a repository.', 409);
    }

    await mkdir(workspace.path, { recursive: true });
    const entries = await readdir(workspace.path);

    if (!gitUrl) {
      await this.git(workspace.path, ['init']);
      return { mode: 'initialised', branch: await this.currentBranch(workspace.path) };
    }

    if (entries.length === 0) {
      await this.cloneInto(workspace.path, gitUrl);
      return { mode: 'cloned', branch: await this.currentBranch(workspace.path) };
    }

    this.assertCloneableUrl(gitUrl);
    await this.git(workspace.path, ['init']);
    await this.git(workspace.path, ['remote', 'add', 'origin', gitUrl]);
    try {
      await this.git(workspace.path, ['fetch', '--depth', '50', 'origin'], 180_000);
    } catch (error) {
      // Leave the remote in place: the owner can fix credentials and retry
      // without starting over, and a half-connected repository is still more
      // useful than none.
      throw new WorkspaceServiceError(
        `The remote was added but could not be fetched: ${(error as Error).message.slice(0, 300)}`,
        422,
      );
    }
    return { mode: 'fetched', branch: null };
  }

  private async git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: CLONE_ENV,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
      throw new WorkspaceServiceError(stderr.slice(0, 500), 422);
    }
  }

  private async currentBranch(cwd: string): Promise<string | null> {
    try {
      return (await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)).trim() || null;
    } catch {
      return null;
    }
  }

  private uniqueSlug(base: string): string {
    if (!this.deps.repo.slugExists(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!this.deps.repo.slugExists(candidate)) return candidate;
    }
    throw new WorkspaceServiceError('Could not allocate a unique workspace slug.');
  }

  /**
   * Delete a workspace.
   * Files on disk are only removed when `purgeFiles` is set — losing an agent's
   * work to a mis-click is not recoverable, so it must be deliberate.
   */
  async delete(id: string, purgeFiles: boolean): Promise<boolean> {
    const workspace = this.deps.repo.get(id);
    if (!workspace) return false;

    if (purgeFiles) {
      if (!isInside(this.deps.workspacesRoot, workspace.path)) {
        this.deps.log('error', 'refusing to purge a workspace outside the workspaces root', {
          path: workspace.path,
        });
      } else {
        await rm(workspace.path, { recursive: true, force: true });
      }
    }
    return this.deps.repo.delete(id);
  }
}
