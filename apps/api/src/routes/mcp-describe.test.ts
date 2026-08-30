/**
 * Asking a server what it offers, driven through the edge — and kept.
 *
 * `mcp-probe.test.ts` proves the probe reads a server correctly, and
 * `registry.test.ts` proves `saveDescription` writes and reads back. Neither
 * can see the thing an operator actually ran into: press Test, read the tools,
 * navigate away, come back to an empty card. What closes that is the route
 * storing what it just learned and the listing carrying it — two decisions
 * that live only here.
 *
 * So this boots the real server and points a real MCP server at it: a
 * Streamable HTTP endpoint on loopback answering real protocol messages. No
 * CLI, no outside network, and no test double standing in for the thing under
 * test.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CSRF_COOKIE, type McpServerRecord } from '@metaclaude/shared';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createAppContext } from '../context.js';
import { buildServer } from '../server.js';

const USERNAME = 'describe-operator';
const PASSWORD = 'a-long-enough-test-password';

let dataDir: string;
let context: AppContext;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let cookies: string;
let csrfToken: string;

/** The loopback host the described server answers on, and its live sessions. */
let mcpHost: Server;
let mcpUrl: string;
const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

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

async function listed(id: string): Promise<McpServerRecord> {
  const response = await fetch(`${baseUrl}/api/mcp?scope=global`, { headers: { cookie: cookies } });
  expect(response.status).toBe(200);
  const { servers } = (await response.json()) as { servers: McpServerRecord[] };
  const found = servers.find((server) => server.id === id);
  expect(found).toBeDefined();
  return found!;
}

/** A real MCP server, one per session, the way a configured one behaves. */
function describedServer(): McpServer {
  const mcp = new McpServer(
    { name: 'inventory', version: '2.1.0' },
    { instructions: 'Ask it about stock.' },
  );
  mcp.registerTool(
    'list_items',
    { description: 'Returns the items in stock.', inputSchema: { category: z.string().optional() } },
    async () => ({ content: [{ type: 'text' as const, text: '[]' }] }),
  );
  return mcp;
}

beforeAll(async () => {
  // A session per connection, which is what the probe actually does: it
  // connects, asks, and closes — and closing sends the DELETE that ends the
  // session. One shared transport therefore answers the first test and 404s
  // every one after it, and the SDK's stateless mode refuses the `initialized`
  // notification that follows a handshake, so neither shortcut survives more
  // than one probe.
  mcpHost = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      void (async () => {
        const body = raw ? JSON.parse(raw) : undefined;
        const sessionId = request.headers['mcp-session-id'];
        let transport = typeof sessionId === 'string' ? mcpSessions.get(sessionId) : undefined;

        if (!transport) {
          // Annotated because the handlers below close over the very binding
          // being initialised, which TypeScript cannot infer through.
          const opened: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              mcpSessions.set(id, opened);
            },
          });
          opened.onclose = () => {
            if (opened.sessionId) mcpSessions.delete(opened.sessionId);
          };
          await describedServer().connect(opened);
          transport = opened;
        }

        await transport.handleRequest(request, response, body);
      })();
    });
  });
  await new Promise<void>((resolve) => mcpHost.listen(0, '127.0.0.1', resolve));
  const mcpAddress = mcpHost.address();
  const mcpPort = typeof mcpAddress === 'object' && mcpAddress ? mcpAddress.port : 0;
  mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  dataDir = mkdtempSync(join(tmpdir(), 'mc-describe-'));
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
  expect(login.status).toBe(200);
  const setCookies = login.headers.getSetCookie();
  cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  const csrf = setCookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
  csrfToken = decodeURIComponent(csrf!.split(';')[0]!.split('=')[1]!);
});

