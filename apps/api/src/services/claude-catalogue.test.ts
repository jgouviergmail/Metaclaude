/**
 * Caching what the CLI says it offers.
 *
 * Reading the catalogue spawns a Claude CLI subprocess. That is fine once and
 * unacceptable per page load, so the interesting behaviour here is not "it
 * remembers" — it is what happens under the conditions that make a naive cache
 * worse than none: several screens asking at once, a read that fails, and an
 * answer old enough to be wrong.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClaudeCatalogue } from '@metaclaude/shared';
import { CatalogueCache } from './claude-catalogue.js';

const catalogue = (over: Partial<ClaudeCatalogue> = {}): ClaudeCatalogue => ({
  models: [],
  commands: [],
  agents: [],
  mcpServers: [],
  account: null,
  unavailable: [],
  fetchedAt: 0,
  ...over,
});

/** A cache whose clock and reader the test drives. */
function setup(read: (path: string) => Promise<ClaudeCatalogue>, ttlMs = 60_000) {
  let now = 1_000;
  const cache = new CatalogueCache({ read, ttlMs, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

describe('CatalogueCache', () => {
  it('reads once and serves the answer again', async () => {
    const read = vi.fn().mockResolvedValue(catalogue());
    const { cache } = setup(read);

    await cache.get('/w/a');
    await cache.get('/w/a');

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps workspaces apart', async () => {
    // The answer is per-directory: a workspace's own skills, subagents and MCP
    // servers are what make it different. One shared entry would show every
    // workspace whichever one was opened first.
    const read = vi.fn().mockResolvedValue(catalogue());
    const { cache } = setup(read);

    await cache.get('/w/a');
    await cache.get('/w/b');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('re-reads once the answer is stale', async () => {
    const read = vi.fn().mockResolvedValue(catalogue());
    const { cache, advance } = setup(read, 60_000);

    await cache.get('/w/a');
    advance(60_001);
    await cache.get('/w/a');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers onto one read', async () => {
    // This is the case that matters. Three panels mount together on a page
    // load; without sharing the in-flight promise that is three Claude CLI
    // subprocesses for one answer.
    let release!: (value: ClaudeCatalogue) => void;
    const read = vi.fn().mockReturnValue(new Promise<ClaudeCatalogue>((r) => (release = r)));
    const { cache } = setup(read);

    const all = Promise.all([cache.get('/w/a'), cache.get('/w/a'), cache.get('/w/a')]);
    release(catalogue({ fetchedAt: 5 }));
    const results = await all;

    expect(read).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.fetchedAt)).toEqual([5, 5, 5]);
  });

  it('re-reads on demand even when the answer is fresh', async () => {
    // The operator has just fixed an MCP server's command. Making them wait out
    // the TTL to find out whether it worked is the wrong answer.
    const read = vi.fn().mockResolvedValue(catalogue());
    const { cache } = setup(read);

    await cache.get('/w/a');
    await cache.get('/w/a', { force: true });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure as if it were an answer', async () => {
    // A read that throws must not pin an empty catalogue in place for the whole
    // TTL — the operator retries, and nothing happens.
    const read = vi.fn().mockRejectedValueOnce(new Error('no CLI')).mockResolvedValue(catalogue({ fetchedAt: 9 }));
    const { cache } = setup(read);

    await expect(cache.get('/w/a')).rejects.toThrow('no CLI');
    expect((await cache.get('/w/a')).fetchedAt).toBe(9);
  });

  it('lets a later caller retry after a failed shared read', async () => {
    // The in-flight promise is shared, so a rejection reaches everyone waiting
    // on it. What must not happen is the rejected promise staying in the map.
    const read = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(catalogue());
    const { cache } = setup(read);

    await Promise.allSettled([cache.get('/w/a'), cache.get('/w/a')]);
    await expect(cache.get('/w/a')).resolves.toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('forgets a workspace on request', async () => {
    // Deleting a workspace, or changing its MCP configuration, invalidates the
    // answer immediately.
    const read = vi.fn().mockResolvedValue(catalogue());
    const { cache } = setup(read);

    await cache.get('/w/a');
    cache.invalidate('/w/a');
    await cache.get('/w/a');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('forgets everything on request', async () => {
    const read = vi.fn().mockResolvedValue(catalogue());
    const { cache } = setup(read);

    await cache.get('/w/a');
    await cache.get('/w/b');
    cache.invalidate();
    await cache.get('/w/a');
    await cache.get('/w/b');

    expect(read).toHaveBeenCalledTimes(4);
  });
});
