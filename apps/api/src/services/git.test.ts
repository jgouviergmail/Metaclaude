/**
 * The git service runs a real `git` binary inside the API process, in a
 * directory whose contents the agent writes. That makes it the one place where
 * a file the agent created can become a command the *server* executes, so these
 * tests are adversarial: each one builds a repository that attacks, and asserts
 * that nothing ran.
 *
 * They use a real git repository rather than a mock. A mock of git would only
 * prove that the mock agrees with the assumptions being tested, and the
 * assumption under test here is precisely what git does with a config file.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitError, GitService } from './git.js';

const execFileAsync = promisify(execFile);

let dir = '';
let marker = '';
let git: GitService;

/** A plain git invocation, for building the fixture rather than testing it. */
async function raw(args: string[], cwd = dir): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
  return stdout;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-git-'));
  marker = join(dir, 'EXECUTED');
  git = new GitService();
  await raw(['init', '-q', '.']);
  await writeFile(join(dir, 'f.txt'), 'hello\n');
  await raw(['add', '-A']);
  await raw(['commit', '-qm', 'init']);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Install a `.gitattributes` + `.git/config` pair that runs `script` on `f.txt`. */
async function arm(family: 'filter' | 'diff' | 'merge'): Promise<void> {
  const script = join(dir, 'payload.sh');
  await writeFile(script, `#!/bin/sh\necho owned > ${marker}\ncat\n`);
  await chmod(script, 0o755);

  const attr = family === 'diff' ? 'diff=pwn' : family === 'merge' ? 'merge=pwn' : 'filter=pwn';
  await writeFile(join(dir, '.gitattributes'), `* ${attr}\n`);

  const key =
    family === 'filter' ? 'filter.pwn.clean' : family === 'diff' ? 'diff.pwn.textconv' : 'merge.pwn.driver';
  await raw(['config', '--local', key, script]);
}

describe('a repository cannot turn a file write into a command', () => {
  it('refuses every operation once .git/config names a clean filter', async () => {
    await arm('filter');
    await writeFile(join(dir, 'f.txt'), 'changed\n');

    // The reproduction that motivated this: `git add` applies the clean filter.
    await expect(git.stage(dir, ['f.txt'])).rejects.toBeInstanceOf(GitError);
    expect(existsSync(marker)).toBe(false);

    // And it is not only the write paths — a read is refused too, because the
    // refusal is about the repository, not about the verb.
    await expect(git.status(dir)).rejects.toThrow(/would execute as a command/i);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a textconv driver', async () => {
    await arm('diff');
    await writeFile(join(dir, 'f.txt'), 'changed\n');
    await expect(git.diff(dir)).rejects.toThrow(/\.git\/config/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a merge driver', async () => {
    await arm('merge');
    await expect(git.status(dir)).rejects.toThrow(/would execute as a command/i);
    expect(existsSync(marker)).toBe(false);
  });

  it('names the offending key so the owner can fix it', async () => {
    await arm('filter');
    await expect(git.status(dir)).rejects.toThrow(/filter\.pwn\.clean/);
  });

  it('is not fooled by a value containing a newline', async () => {
    // A line-oriented parser reading `git config --list` would see the second
    // line as a key of its own and the real key as harmless. The listing is
    // NUL-delimited for this reason.
    const script = join(dir, 'payload.sh');
    await writeFile(script, `#!/bin/sh\necho owned > ${marker}\ncat\n`);
    await chmod(script, 0o755);
    await writeFile(join(dir, '.gitattributes'), '* filter=pwn\n');
    await raw(['config', '--local', 'filter.pwn.clean', `${script}\nnot.a.key=harmless`]);

    await expect(git.status(dir)).rejects.toThrow(/filter\.pwn\.clean/);
    expect(existsSync(marker)).toBe(false);
  });

  it('leaves an ordinary repository working', async () => {
    await writeFile(join(dir, 'f.txt'), 'changed\n');
    const status = await git.status(dir);
    expect(status.isRepo).toBe(true);
    expect(status.modified).toContain('f.txt');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('the child environment', () => {
  it('carries no server secret', async () => {
    process.env.METACLAUDE_MASTER_KEY = 'must-not-leak-0123456789';
    try {
      await writeFile(join(dir, 'f.txt'), 'changed\n');
      const diff = await git.diff(dir);
      expect(diff).not.toContain('must-not-leak');

      const status = await git.status(dir);
      expect(JSON.stringify(status)).not.toContain('must-not-leak');
    } finally {
      delete process.env.METACLAUDE_MASTER_KEY;
    }
  });

  it('can commit, which needs a committer identity the global config cannot supply', async () => {
    // GIT_CONFIG_GLOBAL is /dev/null by design, so a commit works only if the
    // service passes an identity itself. With only GIT_AUTHOR_* — which is what
    // compose.yml provided — git fails with "Committer identity unknown".
    await writeFile(join(dir, 'f.txt'), 'changed\n');
    await git.stage(dir, ['f.txt']);
    const sha = await git.commit(dir, 'a commit from the panel');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const log = await raw(['log', '-1', '--format=%an <%ae> | %cn <%ce> | %s']);
    expect(log.trim()).toContain('a commit from the panel');
    // Author and committer are both populated; neither is empty.
    const [author, committer] = log.split('|').map((s) => s.trim());
    expect(author).toMatch(/\S+ <\S+@\S+>/);
    expect(committer).toMatch(/\S+ <\S+@\S+>/);
  });

  it('honours GIT_AUTHOR_NAME when the owner sets one', async () => {
    process.env.GIT_AUTHOR_NAME = 'Owner Named In Env';
    process.env.GIT_AUTHOR_EMAIL = 'owner@example.com';
    try {
      await writeFile(join(dir, 'f.txt'), 'changed\n');
      await git.stage(dir, ['f.txt']);
      await git.commit(dir, 'attributed');
      const log = await raw(['log', '-1', '--format=%an|%ae|%cn|%ce']);
      expect(log.trim()).toBe('Owner Named In Env|owner@example.com|Owner Named In Env|owner@example.com');
    } finally {
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;
    }
  });
});

describe('the fixture itself is sound', () => {
  it('control: plain git DOES run the filter, so the refusals above mean something', async () => {
    await arm('filter');
    await writeFile(join(dir, 'f.txt'), 'changed\n');
    await raw(['add', '--', 'f.txt']);
    expect(existsSync(marker)).toBe(true);
    expect(await readFile(marker, 'utf8')).toContain('owned');
  });
});
