import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { defaultWorkspaceSettings, WorkspaceRepo } from '../kernel/repositories.js';
import { Vault } from '../security/vault.js';
import { Registry, RegistryError } from '../services/registry.js';
import { LIBRARY } from './catalog.js';
import { LibraryService } from './service.js';

let db: Db;
let registry: Registry;
let library: LibraryService;

const someAgent = LIBRARY.find((entry) => entry.kind === 'agent')!;
const someSkill = LIBRARY.find((entry) => entry.kind === 'skill')!;

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
