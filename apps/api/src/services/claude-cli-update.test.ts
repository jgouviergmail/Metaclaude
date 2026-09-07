/**
 * Knowing the CLI is behind, which is all this can honestly offer.
 *
 * The container refuses to change the CLI three times over — non-root process,
 * root-owned directory, read-only filesystem — and all three are deliberate,
 * so there is no update to trigger. What was missing was the *knowledge*: the
 * installed version appeared only in a diagnostics check and the published one
 * nowhere, so an operator had no way to know a release was worth asking for.
 */

import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliUpdate } from './claude-cli-update.js';

const published = (version: string) => async () => JSON.stringify({ version });

const make = (
  installed: string | null,
  fetchText: (url: string) => Promise<string>,
  now = () => 1_000,
) => new ClaudeCliUpdate({ installedVersion: async () => installed, fetchText, now });

describe('the Claude CLI version check', () => {
  it('reads the number out of what the CLI prints', async () => {
    // `claude --version` answers `2.1.247 (Claude Code)`; comparing that
    // string to a registry version would never match.
    const status = await make('2.1.247 (Claude Code)', published('2.1.247')).check();

    expect(status.installed).toBe('2.1.247');
    expect(status.latest).toBe('2.1.247');
    expect(status.behind).toBe(false);
  });

  it('says when the image is behind what is published', async () => {
    const status = await make('2.1.247 (Claude Code)', published('2.2.0')).check();

    expect(status.behind).toBe(true);
  });

  /**
   * The comparison a string sort gets wrong, and a CLI on this release cadence
   * meets every few weeks: `2.1.9` against `2.1.10`.
   */
  it('compares numerically, not alphabetically', async () => {
    expect((await make('2.1.9', published('2.1.10')).check()).behind).toBe(true);
    expect((await make('2.1.10', published('2.1.9')).check()).behind).toBe(false);
  });

  it('is not behind when it is ahead of the registry', async () => {
    // A locally built image can carry a version npm has not published.
    expect((await make('2.2.0', published('2.1.247')).check()).behind).toBe(false);
  });

  /**
   * `null`, never `false`. "Not behind" and "we could not tell" are different
   * answers, and a badge that renders the second as the first goes quiet
   * exactly when the network is broken.
   */
  it('answers unknown rather than reassuring when the registry cannot be read', async () => {
    const status = await make('2.1.247', async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }).check();

    expect(status.behind).toBeNull();
    expect(status.latest).toBeNull();
    expect(status.error).toContain('ENOTFOUND');
    expect(status.installed).toBe('2.1.247');
  });

  it('answers unknown when the CLI itself cannot be spawned', async () => {
    const status = await make(null, published('2.2.0')).check();

    expect(status.installed).toBeNull();
    expect(status.behind).toBeNull();
  });

  it('does not throw on a registry that answers nonsense', async () => {
    const status = await make('2.1.247', async () => 'not json at all').check();

    expect(status.behind).toBeNull();
    expect(status.error).not.toBeNull();
  });

  it('asks the registry once, then answers from the cache', async () => {
    // A card renders on every page view; a request per view would be rude to
    // a public registry and slow for no gain — the answer changes weekly.
    const fetchText = vi.fn(published('2.2.0'));
    const check = make('2.1.247', fetchText);

    await check.check();
    await check.check();

    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('asks again when told to, and when the cache has aged out', async () => {
    const fetchText = vi.fn(published('2.2.0'));
    let clock = 1_000;
    const check = new ClaudeCliUpdate({
      installedVersion: async () => '2.1.247',
      fetchText,
      now: () => clock,
    });

    await check.check();
    await check.check({ force: true });
    expect(fetchText).toHaveBeenCalledTimes(2);

    clock += 7 * 60 * 60 * 1000;
    await check.check();
    expect(fetchText).toHaveBeenCalledTimes(3);
  });
});
