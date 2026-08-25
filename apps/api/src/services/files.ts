/**
 * Workspace filesystem access.
 *
 * Every method takes a workspace-relative path and funnels it through
 * `resolveInside`, so a traversal attempt fails before any file descriptor is
 * opened. Directory listings additionally skip entries that would be useless or
 * dangerous to surface (`.git` internals, `node_modules`, sockets, devices).
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FileEntry } from '@metaclaude/shared';
import { languageForPath, MAX_EDITABLE_FILE_BYTES } from '@metaclaude/shared';
import { PathEscapeError, resolveInside, toRelative } from '../security/paths.js';

export class FileServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'FileServiceError';
  }
}

/**
 * Directories that are always hidden from the browser tree.
 *
 * These are large, uninteresting, and in `.git`'s case actively hazardous to
 * expose (it contains credentials in some configurations).
 */
const HIDDEN_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  '.next',
  '.turbo',
  'target',
  '.gradle',
  'vendor',
  '.terraform',
]);

/** Extensions we will not attempt to render as text. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'pdf', 'zip', 'tar', 'gz', 'bz2', 'xz', 'zst', '7z', 'rar',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'class', 'jar',
  'db', 'sqlite', 'sqlite3', 'wasm',
]);

export interface ReadFileResult {
  path: string;
  content: string;
  language: string | null;
  size: number;
  truncated: boolean;
  modifiedAt: number;
}

export class FileService {
  /**
   * List a directory.
   *
   * @param root       Absolute workspace directory (the jail).
   * @param relative   Workspace-relative directory to list; `''` is the root.
   * @param showHidden Include dotfiles and the normally-hidden directories.
   */
  async list(root: string, relative: string, showHidden = false): Promise<FileEntry[]> {
    const target = this.resolve(root, relative);

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (error) {
      throw this.wrap(error, relative);
    }

    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const name = dirent.name;
      if (!showHidden) {
        if (name.startsWith('.') && name !== '.env.example') continue;
        if (dirent.isDirectory() && HIDDEN_DIRECTORIES.has(name)) continue;
      }
      // Sockets, FIFOs and device nodes cannot be usefully rendered and reading
      // one can block indefinitely.
      if (!dirent.isFile() && !dirent.isDirectory() && !dirent.isSymbolicLink()) continue;

      const absolute = join(target, name);
      let stats;
      try {
        stats = await stat(absolute);
      } catch {
        continue; // Broken symlink or a race with a concurrent delete.
      }

      const path = toRelative(root, absolute);
      entries.push({
        name,
        path,
        type: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
        size: stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
        language: dirent.isDirectory() ? null : languageForPath(name),
      });
    }

    // Directories first, then case-insensitive alphabetical — the ordering a
    // file explorer is expected to have.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return entries;
  }

  async read(root: string, relative: string): Promise<ReadFileResult> {
    const target = this.resolve(root, relative);

    let stats;
    try {
      stats = await stat(target);
    } catch (error) {
      throw this.wrap(error, relative);
    }
    if (stats.isDirectory()) throw new FileServiceError(`"${relative}" is a directory.`, 400);

    const extension = basename(relative).split('.').pop()?.toLowerCase() ?? '';
    if (BINARY_EXTENSIONS.has(extension)) {
      throw new FileServiceError(`"${relative}" is a binary file and cannot be displayed.`, 415);
    }

    const truncated = stats.size > MAX_EDITABLE_FILE_BYTES;
    const buffer = truncated
      ? await this.readPrefix(target, MAX_EDITABLE_FILE_BYTES)
      : await readFile(target);

    // A NUL byte in the first block is the reliable signal for "actually binary"
    // regardless of what the extension claims.
    if (buffer.subarray(0, 8192).includes(0)) {
      throw new FileServiceError(`"${relative}" appears to be binary.`, 415);
    }

    return {
      path: relative,
      content: buffer.toString('utf8'),
      language: languageForPath(relative),
      size: stats.size,
      truncated,
      modifiedAt: Math.floor(stats.mtimeMs),
    };
  }

  async write(root: string, relative: string, content: string): Promise<FileEntry> {
    const target = this.resolve(root, relative);
    if (content.length > MAX_EDITABLE_FILE_BYTES) {
      throw new FileServiceError('The file is too large to save through the editor.', 413);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');

    const stats = await stat(target);
    return {
      name: basename(relative),
      path: relative,
      type: 'file',
      size: stats.size,
      modifiedAt: Math.floor(stats.mtimeMs),
      language: languageForPath(relative),
    };
  }

  async createDirectory(root: string, relative: string): Promise<void> {
    await mkdir(this.resolve(root, relative), { recursive: true });
  }

  async remove(root: string, relative: string): Promise<void> {
    const target = this.resolve(root, relative);
    if (target === root) throw new FileServiceError('The workspace root cannot be deleted.', 400);
    await rm(target, { recursive: true, force: true });
  }

  async move(root: string, from: string, to: string): Promise<void> {
    const source = this.resolve(root, from);
    const destination = this.resolve(root, to);
    if (source === root) throw new FileServiceError('The workspace root cannot be moved.', 400);
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }

  /**
   * Recursive search by filename fragment.
   * Bounded in both breadth and depth so a huge tree cannot stall the request.
   */
  async search(
    root: string,
    fragment: string,
    options: { limit?: number; maxDepth?: number } = {},
  ): Promise<FileEntry[]> {
    const needle = fragment.trim().toLowerCase();
    if (needle.length < 2) return [];

    const limit = Math.min(options.limit ?? 50, 200);
    const maxDepth = options.maxDepth ?? 8;
    const results: FileEntry[] = [];

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (results.length >= limit || depth > maxDepth) return;

      let dirents;
      try {
        dirents = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const dirent of dirents) {
        if (results.length >= limit) return;
        if (dirent.name.startsWith('.')) continue;
        if (dirent.isDirectory() && HIDDEN_DIRECTORIES.has(dirent.name)) continue;

        const absolute = join(directory, dirent.name);
        if (dirent.isDirectory()) {
          await walk(absolute, depth + 1);
        } else if (dirent.isFile() && dirent.name.toLowerCase().includes(needle)) {
          try {
            const stats = await stat(absolute);
            results.push({
              name: dirent.name,
              path: toRelative(root, absolute),
              type: 'file',
              size: stats.size,
              modifiedAt: Math.floor(stats.mtimeMs),
              language: languageForPath(dirent.name),
            });
          } catch {
            // Skip files that vanished mid-walk.
          }
        }
      }
    };

    await walk(root, 0);
    return results;
  }

  /* ---------------------------------------------------------------------- */

  private resolve(root: string, relative: string): string {
    try {
      return resolveInside(root, relative);
    } catch (error) {
      if (error instanceof PathEscapeError) {
        throw new FileServiceError('That path is outside the workspace.', 403);
      }
      throw error;
    }
  }

  private async readPrefix(path: string, bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let read = 0;
    const stream = createReadStream(path, { end: bytes - 1 });
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      chunks.push(buffer);
      read += buffer.length;
      if (read >= bytes) break;
    }
    return Buffer.concat(chunks).subarray(0, bytes);
  }

  private wrap(error: unknown, relative: string): FileServiceError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new FileServiceError(`"${relative}" does not exist.`, 404);
    if (code === 'EACCES' || code === 'EPERM') {
      return new FileServiceError(`"${relative}" is not readable.`, 403);
    }
    if (code === 'ENOTDIR') return new FileServiceError(`"${relative}" is not a directory.`, 400);
    return new FileServiceError((error as Error).message, 500);
  }
}
