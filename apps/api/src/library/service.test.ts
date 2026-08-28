import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { defaultWorkspaceSettings, WorkspaceRepo } from '../kernel/repositories.js';
import { Vault } from '../security/vault.js';
import { Registry, RegistryError } from '../services/registry.js';
import { LIBRARY } from './catalog.js';
import { CONNECTORS } from './connectors.js';
import { LibraryService } from './service.js';

let db: Db;
let registry: Registry;
let library: LibraryService;

const someAgent = LIBRARY.find((entry) => entry.kind === 'agent')!;
const someSkill = LIBRARY.find((entry) => entry.kind === 'skill')!;
const remoteConnector = CONNECTORS.find(
  (connector) => connector.credential?.kind === 'header' && connector.credential.required,
)!;
const stdioConnector = CONNECTORS.find(
  (connector) => connector.credential?.kind === 'env' && connector.credential.required,
)!;
const openConnector = CONNECTORS.find((connector) => connector.credential === null)!;
const optionalConnector = CONNECTORS.find((connector) => connector.credential?.required === false)!;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  registry = new Registry(db, new Vault(db, Buffer.alloc(32, 7)), () => {
    /* no-op logger */
  });
  library = new LibraryService(registry);
});

afterEach(() => {
  db.close();
});

describe('listing', () => {
  it('serves the whole catalogue, nothing installed on a fresh database', () => {
    const listing = library.list();
    expect(listing.length).toBe(LIBRARY.length);
    expect(listing.every((entry) => entry.installed === false)).toBe(true);
  });

  it('marks an entry installed once its global namesake exists', () => {
    library.install(someSkill.name);
    const listing = library.list();
    expect(listing.find((entry) => entry.name === someSkill.name)?.installed).toBe(true);
    expect(listing.filter((entry) => entry.installed).length).toBe(1);
  });

  it('ignores a workspace-scoped namesake — install writes global scope only', () => {
    const workspaces = new WorkspaceRepo(db);
    const ws = workspaces.create({
      name: 'Alpha',
      slug: 'alpha',
      description: '',
      path: '/tmp/alpha',
      color: '#6366f1',
      icon: 'folder',
      settings: defaultWorkspaceSettings(),
    });
    registry.upsertSkill({
      workspaceId: ws.id,
      name: someSkill.name,
      description: 'a local namesake',
      body: 'not the library copy',
    });

    expect(library.list().find((entry) => entry.name === someSkill.name)?.installed).toBe(false);
    // And it does not block the real install either.
    expect(() => library.install(someSkill.name)).not.toThrow();
  });
});

describe('installing', () => {
  it('copies a skill into the registry: global, disabled, with its category', () => {
    const { id } = library.install(someSkill.name);
    const skill = registry.getSkill(id);
    expect(skill).not.toBeNull();
    expect(skill?.workspaceId).toBeNull();
    expect(skill?.enabled).toBe(false);
    expect(skill?.category).toBe(someSkill.category);
    expect(skill?.body).toBe(someSkill.kind === 'skill' ? someSkill.body : '');
  });

  it('copies an agent the same way', () => {
    const { id } = library.install(someAgent.name);
    const agent = registry.getAgent(id);
    expect(agent?.workspaceId).toBeNull();
    expect(agent?.enabled).toBe(false);
    expect(agent?.category).toBe(someAgent.category);
    expect(agent?.prompt).toBe(someAgent.kind === 'agent' ? someAgent.prompt : '');
  });

  it('refuses an unknown name with 404', () => {
    try {
      library.install('not-on-the-shelf');
      expect.unreachable('expected a RegistryError');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).statusCode).toBe(404);
    }
  });

  it('refuses a second install with 409', () => {
    library.install(someAgent.name);
    try {
      library.install(someAgent.name);
      expect.unreachable('expected a RegistryError');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).statusCode).toBe(409);
    }
  });

  it('lets a deleted copy be installed again — the library keeps the original', () => {
    const { id } = library.install(someSkill.name);
    registry.deleteSkill(id);
    expect(library.list().find((entry) => entry.name === someSkill.name)?.installed).toBe(false);
    expect(() => library.install(someSkill.name)).not.toThrow();
  });

  it('installs every entry of the catalogue without a single refusal', () => {
    // The end-to-end promise of the shelf, against the real registry rules.
    for (const entry of LIBRARY) library.install(entry.name);
    const listing = library.list();
    expect(listing.every((entry) => entry.installed)).toBe(true);
  });
});

