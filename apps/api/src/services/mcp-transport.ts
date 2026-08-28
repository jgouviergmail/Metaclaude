/**
 * Turning a mounted MCP configuration into a client transport.
 *
 * Split from the probe so the probe stays about the *conversation* — connect,
 * ask, close — and this stays about the plumbing. It also keeps the probe
 * testable over an in-memory pair, with no process and no port.
 *
 * The configuration is the one the registry hands a run, secrets already
 * resolved, so what is asked here is asked with the same credentials a run
 * would use. What it is *not* is a second opinion on connectivity: the answer
 * from a transport built here says whether this process could reach the
 * server, which is a different question from whether the CLI could.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpMountConfig } from './registry.js';

export function buildMcpTransport(config: McpMountConfig): Transport {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      // The child inherits nothing but what the registry resolved. A probe is
      // a subprocess with the same reach as a run's, so it gets the same
      // deliberately narrow environment rather than this process's.
      env: config.env,
      // Its own diagnostics belong nowhere near the response.
      stderr: 'ignore',
    });
  }

  const url = new URL(config.url);
  const requestInit = { headers: config.headers };

  // `sse` is the older shape and some servers still speak only that one.
  return config.type === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}
