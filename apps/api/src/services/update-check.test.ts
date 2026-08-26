/**
 * The update check — informational only, and honest about not knowing.
 */

import { describe, expect, it, vi } from 'vitest';
import { UpdateChecker } from './update-check.js';

const release = (tag: string) =>
  JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}` });

function makeChecker(fetchText: (url: string) => Promise<string>, current = '0.1.0') {
  return new UpdateChecker({
    repo: 'x/y',
    fetchText: vi.fn(fetchText),
    now: () => 1_000,
    currentVersion: current,
  });
}

describe('UpdateChecker', () => {
  it('reports a newer release as an available update, with its URL', async () => {
    const result = await makeChecker(async () => release('v0.2.0')).check();

    expect(result).toMatchObject({
      current: '0.1.0',
      latest: 'v0.2.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/x/y/releases/tag/v0.2.0',
      error: null,
    });
  });

  it('reports the same version as up to date', async () => {
    const result = await makeChecker(async () => release('v0.1.0')).check();
    expect(result.updateAvailable).toBe(false);
  });

  it('never calls an older release an update', async () => {
    const result = await makeChecker(async () => release('v0.0.9')).check();
    expect(result.updateAvailable).toBe(false);
  });

  it('says null — not false — when a tag does not parse as a version', async () => {
    // "No update" and "I cannot tell" are different answers, and conflating
    // them hides a mistagged release forever.
    const result = await makeChecker(async () => release('nightly-2026-08-26')).check();
    expect(result.updateAvailable).toBeNull();
    expect(result.latest).toBe('nightly-2026-08-26');
  });

  it('surfaces a fetch failure in the answer rather than throwing', async () => {
    const result = await makeChecker(async () => {
      throw new Error('404 Not Found');
    }).check();

    expect(result.error).toContain('404');
    expect(result.updateAvailable).toBeNull();
  });

  it('caches within the hour, unless forced', async () => {
    const fetchText = vi.fn(async () => release('v0.2.0'));
    const checker = new UpdateChecker({ repo: 'x/y', fetchText, now: () => 1_000 });

    await checker.check();
    await checker.check();
    expect(fetchText).toHaveBeenCalledTimes(1);

    await checker.check({ force: true });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});