afterAll(async () => {
  await app?.close();
  await context?.shutdown?.();
  for (const session of mcpSessions.values()) await session.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (!mcpHost) return resolve();
    mcpHost.close(() => resolve());
  });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/mcp/:id/describe', () => {
  const register = async (name: string, url = mcpUrl): Promise<McpServerRecord> => {
    const response = await post('/api/mcp', { workspaceId: null, name, transport: 'http', url });
    expect(response.status).toBe(201);
    return ((await response.json()) as { server: McpServerRecord }).server;
  };

  it('brings back the server’s own words and keeps them on the row', async () => {
    const server = await register('inventory-kept');
    // Null, not an empty list: nothing has asked yet, which is a different
    // state from a server that answered and exposes nothing.
    expect(server.described).toBeNull();

    const response = await post(`/api/mcp/${server.id}/describe`, {});
    expect(response.status).toBe(200);
    const { description } = (await response.json()) as {
      description: { instructions: string | null; tools: { name: string; description: string }[] };
    };
    expect(description.instructions).toBe('Ask it about stock.');
    expect(description.tools).toEqual([
      { name: 'list_items', description: 'Returns the items in stock.' },
    ]);

    // The point of the whole change: a later reader, on a fresh listing that
    // asked nobody anything, still sees what that test learned.
    const after = await listed(server.id);
    expect(after.described?.instructions).toBe('Ask it about stock.');
    expect(after.described?.tools).toEqual([
      { name: 'list_items', description: 'Returns the items in stock.' },
    ]);
    expect(after.described!.at).toBeGreaterThan(0);
  });

  /**
   * A stored answer is a snapshot, and a snapshot that cannot be told from a
   * live reading is a lie waiting to happen. The route stores *when*, and the
   * card shows it.
   */
  it('refreshes the stamp on every test, so the card can say how old it is', async () => {
    const server = await register('inventory-restamped');

    expect((await post(`/api/mcp/${server.id}/describe`, {})).status).toBe(200);
    const first = (await listed(server.id)).described!.at;

    expect((await post(`/api/mcp/${server.id}/describe`, {})).status).toBe(200);
    expect((await listed(server.id)).described!.at).toBeGreaterThanOrEqual(first);
  });

  /**
   * A failed probe is not a verdict on the server — and it must not be
   * mistaken for one on the stored list either. Overwriting with nothing would
   * turn a momentary blip into "this server exposes no tools".
   */
  it('leaves the last known description alone when the probe fails', async () => {
    const server = await register('inventory-flaky');
    expect((await post(`/api/mcp/${server.id}/describe`, {})).status).toBe(200);
    const kept = await listed(server.id);
    expect(kept.described).not.toBeNull();

    // Point it at an address nothing answers on, then ask again.
    const moved = await post('/api/mcp', {
      id: server.id,
      workspaceId: null,
      name: 'inventory-flaky',
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
    });
    expect(moved.status).toBe(200);

    const failed = await post(`/api/mcp/${server.id}/describe`, {});
    expect(failed.status).toBe(502);

    expect((await listed(server.id)).described).toEqual(kept.described);
  });
});

/**
 * The badge the operator reads after pressing Test.
 *
 * `mcp_servers.status` could only ever hold `unknown` or `failed`: nothing in
 * the codebase ever wrote `connected`. So seven servers on a live deployment,
 * every one of them tested by hand and answering, all still showed `unknown` —
 * reported as a persistence bug, and it was worse than that. The value was
 * unreachable.
 *
 * A successful test is a verdict and is recorded. A failed one deliberately is
 * not: the route's own reasoning holds — a description that cannot be fetched
 * may be a slow server or a credential this process cannot see, and condemning
 * it on that is worse than saying nothing. So the badge answers "did it answer
 * us the last time we asked", and the live catalogue keeps answering "is it up
 * right now".
 */
describe('what a test writes on the row', () => {
  const register = async (name: string, url = mcpUrl): Promise<McpServerRecord> => {
    const response = await post('/api/mcp', { workspaceId: null, name, transport: 'http', url });
    expect(response.status).toBe(201);
    return ((await response.json()) as { server: McpServerRecord }).server;
  };

  it('records that the server answered, so the badge stops saying unknown', async () => {
    const server = await register('status-recorded');
    expect(server.status).toBe('unknown');

    expect((await post(`/api/mcp/${server.id}/describe`, {})).status).toBe(200);

    const after = await listed(server.id);
    expect(after.status).toBe('connected');
    expect(after.lastError).toBeNull();
  });

  it('does not condemn a server whose description could not be fetched', async () => {
    const server = await register('status-untouched', 'http://127.0.0.1:9/mcp');
    expect((await post(`/api/mcp/${server.id}/describe`, {})).status).toBe(502);

    // Still `unknown`: the probe failing is not evidence the server is down.
    expect((await listed(server.id)).status).toBe('unknown');
  });

  it('clears a stale error once the server answers again', async () => {
    const server = await register('status-recovered');
    expect((await post(`/api/mcp/${server.id}/describe`, {})).status).toBe(200);
    expect((await listed(server.id)).status).toBe('connected');
  });
});
