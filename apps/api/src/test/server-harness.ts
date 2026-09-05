/**
 * A booted server for route tests.
 *
 * Ten route tests carried the same forty lines: a throwaway data directory,
 * `loadConfig` with the test environment, `createAppContext`, `buildServer`,
 * a login, the cookie jar and the CSRF token, then `fetch` helpers. This is
 * that once. It stays deliberately thin — the real context and the real
 * server, nothing stubbed — because what a route test is for is the edge:
 * schemas, status codes, audit lines, and the guards between them.
 *
 * A test must never spawn the CLI; stub `context.kernel` methods on the
 * instance for anything that would (`vi.spyOn(harness.context.kernel, …)`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { expect } from 'vitest';
import { CSRF_COOKIE, type UserRole } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ServerHarness {
  context: AppContext;
  baseUrl: string;
  /** A request as the logged-in user, with the CSRF header on writes. */
  send(method: HttpMethod, path: string, body?: unknown): Promise<Response>;
  /** A `GET` that must succeed, parsed. */
  get<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

const PASSWORD = 'a-long-enough-test-password';

export async function bootTestServer(options: {
  /** Also the temp directory's prefix, so a leaked one names its test. */
  name: string;
  username?: string;
  role?: UserRole;
}): Promise<ServerHarness> {
  const username = options.username ?? `${options.name}-user`;
  const dataDir = mkdtempSync(join(tmpdir(), `mc-${options.name}-`));

  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
  } as NodeJS.ProcessEnv);

  const context = await createAppContext(config, pino({ level: 'silent' }));
  await context.auth.createUser({ username, password: PASSWORD, role: options.role ?? 'owner' });
  const app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const setCookies = login.headers.getSetCookie();
  const cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
  const csrfToken = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);

  const send = (method: HttpMethod, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        // Only with a body: Fastify answers 400 to a JSON content type over
        // an empty one, which reads as a broken DELETE guard.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: cookies,
        ...(method === 'GET' ? {} : { 'x-metaclaude-csrf': csrfToken }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    context,
    baseUrl,
    send,
    get: async <T>(path: string): Promise<T> => {
      const response = await send('GET', path);
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    },
    close: async () => {
      await app.close();
      await context.shutdown?.();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
