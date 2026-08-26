/**
 * `additionalDirectories` policy.
 *
 * This setting is the only place an operator can widen the agent's filesystem
 * scope beyond the workspace, and the CLI honours whatever it is handed without
 * an approval prompt. Every case below is an escape attempt.
 */

import { describe, expect, it } from 'vitest';
import { reviewAdditionalDirectories } from './directories.js';

const POLICY = { workspacesDir: '/srv/metaclaude/workspaces', dataDir: '/srv/metaclaude/data' };

/** Just the reasons, for readable assertions. */
const reasons = (paths: string[]) =>
  reviewAdditionalDirectories(paths, POLICY).rejected.map((entry) => entry.reason);

describe('reviewAdditionalDirectories', () => {
  it('allows a sibling workspace', () => {
    const review = reviewAdditionalDirectories(['/srv/metaclaude/workspaces/other'], POLICY);
    expect(review.allowed).toEqual(['/srv/metaclaude/workspaces/other']);
    expect(review.rejected).toEqual([]);
  });

  it('normalises and de-duplicates', () => {
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

  it('refuses the data directory even when it is nested under the workspaces root', () => {
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

  it('works under the layout the image actually ships', () => {
    // Every case above puts `dataDir` beside the workspaces root or beneath it.
    // `docker/Dockerfile` does the opposite: METACLAUDE_DATA_DIR is
    // /var/lib/metaclaude and METACLAUDE_WORKSPACES_DIR is
    // /var/lib/metaclaude/workspaces — the data directory is the *parent*.
    //
    // Under that layout every candidate is inside `dataRoot` by construction,
    // so a blanket "is inside the data directory" refusal rejected all of them
    // and the feature could not work at all in the shipped image. Being under
    // the data root is only disqualifying when the target is not also under the
    // workspaces root, which is the part the operator is allowed to reach.
    const shipped = {
      workspacesDir: '/var/lib/metaclaude/workspaces',
      dataDir: '/var/lib/metaclaude',
    };
    const review = reviewAdditionalDirectories(
      ['/var/lib/metaclaude/workspaces/shared-lib', '/var/lib/metaclaude', '/etc'],
      shipped,
    );

    expect(review.allowed).toEqual(['/var/lib/metaclaude/workspaces/shared-lib']);
    expect(review.rejected).toHaveLength(2);
  });

  it('refuses a directory that would contain the data directory', () => {
    const nested = { workspacesDir: '/srv/mc', dataDir: '/srv/mc/inner/data' };
    // Granting `/srv/mc/inner` grants the data directory beneath it.
    expect(reviewAdditionalDirectories(['/srv/mc/inner'], nested).allowed).toEqual([]);
  });

  it('rejects a NUL byte and skips blanks without failing the rest', () => {
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
