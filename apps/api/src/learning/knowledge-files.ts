/**
 * The original file, kept.
 *
 * A document's *text* is what retrieval needs; the file is what makes two
 * other things possible. An operator can download what they uploaded, which
 * is the difference between a library and a one-way funnel. And the document
 * can be **re-extracted** when an extractor improves — without it, every
 * document read by a weaker engine would be stuck that way until somebody
 * found the original and dropped it again.
 *
 * Named by content hash, like the message attachments: the bytes behind an id
 * never change, two uploads of one file cost one copy, and a hostile filename
 * cannot reach the filesystem at all. Under `dataDir`, not under a workspace:
 * a document reaches several workspaces now, so it belongs to none of them.
 */

import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReadStream } from 'node:fs';

import { resolveInside } from '../security/paths.js';

/**
 * The extension a stored file gets, by MIME.
 *
 * From the *type*, never from the uploaded name: the name is user input and
 * the type has already been checked against a closed list. It exists only so
 * a person browsing the data directory, or a `file` command, can tell what
 * they are looking at.
 */
const EXTENSION: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export const extensionFor = (mime: string): string => EXTENSION[mime] ?? 'bin';

export class KnowledgeFileStore {
  constructor(private readonly dir: string) {}

  /** `<dir>/<sha256>.<ext>`, jailed — the hash is hex, so this cannot escape. */
  pathFor(sha256: string, mime: string): string {
    return resolveInside(this.dir, `${sha256}.${extensionFor(mime)}`);
  }

  exists(sha256: string, mime: string): boolean {
    return existsSync(this.pathFor(sha256, mime));
  }

  /**
   * Write the bytes, and return where they went.
   *
   * Through a `.part` and a rename: an interrupted write must not leave a
   * truncated file under the name the database is about to point at, which
   * would be a document whose original silently no longer parses.
   */
  async write(sha256: string, mime: string, data: Buffer): Promise<string> {
    const target = this.pathFor(sha256, mime);
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.part`;
    await writeFile(partial, data);
    await rename(partial, target);
    return target;
  }

  read(sha256: string, mime: string): Promise<Buffer> {
    return readFile(this.pathFor(sha256, mime));
  }

  stream(sha256: string, mime: string): ReadStream {
    return createReadStream(this.pathFor(sha256, mime));
  }

  /** Idempotent: a file already gone is the state the caller wanted. */
  async remove(sha256: string, mime: string): Promise<void> {
    try {
      await unlink(this.pathFor(sha256, mime));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
