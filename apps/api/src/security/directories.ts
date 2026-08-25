/**
 * Validation for `additionalDirectories`.
 *
 * A workspace can grant a run read/write access to directories outside its own
 * root — useful for a shared reference checkout or a sibling workspace, and
 * dangerous everywhere else. The value is an arbitrary absolute path chosen by
 * an operator, and the CLI treats whatever it is given as an allowed root.
 *
 * Left unvalidated it is a straight privilege escalation: `/` hands the agent
 * the whole container; the data directory hands it `metaclaude.db` (session and
 * password hashes, the encrypted vault) and `master.key`, which together are
 * every credential the OS holds. Neither goes through the approval flow, since
 * from the CLI's point of view the directory is simply in scope.
 *
 * The rule enforced here: an additional directory must live under the
 * workspaces root, and must neither be nor contain the data directory. That
 * admits the legitimate case (another workspace, a checkout the operator put
 * there) and refuses everything else, including the case where the deployment
 * has nested the two directories.
 */

import { resolve } from 'node:path';
import { isInside } from './paths.js';

export interface DirectoryPolicy {
  /** Absolute root that every workspace lives under. */
  workspacesDir: string;
  /** Absolute Metaclaude data directory — never grantable. */
  dataDir: string;
}

export interface DirectoryReview {
  /** Resolved, de-duplicated paths that may be granted. */
  allowed: string[];
  /** Rejected inputs, with the reason, for the operator's benefit. */
  rejected: { path: string; reason: string }[];
}

/**
 * Partition a list of candidate directories into allowed and rejected.
 *
 * Never throws: the supervisor calls it on every run and must not fail a run
 * because a stale setting has become invalid — it drops the entry instead.
 */
export function reviewAdditionalDirectories(
  candidates: readonly string[],
  policy: DirectoryPolicy,
): DirectoryReview {
  const workspacesRoot = resolve(policy.workspacesDir);
  const dataRoot = resolve(policy.dataDir);

  const allowed: string[] = [];
  const rejected: { path: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const raw = candidate.trim();
    if (raw.length === 0) continue;

    if (raw.includes('\0')) {
      rejected.push({ path: candidate, reason: 'contains a NUL byte' });
      continue;
    }

    const target = resolve(raw);

    if (!isInside(workspacesRoot, target)) {
      rejected.push({ path: raw, reason: `is outside ${workspacesRoot}` });
      continue;
    }
    // Granting the workspaces root itself grants every workspace at once, which
    // is never what a per-workspace setting should mean.
    if (target === workspacesRoot) {
      rejected.push({ path: raw, reason: 'is the workspaces root itself' });
      continue;
    }
    // Covers a data directory nested under the workspaces root, in either
    // direction: the grant must not reach it and must not contain it.
    if (isInside(dataRoot, target) || isInside(target, dataRoot)) {
      rejected.push({ path: raw, reason: 'would expose the Metaclaude data directory' });
      continue;
    }

    if (seen.has(target)) continue;
    seen.add(target);
    allowed.push(target);
  }

  return { allowed, rejected };
}
