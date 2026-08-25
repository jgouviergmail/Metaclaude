/**
 * Workspace service.
 *
 * A workspace is a directory plus a policy. Creating one provisions the
 * directory (optionally seeded from a git clone) and writes a starter
 * `CLAUDE.md` so the agent has project context from the first run.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CreateWorkspaceRequest, Workspace, WorkspaceSettings } from '@metaclaude/shared';
import { WorkspaceSettings as WorkspaceSettingsSchema } from '@metaclaude/shared';
import { isInside, slugify } from '../security/paths.js';
import { defaultWorkspaceSettings, type WorkspaceRepo } from '../kernel/repositories.js';

const execFileAsync = promisify(execFile);

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
  private async cloneInto(path: string, gitUrl: string): Promise<void> {
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

    try {
      await execFileAsync('git', ['clone', '--depth', '50', '--', gitUrl, path], {
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          // Never let git block on an interactive credential or host-key prompt
          // inside a container with no TTY.
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
        },
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
      throw new WorkspaceServiceError(`Clone failed: ${stderr.slice(0, 500)}`, 422);
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
