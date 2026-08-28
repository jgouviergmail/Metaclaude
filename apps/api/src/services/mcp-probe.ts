/**
 * Asking an MCP server what it offers, in its own words.
 *
 * There is one reason this exists, and it is narrow. The CLI's catalogue probe
 * is the authority on whether a server connects — it mounts exactly what a run
 * mounts, same setting sources, same managed locks, same strict MCP config —
 * and it reports each tool's name and the annotations the server advertises.
 * What it does not carry through is each tool's `description`. Measured
 * against a real server that sends them: every description came back empty
 * while the annotations arrived intact.
 *
 * So this asks the server directly, for text and nothing else.
 *
 * **It decides nothing about connectivity, ever.** That distinction is the
 * whole design. A status from here would answer a different question —
 * connected to what a *run* would mount, or connected to whatever this process
 * happened to spawn with whatever environment it happened to build? The two
 * can differ, and reporting the second as the first is precisely the kind of
 * false positive that makes a health indicator worse than none. Callers use
 * this to enrich servers the catalogue has already declared connected.
 *
 * It also reads `instructions` — the string a server returns from
 * `initialize`, which the agent SDK surfaces to the model as an MCP
 * instructions block. That is the protocol's own answer to "what is this
 * server for", written by the server's author, and it beats anything that
 * could be generated from a list of tool names.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Long enough for a cold `npx` start, short enough that nobody wonders. */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface McpToolDescription {
  name: string;
  description: string;
}

export interface McpServerDescription {
  /** The server's own account of itself, or null when it gave none. */
  instructions: string | null;
  serverName: string | null;
  serverVersion: string | null;
  tools: McpToolDescription[];
}

/**
 * Connect, ask, disconnect.
 *
 * The transport arrives as a factory rather than an instance so that building
 * it — spawning a process, resolving a URL — is inside the timeout and inside
 * the error handling. A command that does not exist should fail this call, not
 * the caller's constructor.
 */
export async function describeServer(
  transport: () => Transport,
  options: { timeoutMs?: number } = {},
): Promise<McpServerDescription> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client({ name: 'metaclaude-probe', version: '1.0.0' });

  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the server did not answer within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    // Never hold the process open for a probe.
    timer.unref?.();
  });

  try {
    const read = (async (): Promise<McpServerDescription> => {
      await client.connect(transport());
      const info = client.getServerVersion();
      const { tools } = await client.listTools();
      return {
        instructions: client.getInstructions() ?? null,
        serverName: info?.name ?? null,
        serverVersion: info?.version ?? null,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
      };
    })();

    return await Promise.race([read, deadline]);
  } finally {
    // Whatever happened, do not leave a subprocess or a socket behind. A
    // failure to close is not the caller's problem and must not mask the
    // error that brought us here.
    await client.close().catch(() => undefined);
  }
}
