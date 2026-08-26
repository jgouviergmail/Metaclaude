/**
 * Git integration.
 *
 * Shelling out to `git` directly rather than pulling in a wrapper library: the
 * surface we need is small, `execFile` (never `exec`) means no shell and so no
 * command injection, and the porcelain v2 format is a stable contract.
 *
 * Only read and low-risk write operations are exposed. Anything destructive
 * (reset --hard, force push, history rewriting) is deliberately absent — the
 * agent can do those through the Bash tool, where they go through the permission
 * prompt and land in the audit log.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitStatus } from '@metaclaude/shared';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * The child's entire environment — a replacement, never a merge.
 *
 * `{ ...process.env }` used to be spread in here, which put
 * `METACLAUDE_MASTER_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and
 * `METACLAUDE_BOOTSTRAP_PASSWORD` into the environment of a process that a
 * repository can influence. Git executes several config values as commands, and
 * a repository-local `.git/config` is outside the reach of
 * `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL` — so that spread turned "a
 * repository was cloned" into "the master key is one `git add` away". The
 * driver families are refused outright below; this list is what keeps the
 * damage bounded if a mechanism is ever missed.
 *
 * The committer identity is here because git will not commit without one. The
 * global config is /dev/null by design, so there is nowhere else for it to come
 * from: with only `GIT_AUTHOR_*` set — which is all compose.yml provided — every
 * commit failed with "Committer identity unknown", and the Git panel's commit
 * button could not succeed in the shipped container.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const name = process.env.GIT_AUTHOR_NAME || 'Metaclaude';
  const email = process.env.GIT_AUTHOR_EMAIL || 'metaclaude@localhost';
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    // Not the operator's home, and not the container's either: nothing in a
    // home directory should influence how the agent's repositories are read.
    HOME: '/nonexistent',
    // Deterministic parsing for the porcelain output the methods below read.
    LANG: 'C',
    LC_ALL: 'C',
    TZ: process.env.TZ ?? 'UTC',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    // Colour codes and pager output would corrupt the parsers below.
    GIT_PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Config keys whose value git runs as a command.
 *
 * The previous defence pinned a handful of these on the command line, which
 * works only for keys that are known and singular. It cannot work for the
 * *driver* families — `filter.<name>.clean`, `diff.<name>.textconv`,
 * `merge.<name>.driver` — because the name is chosen by the repository and `-c`
 * has no wildcard. Reproduced against the exact argv this service built:
 * `.gitattributes` assigning `filter=x` plus a `.git/config` defining
 * `filter.x.clean` ran that command on `git add`, inside the API process.
 *
 * So the check is inverted. Rather than trying to out-pin a repository, refuse
 * to run at all in a worktree whose local config names a command. Reading the
 * config executes nothing, which is what makes the check safe to perform first.
 */
const EXECUTABLE_CONFIG_KEY =
  /^(?:filter\..*\.(?:clean|smudge|process)|diff\..*\.(?:textconv|command)|diff\.external|merge\..*\.driver|core\.(?:fsmonitor|hooksPath|sshCommand|askPass|editor|pager|gitProxy|alternateRefsCommand)|credential\.(?:.*\.)?helper|uploadpack\.packObjectsHook|gpg\.(?:.*\.)?program|trailer\..*\.command|sequence\.editor|pager\..*|alias\..*|browser\..*\.cmd|man\..*\.cmd|guitool\..*\.cmd|instaweb\.httpd|ssh\.variant)$/i;

/**
 * Config overrides applied to every invocation.
 *
 * `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL` cover the system and user files,
 * but not the **repository-local** `.git/config` — and several git settings name
 * a command that git then executes. `core.fsmonitor` is the sharp one: it runs
 * on a plain `git status`, which this service performs whenever the operator
 * opens a workspace page.
 *
 * That turns an approval-free file write into unapproved command execution: an
 * agent following an injected instruction writes `.git/config` (no prompt at all
 * in `acceptEdits` mode), and the command runs in the API process the next time
 * anyone looks at the workspace. Pinning these on the command line beats
 * anything a repository can set, so the permission prompt stays the only route
 * to executing something.
 */
