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
 * needs or be throttled by traffic that has nothing to do with it. Sized for
 * an integration that polls, not for one that streams — a run costs minutes of
 * an agent's time, so a token asking faster than this is a loop, not a user.
 */
const GATEWAY_CAPACITY = 30;
const GATEWAY_REFILL_PER_SECOND = 0.5;

export function registerGatewayRoutes(app: App, context: AppContext): void {
  const budget = new TokenBucket(GATEWAY_CAPACITY, GATEWAY_REFILL_PER_SECOND);

  const deps = {
    workspaces: context.workspaceRepo,
    kernel: context.kernel,
    knowledge: context.knowledge,
    board: context.board,
    audit: context.audit,
  };

  /**
   * The protocol's single endpoint.
   *
   * `POST` only. Streamable HTTP also defines `GET` for a server-initiated
   * stream and `DELETE` to end a session; a stateless server has neither to
   * offer, and answering them with an empty 405 is more honest than opening a
   * stream that will never carry anything.
   */
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
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}
