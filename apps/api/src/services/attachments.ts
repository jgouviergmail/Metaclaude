/**
 * Message attachments — files a prompt carries.
 *
 * The bytes live on disk under the workspace's `attachments/` directory, named
 * by content hash, which buys three things at once: the agent's own tools can
 * read them (Read handles images and PDFs natively, everything else goes
 * through ordinary tooling), the Files browser shows them, and two uploads of
 * the same file cost one copy. The database row is the ledger — who uploaded
 * what into which session, and which run consumed it.
 *
 * Binding an attachment to a run is the write-is-the-check: the UPDATE only
 * lands where `run_id IS NULL`, so a pending upload can be sent exactly once
 * however many submissions race for it.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReadStream } from 'node:fs';
import type { Attachment } from '@metaclaude/shared';
import { ATTACHMENT_LIMITS, ATTACHMENT_MIME_TYPES, newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { resolveInside } from '../security/paths.js';

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

interface AttachmentRow {
  id: string;
  workspace_id: string;
  session_id: string;
  run_id: string | null;
  name: string;
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
  created_at: number;
}

const ALLOWED_MIME = new Set<string>(ATTACHMENT_MIME_TYPES);

/**
 * A few browsers hand over an empty MIME type for perfectly ordinary files
 * (drag-dropped .md on some platforms, for one). Inferring from the extension
 * for exactly the types we already allow is not a loosening of the allowlist —
 * an unknown extension still refuses.
 */
const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    runId: row.run_id,
    name: row.name,
    path: row.path,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

/**
 * A display name safe to embed in a filesystem path. The stored file is named
 * by hash first, so this only has to be readable, never unique — and it must
 * never be able to traverse (the hostile `../../etc/passwd` becomes
 * `etc-passwd` long before resolveInside sees it).
 */
export function safeFileName(original: string): string {
  const base = original.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return cleaned || 'file';
}

export class AttachmentService {
  constructor(private readonly db: Db) {}