const GIT_SAFE_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.sshCommand=',
  '-c', 'core.askPass=',
  '-c', 'core.editor=true',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'protocol.ext.allow=never',
  '-c', 'credential.helper=',
  '-c', 'uploadpack.packObjectsHook=',
] as const;

export class GitService {
  /** Raw invocation. Used by the guard itself, which cannot go through `run`. */
  private async exec(cwd: string, args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await execFileAsync('git', ['--no-pager', ...GIT_SAFE_CONFIG, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: gitEnv(),
    });
    return stdout;
  }

  /**
   * Refuse to touch a worktree whose local config names a command to run.
   *
   * `git config --list` parses; it does not invoke a single driver, so this is
   * safe to run before anything else. NUL-delimited because a config value may
   * contain newlines, and a value that spans lines is exactly what an attacker
   * would reach for to hide a key from a line-oriented parser.
   */
  private async assertNoExecutableConfig(cwd: string): Promise<void> {
    let raw: string;
    try {
      raw = await this.exec(cwd, ['config', '--local', '--list', '--null'], 5000);
    } catch {
      // No repository, or no local config to read. Nothing to refuse.
      return;
    }
    const offending = raw
      .split('\0')
      .map((entry) => entry.split('\n', 1)[0] ?? '')
      .filter((key) => key && EXECUTABLE_CONFIG_KEY.test(key));

    if (offending.length > 0) {
      const unique = [...new Set(offending)].slice(0, 5).join(', ');
      throw new GitError(
        `This repository's .git/config sets ${unique}, which git would execute as a command ` +
          `in the server process. Git operations are disabled for this workspace until those ` +
          `keys are removed. Nothing has been run.`,
        422,
      );
    }
  }

  /** Run a git command in `cwd`. Arguments are passed as an array, never a string. */
  private async run(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
    await this.assertNoExecutableConfig(cwd);
    try {
      return await this.exec(cwd, args, timeoutMs);
    } catch (error) {
      const err = error as { stderr?: string; code?: number | string; message: string };
      throw new GitError((err.stderr || err.message).slice(0, 2000), 422);
    }
  }

  async isRepository(cwd: string): Promise<boolean> {
    // Outside the catch. "This directory is not a repository" and "this
    // repository is booby-trapped" are different answers, and swallowing the
    // second into `false` would report a hostile worktree as an ordinary
    // folder — the panel would show "not a repository" and the owner would
    // never learn why.
    await this.assertNoExecutableConfig(cwd);
    try {
      const out = await this.exec(cwd, ['rev-parse', '--is-inside-work-tree'], 5000);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Working-tree status.
   *
   * Uses `status --porcelain=v2 -z`: NUL-separated so filenames containing
   * spaces, quotes or newlines parse correctly, which the v1 format cannot
   * guarantee.
   */
  async status(cwd: string): Promise<GitStatus> {
    if (!(await this.isRepository(cwd))) {
      return {
        isRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        untracked: [],
        conflicted: [],
      };
    }

    const raw = await this.run(cwd, ['status', '--porcelain=v2', '--branch', '-z']);
    const records = raw.split('\0');

    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const conflicted: string[] = [];

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record) continue;

      if (record.startsWith('# branch.head ')) {
        const head = record.slice('# branch.head '.length).trim();
        branch = head === '(detached)' ? null : head;
        continue;
      }
      if (record.startsWith('# branch.ab ')) {
        // Format: `# branch.ab +<ahead> -<behind>`
        const match = /\+(\d+)\s+-(\d+)/.exec(record);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
        continue;
      }
      if (record.startsWith('#')) continue;

      const kind = record[0];
      if (kind === '?') {
        untracked.push(record.slice(2));
      } else if (kind === 'u') {
        // Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
        const path = record.split(' ').slice(10).join(' ');
        if (path) conflicted.push(path);
      } else if (kind === '1') {
        // Ordinary: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
        const parts = record.split(' ');
        const xy = parts[1] ?? '..';
        const path = parts.slice(8).join(' ');
        if (!path) continue;
        if (xy[0] !== '.') staged.push(path);
        if (xy[1] !== '.') modified.push(path);
      } else if (kind === '2') {
        // Renamed/copied: the path field is `<new>\0<old>`, so the original
        // path occupies the following NUL-separated record.
        const parts = record.split(' ');
        const xy = parts[1] ?? '..';
        const path = parts.slice(9).join(' ');
        i += 1; // Skip the original path record.
        if (!path) continue;
        if (xy[0] !== '.') staged.push(path);
        if (xy[1] !== '.') modified.push(path);
      }
    }

    return { isRepo: true, branch, ahead, behind, staged, modified, untracked, conflicted };
  }

