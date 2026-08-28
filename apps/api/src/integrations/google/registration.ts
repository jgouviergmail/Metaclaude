/**
 * Putting the Google connection on the MCP shelf.
 *
 * The connection itself is only credentials; what makes it *usable* is an MCP
 * server record like any other, so it inherits everything that machinery
 * already does — the vault resolving its environment at run time, the
 * per-workspace enable, the "From Claude" probe reporting whether it really
 * connected, the editor showing which secrets it holds.
 *
 * Two rules the flow depends on:
 *
 *  - **Created disabled, but re-consent keeps the switch where it was.** A new
 *    connection must not silently mount a mailbox into every run. An operator
 *    who reconnects to add a grant, though, has already decided — flipping
 *    them back off would look like the reconnection failed.
 *  - **The grants ride on the command line, the secrets in the environment.**
 *    Grants are configuration and belong where the operator can read them on
 *    the server card; the three credentials are secrets and belong in the
 *    vault, which is exactly what `env` does for every other MCP server.
 */

import { fileURLToPath } from 'node:url';

import type { Registry } from '../../services/registry.js';
import type { GoogleConnectService } from './service.js';

/** The registry name the connection is installed under. */
export const GOOGLE_SERVER_NAME = 'google';

/**
 * Where the built server lives, beside this module in `dist/`.
 *
 * Resolved from `import.meta.url` so it follows the build rather than a
 * hard-coded path — and injectable because under vitest `import.meta.url` is
 * an http URL that `fileURLToPath` refuses (a trap this repository has hit
 * before).
 */
export function defaultServerEntry(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

export interface SyncInput {
  registry: Registry;
  google: GoogleConnectService;
  /** Absolute path to the built `main.js`; defaults to the sibling file. */
  serverEntry?: string;
  /** The interpreter to spawn; `process.execPath` in production. */
  nodePath?: string;
}

/**
 * Create or update the `google` MCP server to match the current connection.
 *
 * Returns the server id, or null when there is nothing connected — in which
 * case any existing record is removed, because a Google server with no
 * credentials is a row that can only ever fail to connect.
 */
export function syncGoogleMcpServer(input: SyncInput): string | null {
  const { registry, google } = input;
  // Matched by name alone, deliberately: if an operator hand-built a server
  // called `google` before connecting, this adopts and overwrites it rather
  // than erroring the OAuth callback into a dead end. The name is short and
  // obvious enough that the collision is almost certainly the same intent —
  // and the audit line the routes write records what happened.
  const existing = registry
    .listMcpServers(null)
    .find((server) => server.name === GOOGLE_SERVER_NAME);

  const environment = google.serverEnvironment();
  const grants = google.status().grants;

  if (!environment || grants.length === 0) {
    if (existing) registry.deleteMcpServer(existing.id);
    return null;
  }

  const server = registry.upsertMcpServer({
    ...(existing ? { id: existing.id } : {}),
    workspaceId: null,
    name: GOOGLE_SERVER_NAME,
    transport: 'stdio',
    command: input.nodePath ?? process.execPath,
    args: [input.serverEntry ?? defaultServerEntry(), '--grants', grants.join(',')],
    url: null,
    env: environment,
    // A grant the operator revoked must take its secret slot with it — but
    // these three keys are always all present or all absent, so nothing to
    // remove here beyond what upsert already merges.
    enabled: existing?.enabled ?? false,
  });
  return server.id;
}
