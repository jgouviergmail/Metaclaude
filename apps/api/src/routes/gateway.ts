/**
 * The MCP endpoint other applications connect to.
 *
 * One route, one method. Everything about it is narrower than the rest of the
 * API on purpose, because it is the only surface where a program that is not a
 * browser, holding a credential that never expires within a session, can make
 * this deployment execute something.
 *
 * **Stateless.** A fresh MCP server and transport per request, which is the
 * SDK's own stateless pattern. There is no session table to grow, nothing to
 * sweep, and no possibility of one token's request resuming another's session
 * — the token on *this* request decides what this request can see, every time.
 *
 * **The guard is not here.** `authenticateBearer` runs in the global
 * `onRequest` hook, because a check a route installs for itself is a check the
 * next route forgets. What this file may assume, and asserts, is that
 * `request.apiToken` is set.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../context.js';
import { HttpError, requireApiToken } from '../http/guards.js';
import type { App } from '../http/types.js';
import { TokenBucket } from '../security/ratelimit.js';
import { buildGatewayServer } from '../services/mcp-gateway.js';

/**
 * A budget per token rather than per address.
 *
 * The global limiter counts by IP, and every call from one integration shares
 * one address: a busy automation would either exhaust the budget the interface
 * needs or be throttled by traffic that has nothing to do with it.
 *
 * Sized against a *measured* figure, not an assumed one. One complete exchange
 * — connect, negotiate, list the tools, call one, disconnect — costs **five
 * HTTP requests**, because a client has to establish the protocol before it can
 * ask anything (`gateway.test.ts` pins that measurement, so a transport upgrade
 * that changes it fails loudly rather than silently miscalibrating this).
 *
 * The first version of these numbers was written before that was known and read
 * as generous while allowing six exchanges: the budget was counting the wrong
 * unit. At 60 and 1/s a token may burst a dozen exchanges and sustain twelve a
 * minute — far above any honest integration, since a run costs minutes of an
 * agent's time, and far below a loop.
 */
const REQUESTS_PER_EXCHANGE = 5;
const GATEWAY_CAPACITY = 12 * REQUESTS_PER_EXCHANGE;
const GATEWAY_REFILL_PER_SECOND = 1;

export function registerGatewayRoutes(app: App, context: AppContext): void {
  const budget = new TokenBucket(GATEWAY_CAPACITY, GATEWAY_REFILL_PER_SECOND);

  const deps = {
    workspaces: context.workspaceRepo,
    kernel: context.kernel,
    knowledge: context.knowledge,
    board: context.board,
    runs: context.runRepo,
    transcript: context.transcriptRepo,
    audit: context.audit,
  };

  /**
   * Streamable HTTP also defines `GET`, for a server-initiated stream, and
   * `DELETE`, to end a session. A stateless server has neither to offer — and
   * `405` is not a nicety here, it is the contract: the specification says a
   * server MAY answer `405` to that `GET`, and the reference client treats
   * exactly that status as "no stream here, carry on". **Every other status is
   * an error it raises**, so leaving these unregistered — which answers `404`
   * from the not-found handler — makes a conforming client report a broken
   * server while every request actually works. Registered rather than
   * commented, because the comment saying so was wrong for a release.
   */
  for (const method of ['get', 'delete'] as const) {
    app[method]('/api/gateway/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
      requireApiToken(request);
      return reply.status(405).send({ error: 'This endpoint is POST only.', code: 'method' });
    });
  }

  /** The protocol's one working endpoint. */
  app.post('/api/gateway/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = requireApiToken(request);

    if (!budget.take(token.id)) {
      throw new HttpError(429, 'Too many requests for this token.', 'rate_limited');
    }

    // `createSdkMcpServer` returns the agent SDK's *configuration* wrapper; the
    // protocol object that speaks to a transport is the `instance` inside it.
    // The wrapper is what a run mounts in-process, and reusing it here is what
    // keeps one definition of these tools rather than two.
    const server = buildGatewayServer(deps, token).instance;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Whatever happens to the connection, nothing is left behind: a stateless
    // request that leaked its transport would leak one per call.
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);

    // Fastify has parsed the body and must now stay out of the way: the
    // transport writes the response itself, including when it streams.
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      // Past `hijack()` Fastify's error handler cannot answer — it would try to
      // send on a reply it no longer owns. Without this the socket simply stays
      // open, and the caller waits out the proxy's 30-minute read timeout for a
      // request that failed immediately. Answer on the raw socket, or at least
      // close it.
      context.log.error({ err: error }, 'gateway request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'Internal server error.', code: 'internal' }));
      } else {
        reply.raw.end();
      }
    }
  });
}
