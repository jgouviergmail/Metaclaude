/**
 * The apply half of the update mechanism — the app's side of the handshake.
 *
 * The app never touches Docker and never names an image: it writes a bare
 * version into the exchange directory and the host's updater does the rest
 * against its own pinned repository. What must hold here: only well-formed
 * versions leave the app, one request at a time, atomically — and absence
 * of the exchange directory means the feature is honestly "not installed",
 * never a crash.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishRequest, UpdateApplier, UpdateApplyError } from './update-apply.js';

let dir: string;
let applier: UpdateApplier;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metaclaude-updates-'));
  // The marker is install-app.sh's signature: a mounted directory without it
  // is a bind mount on a host that never installed the updater.
  writeFileSync(join(dir, '.updater-installed'), '');
  applier = new UpdateApplier({ dir, now: () => 1_000 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('requesting', () => {
  it('writes one well-formed request the host updater can trust', async () => {
    await applier.request('v1.2.3', 'jules');

    const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    expect(request).toEqual({ version: 'v1.2.3', requestedBy: 'jules', at: 1_000 });
  });

  it('refuses anything that is not a bare vX.Y.Z', async () => {
    for (const bad of ['1.2.3', 'v1.2', 'latest', 'v1.2.3-rc1', 'v1.2.3 && rm -rf /', 'v1.2.3\n']) {
      await expect(applier.request(bad, 'jules')).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('refuses a second request while one is pending', async () => {
    await applier.request('v1.2.3', 'jules');
    await expect(applier.request('v1.2.4', 'jules')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('admits exactly one of many simultaneous requests — the write is the check', async () => {
    // Read-then-decide-then-write is a race, not a check (the login lesson):
    // every contender below passes the status read before any of them has
    // written, so only an exclusive create can keep the count at one.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => applier.request(`v1.0.${index}`, 'jules')),
    );
    const admitted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(admitted).toHaveLength(1);
    for (const refused of outcomes.filter((outcome) => outcome.status === 'rejected')) {
      expect((refused as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    }
    // And the one that won is the one on disk, whole.
    const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    expect(request.version).toMatch(/^v1\.0\.\d$/);
  });

  it('does not stay locked behind a stale write that never completed', async () => {
    // A crash between claiming the lock file and renaming it would otherwise
    // brick the button until someone shells in and deletes a hidden file.
    // Staleness compares wall-clock mtimes, so the fixture backdates the file.
    const lock = join(dir, '.request.json.tmp');
    writeFileSync(lock, 'half-written');
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(lock, past, past);

    await applier.request('v2.0.0', 'jules');
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).version).toBe('v2.0.0');
  });

  it('treats a fresh half-written lock as a writer in progress, not as free', async () => {
    writeFileSync(join(dir, '.request.json.tmp'), 'half-written');
    await expect(applier.request('v2.0.0', 'jules')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses while the updater reports a deploy in flight', async () => {
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ state: 'running', version: 'v1.2.3', message: '', at: 900 }),
    );
    await expect(applier.request('v1.2.4', 'jules')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is honestly unavailable without the exchange directory', async () => {
    const missing = new UpdateApplier({ dir: null });
    expect(missing.available()).toBe(false);
    await expect(missing.request('v1.2.3', 'jules')).rejects.toBeInstanceOf(UpdateApplyError);
    expect((await missing.status()).available).toBe(false);
  });

  it('is unavailable when the directory exists but no updater was installed', async () => {
    // The compose bind mount creates the directory on any host; only
    // install-app.sh leaves the marker. Without it, a request would sit
    // unconsumed forever — better to say so than to accept it.
    const bare = mkdtempSync(join(tmpdir(), 'metaclaude-bare-'));
    const unmarked = new UpdateApplier({ dir: bare });
    expect(unmarked.available()).toBe(false);
    await expect(unmarked.request('v1.2.3', 'jules')).rejects.toMatchObject({ statusCode: 501 });
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('status', () => {
  it('reads idle on a clean directory', async () => {
    expect(await applier.status()).toMatchObject({ available: true, state: 'idle' });
  });

  it('reports a pending request ahead of an old outcome', async () => {
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ state: 'succeeded', version: 'v1.0.0', message: 'ok', at: 500 }),
    );
    await applier.request('v1.2.3', 'jules');

    expect(await applier.status()).toMatchObject({ state: 'requested', version: 'v1.2.3' });
  });

  it("relays the updater's outcome, message included", async () => {
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ state: 'failed', version: 'v1.2.3', message: 'health gate refused', at: 2_000 }),
    );

    expect(await applier.status()).toMatchObject({
      state: 'failed',
      version: 'v1.2.3',
      message: 'health gate refused',
      at: 2_000,
    });
  });

  it('treats an unreadable status file as idle with a note, never a crash', async () => {
    writeFileSync(join(dir, 'status.json'), 'not json at all');
    const status = await applier.status();
    expect(status.state).toBe('idle');
    expect(status.message).toMatch(/unreadable/i);
  });
});

/**
 * Publishing, and the window the lock alone never closed.
 *
 * The lock excludes writers whose attempts overlap. It said nothing about a
 * contender that claimed the name *after* the winner had already moved it
 * away — and `rename` overwrites, so that contender published a second
 * request over the first. Both callers were told they had won, and the
 * version that deployed was the later one.
 *
 * `link` refuses an existing destination, which makes the ordering
 * irrelevant. What is testable single-threaded is the other half of that
 * change: refusing an existing file must not brick the button on one that
 * nobody can act on.
 */
