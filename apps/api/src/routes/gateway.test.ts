/**
 * The gateway, driven the way another application would drive it.
 *
 * A real MCP client over HTTP against the real server: the guard, the
 * transport, the tools. Nothing here is a double, because every interesting
 * failure of this feature lives in the seams — a route the guard does not
 * cover, a cookie honoured where it must not be, a token whose scope the
 * handler checks but the transport reaches around.
 *
 * `mcp-gateway.test.ts` covers the scope rules themselves at handler level.
 * What is proved here is that they are what an outside caller actually meets.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_COOKIE } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const USERNAME = 'gateway-owner';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;
let mineId: string;
let theirsId: string;
let secret: string;

/** A client speaking the protocol with whatever credential is given. */
async function connect(token: string | null): Promise<Client> {
  const client = new Client({ name: 'outside-app', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/gateway/mcp`), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    }),
  );
  return client;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies,
      'x-metaclaude-csrf': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mc-gateway-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataDir, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataDir, 'workspaces'),
    METACLAUDE_WEB_DIR: join(dataDir, 'web'),
    METACLAUDE_INSECURE_COOKIES: 'true',
    METACLAUDE_PORT: '8787',
  } as NodeJS.ProcessEnv);

  context = await createAppContext(config, pino({ level: 'silent' }));
  await context.auth.createUser({ username: USERNAME, password: PASSWORD, role: 'owner' });
  app = await buildServer(context);
  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const setCookies = login.headers.getSetCookie();
  cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  csrfToken = decodeURIComponent(
    setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))!.split(';')[0]!.split('=')[1]!,
  );

  for (const name of ['Mine', 'Theirs']) {
    const response = await post('/api/workspaces', { name });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { workspace: { id: string } }).workspace.id;
    if (name === 'Mine') mineId = id;
    else theirsId = id;
  }

  // Minted through the API, like an operator would: the route is part of what
  // is under test, not a shortcut around it.
  const minted = await post('/api/tokens', {
    name: 'outside app',
    scopes: ['run', 'read'],
    workspaceIds: [mineId],
    ceiling: 'plan',
    expiresInDays: 30,
  });
  expect(minted.status).toBe(201);
  secret = ((await minted.json()) as { secret: string }).secret;
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the door', () => {
  it('refuses a client with no token at all', async () => {
    await expect(connect(null)).rejects.toThrow();
  });

  it('refuses a made-up token', async () => {
    await expect(connect('mck_tok_0000000000000000000000_nope')).rejects.toThrow();
  });

  /**
   * The confused-deputy case, end to end.
   *
   * A signed-in operator's cookie is the credential a browser attaches by
   * itself, and this route carries no CSRF token. If the cookie worked here,
   * any page the operator visited could run tools in their name.
   */
  it('refuses a perfectly valid session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/gateway/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: cookies,
        'x-metaclaude-csrf': csrfToken,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
  });

  /** A real MCP client sends no Origin; a browser always does. */
  it('refuses a request carrying an Origin, token or not', async () => {
    const response = await fetch(`${baseUrl}/api/gateway/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${secret}`,
        origin: 'https://evil.test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(403);
  });

  /**
   * `405`, not `404`, and the difference is not cosmetic.
   *
   * A Streamable HTTP client opens a `GET` to look for a server-initiated
   * stream. The specification lets a server answer `405` to say it has none,
   * and the reference client treats exactly that status as "carry on" —
   * *every other status becomes an error it raises*. Leaving the method
   * unregistered answers `404` from the not-found handler, which makes a
   * conforming client report a broken server while every request works.
   */
  it('answers 405 on the methods a stateless server has nothing to offer for', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${baseUrl}/api/gateway/mcp`, {
        method,
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(response.status, method).toBe(405);
    }
  });

  it('still requires a token on those methods', async () => {
    // They are registered routes now, so they are inside the guard — a status
    // that leaks whether an endpoint exists is a status handed out for free.
    expect((await fetch(`${baseUrl}/api/gateway/mcp`, { method: 'GET' })).status).toBe(401);
  });

  it('refuses a revoked token immediately', async () => {
    const minted = await post('/api/tokens', {
      name: 'short lived',
      scopes: ['read'],
      workspaceIds: [mineId],
      ceiling: 'plan',
      expiresInDays: 1,
    });
    const { token, secret: doomed } = (await minted.json()) as {
      token: { id: string };
      secret: string;
    };

    await (await connect(doomed)).close();

    const revoked = await fetch(`${baseUrl}/api/tokens/${token.id}`, {
      method: 'DELETE',
      headers: { cookie: cookies, 'x-metaclaude-csrf': csrfToken },
    });
    expect(revoked.status).toBe(200);

    await expect(connect(doomed)).rejects.toThrow();
  });
});

