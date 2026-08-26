/**
 * The attachment ledger and its jail.
 *
 * What matters here: the allowlist and the caps actually refuse; a hostile
 * name cannot traverse; deduplication shares bytes but never ledger rows; and
 * binding to a run is single-use because the write is the check.
 */

import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { AttachmentError, AttachmentService, safeFileName } from './attachments.js';

let db: Db;
let service: AttachmentService;
let root: string;
let workspace: { id: string; path: string };
let sessionId: string;

function insertWorkspace(id: string, path: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, '#000000', 'folder', '{}', 0, 0)`,
  ).run(id, id, id, path);
}

function insertSession(id: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at)
     VALUES (?, ?, 0, 0, 0)`,
  ).run(id, workspaceId);
}

function insertRun(id: string, sessionId_: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
     VALUES (?, ?, ?, 'p', 'queued', 0)`,
  ).run(id, sessionId_, workspaceId);
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  root = mkdtempSync(join(tmpdir(), 'metaclaude-att-'));
  workspace = { id: 'ws_test', path: root };
  sessionId = 'ses_test';
  insertWorkspace(workspace.id, root);
  insertSession(sessionId, workspace.id);
  service = new AttachmentService(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('safeFileName', () => {
  it('neutralises traversal and path separators', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeFileName('rapport final (v2).pdf')).toBe('rapport-final-v2-.pdf');
  });

  it('never returns something empty or dot-leading', () => {
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('.env')).toBe('env');
  });
});

describe('save', () => {
  it('stores the bytes under attachments/ and records the ledger row', async () => {
    const saved = await service.save(workspace, sessionId, {
      name: 'photo.png',
      mime: 'image/png',
      data: Buffer.from('fake-png-bytes'),
    });

    expect(saved.path.startsWith('attachments/')).toBe(true);
    expect(saved.runId).toBeNull();
    expect(existsSync(join(root, saved.path))).toBe(true);
    expect(service.get(saved.id)?.sha256).toBe(saved.sha256);
  });

  it('refuses an empty file, an oversized file, and a type off the allowlist', async () => {
    await expect(
      service.save(workspace, sessionId, { name: 'a.png', mime: 'image/png', data: Buffer.alloc(0) }),
    ).rejects.toThrow(AttachmentError);

    const oversized = Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1);
    await expect(
      service.save(workspace, sessionId, { name: 'a.png', mime: 'image/png', data: oversized }),
    ).rejects.toMatchObject({ statusCode: 413 });

    await expect(
      service.save(workspace, sessionId, { name: 'virus.exe', mime: 'application/x-msdownload', data: Buffer.from('x') }),
    ).rejects.toMatchObject({ statusCode: 415 });
  });

  it('infers the type from the extension when the browser sends none', async () => {
    // Drag-dropping a .md file yields an empty MIME on some platforms; the
    // extension map covers exactly the allowlisted types, nothing more.
    const saved = await service.save(workspace, sessionId, {
      name: 'notes.md',
      mime: '',
      data: Buffer.from('# notes'),
    });
    expect(saved.mime).toBe('text/markdown');

    await expect(
      service.save(workspace, sessionId, { name: 'tool.exe', mime: '', data: Buffer.from('x') }),
    ).rejects.toMatchObject({ statusCode: 415 });
  });

  it('keeps a hostile name inside the jail', async () => {
    const saved = await service.save(workspace, sessionId, {
      name: '../../outside.png',
      mime: 'image/png',
      data: Buffer.from('bytes'),
    });
    // The stored path stays under attachments/ and the parent temp dir gained
    // no stray file.
    expect(saved.path.startsWith('attachments/')).toBe(true);
    expect(existsSync(join(root, saved.path))).toBe(true);
    expect(existsSync(join(root, '..', 'outside.png'))).toBe(false);
  });

  it('deduplicates content: one file on disk, one ledger row per upload', async () => {
    const data = Buffer.from('same-bytes');
    const first = await service.save(workspace, sessionId, { name: 'a.png', mime: 'image/png', data });
    const second = await service.save(workspace, sessionId, { name: 'b.png', mime: 'image/png', data });

    expect(second.path).toBe(first.path);
    expect(second.id).not.toBe(first.id);
    expect(readdirSync(join(root, 'attachments'))).toHaveLength(1);
  });
});

describe('bind', () => {
  it('is single-use — the write is the check', async () => {
    insertRun('run_1', sessionId, workspace.id);
    insertRun('run_2', sessionId, workspace.id);
    const saved = await service.save(workspace, sessionId, {
      name: 'a.png',
      mime: 'image/png',
      data: Buffer.from('x'),
    });

    service.bind([saved.id], sessionId, 'run_1');
    expect(service.get(saved.id)?.runId).toBe('run_1');
    expect(() => service.bind([saved.id], sessionId, 'run_2')).toThrow(/already sent/i);
    // The first binding survives the losing attempt.
    expect(service.get(saved.id)?.runId).toBe('run_1');
  });

  it('refuses another session’s attachment and enforces the per-message cap', async () => {
    insertSession('ses_other', workspace.id);
    insertRun('run_1', sessionId, workspace.id);
    const saved = await service.save(workspace, 'ses_other', {
      name: 'a.png',
      mime: 'image/png',
      data: Buffer.from('x'),
    });

    expect(() => service.bind([saved.id], sessionId, 'run_1')).toThrow(AttachmentError);
    expect(() =>
      service.bind(
        Array.from({ length: ATTACHMENT_LIMITS.maxPerMessage + 1 }, (_, i) => `att_${i}`),
        sessionId,
        'run_1',
      ),
    ).toThrow(/at most/i);
  });
});

describe('remove', () => {
  it('deletes a pending attachment, but never a sent one', async () => {
    insertRun('run_1', sessionId, workspace.id);
    const pending = await service.save(workspace, sessionId, {
      name: 'a.png',
      mime: 'image/png',
      data: Buffer.from('one'),
    });
    const sent = await service.save(workspace, sessionId, {
      name: 'b.png',
      mime: 'image/png',
      data: Buffer.from('two'),
    });
    service.bind([sent.id], sessionId, 'run_1');

    await service.remove(pending.id);
    expect(service.get(pending.id)).toBeNull();
    expect(existsSync(join(root, pending.path))).toBe(false);

    await expect(service.remove(sent.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps the shared file while another row still names it', async () => {
    const data = Buffer.from('shared');
    const first = await service.save(workspace, sessionId, { name: 'a.png', mime: 'image/png', data });
    const second = await service.save(workspace, sessionId, { name: 'b.png', mime: 'image/png', data });

    await service.remove(first.id);
    expect(existsSync(join(root, second.path))).toBe(true);
    await service.remove(second.id);
    expect(existsSync(join(root, second.path))).toBe(false);
  });
});

describe('pending', () => {
  it('lists only what has not been sent, oldest first', async () => {
    insertRun('run_1', sessionId, workspace.id);
    const a = await service.save(workspace, sessionId, { name: 'a.png', mime: 'image/png', data: Buffer.from('a') });
    const b = await service.save(workspace, sessionId, { name: 'b.png', mime: 'image/png', data: Buffer.from('b') });
    service.bind([a.id], sessionId, 'run_1');

    expect(service.pending(sessionId).map((x) => x.id)).toEqual([b.id]);
  });
});
