/**
 * Path jailing.
 *
 * Every filesystem operation exposed over HTTP funnels through `resolveInside`.
 * The rule is simple and absolute: a resolved real path must remain under its
 * jail root, symlinks included. Anything else is rejected before an fd is
 * opened, not after.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path "${requested}" resolves outside its workspace.`);
    this.name = 'PathEscapeError';
  }
}

/** Reserved names that must never be addressable through the file API. */
const BLOCKED_SEGMENTS = new Set(['.git-credentials', '.netrc', 'master.key']);

/**
 * True when `child` is `root` itself or lives beneath it.
 * Uses `path.relative` rather than string prefixing, which would accept
 * `/data/workspaces-evil` as being inside `/data/workspaces`.
 */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a user-supplied, workspace-relative path against its jail root.
 *
 * @param root      Absolute jail root (the workspace directory).
 * @param userPath  Untrusted relative path from the client.
 * @returns         An absolute path guaranteed to be inside `root`.
 * @throws PathEscapeError when the path escapes, or contains a NUL byte.
 */
export function resolveInside(root: string, userPath: string): string {
  if (userPath.includes('\0')) throw new PathEscapeError(userPath);

  const absoluteRoot = resolve(root);

  // Treat a leading "/" as workspace-root-relative rather than filesystem-root.
  const cleaned = normalize(userPath).replace(/^([/\\]+)/, '');
  const candidate = resolve(absoluteRoot, cleaned);

  if (!isInside(absoluteRoot, candidate)) throw new PathEscapeError(userPath);

  for (const segment of relative(absoluteRoot, candidate).split(sep)) {
    if (BLOCKED_SEGMENTS.has(segment)) throw new PathEscapeError(userPath);
  }

  // Resolve symlinks so a link planted inside the workspace cannot point out of
  // it. A non-existent path is fine (we may be creating it) — in that case we
  // verify the nearest existing ancestor instead.
  const realRoot = safeRealpath(absoluteRoot);
  const realCandidate = safeRealpath(candidate);
  if (!isInside(realRoot, realCandidate)) throw new PathEscapeError(userPath);

  return candidate;
}

/**
 * `realpathSync` that walks up to the closest existing ancestor instead of
 * throwing on a path that does not exist yet.
 */
function safeRealpath(target: string): string {
  let current = resolve(target);
  const suffixes: string[] = [];

  for (;;) {
    try {
      const real = realpathSync(current);
      return suffixes.length > 0 ? resolve(real, ...suffixes.reverse()) : real;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return current; // Reached the filesystem root.
      suffixes.push(relative(parent, current));
      current = parent;
    }
  }
}

/** Normalise an absolute path back to the POSIX, workspace-relative form. */
export function toRelative(root: string, absolutePath: string): string {
  return relative(resolve(root), resolve(absolutePath)).split(sep).join('/');
}

/**
 * Turn arbitrary user text into a safe directory slug.
 * Always returns a non-empty string that is a valid single path segment.
 */
export function slugify(input: string, fallback = 'workspace'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}
