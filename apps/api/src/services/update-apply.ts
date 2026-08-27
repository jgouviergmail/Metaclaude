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
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
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

    // Atomic: the host's path unit fires on the final name only, so it can
    // never read a half-written request.
    const body = JSON.stringify({
      version,
      requestedBy: actor,
      at: this.deps.now ? this.deps.now() : Date.now(),
    });
    const tmp = join(dir, '.request.json.tmp');
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, join(dir, 'request.json'));
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

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