  /** Unified diff. `staged` selects the index rather than the working tree. */
  async diff(cwd: string, options: { path?: string; staged?: boolean } = {}): Promise<string> {
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (options.staged) args.push('--cached');
    if (options.path) args.push('--', options.path);
    return this.run(cwd, args, 60_000);
  }

  async log(cwd: string, limit = 30): Promise<
    Array<{ hash: string; author: string; date: number; subject: string }>
  > {
    // Unit separator between fields, record separator between commits: neither
    // can appear in a commit message, unlike the usual `|` delimiter.
    const format = '%H%x1f%an%x1f%at%x1f%s%x1e';
    const raw = await this.run(cwd, ['log', `--max-count=${Math.min(limit, 200)}`, `--format=${format}`]);

    return raw
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.trim().length > 0)
      .map((record) => {
        const [hash = '', author = '', date = '0', subject = ''] = record.split('\x1f');
        return { hash, author, date: Number(date) * 1000, subject };
      });
  }

  async branches(cwd: string): Promise<{ current: string | null; all: string[] }> {
    const raw = await this.run(cwd, ['branch', '--format=%(refname:short)%(HEAD)']);
    const all: string[] = [];
    let current: string | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.endsWith('*')) {
        const name = trimmed.slice(0, -1).trim();
        current = name;
        all.push(name);
      } else {
        all.push(trimmed);
      }
    }
    return { current, all };
  }

  async stage(cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // `--` terminates option parsing so a path beginning with `-` is treated as
    // a path and not as a flag.
    await this.run(cwd, ['add', '--', ...paths]);
  }

  async unstage(cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(cwd, ['restore', '--staged', '--', ...paths]);
  }

  async commit(cwd: string, message: string): Promise<string> {
    const trimmed = message.trim();
    if (!trimmed) throw new GitError('A commit needs a message.');
    // `-m` takes the message as a single argv element, so no escaping is needed
    // and no shell ever sees it.
    await this.run(cwd, ['commit', '-m', trimmed]);
    return (await this.run(cwd, ['rev-parse', 'HEAD'])).trim();
  }

  /** Numstat summary for the current working tree, for the diff viewer. */
  async changedFiles(
    cwd: string,
    staged = false,
  ): Promise<Array<{ path: string; additions: number; deletions: number }>> {
    // `--no-ext-diff` for the same reason `diff.external` is pinned empty: a
    // repository must not be able to name a program that this call then runs.
    const args = ['diff', '--numstat', '--no-color', '--no-ext-diff'];
    if (staged) args.push('--cached');
    const raw = await this.run(cwd, args);

    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [additions = '0', deletions = '0', ...rest] = line.split('\t');
        return {
          path: rest.join('\t'),
          // A dash means a binary file; report it as zero rather than NaN.
          additions: additions === '-' ? 0 : Number(additions),
          deletions: deletions === '-' ? 0 : Number(deletions),
        };
      })
      .filter((entry) => entry.path.length > 0);
  }
}
