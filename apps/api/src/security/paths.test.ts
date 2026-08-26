import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathEscapeError, isInside, resolveInside, slugify, toRelative } from './paths.js';

let base: string;
let jail: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mc-paths-'));
  jail = join(base, 'ws');
  outside = join(base, 'outside');
  mkdirSync(join(jail, 'sub', 'deep'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(jail, 'sub', 'file.txt'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  // A sibling directory whose name merely starts with the jail's name.
  mkdirSync(`${jail}-evil`, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('isInside', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isInside('/data/ws', '/data/ws')).toBe(true);
    expect(isInside('/data/ws', '/data/ws/')).toBe(true);
    expect(isInside('/data/ws', '/data/ws/a')).toBe(true);
    expect(isInside('/data/ws', '/data/ws/a/b/c.txt')).toBe(true);
    expect(isInside('/data/ws', '/data/ws/a/../b')).toBe(true);
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', () => {
    expect(isInside('/data/ws', '/data/ws-evil')).toBe(false);
    expect(isInside('/data/ws', '/data/ws-evil/steal.txt')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces-evil')).toBe(false);
  });

  it('rejects parents, siblings and unrelated absolute paths', () => {
    expect(isInside('/data/ws', '/data')).toBe(false);
    expect(isInside('/data/ws', '/data/other')).toBe(false);
    expect(isInside('/data/ws', '/etc/passwd')).toBe(false);
    expect(isInside('/data/ws', '/data/ws/../..')).toBe(false);
  });
});

describe('resolveInside', () => {
  it('allows ordinary relative paths and returns an absolute path', () => {
    expect(resolveInside(jail, 'sub/file.txt')).toBe(join(jail, 'sub', 'file.txt'));
    expect(resolveInside(jail, './sub/deep')).toBe(join(jail, 'sub', 'deep'));
    expect(resolveInside(jail, 'sub/deep/../file.txt')).toBe(join(jail, 'sub', 'file.txt'));
    expect(resolveInside(jail, '')).toBe(jail);
    expect(resolveInside(jail, '.')).toBe(jail);
  });

  it('allows a path that does not exist yet (creation is a legitimate use)', () => {
    expect(resolveInside(jail, 'sub/new/nested/file.txt')).toBe(
      join(jail, 'sub', 'new', 'nested', 'file.txt'),
    );
  });

  it('rejects ../ escapes', () => {
    for (const bad of [
      '..',
      '../',
      '../secret.txt',
      '../outside/secret.txt',
      'sub/../../outside/secret.txt',
      'sub/deep/../../../outside/secret.txt',
      './../../etc/passwd',
    ]) {
      expect(() => resolveInside(jail, bad)).toThrow(PathEscapeError);
    }
  });

  it('rejects an escape that lands on a sibling sharing the root name prefix', () => {
    expect(() => resolveInside(jail, '../ws-evil/steal.txt')).toThrow(PathEscapeError);
  });

  it('treats a leading slash as jail-relative rather than filesystem-absolute', () => {
    expect(resolveInside(jail, '/sub/file.txt')).toBe(join(jail, 'sub', 'file.txt'));
    // An absolute path pointing at a real system file stays trapped in the jail.
    expect(resolveInside(jail, '/etc/passwd')).toBe(join(jail, 'etc', 'passwd'));
    expect(resolveInside(jail, '///sub/file.txt')).toBe(join(jail, 'sub', 'file.txt'));
    expect(resolveInside(jail, outside)).toBe(join(jail, outside.replace(/^\//, '')));
  });

  it('rejects NUL bytes', () => {
    expect(() => resolveInside(jail, 'sub/file.txt\u0000.png')).toThrow(PathEscapeError);
    expect(() => resolveInside(jail, '\u0000')).toThrow(PathEscapeError);
    expect(() => resolveInside(jail, 'sub\u0000/../../outside')).toThrow(PathEscapeError);
  });

  it('rejects blocked segments anywhere in the path', () => {
    for (const blocked of [
      '.git-credentials',
      '.netrc',
      'master.key',
      'sub/.netrc',
      'sub/deep/master.key',
      '/.git-credentials',
    ]) {
      expect(() => resolveInside(jail, blocked)).toThrow(PathEscapeError);
    }
  });

  it('does not block segments that merely contain a blocked name', () => {
    expect(() => resolveInside(jail, 'sub/master.key.bak')).not.toThrow();
    expect(() => resolveInside(jail, 'sub/not-a-.netrc')).not.toThrow();
  });

  it('rejects a symlink planted inside the jail that points outside it', () => {
    symlinkSync(outside, join(jail, 'escape-link'), 'dir');
    symlinkSync(join(outside, 'secret.txt'), join(jail, 'escape-file'), 'file');

    expect(() => resolveInside(jail, 'escape-link')).toThrow(PathEscapeError);
    expect(() => resolveInside(jail, 'escape-link/secret.txt')).toThrow(PathEscapeError);
    // Even a path that does not exist yet under the escaping link is refused.
    expect(() => resolveInside(jail, 'escape-link/brand-new.txt')).toThrow(PathEscapeError);
    expect(() => resolveInside(jail, 'escape-file')).toThrow(PathEscapeError);
  });

  it('rejects a symlink that stays inside the jail but resolves to a blocked segment', () => {
    // The gap the two existing symlink cases leave between them. The blocked
    // segments are checked against the *requested* path, and the realpath pass
    // is used only for `isInside` — so a link that never leaves the jail but
    // lands on `.git` passed both gates. `FileService` then follows it on every
    // syscall: `readdir` enumerates the directory, `readFile` reads
    // `.git/config` — the credentialed clone URL the blocklist comment names —
    // and `writeFile` writes into it. The file routes carry no `requireOperator`,
    // so a viewer reaches all of it.
    mkdirSync(join(jail, '.git'), { recursive: true });
    writeFileSync(join(jail, '.git', 'config'), '[remote "origin"]\n\turl = https://token@host/r\n');
    symlinkSync(join(jail, '.git'), join(jail, 'g'), 'dir');

    expect(() => resolveInside(jail, '.git/config')).toThrow(PathEscapeError);
    // The same file, one indirection away.
    expect(() => resolveInside(jail, 'g/config')).toThrow(PathEscapeError);
    expect(() => resolveInside(jail, 'g')).toThrow(PathEscapeError);
  });

  it('allows a symlink that stays inside the jail', () => {
    symlinkSync(join(jail, 'sub'), join(jail, 'inner-link'), 'dir');
    expect(() => resolveInside(jail, 'inner-link/file.txt')).not.toThrow();
    expect(resolveInside(jail, 'inner-link/file.txt')).toBe(join(jail, 'inner-link', 'file.txt'));
  });

  it('carries the offending input in the error message', () => {
    try {
      resolveInside(jail, '../outside/secret.txt');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PathEscapeError);
      expect((error as Error).name).toBe('PathEscapeError');
      expect((error as Error).message).toContain('../outside/secret.txt');
    }
  });
});

describe('toRelative', () => {
  it('returns a POSIX, workspace-relative path', () => {
    expect(toRelative('/data/ws', '/data/ws/sub/file.txt')).toBe('sub/file.txt');
    expect(toRelative('/data/ws', '/data/ws')).toBe('');
    expect(toRelative('/data/ws/', '/data/ws/a/b')).toBe('a/b');
  });

  it('round-trips with resolveInside', () => {
    const absolute = resolveInside(jail, 'sub/deep/x.txt');
    expect(toRelative(jail, absolute)).toBe('sub/deep/x.txt');
  });

  it('yields a ../ path for something genuinely outside (callers must jail first)', () => {
    expect(toRelative('/data/ws', '/data/other/file')).toBe('../other/file');
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World 42')).toBe('hello-world-42');
    expect(slugify('My  Cool   Project')).toBe('my-cool-project');
  });

  it('strips accents down to ascii', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(slugify('Élève à Paris')).toBe('eleve-a-paris');
    expect(slugify('Мой проект')).toBe('workspace');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('!!! wow !!!')).toBe('wow');
    expect(slugify('/etc/passwd')).toBe('etc-passwd');
  });

  it('falls back when nothing survives, and honours a custom fallback', () => {
    expect(slugify('')).toBe('workspace');
    expect(slugify('   ')).toBe('workspace');
    expect(slugify('!!!')).toBe('workspace');
    expect(slugify('', 'my-fallback')).toBe('my-fallback');
    expect(slugify('...', 'my-fallback')).toBe('my-fallback');
  });

  it('always returns a single, safe path segment bounded to 48 characters', () => {
    for (const input of ['../../etc/passwd', 'a/b/c', 'x'.repeat(200), 'Ne pas / casser']) {
      const slug = slugify(input);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug.length).toBeLessThanOrEqual(48);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.includes('/')).toBe(false);
      expect(slug.includes('..')).toBe(false);
      // A slug is always safe to use as a directory name inside a jail.
      expect(resolve('/data/ws', slug).startsWith('/data/ws/')).toBe(true);
    }
  });
});