describe('publishing', () => {
  it('publishes through a link, so a second arrival cannot overwrite the first', async () => {
    await applier.request('v1.0.0', 'jules');

    const published = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    expect(published.version).toBe('v1.0.0');
    // The claim is released once it is published — a lock left behind would
    // refuse every later request until it aged out.
    expect(existsSync(join(dir, '.request.json.tmp'))).toBe(false);
  });

  it('does not brick the button on a request file nobody can act on', async () => {
    // Unreadable to `status`, which therefore reports idle and lets the call
    // through — and then the publish finds the name taken. Sweeping it is the
    // same judgement the stale lock already gets.
    writeFileSync(join(dir, 'request.json'), '{ not json at all');

    await applier.request('v3.0.0', 'jules');

    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).version).toBe('v3.0.0');
  });

  it('leaves a well-formed pending request alone rather than replacing it', async () => {
    await applier.request('v1.0.0', 'jules');

    // The status guard is what catches this one, before the publish is even
    // attempted — but the outcome is what matters: the first intent stands.
    await expect(applier.request('v2.0.0', 'someone-else')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).version).toBe('v1.0.0');
  });
});

/**
 * `publishRequest` on its own — the invariant no test of `request()` can reach.
 *
 * The window it closes exists only between two concurrent callers: one that
 * has already published, and one that claimed the lock afterwards because the
 * name had been freed. A single-threaded test cannot stand inside that
 * window, which is exactly why the guarantee is a property of the *publish*
 * step and is asserted here instead.
 */
describe('publishRequest', () => {
  const lock = (): string => join(dir, '.request.json.tmp');
  const published = (): string => join(dir, 'request.json');

  it('publishes when the destination is free, and releases the claim', async () => {
    writeFileSync(lock(), JSON.stringify({ version: 'v1.0.0', requestedBy: 'a', at: 1 }));

    await publishRequest(lock(), published());

    expect(JSON.parse(readFileSync(published(), 'utf8')).version).toBe('v1.0.0');
    expect(existsSync(lock())).toBe(false);
  });

  it('refuses rather than overwriting a request already published', async () => {
    // This is the case `rename` silently won: both callers succeed, and the
    // later version is the one that deploys.
    writeFileSync(published(), JSON.stringify({ version: 'v1.0.0', requestedBy: 'a', at: 1 }));
    writeFileSync(lock(), JSON.stringify({ version: 'v2.0.0', requestedBy: 'b', at: 2 }));

    await expect(publishRequest(lock(), published())).rejects.toMatchObject({ statusCode: 409 });

    expect(JSON.parse(readFileSync(published(), 'utf8')).version).toBe('v1.0.0');
    // And the loser leaves nothing behind that would refuse the next caller.
    expect(existsSync(lock())).toBe(false);
  });

  it('sweeps a destination nobody can act on rather than bricking the button', async () => {
    writeFileSync(published(), 'half a file');
    writeFileSync(lock(), JSON.stringify({ version: 'v2.0.0', requestedBy: 'b', at: 2 }));

    await publishRequest(lock(), published());

    expect(JSON.parse(readFileSync(published(), 'utf8')).version).toBe('v2.0.0');
  });
});
