/**
 * The apply half of the update mechanism — the app's side of the handshake.
 *
 * The app never touches Docker, never opens the socket, never names an
 * image. It writes a bare version into an exchange directory that a host
 * systemd unit watches; the updater there composes the image from its own
 * pinned repository and runs the same health-gated, auto-rolling-back
 * deploy the CI path uses. Even a fully compromised app can therefore only
 * choose *which published version of the pinned repository* runs — and the
 * blast radius of this file is exactly one JSON write.
 *
 * Protocol, both files inside the exchange directory:
 *   request.json  { version, requestedBy, at }   written here, consumed there
 *   status.json   { state, version, message, at } written there, read here
 */

import { existsSync } from 'node:fs';
import { link, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateApplyStatus } from '@metaclaude/shared';

export type { UpdateApplyStatus };

export class UpdateApplyError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'UpdateApplyError';
  }
}

/** Exactly a release tag, nothing that could be read as anything else. */
const VERSION_SHAPE = /^v\d+\.\d+\.\d+$/;

const ACTIVE = new Set(['requested', 'running']);

/**
 * How old a leftover lock file must be before it is judged a crash artefact
 * rather than a writer in progress. A real write is two syscalls.
 */
const STALE_LOCK_MS = 60_000;

export class UpdateApplier {
  constructor(private readonly deps: { dir: string | null; now?: () => number }) {}

  /**
   * Configured *and* installed: the compose bind mount creates the directory
   * on any host, but only install-app.sh leaves the marker — and a request
   * written where no updater listens would sit unconsumed forever.
   */
  available(): boolean {
    return this.deps.dir !== null && existsSync(join(this.deps.dir, '.updater-installed'));
  }

  async request(version: string, actor: string): Promise<void> {
    const dir = this.deps.dir;
    if (!dir || !this.available()) {
      throw new UpdateApplyError(
        'No updater is installed on this host — re-run deploy/install-app.sh to add it.',
        501,
      );
    }
    if (!VERSION_SHAPE.test(version)) {
      throw new UpdateApplyError('A version looks like v1.2.3 — nothing else is accepted.', 400);
    }

    const current = await this.status();
    if (ACTIVE.has(current.state)) {
      throw new UpdateApplyError(
        `An update to ${current.version ?? 'another version'} is already ${current.state}.`,
        409,
      );
    }

    // Atomic AND exclusive. The status read above is advisory — every
    // concurrent caller can pass it before any of them has written — so the
    // fixed-name lock file is the real check: `wx` admits exactly one writer
    // (read-then-decide-then-write is a race, not a check — the login
    // lesson), and the rename publishes the request in one operation, so the
    // host's path unit can never read a half-written file.
    const body = JSON.stringify({
      version,
      requestedBy: actor,
      at: this.deps.now ? this.deps.now() : Date.now(),
    });
    const lock = join(dir, '.request.json.tmp');
    try {
      await writeFile(lock, body, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Wall-clock against wall-clock: mtimes are real time, so the injected
      // test clock deliberately plays no part in the staleness judgement.
      const mtime = await stat(lock).then(
        (stats) => stats.mtimeMs,
        () => 0,
      );
      if (Date.now() - mtime < STALE_LOCK_MS) {
        throw new UpdateApplyError(
          'Another update request is being written this instant — try again.',
          409,
        );
      }
      // A crash left the lock behind. Sweep it and take one more swing; a
      // loser here is a genuine concurrent writer and stays refused.
      await rm(lock, { force: true });
      await writeFile(lock, body, { encoding: 'utf8', flag: 'wx' });
    }

    await publishRequest(lock, join(dir, 'request.json'));
  }

  async status(): Promise<UpdateApplyStatus> {
    const dir = this.deps.dir;
    const empty: UpdateApplyStatus = {
      available: this.available(),
      state: 'idle',
      version: null,
      message: null,
      at: null,
    };
    if (!dir) return empty;

    // A pending request outranks any recorded outcome: it is the newer intent.
    const pending = await readJson(join(dir, 'request.json'));
    if (pending && typeof pending.version === 'string') {
      return {
        ...empty,
        state: 'requested',
        version: pending.version,
        at: typeof pending.at === 'number' ? pending.at : null,
      };
    }

    const outcomePath = join(dir, 'status.json');
    try {
      await stat(outcomePath);
    } catch {
      return empty;
    }
    const outcome = await readJson(outcomePath);
    if (!outcome || typeof outcome.state !== 'string') {
      return { ...empty, message: 'The updater status file is unreadable.' };
    }
    const state = (['running', 'succeeded', 'failed'] as const).find(
      (known) => known === outcome.state,
    );
    if (!state) return { ...empty, message: 'The updater status file is unreadable.' };
    return {
      ...empty,
      state,
      version: typeof outcome.version === 'string' ? outcome.version : null,
      message: typeof outcome.message === 'string' ? outcome.message : null,
      at: typeof outcome.at === 'number' ? outcome.at : null,
    };
  }
}

/**
 * Move a claimed request into place, and let exactly one of them arrive.
 *
 * Exported because it carries an invariant of its own, and one that no test of
 * `request()` can reach: the window it closes exists only between two
 * concurrent callers, and a single-threaded test can never stand inside it.
 * Tested here, it is a plain question — publishing over something that is
 * already there must refuse.
 *
 * This used to be a `rename`, which overwrites its destination. The lock that
 * precedes it only excludes writers whose attempts *overlap*: a contender that
 * claimed the lock after the winner had already renamed it away found the name
 * free, took it, and renamed a second request over the first. Both callers
 * were told they had won, and the version that actually deployed was the
 * later one. Two operators pressing Apply in the same instant is all it takes,
 * and it is silent on both sides.
 *
 * `link` refuses an existing destination, so the ordering stops mattering:
 * whoever arrives first publishes, everyone else is refused. It needs a
 * filesystem with hard links — every layout this ships on has them — and
 * anything else fails loudly here rather than racing quietly.
 */
export async function publishRequest(lock: string, published: string): Promise<void> {
  const drop = async (): Promise<void> => {
    await rm(lock, { force: true });
  };
  const lost = new UpdateApplyError('Another update request was accepted a moment ago.', 409);

  try {
    await link(lock, published);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await drop();
      throw error;
    }

    // Something is already there. Either a genuine concurrent winner — this
    // caller loses, which is the point — or a leftover nobody can act on,
    // which must not brick the button until someone shells in. The same
    // judgement the stale lock gets, and for the same reason.
    const existing = await readJson(published);
    if (existing && typeof existing.version === 'string') {
      await drop();
      throw lost;
    }

    await rm(published, { force: true });
    try {
      await link(lock, published);
    } catch {
      await drop();
      throw lost;
    }
  }

  await drop();
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
