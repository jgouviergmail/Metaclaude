/**
 * Plugin marketplaces — stored sources the CLI installs from.
 *
 * The database is real; the network is a fake handed in as `fetchText`. What
 * is under test is the trust plumbing: what gets stored, what reaches the
 * CLI's settings payload, and that a catalogue fetch failing loudly beats one
 * failing invisibly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { MarketplacesService, MarketplacesError } from './marketplaces.js';

let db: Db;

const CATALOGUE_JSON = JSON.stringify({
  name: 'anthropic-tools',
  owner: { name: 'Anthropic' },
  plugins: [
    { name: 'formatter', description: 'Formats things', version: '1.2.0' },
    { name: 'reviewer', author: { name: 'Jane' } },
  ],
});

function makeService(fetchText = vi.fn(async () => CATALOGUE_JSON)) {
  return {
    service: new MarketplacesService({ db, fetchText, now: () => 1_000 }),
    fetchText,
  };
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
});

afterEach(() => db.close());

describe('the store', () => {
  it('round-trips a marketplace and lists it', () => {
    const { service } = makeService();
    const added = service.add({
      name: 'anthropic-tools',
      source: { source: 'github', repo: 'anthropics/claude-plugins' },
    });

    expect(service.list()).toEqual([added]);
    expect(added.enabled).toBe(true);
  });

  it('refuses a second marketplace with the same name', () => {
    // The name is the id plugins are enabled against; two sources answering
    // to one name would make `plugin@name` ambiguous.
    const { service } = makeService();
    service.add({ name: 'tools', source: { source: 'github', repo: 'a/b' } });

    expect(() => service.add({ name: 'tools', source: { source: 'github', repo: 'c/d' } })).toThrow(
      MarketplacesError,
    );
  });

  it('disables and removes', () => {
    const { service } = makeService();
    const added = service.add({ name: 'tools', source: { source: 'github', repo: 'a/b' } });

    expect(service.setEnabled(added.id, false)).toBe(true);
    expect(service.list()[0]?.enabled).toBe(false);
    expect(service.remove(added.id)).toBe(true);
    expect(service.list()).toEqual([]);
    expect(service.remove(added.id)).toBe(false);
  });
});

describe('the settings payload', () => {
  it('maps enabled marketplaces to the extraKnownMarketplaces shape, passing the source through', () => {
    const { service } = makeService();
    service.add({
      name: 'tools',
      source: { source: 'github', repo: 'a/b', ref: 'v1', path: 'plugins/marketplace.json' },
    });
    service.add({ name: 'internal', source: { source: 'url', url: 'https://x.example/m.json' } });

    expect(service.settingsPayload()).toEqual({
      tools: {
        source: { source: 'github', repo: 'a/b', ref: 'v1', path: 'plugins/marketplace.json' },
      },
      internal: { source: { source: 'url', url: 'https://x.example/m.json' } },
    });
  });

  it('leaves a disabled marketplace out of the payload', () => {
    // Disabling must actually sever the source — the payload is what the CLI
    // fetches from, not the listing screen.
    const { service } = makeService();
    const added = service.add({ name: 'tools', source: { source: 'github', repo: 'a/b' } });
    service.setEnabled(added.id, false);

    expect(service.settingsPayload()).toEqual({});
  });
});

describe('the catalogue', () => {
  it('fetches a GitHub source from the raw marketplace.json location', async () => {
    const { service, fetchText } = makeService();
    const added = service.add({
      name: 'anthropic-tools',
      source: { source: 'github', repo: 'anthropics/claude-plugins' },
    });

    const catalogue = await service.catalogue(added.id);

    expect(fetchText).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/anthropics/claude-plugins/HEAD/.claude-plugin/marketplace.json',
    );
    expect(catalogue.error).toBeNull();
    expect(catalogue.plugins).toEqual([
      { name: 'formatter', description: 'Formats things', version: '1.2.0', author: null },
      { name: 'reviewer', description: null, version: null, author: 'Jane' },
    ]);
  });

  it('honours ref and path in the raw URL', async () => {
    const { service, fetchText } = makeService();
    const added = service.add({
      name: 'tools',
      source: { source: 'github', repo: 'a/b', ref: 'v2', path: 'sub/marketplace.json' },
    });

    await service.catalogue(added.id);
    expect(fetchText).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/a/b/v2/sub/marketplace.json',
    );
  });

  it('reports a fetch failure in the catalogue rather than throwing', async () => {
    // The screen must render "this source is broken and here is why" — an
    // exception would render nothing.
    const fetchText = vi.fn(async () => {
      throw new Error('403 rate limited');
    });
    const { service } = makeService(fetchText);
    const added = service.add({ name: 'tools', source: { source: 'github', repo: 'a/b' } });

    const catalogue = await service.catalogue(added.id);
    expect(catalogue.plugins).toEqual([]);
    expect(catalogue.error).toContain('403');
  });

  it('reports unparseable JSON the same way', async () => {
    const fetchText = vi.fn(async () => 'not json');
    const { service } = makeService(fetchText);
    const added = service.add({ name: 'tools', source: { source: 'github', repo: 'a/b' } });

    const catalogue = await service.catalogue(added.id);
    expect(catalogue.plugins).toEqual([]);
    expect(catalogue.error).not.toBeNull();
  });

  it('serves the second read from cache, unless forced', async () => {
    const { service, fetchText } = makeService();
    const added = service.add({ name: 'tools', source: { source: 'github', repo: 'a/b' } });

    await service.catalogue(added.id);
    await service.catalogue(added.id);
    expect(fetchText).toHaveBeenCalledTimes(1);

    await service.catalogue(added.id, { force: true });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown marketplace id', async () => {
    const { service } = makeService();
    await expect(service.catalogue('mkt_nope')).rejects.toThrow(MarketplacesError);
  });
});
