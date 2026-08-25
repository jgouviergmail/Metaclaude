import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_EDITABLE_FILE_BYTES } from '@metaclaude/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FileService, FileServiceError } from './files.js';

let root: string;
let files: FileService;
const roots: string[] = [];

/**
 * A real directory tree per test. `realpathSync` matters: `resolveInside`
 * compares against the resolved root, and on some hosts `os.tmpdir()` is itself
 * a symlink.
 */
function newRoot(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), 'mc-files-')));
  roots.push(created);
  return created;
}

async function seedFiles(tree: Record<string, string | Buffer>): Promise<void> {
  for (const [relative, content] of Object.entries(tree)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function seedDirs(...relatives: string[]): Promise<void> {
  for (const relative of relatives) await mkdir(join(root, relative), { recursive: true });
}

async function exists(relative: string): Promise<boolean> {
  try {
    await stat(join(root, relative));
    return true;
  } catch {
    return false;
  }
}

/** Assert that `promise` rejects with a `FileServiceError` carrying `status`. */
async function expectStatus(promise: Promise<unknown>, status: number): Promise<FileServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileServiceError);
    expect((error as FileServiceError).statusCode).toBe(status);
    return error as FileServiceError;
  }
  expect.unreachable(`expected a FileServiceError with status ${status}`);
  throw new Error('unreachable');
}

beforeEach(() => {
  root = newRoot();
  files = new FileService();
});

