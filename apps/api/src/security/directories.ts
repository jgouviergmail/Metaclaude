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
    // The grant must neither reach the data directory nor contain it.
    //
    // The first half is conditional, and that is the whole subtlety: the
    // shipped image puts the workspaces root *inside* the data directory —
    // METACLAUDE_DATA_DIR=/var/lib/metaclaude,
    // METACLAUDE_WORKSPACES_DIR=/var/lib/metaclaude/workspaces — so every legal
    // candidate is under `dataRoot` by construction. A blanket refusal
    // therefore rejected all of them and left the feature inert in the only
    // configuration that actually ships, while every test here used a layout
    // where the two are siblings and never noticed.
    //
    // Which exemption applies depends on which directory contains which, and
    // both layouts are real:
    //
    //   data/workspaces   (shipped)  every legal candidate is under dataRoot,
    //                                so only one *outside* workspacesRoot is
    //                                reaching for something it should not
    //   workspaces/.data  (nested)   dataRoot is below workspacesRoot, so being
    //                                under dataRoot is disqualifying outright
    //
    // Getting this backwards is how the shipped layout came to reject
    // everything — and exempting the workspaces subtree unconditionally would
    // hand out the vault under the nested one.
    const workspacesUnderData = workspacesRoot !== dataRoot && isInside(dataRoot, workspacesRoot);
    const reachesData = workspacesUnderData
      ? isInside(dataRoot, target) && !isInside(workspacesRoot, target)
      : isInside(dataRoot, target);
    if (reachesData || isInside(target, dataRoot)) {
      rejected.push({ path: raw, reason: 'would expose the Metaclaude data directory' });
      continue;
    }

    if (seen.has(target)) continue;
    seen.add(target);
    allowed.push(target);
  }

  return { allowed, rejected };
}
