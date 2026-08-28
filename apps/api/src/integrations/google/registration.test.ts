import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/index.js';
import { migrate, openDatabase } from '../../db/index.js';
import { Vault } from '../../security/vault.js';
import { Registry } from '../../services/registry.js';
import type { FetchLike } from './oauth.js';
import { GOOGLE_SERVER_NAME, syncGoogleMcpServer } from './registration.js';
import { GoogleConnectService } from './service.js';

let db: Db;
let vault: Vault;
let registry: Registry;
let google: GoogleConnectService;

const ENTRY = '/srv/app/dist/integrations/google/main.js';
const NODE = '/usr/local/bin/node';

function googleFetch(scope?: string): FetchLike {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        access_token: 'at-1',
        refresh_token: 'rt-secret-1',
        expires_in: 3599,
        scope:
          scope ??
          'openid email https://www.googleapis.com/auth/gmail.readonly ' +
            'https://www.googleapis.com/auth/calendar.events',
        id_token: `${encode({ alg: 'RS256' })}.${encode({ email: 'ops@example.com' })}.sig`,
      }),
  });
}

async function connect(grants: readonly ('gmail.read' | 'calendar.write' | 'drive.write')[] = [
  'gmail.read',
  'calendar.write',
]): Promise<void> {
  const { state } = google.begin({
    userId: 'user_1',
    clientId: 'client-123',
    clientSecret: 'secret-xyz',
    grants,
    origin: 'https://metaclaude.example',
  });
  await google.complete({ state, code: 'auth-code' });
}

const sync = () => syncGoogleMcpServer({ registry, google, serverEntry: ENTRY, nodePath: NODE });
const stored = () => registry.listMcpServers(null).find((s) => s.name === GOOGLE_SERVER_NAME);

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, Buffer.alloc(32, 7));
  registry = new Registry(db, vault, () => {
    /* no-op logger */
  });
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
     VALUES ('user_1', 'owner', 'Owner', 'x', 'owner', 0, 0)`,
  ).run();
  google = new GoogleConnectService(db, vault, googleFetch(), () => 1_700_000_000_000);
});

afterEach(() => db.close());

describe('putting the connection on the MCP shelf', () => {
  it('creates nothing while nothing is connected', () => {
    expect(sync()).toBeNull();
    expect(stored()).toBeUndefined();
  });

  it('creates a disabled stdio server once Google is connected', async () => {
    // Disabled matters more here than for a skill: an enabled MCP server is
    // mounted into every run of every workspace, so a connection that switched
    // itself on would put a live mailbox in front of every agent.
    await connect();
    sync();

    const server = stored()!;
    expect(server.enabled).toBe(false);
    expect(server.transport).toBe('stdio');
    expect(server.command).toBe(NODE);
    expect(server.args).toEqual([ENTRY, '--grants', 'gmail.read,calendar.write']);
  });

  it('seals the three credentials as environment secrets, naming them on the row only', async () => {
    await connect();
    sync();

    const server = stored()!;
    expect(server.envKeys.sort()).toEqual([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
    ]);
    expect(JSON.stringify(server)).not.toContain('rt-secret-1');
    expect(JSON.stringify(server)).not.toContain('secret-xyz');

    const row = db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM mcp_servers WHERE id = ?')
      .get(server.id)!;
    expect(JSON.stringify(row)).not.toContain('rt-secret-1');
  });

  it('puts the credentials where the run resolver will look for them', async () => {
    // The row names the keys; the values live in the vault under this
    // server's own scope, which is exactly what `resolve` reads at run time.
    await connect();
    const id = sync()!;

    expect(
      vault.resolveEnv(`mcp:${id}`, [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'GOOGLE_REFRESH_TOKEN',
      ]),
    ).toEqual({
      GOOGLE_CLIENT_ID: 'client-123',
      GOOGLE_CLIENT_SECRET: 'secret-xyz',
      GOOGLE_REFRESH_TOKEN: 'rt-secret-1',
    });
  });

  it('keeps the switch where the operator left it when they re-consent', async () => {
    // Someone reconnecting to add a grant has already decided; turning the
    // server back off would read as the reconnection having failed.
    await connect();
    const id = sync()!;
    registry.upsertMcpServer({
      id,
      workspaceId: null,
      name: GOOGLE_SERVER_NAME,
      transport: 'stdio',
      command: NODE,
      args: [ENTRY, '--grants', 'gmail.read,calendar.write'],
      enabled: true,
    });

    google = new GoogleConnectService(
      db,
      vault,
      googleFetch('openid email https://www.googleapis.com/auth/drive.file'),
      () => 1_700_000_100_000,
    );
    await connect(['drive.write']);
    sync();

    const server = stored()!;
    expect(server.enabled).toBe(true);
    expect(server.args).toEqual([ENTRY, '--grants', 'drive.write']);
  });

  it('updates in place rather than accumulating servers', async () => {
    await connect();
    const first = sync();
    const second = sync();
    expect(second).toBe(first);
    expect(registry.listMcpServers(null).filter((s) => s.name === GOOGLE_SERVER_NAME)).toHaveLength(
      1,
    );
  });

  it('removes the server when the connection is dropped', async () => {
    // A Google server with no credentials is a row that can only ever fail to
    // connect, and it would sit in the list looking like a broken feature.
    await connect();
    sync();
    expect(stored()).toBeDefined();

    google.disconnect();
    expect(sync()).toBeNull();
    expect(stored()).toBeUndefined();
  });
});