describe('the connector directory', () => {
  it('serves the whole directory, nothing installed on a fresh database', () => {
    const listing = library.listConnectors();
    expect(listing.length).toBe(CONNECTORS.length);
    expect(listing.every((connector) => connector.installed === false)).toBe(true);
  });

  it('marks a connector installed once its global namesake exists', () => {
    library.installConnector(openConnector.name);
    const listing = library.listConnectors();
    expect(listing.find((c) => c.name === openConnector.name)?.installed).toBe(true);
    expect(listing.filter((c) => c.installed).length).toBe(1);
  });

  it('installs disabled, so one click cannot widen what a run reaches', () => {
    // The property the whole design rests on: an enabled MCP server is mounted
    // into every run of every workspace.
    library.installConnector(openConnector.name);
    const server = registry.listMcpServers(null).find((s) => s.name === openConnector.name);
    expect(server?.enabled).toBe(false);
  });

  it('copies the transport, URL and arguments the directory recorded', () => {
    library.installConnector(stdioConnector.name, 'ntn_pasted-by-the-operator');
    const server = registry.listMcpServers(null).find((s) => s.name === stdioConnector.name)!;
    expect(server.transport).toBe(stdioConnector.transport);
    expect(server.command).toBe(stdioConnector.command);
    expect(server.args).toEqual([...stdioConnector.args]);
    expect(server.url).toBe(stdioConnector.url);
  });

  it('seals a header credential under its own name, and never on the row', () => {
    const credential = remoteConnector.credential!;
    library.installConnector(remoteConnector.name, 'pasted-token');
    const server = registry.listMcpServers(null).find((s) => s.name === remoteConnector.name)!;
    // The row names the header and nothing more — the value is in the vault.
    expect(server.headerKeys).toEqual([credential.key]);
    expect(server.envKeys).toEqual([]);
    expect(JSON.stringify(server)).not.toContain('pasted-token');
    const row = db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM mcp_servers WHERE id = ?')
      .get(server.id)!;
    expect(JSON.stringify(row)).not.toContain('pasted-token');
  });

  it('delivers the pasted token to a run with the publisher’s scheme word attached', () => {
    // End to end rather than through the vault's internals, because the thing
    // worth pinning is what a run actually mounts: the operator pastes a token
    // and the directory supplies the scheme word, which is exactly the half
    // that gets guessed wrong (Sentry-Bearer, X-Goog-Api-Key with no scheme).
    const credential = remoteConnector.credential!;
    const { id } = library.installConnector(remoteConnector.name, 'pasted-token');
    registry.upsertMcpServer({
      id,
      workspaceId: null,
      name: remoteConnector.name,
      transport: remoteConnector.transport,
      url: remoteConnector.url,
      enabled: true,
    });
    const workspace = new WorkspaceRepo(db).create({
      name: 'Alpha',
      slug: 'alpha',
      description: '',
      path: '/tmp/alpha',
      color: '#6366f1',
      icon: 'folder',
      settings: defaultWorkspaceSettings(),
    });
    const mounted = registry.resolve(workspace).mcpServers[remoteConnector.name] as {
      headers: Record<string, string>;
    };
    expect(mounted.headers[credential.key]).toBe(`${credential.prefix}pasted-token`);
  });

  it('seals an env credential under its variable name', () => {
    const credential = stdioConnector.credential!;
    library.installConnector(stdioConnector.name, 'ntn_secret');
    const server = registry.listMcpServers(null).find((s) => s.name === stdioConnector.name)!;
    expect(server.envKeys).toEqual([credential.key]);
    expect(server.headerKeys).toEqual([]);
  });

  it('refuses to install a connector whose required credential is missing', () => {
    // Left to the registry, this would store happily and fail at run time with
    // an authentication error the operator reads as a bad token.
    expect(() => library.installConnector(remoteConnector.name)).toThrow(RegistryError);
    expect(() => library.installConnector(remoteConnector.name, '   ')).toThrow(RegistryError);
    expect(registry.listMcpServers(null)).toHaveLength(0);
  });

  it('installs an optional-credential connector with nothing pasted', () => {
    library.installConnector(optionalConnector.name);
    const server = registry.listMcpServers(null).find((s) => s.name === optionalConnector.name)!;
    expect(server.headerKeys).toEqual([]);
  });

  it('stores nothing for a connector that takes no credential', () => {
    library.installConnector(openConnector.name, 'a token nobody asked for');
    const server = registry.listMcpServers(null).find((s) => s.name === openConnector.name)!;
    expect(server.envKeys).toEqual([]);
    expect(server.headerKeys).toEqual([]);
  });

  it('404s an unknown connector and 409s one already installed', () => {
    expect(() => library.installConnector('no-such-connector')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    library.installConnector(openConnector.name);
    expect(() => library.installConnector(openConnector.name)).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
  });
});
