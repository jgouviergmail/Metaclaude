/**
 * The settings route, driven against a real server.
 *
 * The service decides what may be stored; this asserts the two things only the
 * route can get wrong. **It is owner-only**, because an operator account is not
 * the person who decides how long a run may take or how many may run at once.
 * And **the surface is closed**: the catalogue is the whole of it, so a
 * hand-made request naming a security setting gets a 404 rather than a stored
 * row — the security tier is absent from the surface, not merely from the form.
 *
 * The round trip matters too. A form that saves and then reads back a
 * different value is how a screen and a `.env` come to disagree, so every
 * write here is checked by reading it again.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE, type RuntimeSettingRecord } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const OWNER = 'settings-owner';
const OPERATOR = 'settings-operator';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let owner: { cookies: string; csrf: string };
let operator: { cookies: string; csrf: string };

async function signIn(username: string): Promise<{ cookies: string; csrf: string }> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const setCookies = response.headers.getSetCookie();
  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))!;
  return {
    cookies: setCookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf: decodeURIComponent(csrf.split(';')[0]!.split('=')[1]!),
  };
}

function put(
  who: { cookies: string; csrf: string },
  key: string,
  value: number | string | null,
): Promise<Response> {
  return fetch(`${baseUrl}/api/system/settings/${key}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: who.cookies,
      'x-metaclaude-csrf': who.csrf,
    },
    body: JSON.stringify({ value }),
  });
}

async function read(who: { cookies: string }): Promise<RuntimeSettingRecord[]> {
  const response = await fetch(`${baseUrl}/api/system/settings`, {
    headers: { cookie: who.cookies },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { settings: RuntimeSettingRecord[] }).settings;
}

const find = (records: RuntimeSettingRecord[], key: string) =>
  records.find((record) => record.key === key)!;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-rtset-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
    METACLAUDE_MAX_CONCURRENT_RUNS: '6',
  } as NodeJS.ProcessEnv);

  context = await createAppContext(config, pino({ level: 'silent' }));
  await context.auth.createUser({ username: OWNER, password: PASSWORD, role: 'owner' });
  await context.auth.createUser({ username: OPERATOR, password: PASSWORD, role: 'operator' });
  app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  owner = await signIn(OWNER);
  operator = await signIn(OPERATOR);
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('who may read and write them', () => {
  it('answers an owner with every setting and its provenance', async () => {
    const settings = await read(owner);
    expect(settings.length).toBeGreaterThanOrEqual(7);

    // Declared in this test's environment, so it must say so rather than
    // claiming a default that happens to differ.
    const concurrency = find(settings, 'maxConcurrentRuns');
    expect(concurrency.value).toBe(6);
    expect(concurrency.source).toBe('environment');

    const idle = find(settings, 'idleTimeoutMs');
    expect(idle.source).toBe('default');
  });

  it('refuses an operator, who does not decide this', async () => {
    const listing = await fetch(`${baseUrl}/api/system/settings`, {
      headers: { cookie: operator.cookies },
    });
    expect(listing.status).toBe(403);
    expect((await put(operator, 'maxConcurrentRuns', 8)).status).toBe(403);
  });
});

describe('writing one', () => {
  it('stores it, says it is stored, and names what it shadows', async () => {
    const response = await put(owner, 'maxConcurrentRuns', 12);
    expect(response.status).toBe(200);

    const record = find(await read(owner), 'maxConcurrentRuns');
    expect(record.value).toBe(12);
    expect(record.source).toBe('stored');
    expect(record.fallback).toBe(6);
    expect(record.updatedBy).toBe(OWNER);
  });

  it('takes effect on the running server, with no restart', () => {
    // The point of the whole feature: the kernel reads through a getter, so
    // this is the value the next submission is admitted against.
    expect(context.runtimeSettings.number('maxConcurrentRuns')).toBe(12);
  });

  it('goes back to the environment when the value is null', async () => {
    expect((await put(owner, 'maxConcurrentRuns', null)).status).toBe(200);

    const record = find(await read(owner), 'maxConcurrentRuns');
    expect(record.value).toBe(6);
    expect(record.source).toBe('environment');
    expect(record.updatedBy).toBeNull();
  });

  it('refuses a value the server could not boot with, and says why', async () => {
    const response = await put(owner, 'maxConcurrentRuns', 999);
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('64');

    // And nothing was stored: a 400 that still saves is worse than no check.
    expect(find(await read(owner), 'maxConcurrentRuns').source).toBe('environment');
  });

  it('refuses a duration between zero and the floor', async () => {
    expect((await put(owner, 'idleTimeoutMs', 5_000)).status).toBe(400);
    // Zero is not in that gap — it is how the ceiling is switched off.
    expect((await put(owner, 'idleTimeoutMs', 0)).status).toBe(200);
    expect(find(await read(owner), 'idleTimeoutMs').value).toBe(0);
    await put(owner, 'idleTimeoutMs', null);
  });
});

describe('the surface is closed', () => {
  /**
   * The list is the whole of it. A setting that is a security decision is not
   * hidden from the form — there is no route to it at all, which is what makes
   * `docs/SECURITY.md`'s "deployment-level decision" still true with a
   * settings screen in the product.
   */
  it('answers 404 for a security setting, rather than storing it', async () => {
    for (const key of [
      'allowBypassPermissions',
      'allowedOrigins',
      'trustProxy',
      'masterKey',
      'dataDir',
      'embeddings',
    ]) {
      expect((await put(owner, key, 1)).status).toBe(404);
    }
    expect(context.config.allowBypassPermissions).toBe(false);
  });

  it('answers 400 for a body that is not a value', async () => {
    const response = await fetch(`${baseUrl}/api/system/settings/logLevel`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: owner.cookies,
        'x-metaclaude-csrf': owner.csrf,
      },
      body: JSON.stringify({ nope: true }),
    });
    expect(response.status).toBe(400);
  });

  it('applies the log level to the running logger, which is not a getter', async () => {
    expect((await put(owner, 'logLevel', 'debug')).status).toBe(200);
    expect(context.log.level).toBe('debug');

    expect((await put(owner, 'logLevel', null)).status).toBe(200);
    expect(context.log.level).toBe('info');
  });
});

describe('the edge itself', () => {
  it('refuses an over-long string before anything looks at what it means', async () => {
    const response = await put(owner, 'logLevel', 'x'.repeat(200));
    expect(response.status).toBe(400);
  });
});