describe('the tools', () => {
  it('offers exactly the tools this gateway means to expose', async () => {
    const client = await connect(secret);

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'ask_workspace',
      'list_tasks',
      'list_workspaces',
      'run_status',
      'search_notes',
      'start_run',
    ]);

    await client.close();
  });

  it('lists only the workspaces the token was given', async () => {
    const client = await connect(secret);

    const result = (await client.callTool({ name: 'list_workspaces', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    const listed = JSON.parse(result.content[0]!.text) as Array<{ id: string }>;

    expect(listed.map((one) => one.id)).toEqual([mineId]);
    await client.close();
  });

  /**
   * An empty list is a conclusion the caller cannot check.
   *
   * A token whose grants were pruned by a workspace deletion reaches nothing,
   * and `list_workspaces` used to answer `[]` — which a program on the other
   * side reports to its operator as "this deployment has no workspaces". It
   * happened in production. The answer now says which of the two it is, and
   * the count is what makes it checkable.
   */
  it('says a token reaches nothing rather than answering an empty list', async () => {
    const minted = await post('/api/tokens', {
      name: 'stale',
      scopes: ['read'],
      workspaceIds: [mineId],
      ceiling: 'plan',
      expiresInDays: 7,
    });
    const body = (await minted.json()) as { secret: string; token: { id: string } };
    // Exactly the production state: the grant names a workspace that no longer
    // exists. Set on this token alone — pruning `mineId` would empty the grants
    // of every other case in this file.
    context.apiTokens.update(body.token.id, { workspaceIds: ['ws_deleted'] });

    const client = await connect(body.secret);

    const result = (await client.callTool({ name: 'list_workspaces', arguments: {} })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/reaches none of the/i);
    expect(result.content[0]!.text).toMatch(/grant it a workspace again/i);
    await client.close();
  });

  /**
   * The property the whole design rests on. The other workspace exists, and
   * the answer must not say so.
   */
  it('answers for a workspace outside the token as if it did not exist', async () => {
    const client = await connect(secret);

    const result = (await client.callTool({
      name: 'list_tasks',
      arguments: { workspace: theirsId },
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no workspace/i);
    expect(result.content[0]!.text).not.toMatch(/permission|denied|scope/i);
    await client.close();
  });

  it('refuses a capability the token does not carry', async () => {
    const minted = await post('/api/tokens', {
      name: 'read only',
      scopes: ['read'],
      workspaceIds: [mineId],
      ceiling: 'plan',
      expiresInDays: 30,
    });
    const readOnly = ((await minted.json()) as { secret: string }).secret;
    const client = await connect(readOnly);

    const result = (await client.callTool({
      name: 'ask_workspace',
      arguments: { workspace: mineId, prompt: 'do something' },
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not allowed to start runs/i);
    await client.close();
  });

  /**
   * Stateless means the token on *this* request decides what it sees. Two
   * clients alive at once must not be able to inherit one another's identity,
   * which a shared session table is exactly how you get wrong.
   */
  it('keeps two concurrent clients apart', async () => {
    const minted = await post('/api/tokens', {
      name: 'other reach',
      scopes: ['read'],
      workspaceIds: [theirsId],
      ceiling: 'plan',
      expiresInDays: 30,
    });
    const otherSecret = ((await minted.json()) as { secret: string }).secret;

    const [mine, theirs] = await Promise.all([connect(secret), connect(otherSecret)]);
    const read = async (client: Client) => {
      const result = (await client.callTool({ name: 'list_workspaces', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      return (JSON.parse(result.content[0]!.text) as Array<{ id: string }>).map((one) => one.id);
    };

    expect(await read(mine)).toEqual([mineId]);
    expect(await read(theirs)).toEqual([theirsId]);

    await Promise.all([mine.close(), theirs.close()]);
  });
});

/**
 * Minting is an owner's decision.
 *
 * A token can make this deployment execute things for a year with nobody
 * present. That is the weight of adding a user, not of editing a skill, and
 * `operator` — the role that may change almost everything else here —
 * deliberately does not carry it.
 */
/**
 * What one exchange actually costs the per-token budget.
 *
 * The bucket is sized in *HTTP requests*, not in tool calls, and the two are
 * not the same number: a client opens by negotiating the protocol before it
 * can ask anything. That figure was assumed when the limiter was written. It
 * is measured here instead, so the assumption fails loudly the day a transport
 * upgrade changes it — a budget calibrated against the wrong unit is a
 * limiter that throttles honest callers or lets a loop through.
 */
describe('what an exchange costs', () => {
  it('takes a handful of requests to connect, list and call once', async () => {
    const real = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/api/gateway/mcp')) requests += 1;
      return real(input, init);
    }) as typeof fetch;

    try {
      const client = await connect(secret);
      await client.listTools();
      await client.callTool({ name: 'list_workspaces', arguments: {} });
      await client.close();
    } finally {
      globalThis.fetch = real;
    }

    // Pinned as a range, not a constant: the exact count is the SDK's business
    // and may reasonably shift by one. An order of magnitude may not — that
    // would mean the budget below is calibrated against the wrong thing.
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(requests).toBeLessThanOrEqual(8);
  });
});

describe('minting', () => {
  let operatorCookies: string;
  let operatorCsrf: string;

  beforeAll(async () => {
    await context.auth.createUser({
      username: 'gateway-operator',
      password: PASSWORD,
      role: 'operator',
    });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'gateway-operator', password: PASSWORD }),
    });
    const setCookies = login.headers.getSetCookie();
    operatorCookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
    operatorCsrf = decodeURIComponent(
      setCookies
        .find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))!
        .split(';')[0]!
        .split('=')[1]!,
    );
  });

  it('refuses an operator, who may change nearly everything else', async () => {
    const response = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: operatorCookies,
        'x-metaclaude-csrf': operatorCsrf,
      },
      body: JSON.stringify({
        name: 'sneaky',
        scopes: ['run'],
        workspaceIds: [mineId],
        ceiling: 'acceptEdits',
        expiresInDays: 365,
      }),
    });

    expect(response.status).toBe(403);
    // And listing them is not a consolation prize: the hints and the reach of
    // every integration are exactly the map an attacker would want.
    expect(
      (await fetch(`${baseUrl}/api/tokens`, { headers: { cookie: operatorCookies } })).status,
    ).toBe(403);
  });

  it('never returns the secret again, on any route', async () => {
    const minted = await post('/api/tokens', {
      name: 'once only',
      scopes: ['read'],
      workspaceIds: [mineId],
      ceiling: 'plan',
      expiresInDays: 7,
    });
    const created = (await minted.json()) as { token: { id: string; hint: string }; secret: string };

    const listing = await fetch(`${baseUrl}/api/tokens`, { headers: { cookie: cookies } });
    const body = await listing.text();

    expect(body).toContain(created.token.id);
    // The hint is in there — that is what it is for. The value is not.
    expect(body).toContain(created.token.hint);
    expect(body).not.toContain(created.secret);
  });

  it('refuses a token pointing at a workspace that does not exist', async () => {
    const response = await post('/api/tokens', {
      name: 'nowhere',
      scopes: ['read'],
      workspaceIds: ['ws_nothing'],
      ceiling: 'plan',
      expiresInDays: 7,
    });

    expect(response.status).toBe(400);
  });

  it('refuses an expiry beyond a year, whatever the caller asks for', async () => {
    const response = await post('/api/tokens', {
      name: 'forever',
      scopes: ['read'],
      workspaceIds: [mineId],
      ceiling: 'plan',
      expiresInDays: 3650,
    });

    expect(response.status).toBe(400);
  });
});