  /**
   * Validate, write to disk and record one uploaded file.
   *
   * The workspace path is trusted exactly as far as the rest of the product
   * trusts it (it is the jail root); everything user-supplied — name, MIME,
   * bytes — is checked here.
   */
  async save(
    workspace: { id: string; path: string },
    sessionId: string,
    input: { name: string; mime: string; data: Buffer },
  ): Promise<Attachment> {
    if (input.data.length === 0) throw new AttachmentError('The file is empty.');
    if (input.data.length > ATTACHMENT_LIMITS.maxBytes) {
      throw new AttachmentError(
        `The file exceeds ${Math.floor(ATTACHMENT_LIMITS.maxBytes / (1024 * 1024))} MB.`,
        413,
      );
    }

    const extension = input.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = ALLOWED_MIME.has(input.mime)
      ? input.mime
      : (EXTENSION_MIME[extension] ?? input.mime);
    if (!ALLOWED_MIME.has(mime)) {
      throw new AttachmentError(`"${input.mime || extension || 'unknown'}" is not an accepted file type.`, 415);
    }

    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const name = safeFileName(input.name);
    const relative = `attachments/${sha256.slice(0, 16)}-${name}`;
    const absolute = resolveInside(workspace.path, relative);

    // Same content already stored in this workspace → reuse the file on disk.
    // The row is still new: each upload is its own ledger entry, bindable to
    // its own run.
    const existing = this.db
      .prepare<[string, string], AttachmentRow>(
        'SELECT * FROM attachments WHERE workspace_id = ? AND sha256 = ? LIMIT 1',
      )
      .get(workspace.id, sha256);

    if (!existing) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, input.data);
    }

    const row: AttachmentRow = {
      id: newId('attachment'),
      workspace_id: workspace.id,
      session_id: sessionId,
      run_id: null,
      name,
      // Reuse the first upload's path when deduplicating: the hash prefix is
      // shared but the readable half could differ, and two rows naming one
      // file must agree on where it is.
      path: existing ? existing.path : relative,
      mime,
      bytes: input.data.length,
      sha256,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO attachments (id, workspace_id, session_id, run_id, name, path, mime, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workspace_id,
        row.session_id,
        row.run_id,
        row.name,
        row.path,
        row.mime,
        row.bytes,
        row.sha256,
        row.created_at,
      );
    return toAttachment(row);
  }

  get(id: string): Attachment | null {
    const row = this.db
      .prepare<[string], AttachmentRow>('SELECT * FROM attachments WHERE id = ?')
      .get(id);
    return row ? toAttachment(row) : null;
  }

  /** Pending (not yet sent) attachments of a session, oldest first. */
  pending(sessionId: string): Attachment[] {
    return this.db
      .prepare<[string], AttachmentRow>(
        'SELECT * FROM attachments WHERE session_id = ? AND run_id IS NULL ORDER BY created_at',
      )
      .all(sessionId)
      .map(toAttachment);
  }

  byRun(runId: string): Attachment[] {
    return this.db
      .prepare<[string], AttachmentRow>(
        'SELECT * FROM attachments WHERE run_id = ? ORDER BY created_at',
      )
      .all(runId)
      .map(toAttachment);
  }

  /**
   * Bind pending attachments to the run consuming them. The `run_id IS NULL`
   * condition in the WHERE is the single-use guarantee: a row someone else
   * already bound simply is not updated, and the caller learns from the count.
   */
  bind(ids: string[], sessionId: string, runId: string): void {
    if (ids.length === 0) return;
    if (ids.length > ATTACHMENT_LIMITS.maxPerMessage) {
      throw new AttachmentError(
        `A message carries at most ${ATTACHMENT_LIMITS.maxPerMessage} attachments.`,
      );
    }
    const stmt = this.db.prepare(
      'UPDATE attachments SET run_id = ? WHERE id = ? AND session_id = ? AND run_id IS NULL',
    );
    for (const id of ids) {
      if (stmt.run(runId, id, sessionId).changes === 0) {
        throw new AttachmentError(
          'An attachment was already sent, removed, or belongs to another session.',
          409,
        );
      }
    }
  }

  /** Delete a still-pending attachment; a sent one is part of the record. */
  async remove(id: string): Promise<void> {
    const row = this.db
      .prepare<[string], AttachmentRow>('SELECT * FROM attachments WHERE id = ?')
      .get(id);
    if (!row) throw new AttachmentError('Attachment not found.', 404);
    if (row.run_id !== null) {
      throw new AttachmentError('This attachment was already sent and is part of the transcript.', 409);
    }
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);

    // Remove the file only when no other row still names it.
    const others = this.db
      .prepare<[string, string], { n: number }>(
        'SELECT COUNT(*) AS n FROM attachments WHERE workspace_id = ? AND path = ?',
      )
      .get(row.workspace_id, row.path);
    if ((others?.n ?? 0) === 0) {
      const workspace = this.db
        .prepare<[string], { path: string }>('SELECT path FROM workspaces WHERE id = ?')
        .get(row.workspace_id);
      if (workspace) {
        await unlink(resolveInside(workspace.path, row.path)).catch(() => undefined);
      }
    }
  }

  /** Resolve an attachment's absolute path inside its workspace's jail. */
  absolutePath(attachment: Attachment, workspacePath: string): string {
    return resolveInside(workspacePath, attachment.path);
  }

  /**
   * Open the stored bytes for serving over HTTP. Existence is checked here,
   * synchronously: a missing file must become a 404, and a ReadStream only
   * reports ENOENT asynchronously — after the response has already started.
   */
  stream(attachment: Attachment, workspacePath: string): ReadStream {
    const absolute = this.absolutePath(attachment, workspacePath);
    if (!existsSync(absolute)) {
      throw new AttachmentError('The attachment file is no longer on disk.', 404);
    }
    return createReadStream(absolute);
  }
}
