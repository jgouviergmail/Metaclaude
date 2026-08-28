/**
 * The directory listing route.
 *
 * `FileService.list` caps a listing at `MAX_DIRECTORY_ENTRIES` and says so;
 * that signal is only useful if it survives the route. Dropping it is a
 * one-word omission that no service test can see — the service still returns
 * the flag — and no component test can see either, because the panel's `api`
 * is mocked. This is the only layer where the two halves meet, so it is the
 * only place the propagation can be pinned.
 */

import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppContext } from '../context.js';
import { FileService, MAX_DIRECTORY_ENTRIES } from '../services/files.js';
import type { App } from '../http/types.js';
import { registerFileRoutes } from './files.js';

let root: string;
let app: ReturnType<typeof Fastify>;

/**
 * Only what the listing route touches. A full server would drag in scrypt,
 * the kernel and a database for three lines of handler; what is under test is
 * the handler, and the FileService below it is the real one.
 */
function stubContext(workspacePath: string): AppContext {
  return {
    files: new FileService(),
    workspaceRepo: {
      get: (id: string) => (id === 'ws_a' ? { id, slug: 'alpha', path: workspacePath } : undefined),
    },
  } as unknown as AppContext;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mc-files-route-'));
  app = Fastify();
  registerFileRoutes(app as unknown as App, stubContext(root));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/workspaces/:id/files', () => {
  it('lists what is there, and says nothing about truncation', async () => {
    writeFileSync(join(root, 'bail.md'), 'Le préavis est de trois mois.');

    const response = await app.inject({ method: 'GET', url: '/api/workspaces/ws_a/files' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.entries.map((entry: { name: string }) => entry.name)).toContain('bail.md');
    expect(body.truncated).toBe(false);
  });

  it('tells the client when the listing was cut', async () => {
    // Without this the browser shows a thousand rows and calls it the folder.
    // The count is the *only* difference between "small folder" and "the top
    // of a very large one", and a client cannot infer it.
    const big = join(root, 'many');
    rmSync(big, { recursive: true, force: true });
    const service = new FileService();
    await service.createDirectory(root, 'many');
    for (let i = 0; i < MAX_DIRECTORY_ENTRIES + 5; i += 1) {
      writeFileSync(join(big, `f${i}.txt`), 'x');
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws_a/files?path=many',
    });

    const body = response.json();
    expect(body.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(body.truncated).toBe(true);
  });
});
