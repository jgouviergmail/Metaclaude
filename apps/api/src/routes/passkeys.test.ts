/**
 * The passkey routes, through the real server — real HTTP, real guards, real
 * @simplewebauthn generating the options. The edge-schema lesson (see
 * CLAUDE.md, recovery codes): a service test cannot see a route that refuses
 * upstream of it, so what is asserted here is the edge itself — which paths
 * are public, what the IP refusal looks like over the wire, and that a
 * ceremony nobody started dies as a plain 401.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE, SESSION_COOKIE } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const USERNAME = 'keyholder';
const PASSWORD = 'a-long-enough-test-password';
const DOMAIN_ORIGIN = 'https://claude.home.arpa';
const IP_ORIGIN = 'https://203.0.113.7';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;

async function post(path: string, body: unknown, origin: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
      origin,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-passkey-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
    // A deployment reachable at both a hostname and its bare IP — the exact
    // situation the refusal exists for.
    METACLAUDE_ALLOWED_ORIGINS: `${DOMAIN_ORIGIN},${IP_ORIGIN}`,
  } as NodeJS.ProcessEnv);

  context = await createAppContext(config, pino({ level: 'silent' }));
  await context.auth.createUser({ username: USERNAME, password: PASSWORD, role: 'owner' });
  app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const setCookies = response.headers.getSetCookie();
  cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
  csrfToken = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);
  expect(cookies).toContain(SESSION_COOKIE);
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('enrolment at the edge', () => {
  it('answers real options for a domain origin, rp bound to it', async () => {
    const response = await post('/api/auth/passkeys/begin', { password: PASSWORD }, DOMAIN_ORIGIN);
    expect(response.status).toBe(200);
    const { options } = (await response.json()) as {
      options: { challenge: string; rp: { id: string }; excludeCredentials: unknown[] };
    };
    expect(options.challenge.length).toBeGreaterThan(16);
    expect(options.rp.id).toBe('claude.home.arpa');
    expect(options.excludeCredentials).toEqual([]);
  });

  it('refuses an IP origin with the fix in the message, before any ceremony', async () => {
    const response = await post('/api/auth/passkeys/begin', { password: PASSWORD }, IP_ORIGIN);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/domain/i);
    expect(body.error).toContain('METACLAUDE_SITE');
  });

  it('refuses a wrong password before offering anything', async () => {
    const response = await post(
      '/api/auth/passkeys/begin',
      { password: 'wrong-password-entirely' },
      DOMAIN_ORIGIN,
    );
    expect(response.status).toBe(403);
  });
});

describe('the sign-in ceremony is reachable before any session', () => {
  it('hands out a challenge with no cookie at all', async () => {
    const response = await fetch(`${baseUrl}/api/auth/passkey/begin`, {
      method: 'POST',
      headers: { origin: DOMAIN_ORIGIN },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ceremonyId: string; options: { challenge: string } };
    expect(body.ceremonyId.length).toBeGreaterThan(8);
    expect(body.options.challenge.length).toBeGreaterThan(16);
  });

  it('still refuses an IP origin there', async () => {
    const response = await fetch(`${baseUrl}/api/auth/passkey/begin`, {
      method: 'POST',
      headers: { origin: IP_ORIGIN },
    });
    expect(response.status).toBe(422);
  });

  it('a finish nobody began is a plain 401, not a stack trace', async () => {
    const response = await fetch(`${baseUrl}/api/auth/passkey/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: DOMAIN_ORIGIN },
      body: JSON.stringify({ ceremonyId: 'never-issued', response: { id: 'cred-x' } }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('invalid');
  });
});

describe('management stays behind the session', () => {
  it('lists nothing to nobody', async () => {
    const response = await fetch(`${baseUrl}/api/auth/passkeys`);
    expect(response.status).toBe(401);
  });

  it('bootstrap-status tells the login screen whether the button could work', async () => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap-status`);
    const body = (await response.json()) as { passkeysEnrolled: boolean };
    expect(body.passkeysEnrolled).toBe(false);
  });
});
