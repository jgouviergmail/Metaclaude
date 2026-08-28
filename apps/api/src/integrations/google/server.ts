/**
 * The Google MCP server, spawned by the Claude CLI as a stdio child.
 *
 * It ships inside this image and is versioned with the repository, which is
 * the same trust story the library and the connector directory tell — with one
 * more reason here, because this process holds a refresh token for a live
 * mailbox: there is no third party in the path, and nothing to supply-chain.
 *
 * Its whole configuration arrives from the parent: three secrets in the
 * environment, resolved from the vault at run time by the registry like any
 * other MCP server's, and the granted capabilities as an argument. Nothing is
 * read from disk and nothing is written.
 *
 * **stdout belongs to the protocol.** A stray `console.log` corrupts the JSON-RPC
 * stream and the CLI reports the server as broken with no clue why; diagnostics
 * go to stderr, which the transcript surfaces.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { GoogleGrant, type GoogleGrant as Grant } from '@metaclaude/shared';

import { GoogleApiError } from './api.js';
import type { FetchLike } from './oauth.js';
import { TokenCache } from './token-cache.js';
import { googleTools } from './tools.js';

/** Read `--grants a,b,c` out of argv, keeping only grants that still exist. */
export function parseGrants(argv: readonly string[]): Grant[] {
  const index = argv.indexOf('--grants');
  if (index === -1) return [];
  return (argv[index + 1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is Grant => GoogleGrant.safeParse(value).success);
}

export interface BuildInput {
  grants: readonly Grant[];
  tokens: TokenCache;
  fetchImpl: FetchLike;
  version: string;
}

/**
 * Wire the granted tools onto an McpServer.
 *
 * Every handler shares one shape: mint a token, call Google, hand the result
 * back as JSON text. Two behaviours are deliberate —
 *
 *  - **A 401 is retried once,** with the cache invalidated first. Access tokens
 *    can die early (a password change, a revoked session) and one silent retry
 *    turns that into a hiccup instead of a failed run.
 *  - **An error comes back as a tool result, not a thrown exception.** The
 *    model can read "insufficient authentication scopes" and tell the user what
 *    to re-grant; a transport-level failure just reads as a broken server.
 */
export function buildGoogleServer(input: BuildInput): McpServer {
  const server = new McpServer({ name: 'metaclaude-google', version: input.version });

  for (const tool of googleTools(input.grants)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // The SDK types the callback against the schema; the tool descriptors
      // are uniform by construction, so this is the one place a cast earns
      // its keep.
      (async (args: Record<string, unknown>) => {
        const invoke = async (): Promise<unknown> =>
          tool.run({ fetchImpl: input.fetchImpl, accessToken: await input.tokens.get() }, args ?? {});

        try {
          let result: unknown;
          try {
            result = await invoke();
          } catch (error) {
            if (!(error instanceof GoogleApiError) || error.status !== 401) throw error;
            input.tokens.invalidate();
            result = await invoke();
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          const message =
            error instanceof GoogleApiError
              ? `Google refused this call (${error.status}): ${error.message}`
              : `${(error as Error).message}`;
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      }) as never,
    );
  }

  return server;
}

/** Boot from the environment. Exported so the entry point stays one line. */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): Promise<void> {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    // Naming what is missing, on stderr: the alternative is a server that
    // exits 1 and a transcript line saying only "failed to connect".
    const missing = [
      !clientId && 'GOOGLE_CLIENT_ID',
      !clientSecret && 'GOOGLE_CLIENT_SECRET',
      !refreshToken && 'GOOGLE_REFRESH_TOKEN',
    ].filter(Boolean);
    process.stderr.write(
      `metaclaude-google: not configured — missing ${missing.join(', ')}. ` +
        'Reconnect Google under Settings → Connections.\n',
    );
    process.exit(1);
  }

  const grants = parseGrants(argv);
  if (grants.length === 0) {
    process.stderr.write(
      'metaclaude-google: no grants were passed, so this server would expose no tools. ' +
        'Reconnect Google under Settings → Connections.\n',
    );
    process.exit(1);
  }

  const fetchImpl = globalThis.fetch as unknown as FetchLike;
  const server = buildGoogleServer({
    grants,
    fetchImpl,
    tokens: new TokenCache({ fetchImpl, clientId, clientSecret, refreshToken }),
    version: env.METACLAUDE_VERSION ?? '0.0.0',
  });

  await server.connect(new StdioServerTransport());
}
