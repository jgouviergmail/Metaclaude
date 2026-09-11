/**
 * Which of the Claude CLI's own tools this deployment refuses.
 *
 * The CLI brings its own tool set, and it is written for a person at a
 * terminal signed in to claude.ai. Metaclaude mounted all of it. Some of those
 * tools merely cost tokens — measured against CLI 2.1.267, the built-ins are
 * 23,543 in-window tokens on the cached prefix of every single run — and three
 * of them reach past the deployment entirely: `CronCreate` schedules work in
 * the CLI's own scheduler, outside the automations screen and its quota guard,
 * and `Artifact` publishes a page to claude.ai from inside a run. Nothing on
 * any screen said either was possible.
 *
 * Global rather than per-workspace, deliberately. This is not a preference
 * about how one project works; it is the shape of the agent this deployment
 * runs, and a per-workspace override would be a second place for a door to be
 * open with nobody looking at it. The screen that shows it lives in System,
 * beside the other answers to "what can this deployment do".
 *
 * Stored in `kv` rather than in `runtime_settings`: that table's whole surface
 * is one scalar per key, typed by a catalogue that renders it on the
 * Configuration screen, and a list of tool names is neither a number nor one
 * of a fixed set of choices. Faking it as a comma-joined string would have
 * fitted the column and lied about the type — and would not have fitted
 * anyway, since the value is capped at 128 characters there.
 */

import {
  DEFAULT_DISABLED_CLI_TOOLS,
  MAX_DISABLED_CLI_TOOLS,
  reviewDeniedToolNames,
  type ToolNameReview,
} from '@metaclaude/shared';
import { kvGet, kvSet, type Db } from '../db/index.js';

/** Where `disabled()`'s answer came from. */
export type CliToolSource = 'stored' | 'default';

/**
 * The row's key. Namespaced like every other `kv` tenant, so a future one
 * cannot collide by picking a plain word.
 */
const KEY = 'cli.disabledTools';

interface Stored {
  tools: string[];
}

export class CliToolPolicy {
  constructor(private readonly db: Db) {}

  /**
   * The names in force, sorted.
   *
   * Read at the point of use on every run, never pushed: the same convention
   * `RuntimeSettings` follows, and what makes a change take effect on the next
   * run rather than on the next restart.
   */
  disabled(): readonly string[] {
    const stored = this.stored();
    return stored ?? [...DEFAULT_DISABLED_CLI_TOOLS];
  }

  /**
   * Whether an operator has actually chosen, or this is what shipped.
   *
   * Reported rather than inferred, for the reason `RuntimeSettings` reports
   * provenance: a screen that showed the shipped default as though someone had
   * set it describes a decision nobody made, and the operator cannot tell
   * whether clearing it would change anything.
   */
  source(): CliToolSource {
    return this.stored() ? 'stored' : 'default';
  }

  /**
   * Store a list, or hand the deployment back its default with `null`.
   *
   * Returns what was vetted rather than throwing on a bad name: the caller
   * reports the refusals, and one bad entry must not lose the operator the
   * rest of their edit. An empty array is a legitimate stored value — "refuse
   * nothing" is a decision, and it is not the same as the default.
   */
  set(names: readonly string[] | null): ToolNameReview {
    if (names === null) {
      // Removed rather than written as an empty value: absence is what "the
      // deployment's own default" means everywhere else here, and a row saying
      // "nothing stored" is a second way to say it that a later reader can
      // disagree about.
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
      return { allowed: [...DEFAULT_DISABLED_CLI_TOOLS], rejected: [] };
    }

    const review = reviewDeniedToolNames(names.slice(0, MAX_DISABLED_CLI_TOOLS));
    kvSet(this.db, KEY, { tools: [...review.allowed].sort() } satisfies Stored);
    return { allowed: [...review.allowed].sort(), rejected: review.rejected };
  }

  /**
   * The stored list, or null when there is none.
   *
   * Re-vetted on the way out, not merely parsed. The row is JSON in a
   * key/value table, so nothing but this class's own writes constrain it — and
   * a value hand-edited to name `ToolSearch` would otherwise put fifteen
   * thousand tokens back into every prompt with no screen able to explain it.
   * Same reasoning as the read-time prune on a gate decision: the repair
   * belongs on the read, where every door leads.
   */
  private stored(): string[] | null {
    const row = kvGet<Stored | null>(this.db, KEY, null);
    if (!row || !Array.isArray(row.tools)) return null;
    return reviewDeniedToolNames(
      row.tools.filter((name): name is string => typeof name === 'string').slice(0, MAX_DISABLED_CLI_TOOLS),
    ).allowed.sort();
  }
}
