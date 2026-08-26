/**
 * A short-lived cache in front of the CLI's catalogue.
 *
 * Reading it spawns a Claude CLI subprocess and waits for it to initialise —
 * affordable once, absurd per page load, and the dashboard alone would ask
 * several times while its panels mount.
 *
 * The TTL is short on purpose. This is not reference data: an MCP server's
 * status is exactly the thing an operator refreshes after fixing its command,
 * and a stale "failed" would send them debugging a problem they had already
 * solved. A minute is long enough to cover a page load and its panels, short
 * enough that the answer is never surprising — and `force` skips it for the
 * case where the operator knows something changed.
 */

import type { ClaudeCatalogue } from '@metaclaude/shared';

export interface TtlCacheDeps<T> {
  /** Read the value for one workspace directory. */
  read: (workspacePath: string) => Promise<T>;
  ttlMs?: number;
  /** Injectable clock, so the tests do not sleep. */
  now?: () => number;
}

interface Entry<T> {
  at: number;
  value: T;
}

/**
 * Generic because the CLI answers more than one expensive question the same
 * way: the catalogue was the first tenant, the usage windows the second.
 */
export class TtlCache<T> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<T>>();
  /**
   * Reads currently in flight, by workspace.
   *
   * Without this, three panels mounting together are three CLI subprocesses for
   * one answer. Sharing the promise makes concurrent callers one read.
   */
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly deps: TtlCacheDeps<T>) {
    this.ttlMs = deps.ttlMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  async get(workspacePath: string, options: { force?: boolean } = {}): Promise<T> {
    if (!options.force) {
      const cached = this.entries.get(workspacePath);
      if (cached && this.now() - cached.at < this.ttlMs) return cached.value;

      // Join a read already running rather than starting a second one. Skipped
      // under `force`, which exists precisely to get a fresh answer.
      const running = this.inFlight.get(workspacePath);
      if (running) return running;
    }

    const read = this.deps
      .read(workspacePath)
      .then((value) => {
        this.entries.set(workspacePath, { at: this.now(), value });
        return value;
      })
      .finally(() => {
        // Cleared whether it resolved or rejected. A rejected promise left in
        // the map would be handed to every later caller, so one failed read
        // would look permanent.
        if (this.inFlight.get(workspacePath) === read) this.inFlight.delete(workspacePath);
      });

    this.inFlight.set(workspacePath, read);
    return read;
  }

  /** Forget one workspace, or all of them. */
  invalidate(workspacePath?: string): void {
    if (workspacePath === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(workspacePath);
  }
}

/** The catalogue's cache — the class's original tenant, name kept for its callers. */
export class CatalogueCache extends TtlCache<ClaudeCatalogue> {}
