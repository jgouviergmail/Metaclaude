/**
 * Which transport a configuration turns into.
 *
 * Thin, and worth pinning anyway: the two HTTP shapes are chosen by a string
 * from the database, and picking the wrong one fails at connection time with
 * a protocol error rather than a configuration one — the kind of mistake that
 * gets read as "the server is down".
 *
 * Nothing here connects. Building a transport spawns nothing until it is
 * connected, so this stays a pure construction test.
 */

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { buildMcpTransport } from './mcp-transport.js';

describe('buildMcpTransport', () => {
  it('spawns a process for a stdio server', () => {
    const transport = buildMcpTransport({
      type: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'sealed' },
    });

    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  it('uses the streaming transport for http, and the older one for sse', () => {
    const http = buildMcpTransport({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    const sse = buildMcpTransport({
      type: 'sse',
      url: 'https://example.test/sse',
      headers: {},
    });

    expect(http).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(sse).toBeInstanceOf(SSEClientTransport);
  });

  it('refuses a URL it cannot parse rather than failing at connect time', () => {
    expect(() =>
      buildMcpTransport({ type: 'http', url: 'not a url', headers: {} }),
    ).toThrow();
  });
});
