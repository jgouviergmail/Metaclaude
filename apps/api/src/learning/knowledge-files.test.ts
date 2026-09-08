import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extensionFor, KnowledgeFileStore } from './knowledge-files.js';

let dir: string;
let store: KnowledgeFileStore;

const HASH = 'a'.repeat(64);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'knowledge-files-'));
  store = new KnowledgeFileStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('KnowledgeFileStore', () => {
  it('writes bytes and reads exactly them back', async () => {
    const data = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a]);
    await store.write(HASH, 'application/pdf', data);
    expect(await store.read(HASH, 'application/pdf')).toEqual(data);
    expect(store.exists(HASH, 'application/pdf')).toBe(true);
  });

  it('names the file by its hash and its type, never by the uploaded name', async () => {
    // The uploaded name is user input; the type has already been checked
    // against a closed list. Nothing hostile can reach the filesystem.
    await store.write(HASH, 'application/pdf', Buffer.from('x'));
    expect(existsSync(join(dir, `${HASH}.pdf`))).toBe(true);
  });

  it('leaves no partial file behind after a completed write', async () => {
    await store.write(HASH, 'application/pdf', Buffer.from('x'));
    expect(existsSync(join(dir, `${HASH}.pdf.part`))).toBe(false);
  });

  it('overwrites the same hash with the same bytes rather than accumulating', async () => {
    await store.write(HASH, 'application/pdf', Buffer.from('x'));
    await store.write(HASH, 'application/pdf', Buffer.from('x'));
    expect(readFileSync(join(dir, `${HASH}.pdf`)).toString()).toBe('x');
  });

  it('survives the same file being written several times at once', async () => {
    // Two tabs, or a retry, dropping one document twice. The route hashes,
    // asks whether that hash is known, and writes — so two uploads in flight
    // together both find nothing and both write. They shared one `.part`
    // name: the first rename moved it away and the others failed with ENOENT,
    // a 500 on what should have been a no-op. Measured before the fix: two of
    // six. Six here rather than two because one pair raced only sometimes.
    const data = Buffer.alloc(512 * 1024, 7);
    const writes = await Promise.allSettled(
      Array.from({ length: 6 }, () => store.write(HASH, 'application/pdf', data)),
    );
    expect(writes.filter((w) => w.status === 'rejected')).toEqual([]);
    expect(await store.read(HASH, 'application/pdf')).toEqual(data);
  });

  it('says a file is absent before it is written, and after it is removed', async () => {
    expect(store.exists(HASH, 'application/pdf')).toBe(false);
    await store.write(HASH, 'application/pdf', Buffer.from('x'));
    await store.remove(HASH, 'application/pdf');
    expect(store.exists(HASH, 'application/pdf')).toBe(false);
  });

  it('removing a file that is already gone is not an error', async () => {
    // Deleting a document whose original was lost in a partial restore must
    // still delete the document.
    await expect(store.remove(HASH, 'application/pdf')).resolves.toBeUndefined();
  });

  it('streams the bytes for a download', async () => {
    await store.write(HASH, 'text/csv', Buffer.from('a,b\n1,2'));
    const chunks: Buffer[] = [];
    for await (const chunk of store.stream(HASH, 'text/csv')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('a,b\n1,2');
  });

  it('keeps every stored path inside its own directory', () => {
    // `resolveInside` is the jail, and the hash is hex — but the guard is
    // asserted rather than assumed, because it is the only thing between a
    // caller's mistake and the data directory.
    expect(store.pathFor(HASH, 'application/pdf').startsWith(dir)).toBe(true);
    expect(() => store.pathFor('../../etc/passwd', 'application/pdf')).toThrow();
  });

  it('derives the extension from the type, and falls back rather than failing', () => {
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(extensionFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'docx',
    );
    expect(extensionFor('application/x-unknown')).toBe('bin');
  });
});
