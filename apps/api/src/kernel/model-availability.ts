/**
 * Which models the subscription has refused, and until when.
 *
 * Without this, every run until the window resets pays the same discovery
 * again: ask for the spent model, be refused, switch. A weekly bucket resets
 * days later — measured, the Fable one had six hours left when it was found —
 * so that is a long time to relearn the same fact once per run, and a
 * transcript full of identical warnings.
 *
 * Kept in `kv` rather than in memory because a weekly window outlives a
 * deployment, and a restart that forgets is a restart that starts paying again.
 * Entries expire by their own timestamp, so nothing has to sweep them.
 */

import type { Db } from '../db/index.js';
import { kvGet, kvSet } from '../db/index.js';

const KEY = 'quota.blockedModels';

/** Model alias → epoch millis at which its window resets. */
type Blocked = Record<string, number>;

export class ModelAvailability {
  constructor(private readonly db: Db) {}

  /**
   * Record that the subscription refused this model.
   *
   * A refusal with no reset time is held for `defaultHoldMs` rather than
   * forever: "we do not know when this frees up" must not mean "never try it
   * again", which is how a model would silently leave the frontier for good.
   */
  block(model: string, resetsAt: number | null, now = Date.now(), defaultHoldMs = 3_600_000): void {
    const blocked = this.read(now);
    const until = resetsAt ?? now + defaultHoldMs;
    // Never shorten an existing hold: two refusals in a run would otherwise let
    // the second, which may carry no reset time, undo the first.
    blocked[model] = Math.max(blocked[model] ?? 0, until);
    kvSet(this.db, KEY, blocked);
  }

  /** Models still refused at `now`. */
  blocked(now = Date.now()): Set<string> {
    return new Set(Object.keys(this.read(now)));
  }

  /** When this model frees up, or null if it is not blocked. */
  blockedUntil(model: string, now = Date.now()): number | null {
    return this.read(now)[model] ?? null;
  }

  /** Forget a model's block — the operator pinning it is an override. */
  release(model: string): void {
    const blocked = this.read(Date.now());
    if (!(model in blocked)) return;
    delete blocked[model];
    kvSet(this.db, KEY, blocked);
  }

  /** Everything still held, expired entries dropped. */
  private read(now: number): Blocked {
    const stored = kvGet<Blocked>(this.db, KEY, {});
    const live: Blocked = {};
    for (const [model, until] of Object.entries(stored)) {
      if (typeof until === 'number' && until > now) live[model] = until;
    }
    return live;
  }
}
