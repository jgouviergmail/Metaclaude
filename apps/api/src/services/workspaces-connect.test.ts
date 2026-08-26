/**
 * Attaching a repository to a workspace that already exists.
 *
 * The interesting cases are all about the directory's prior state, so these run
 * against real directories and a real git binary — the branch that decides
 * whether files get overwritten is not one to verify against a mock.
 */

import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { WorkspaceRepo } from '../kernel/repositories.js';
import { WorkspaceService, WorkspaceServiceError } from './workspaces.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

let db: Db;
let root = '';
let origin: Awaited<ReturnType<typeof makeOrigin>>;
let service: WorkspaceService;

/**
 * A real repository, served over real HTTP.
 *
 * `file://` is refused by the service on purpose — it would let a caller read
 * any path on the host — so a fixture cannot use it, and a fixture that worked
 * around the refusal would be testing a different program. `git http-backend`
 * is git's own smart-HTTP server; wrapping it in a CGI shim is the smallest
 * thing that makes the clone under test an actual clone.
 */
async function makeOrigin(): Promise<{ dir: string; url: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-origin-'));
  const work = join(dir, 'work');
  await mkdir(work, { recursive: true });
  await execFileAsync('git', ['init', '-q', '--initial-branch=main', '.'], { cwd: work, env: GIT_ENV });
  await writeFile(join(work, 'README.md'), '# from the origin\n');
  await execFileAsync('git', ['add', '-A'], { cwd: work, env: GIT_ENV });
  await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: work, env: GIT_ENV });
  await execFileAsync('git', ['clone', '-q', '--bare', work, join(dir, 'repo.git')], { env: GIT_ENV });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...GIT_ENV,
        GIT_PROJECT_ROOT: dir,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: '',
      },
    });
    req.pipe(child.stdin);

    let head = '';
    let sentHead = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (sentHead) return res.write(chunk);
      head += chunk.toString('latin1');
      const split = head.indexOf('\r\n\r\n');
      if (split < 0) return;
      for (const line of head.slice(0, split).split('\r\n')) {
        const at = line.indexOf(':');
        if (at > 0) res.setHeader(line.slice(0, at), line.slice(at + 1).trim());
      }
      sentHead = true;
      res.write(Buffer.from(head.slice(split + 4), 'latin1'));
    });
    child.stdout.on('end', () => res.end());
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return {
    dir,
    url: `http://127.0.0.1:${port}/repo.git`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  root = await mkdtemp(join(tmpdir(), 'mc-ws-'));
  origin = await makeOrigin();
  service = new WorkspaceService({
    repo: new WorkspaceRepo(db),
    workspacesRoot: root,
    log: () => {},
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await origin.close();
  await rm(origin.dir, { recursive: true, force: true });
});

async function emptyWorkspace(name = 'ws') {
  const workspace = await service.create({
    name,
    description: '',
    color: '#6366f1',
    icon: 'folder',
  });
  // `create` writes a starter CLAUDE.md, which is exactly the "not empty"
  // case; clear it so each test states the state it means to test.
  await rm(workspace.path, { recursive: true, force: true });
  await mkdir(workspace.path, { recursive: true });
  return workspace;
}

describe('an empty workspace', () => {
  it('clones the repository into it', async () => {
    const workspace = await emptyWorkspace();
    const result = await service.connectRepository(workspace.id, origin.url);

    expect(result.mode).toBe('cloned');
    expect(existsSync(join(workspace.path, '.git'))).toBe(true);
    expect(await readFile(join(workspace.path, 'README.md'), 'utf8')).toContain('from the origin');
  });

  it('initialises a local repository when given no URL', async () => {
    const workspace = await emptyWorkspace();
    const result = await service.connectRepository(workspace.id, null);
    expect(result.mode).toBe('initialised');
    expect(existsSync(join(workspace.path, '.git'))).toBe(true);
  });
});

describe('a workspace that already has files', () => {
  it('adds the remote and fetches WITHOUT touching the working tree', async () => {
    const workspace = await emptyWorkspace();
    await writeFile(join(workspace.path, 'mine.txt'), 'work in progress\n');

    const result = await service.connectRepository(workspace.id, origin.url);

    expect(result.mode).toBe('fetched');
    // The file the owner was working on is still theirs, and untouched.
    expect(await readFile(join(workspace.path, 'mine.txt'), 'utf8')).toBe('work in progress\n');
    // The origin's file was NOT checked out over the top of it.
    expect(existsSync(join(workspace.path, 'README.md'))).toBe(false);
    // But the history is there to merge when they choose.
    const { stdout } = await execFileAsync('git', ['remote', '-v'], {
      cwd: workspace.path,
      env: GIT_ENV,
    });
    expect(stdout).toContain('origin');
  });
});

describe('what it refuses', () => {
  it('refuses a workspace that already tracks a repository', async () => {
    const workspace = await emptyWorkspace();
    await service.connectRepository(workspace.id, origin.url);
    await expect(service.connectRepository(workspace.id, origin.url)).rejects.toThrow(
      /already tracks/i,
    );
  });

  it('refuses a workspace that does not exist', async () => {
    await expect(service.connectRepository('ws_nope', null)).rejects.toBeInstanceOf(
      WorkspaceServiceError,
    );
  });

  it('refuses a scheme that would read the host or run a helper', async () => {
    const workspace = await emptyWorkspace();
    await writeFile(join(workspace.path, 'keep.txt'), 'x');
    // ext:: is git's transport-helper escape hatch; file:// on a non-empty
    // directory reaches the same validation path.
    await expect(service.connectRepository(workspace.id, 'ext::sh -c whoami')).rejects.toThrow();
    await expect(service.connectRepository(workspace.id, 'not a url')).rejects.toThrow(
      /valid URL/i,
    );
  });
});