afterAll(async () => {
  for (const directory of roots) await rm(directory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* list                                                                        */
/* -------------------------------------------------------------------------- */

describe('list', () => {
  it('puts directories before files and sorts each group case-insensitively', async () => {
    await seedDirs('Beta', 'alpha', 'zulu');
    await seedFiles({ 'Zeta.txt': 'z', 'apple.md': 'a', 'Mango.ts': 'm' });

    const entries = await files.list(root, '');
    expect(entries.map((entry) => entry.name)).toEqual([
      'alpha',
      'Beta',
      'zulu',
      'apple.md',
      'Mango.ts',
      'Zeta.txt',
    ]);
    expect(entries.slice(0, 3).every((entry) => entry.type === 'directory')).toBe(true);
    expect(entries.slice(3).every((entry) => entry.type === 'file')).toBe(true);
  });

  it('describes each entry with a workspace-relative path, size and language', async () => {
    await seedFiles({ 'src/main.ts': 'export {};\n', 'src/notes.md': '# hi' });
    await seedDirs('src/nested');

    const entries = await files.list(root, 'src');
    expect(entries.map((entry) => entry.path)).toEqual([
      'src/nested',
      'src/main.ts',
      'src/notes.md',
    ]);

    const directory = entries[0]!;
    expect(directory.type).toBe('directory');
    expect(directory.language).toBeNull();

    const main = entries[1]!;
    expect(main.language).toBe('typescript');
    expect(main.size).toBe('export {};\n'.length);
    expect(main.modifiedAt).toBeGreaterThan(0);
    expect(Number.isInteger(main.modifiedAt)).toBe(true);
    expect(entries[2]!.language).toBe('markdown');
  });

  it('reports null language for a file with no known extension', async () => {
    await seedFiles({ LICENSE: 'MIT', 'notes.unknownext': 'x' });
    const byName = new Map((await files.list(root, '')).map((entry) => [entry.name, entry]));
    expect(byName.get('LICENSE')!.language).toBeNull();
    expect(byName.get('notes.unknownext')!.language).toBeNull();
  });

  it('hides dotfiles unless showHidden is set, but always shows .env.example', async () => {
    await seedFiles({
      'visible.txt': 'v',
      '.hidden': 'h',
      '.env': 'secret',
      '.env.example': 'TEMPLATE=1',
    });

    const visible = (await files.list(root, '')).map((entry) => entry.name).sort();
    expect(visible).toEqual(['.env.example', 'visible.txt']);

    const all = (await files.list(root, '', true)).map((entry) => entry.name).sort();
    expect(all).toEqual(['.env', '.env.example', '.hidden', 'visible.txt']);
  });

  it('hides node_modules and .git unless showHidden is set', async () => {
    await seedFiles({
      'node_modules/pkg/index.js': 'module.exports = 1;',
      '.git/config': '[core]',
      'dist/bundle.js': 'x',
      'src/index.ts': 'x',
    });

    expect((await files.list(root, '')).map((entry) => entry.name)).toEqual(['src']);

    const all = (await files.list(root, '', true)).map((entry) => entry.name).sort();
    expect(all).toEqual(['.git', 'dist', 'node_modules', 'src']);
  });

  it('lists an empty directory as an empty array', async () => {
    await seedDirs('empty');
    expect(await files.list(root, 'empty')).toEqual([]);
    expect(await files.list(root, '')).toHaveLength(1);
  });

  it('rejects a directory that does not exist with 404', async () => {
    await expectStatus(files.list(root, 'nope'), 404);
  });

  it('rejects listing a file with 400', async () => {
    await seedFiles({ 'a.txt': 'a' });
    await expectStatus(files.list(root, 'a.txt'), 400);
  });
});

/* -------------------------------------------------------------------------- */
/* read                                                                        */
/* -------------------------------------------------------------------------- */

describe('read', () => {
  it('returns the content, the inferred language and the metadata', async () => {
    await seedFiles({ 'src/app.ts': 'const answer = 42;\n' });

    const result = await files.read(root, 'src/app.ts');
    expect(result.path).toBe('src/app.ts');
    expect(result.content).toBe('const answer = 42;\n');
    expect(result.language).toBe('typescript');
    expect(result.size).toBe('const answer = 42;\n'.length);
    expect(result.truncated).toBe(false);
    expect(result.modifiedAt).toBeGreaterThan(0);
  });

  it('reads an empty file', async () => {
    await seedFiles({ 'empty.txt': '' });
    const result = await files.read(root, 'empty.txt');
    expect(result.content).toBe('');
    expect(result.size).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('preserves UTF-8 content', async () => {
    await seedFiles({ 'utf8.md': '# Déjà vu — ✅ 日本語\n' });
    expect((await files.read(root, 'utf8.md')).content).toBe('# Déjà vu — ✅ 日本語\n');
  });

  it('throws 404 for a file that does not exist', async () => {
    const error = await expectStatus(files.read(root, 'missing.txt'), 404);
    expect(error.message).toContain('does not exist');
  });

  it('throws 400 for a directory', async () => {
    await seedDirs('a-directory');
    const error = await expectStatus(files.read(root, 'a-directory'), 400);
    expect(error.message).toContain('is a directory');
  });

  it('throws 415 for a binary extension, whatever the bytes say', async () => {
    // Deliberately plain text: the extension alone must be enough.
    await seedFiles({ 'logo.png': 'this is not really a png', 'archive.zip': 'text' });
    const error = await expectStatus(files.read(root, 'logo.png'), 415);
    expect(error.message).toContain('binary');
    await expectStatus(files.read(root, 'archive.zip'), 415);
  });

  it('throws 415 for a NUL byte despite a text extension', async () => {
    await seedFiles({ 'sneaky.txt': Buffer.from([0x68, 0x69, 0x00, 0x74, 0x68, 0x65, 0x72, 0x65]) });
    const error = await expectStatus(files.read(root, 'sneaky.txt'), 415);
    expect(error.message).toContain('appears to be binary');
  });

  it('reads a text file that only becomes binary after the sniffed prefix', async () => {
    // The NUL sits past the first 8 KiB, so this one is accepted as text.
    const content = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    await seedFiles({ 'late-nul.txt': content });
    expect((await files.read(root, 'late-nul.txt')).size).toBe(9001);
  });

  it('truncates a file larger than the editable limit and returns only the prefix', async () => {
    const overshoot = 10;
    const body = 'x'.repeat(MAX_EDITABLE_FILE_BYTES + overshoot);
    await seedFiles({ 'huge.txt': body });

    const result = await files.read(root, 'huge.txt');
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(MAX_EDITABLE_FILE_BYTES + overshoot);
    expect(result.content).toHaveLength(MAX_EDITABLE_FILE_BYTES);
    expect(result.content).toBe(body.slice(0, MAX_EDITABLE_FILE_BYTES));
  });

  it('does not truncate a file exactly at the limit', async () => {
    await seedFiles({ 'exact.txt': 'y'.repeat(MAX_EDITABLE_FILE_BYTES) });
    const result = await files.read(root, 'exact.txt');
    expect(result.truncated).toBe(false);
    expect(result.content).toHaveLength(MAX_EDITABLE_FILE_BYTES);
  });
});

/* -------------------------------------------------------------------------- */
/* write / createDirectory                                                     */
/* -------------------------------------------------------------------------- */

describe('write', () => {
  it('creates the file and every missing parent directory', async () => {
    const entry = await files.write(root, 'a/b/c/notes.md', '# hello');

    expect(entry).toEqual({
      name: 'notes.md',
      path: 'a/b/c/notes.md',
      type: 'file',
      size: '# hello'.length,
      modifiedAt: expect.any(Number),
      language: 'markdown',
    });
    expect(await readFile(join(root, 'a/b/c/notes.md'), 'utf8')).toBe('# hello');
  });

  it('overwrites an existing file', async () => {
    await seedFiles({ 'notes.md': 'old content that is longer' });
    const entry = await files.write(root, 'notes.md', 'new');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('new');
    expect(entry.size).toBe(3);
  });

  it('refuses content larger than the editable limit with 413', async () => {
    const error = await expectStatus(
      files.write(root, 'huge.txt', 'x'.repeat(MAX_EDITABLE_FILE_BYTES + 1)),
      413,
    );
    expect(error.message).toContain('too large');
    expect(await exists('huge.txt')).toBe(false);
  });

  it('creates a directory tree on demand', async () => {
    await files.createDirectory(root, 'deep/nested/tree');
    expect(await exists('deep/nested/tree')).toBe(true);
    // Idempotent.
    await files.createDirectory(root, 'deep/nested/tree');
    expect(await exists('deep/nested/tree')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* remove / move                                                               */
/* -------------------------------------------------------------------------- */

describe('remove', () => {
  it('removes a file and a directory tree', async () => {
    await seedFiles({ 'a.txt': 'a', 'tree/one/two.txt': 'b' });

    await files.remove(root, 'a.txt');
    expect(await exists('a.txt')).toBe(false);

    await files.remove(root, 'tree');
    expect(await exists('tree')).toBe(false);
  });

  it('is a no-op for something that is not there', async () => {
    await expect(files.remove(root, 'never-existed')).resolves.toBeUndefined();
  });

  it('refuses to delete the workspace root, however it is addressed', async () => {
    await seedFiles({ 'keep.txt': 'k' });

    for (const path of ['', '.', './', '/', 'a/..']) {
      const error = await expectStatus(files.remove(root, path), 400);
      expect(error.message).toContain('workspace root cannot be deleted');
    }
    expect(await exists('keep.txt')).toBe(true);
  });

  // The guard compares against the *resolved* root, because `resolveInside`
  // normalises its result: comparing against the raw argument let a root passed
  // with a trailing slash through, and `rm -r` then took the whole workspace.
  it('refuses to delete the root even when the root argument is not normalised', async () => {
    await seedFiles({ 'keep.txt': 'k' });
    await expectStatus(files.remove(`${root}/`, ''), 400);
    expect(await exists('keep.txt')).toBe(true);
  });
});

describe('move', () => {
  it('relocates a file, creating the destination directory', async () => {
    await seedFiles({ 'draft.md': '# draft' });

    await files.move(root, 'draft.md', 'archive/2024/final.md');

    expect(await exists('draft.md')).toBe(false);
    expect(await readFile(join(root, 'archive/2024/final.md'), 'utf8')).toBe('# draft');
  });

  it('renames within the same directory', async () => {
    await seedFiles({ 'src/old.ts': 'x' });
    await files.move(root, 'src/old.ts', 'src/new.ts');
    expect(await exists('src/old.ts')).toBe(false);
    expect(await exists('src/new.ts')).toBe(true);
  });

  it('moves a whole directory', async () => {
    await seedFiles({ 'from/one/two.txt': 'v' });
    await files.move(root, 'from', 'to');
    expect(await exists('from')).toBe(false);
    expect(await readFile(join(root, 'to/one/two.txt'), 'utf8')).toBe('v');
  });

  it('refuses to move the workspace root', async () => {
    const error = await expectStatus(files.move(root, '', 'elsewhere'), 400);
    expect(error.message).toContain('workspace root cannot be moved');
  });
});

/* -------------------------------------------------------------------------- */
/* Path jailing                                                                */
/* -------------------------------------------------------------------------- */

describe('path jailing', () => {
  const escapes = ['../../etc/passwd', '../outside.txt', 'a/../../outside.txt', '../'];

  it('rejects a traversal on every method with 403', async () => {
    for (const path of escapes) {
      await expectStatus(files.list(root, path), 403);
      await expectStatus(files.read(root, path), 403);
      await expectStatus(files.write(root, path, 'pwned'), 403);
      await expectStatus(files.remove(root, path), 403);
      await expectStatus(files.createDirectory(root, path), 403);
      await expectStatus(files.move(root, path, 'inside.txt'), 403);
      await expectStatus(files.move(root, 'inside.txt', path), 403);
    }
  });

  it('says the path is outside the workspace rather than leaking why', async () => {
    const error = await expectStatus(files.read(root, '../../etc/passwd'), 403);
    expect(error.message).toBe('That path is outside the workspace.');
  });

  it('rejects a NUL byte in the path', async () => {
    await expectStatus(files.read(root, 'a\0b.txt'), 403);
    await expectStatus(files.write(root, 'a\0b.txt', 'x'), 403);
  });

  it('rejects the reserved credential filenames', async () => {
    await expectStatus(files.read(root, '.git-credentials'), 403);
    await expectStatus(files.read(root, 'nested/.netrc'), 403);
    await expectStatus(files.write(root, 'config/master.key', 'x'), 403);
  });

  it('treats a leading slash as workspace-relative, not filesystem-absolute', async () => {
    await seedFiles({ 'inside.txt': 'in' });
    expect((await files.read(root, '/inside.txt')).content).toBe('in');
    // `/etc/passwd` becomes `<root>/etc/passwd`, which simply does not exist.
    await expectStatus(files.read(root, '/etc/passwd'), 404);
  });

  it('refuses to follow a symlink that points out of the workspace', async () => {
    const outside = newRoot();
    await writeFile(join(outside, 'secret.txt'), 'classified');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));

    await expectStatus(files.read(root, 'link.txt'), 403);
  });
});

/* -------------------------------------------------------------------------- */
/* search                                                                      */
/* -------------------------------------------------------------------------- */

describe('search', () => {
  async function seedTree(): Promise<void> {
    await seedFiles({
      'README.md': 'a',
      'src/server.ts': 'a',
      'src/serverless.ts': 'a',
      'src/routes/files.ts': 'a',
      'src/routes/README.md': 'a',
      'node_modules/pkg/server.ts': 'a',
      '.git/server.ts': 'a',
      '.hidden/server.ts': 'a',
      'dist/server.ts': 'a',
    });
  }

  it('matches a filename fragment, case-insensitively, anywhere in the name', async () => {
    await seedTree();
    const results = await files.search(root, 'server');
    expect(results.map((entry) => entry.path).sort()).toEqual([
      'src/server.ts',
      'src/serverless.ts',
    ]);
    expect((await files.search(root, 'SERVER')).map((entry) => entry.path).sort()).toEqual([
      'src/server.ts',
      'src/serverless.ts',
    ]);
    expect((await files.search(root, 'rver.t')).map((entry) => entry.path)).toEqual([
      'src/server.ts',
    ]);
  });

  it('returns full file entries', async () => {
    await seedFiles({ 'src/server.ts': 'export {};' });
    const [entry] = await files.search(root, 'server');
    expect(entry).toEqual({
      name: 'server.ts',
      path: 'src/server.ts',
      type: 'file',
      size: 'export {};'.length,
      modifiedAt: expect.any(Number),
      language: 'typescript',
    });
  });

  it('skips hidden and ignored directories entirely', async () => {
    await seedTree();
    const paths = (await files.search(root, 'server')).map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('.git/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('.hidden/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('dist/'))).toBe(false);
  });

  it('finds matches in nested directories', async () => {
    await seedTree();
    expect((await files.search(root, 'readme')).map((entry) => entry.path).sort()).toEqual([
      'README.md',
      'src/routes/README.md',
    ]);
  });

  it('respects the limit', async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) tree[`match-${i}.txt`] = 'x';
    await seedFiles(tree);

    expect(await files.search(root, 'match')).toHaveLength(20);
    expect(await files.search(root, 'match', { limit: 5 })).toHaveLength(5);
    expect(await files.search(root, 'match', { limit: 1 })).toHaveLength(1);
    // The hard ceiling is 200, so a huge limit is simply the whole tree here.
    expect(await files.search(root, 'match', { limit: 10_000 })).toHaveLength(20);
  });

  it('respects the depth bound', async () => {
    await seedFiles({ 'deep/one/two/three/needle.txt': 'x', 'needle.txt': 'x' });
    expect((await files.search(root, 'needle')).map((entry) => entry.path).sort()).toEqual([
      'deep/one/two/three/needle.txt',
      'needle.txt',
    ]);
    expect((await files.search(root, 'needle', { maxDepth: 1 })).map((entry) => entry.path)).toEqual([
      'needle.txt',
    ]);
  });

  it('ignores a fragment shorter than two characters', async () => {
    await seedFiles({ 'a.txt': 'x', 'ab.txt': 'x' });
    expect(await files.search(root, '')).toEqual([]);
    expect(await files.search(root, 'a')).toEqual([]);
    expect(await files.search(root, '   ')).toEqual([]);
    expect(await files.search(root, ' ab ')).toHaveLength(1);
  });

  it('returns nothing when nothing matches', async () => {
    await seedTree();
    expect(await files.search(root, 'no-such-file')).toEqual([]);
  });
});
