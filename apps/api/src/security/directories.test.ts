/**
 * `additionalDirectories` policy.
 *
 * This setting is the only place an operator can widen the agent's filesystem
 * scope beyond the workspace, and the CLI honours whatever it is handed without
 * an approval prompt. Every case below is an escape attempt.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reviewAdditionalDirectories } from './directories.js';
import { POSIX } from '../testing/platform.js';

const POLICY = { workspacesDir: '/srv/metaclaude/workspaces', dataDir: '/srv/metaclaude/data' };

/** Just the reasons, for readable assertions. */
const reasons = (paths: string[]) =>
  reviewAdditionalDirectories(paths, POLICY).rejected.map((entry) => entry.reason);

describe('reviewAdditionalDirectories', () => {
  it.skipIf(!POSIX)('allows a sibling workspace', () => {
    const review = reviewAdditionalDirectories(['/srv/metaclaude/workspaces/other'], POLICY);
    expect(review.allowed).toEqual(['/srv/metaclaude/workspaces/other']);
    expect(review.rejected).toEqual([]);
  });

  it.skipIf(!POSIX)('normalises and de-duplicates', () => {
    const review = reviewAdditionalDirectories(
      [
        '/srv/metaclaude/workspaces/a',
        '/srv/metaclaude/workspaces/a/',
        '/srv/metaclaude/workspaces/b/../a',
        '  /srv/metaclaude/workspaces/a  ',
      ],
      POLICY,
    );
    expect(review.allowed).toEqual(['/srv/metaclaude/workspaces/a']);
  });

  it('refuses anything outside the workspaces root', () => {
    expect(
      reviewAdditionalDirectories(['/', '/etc', '/root', '/proc/self', '/srv/metaclaude'], POLICY)
        .allowed,
    ).toEqual([]);
    expect(reasons(['/etc'])[0]).toMatch(/outside/);
  });

  it('refuses a traversal that climbs out of the root', () => {
    const review = reviewAdditionalDirectories(
      ['/srv/metaclaude/workspaces/../data', '/srv/metaclaude/workspaces/a/../../../etc'],
      POLICY,
    );
    expect(review.allowed).toEqual([]);
  });

  it('is not fooled by a sibling directory sharing the root prefix', () => {
    // `/srv/metaclaude/workspaces-evil` starts with the root as a *string* but
    // is not inside it.
    expect(reviewAdditionalDirectories(['/srv/metaclaude/workspaces-evil'], POLICY).allowed).toEqual(
      [],
    );
  });

  it('refuses the workspaces root itself', () => {
    const review = reviewAdditionalDirectories(['/srv/metaclaude/workspaces'], POLICY);
    expect(review.allowed).toEqual([]);
    expect(review.rejected[0]?.reason).toMatch(/workspaces root/);
  });

  it.skipIf(!POSIX)('refuses the data directory even when it is nested under the workspaces root', () => {
    const nested = {
      workspacesDir: '/srv/mc/workspaces',
      dataDir: '/srv/mc/workspaces/.metaclaude',
    };
    const review = reviewAdditionalDirectories(
      [
        '/srv/mc/workspaces/.metaclaude',
        '/srv/mc/workspaces/.metaclaude/vault',
        '/srv/mc/workspaces/project',
      ],
      nested,
    );
    // The database, the vault and the master key all live under the data dir;
    // reaching any of them is game over.
    expect(review.allowed).toEqual(['/srv/mc/workspaces/project']);
    expect(review.rejected).toHaveLength(2);
    expect(review.rejected[0]?.reason).toMatch(/data directory/);
  });

  it.skipIf(!POSIX)('works under the layout the image actually ships', () => {
    // `docker/Dockerfile`: METACLAUDE_DATA_DIR=/var/lib/metaclaude and
    // METACLAUDE_WORKSPACES_DIR=/srv/metaclaude/workspaces — two separate roots,
    // neither containing the other, which `loadConfig` now requires.
    //
    // It shipped nested, and that is what this case exists to keep from coming
    // back: with the workspaces root inside the data directory, every candidate
    // was inside `dataRoot` by construction, so a blanket "is inside the data
    // directory" refusal rejected all of them and the feature was inert in the
    // only configuration that shipped.
    const shipped = {
      workspacesDir: '/srv/metaclaude/workspaces',
      dataDir: '/var/lib/metaclaude',
    };
    const review = reviewAdditionalDirectories(
      ['/srv/metaclaude/workspaces/shared-lib', '/var/lib/metaclaude', '/etc'],
      shipped,
    );

    expect(review.allowed).toEqual(['/srv/metaclaude/workspaces/shared-lib']);
    // The *reasons*, not just the count: asserting only `toHaveLength(2)` let
    // the whole data-directory branch be deleted with this test still green,
    // which is the failure CLAUDE.md's "prove a new test can fail" is about.
    expect(review.rejected.map((entry) => entry.path)).toEqual([
      '/var/lib/metaclaude',
      '/etc',
    ]);
    for (const entry of review.rejected) {
      expect(entry.reason).toMatch(/is outside|workspaces root|data directory/);
    }
  });

  it('refuses a candidate that reaches the data directory through a symlink', () => {
    // The check compares path names, so without resolving them it was checking
    // a name rather than a place: a link inside the workspaces root pointing at
    // the data directory passed `isInside(workspacesRoot, target)` on its
    // spelling and granted the agent the master key and the database.
    const base = mkdtempSync(join(tmpdir(), 'mc-dirs-'));
    const dataDir = join(base, 'metaclaude');
    const workspacesDir = join(dataDir, 'workspaces');
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(join(dataDir, 'master.key'), 'secret');
    symlinkSync(dataDir, join(workspacesDir, 'looks-like-a-workspace'), 'dir');

    const review = reviewAdditionalDirectories(
      [join(workspacesDir, 'looks-like-a-workspace')],
      { workspacesDir, dataDir },
    );
    expect(review.allowed).toEqual([]);
    // "is outside the workspaces root", not "would expose the data directory":
    // once resolved, the target genuinely is outside, and that is the more
    // accurate of the two things to tell the operator.
    expect(review.rejected[0]?.reason).toMatch(/is outside/);

    rmSync(base, { recursive: true, force: true });
  });

  it('does not pretend to bound what a symlink *inside* a granted directory reaches', () => {
    // Deliberately asserting the limit rather than a defence, because there is
    // no path check that could provide one: the agent writes inside the
    // directory it was granted, so any link it creates there postdates every
    // check. The same is true of its own workspace, which is why this is a
    // property of directory grants rather than a hole in this function.
    // docs/SECURITY.md says so; what is bounded here is which directory is
    // *named*.
    const base = mkdtempSync(join(tmpdir(), 'mc-dirs-'));
    const dataDir = join(base, 'metaclaude');
    const workspacesDir = join(dataDir, 'workspaces');
    const shared = join(workspacesDir, 'shared-lib');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(dataDir, 'master.key'), 'secret');

    const review = reviewAdditionalDirectories([shared], { workspacesDir, dataDir });
    expect(review.allowed).toEqual([shared]);

    // Created after the grant, as an agent would.
    symlinkSync(dataDir, join(shared, 'escape'), 'dir');
    expect(reviewAdditionalDirectories([shared], { workspacesDir, dataDir }).allowed).toEqual([
      shared,
    ]);

    rmSync(base, { recursive: true, force: true });
  });

  it('refuses a directory that would contain the data directory', () => {
    const nested = { workspacesDir: '/srv/mc', dataDir: '/srv/mc/inner/data' };
    // Granting `/srv/mc/inner` grants the data directory beneath it.
    expect(reviewAdditionalDirectories(['/srv/mc/inner'], nested).allowed).toEqual([]);
  });

  it.skipIf(!POSIX)('rejects a NUL byte and skips blanks without failing the rest', () => {
    const review = reviewAdditionalDirectories(
      ['', '   ', '/srv/metaclaude/workspaces/ok\0/etc', '/srv/metaclaude/workspaces/ok'],
      POLICY,
    );
    expect(review.allowed).toEqual(['/srv/metaclaude/workspaces/ok']);
    expect(review.rejected).toHaveLength(1);
    expect(review.rejected[0]?.reason).toMatch(/NUL/);
  });

  it('never throws, whatever it is given', () => {
    expect(() => reviewAdditionalDirectories([], POLICY)).not.toThrow();
    expect(() =>
      reviewAdditionalDirectories(['relative/path', '~/home', '\\\\unc\\share'], POLICY),
    ).not.toThrow();
    // A relative path resolves against the process cwd, which is not the
    // workspaces root, so it is rejected rather than silently accepted.
    expect(reviewAdditionalDirectories(['relative/path'], POLICY).allowed).toEqual([]);
  });
});
