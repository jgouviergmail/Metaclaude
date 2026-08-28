/**
 * Asking a server what it offers, in its own words.
 *
 * The CLI's catalogue reports each server's connection status and the *names*
 * of its tools, and it is the authority on both — it mounts what a run mounts.
 * What it does not carry through is the `description` each tool advertises:
 * measured against a real server, every one came back empty while the
 * annotations arrived intact. So the descriptions have to be asked for
 * directly, and this is the only thing that asks.
 *
 * The line is deliberate and worth restating wherever this is touched: this
 * decides *nothing* about whether a server works. It enriches servers the
 * catalogue has already declared connected. A connectivity answer from here
 * would be answering a different question — connected to what a run would
 * mount, or connected to what this process happened to spawn?
 *
 * Tested over an in-memory transport pair, so a real MCP server answers real
 * protocol messages with no subprocess and no port.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeServer } from './mcp-probe.js';

function server(options: { instructions?: string } = {}): McpServer {
  const mcp = new McpServer(
    { name: 'inventory', version: '2.1.0' },
    options.instructions ? { instructions: options.instructions } : {},
  );

  mcp.registerTool(
    'list_items',
    {
      description: 'Returns the items in stock, optionally filtered by category.',
      inputSchema: { category: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text' as const, text: '[]' }] }),
  );
  mcp.registerTool(
    'delete_item',
    {
      description: 'Removes an item from stock for good. No confirmation.',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  return mcp;
}

/** Connect a real server to the probe over a linked pair of transports. */
async function probe(mcp: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  return describeServer(() => clientSide, { timeoutMs: 5_000 });
}

describe('describeServer', () => {
  it('brings back every tool with the description the CLI drops', async () => {
    const result = await probe(server());

    expect(result.tools.map((tool) => tool.name)).toEqual(['list_items', 'delete_item']);
    expect(result.tools[0]?.description).toBe(
      'Returns the items in stock, optionally filtered by category.',
    );
    expect(result.tools[1]?.description).toContain('No confirmation');
  });

  it('reports the server’s own instructions when it has any', async () => {
    // The protocol's own place for "what this server is for", and what the
    // agent SDK surfaces to the model as an MCP instructions block. Preferring
    // it over anything generated is not a nicety: it is the server author's
    // sentence rather than a paraphrase of their tool names.
    const result = await probe(server({ instructions: 'Read-only stock lookups for the warehouse.' }));

    expect(result.instructions).toBe('Read-only stock lookups for the warehouse.');
  });

  it('reports null instructions rather than inventing them', async () => {
    expect((await probe(server())).instructions).toBeNull();
  });

  it('names the server and its version, so a stale answer is visible', async () => {
    const result = await probe(server());

    expect(result.serverName).toBe('inventory');
    expect(result.serverVersion).toBe('2.1.0');
  });

  it('gives up rather than hanging when nothing answers', async () => {
    // A stdio server that never speaks would otherwise hold the request open
    // for as long as the operator's patience lasts.
    const [clientSide] = InMemoryTransport.createLinkedPair();

    await expect(describeServer(() => clientSide, { timeoutMs: 40 })).rejects.toThrow();
  });

  it('surfaces a transport that cannot even be built', async () => {
    await expect(
      describeServer(
        () => {
          throw new Error('no such command');
        },
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/no such command/);
  });
});
