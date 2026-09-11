/**
 * Which of the Claude CLI's own skills this deployment offers its runs.
 *
 * The CLI ships seventeen skills inside its binary — `design`, `dataviz`,
 * `code-review`, `update-config`, `keybindings-help` and the rest — written
 * for a person at a terminal signed in to claude.ai. They were listed in every
 * Metaclaude run's prompt and openable by the agent, on no screen and behind
 * no switch: an operator who had turned every one of *their* skills off still
 * carried seventeen that were not theirs. That is the defect 0.93 closed by
 * refusing the lot.
 *
 * This is the other half of the answer, and the one the operator asked for:
 * the CLI's skills governed the way their own are — a list, a box each, off
 * unless chosen. Nothing is copied. The skill stays the CLI's, with its real
 * body, maintained by the CLI and never going stale in a row here; all this
 * stores is which of them a run may see.
 *
 * **Two shapes, and the measurement is what forces them.** Measured against
 * CLI 2.1.267: `disableBundledSkills` is a floor nothing climbs back over — the
 * same session with `skillOverrides: { 'code-review': 'on' }` beside it still
 * carried *zero* built-in skills. So exposing a subset means not using the
 * floor at all and naming every other skill `'off'` one by one. That is worse
 * in exactly one way — a skill a future CLI ships is not on the list, so it
 * arrives switched *on* — which is why the floor is kept whenever the choice
 * is empty. A deployment that has chosen nothing is safe against a bump for
 * ever; one that has chosen something has opted into a list it maintains.
 *
 * `known` is the last list the CLI was seen to ship, kept because the run path
 * cannot spawn a probe of its own to ask. It is refreshed wherever the screen
 * reads the CLI, and a stale entry is inert: an override naming a skill that no
 * longer exists does nothing.
 */

import { MAX_CLI_SKILLS, reviewToolNames } from '@metaclaude/shared';
import { kvGet, kvSet, type Db } from '../db/index.js';

/** How a run is told about the CLI's own skills. */
export type CliSkillPlan =
  /** Nothing chosen: one flag refuses the lot, including whatever ships next. */
  | { kind: 'floor' }
  /**
   * Something chosen: every known skill named, `on` for the chosen and `off`
   * for the rest. The floor cannot be combined — measured, it wins.
   */
  | { kind: 'overrides'; overrides: Record<string, 'on' | 'off'> };

const KEY = 'cli.skills';

interface Stored {
  /** The names an operator switched on. */
  enabled: string[];
  /** The names the CLI was last seen to ship. */
  known: string[];
}

/**
 * A skill name as the CLI reports it.
 *
 * `reviewToolNames` is the vetting already in use for the other thing a CLI
 * names — its tools — and the alphabet is the same: it refuses anything that
 * is not a bare identifier, which is what stops a hand-edited row putting a
 * path or a scoped rule into a settings payload. Reused rather than restated
 * so a rule added there reaches here.
 */
function vet(names: readonly unknown[]): string[] {
  return reviewToolNames(
    names.filter((name): name is string => typeof name === 'string').slice(0, MAX_CLI_SKILLS),
  ).allowed;
}

export class CliSkillPolicy {
  constructor(private readonly db: Db) {}

  /** The skills an operator has switched on, sorted. */
  enabled(): readonly string[] {
    return this.stored().enabled;
  }

  /** The skills the CLI was last seen to ship, sorted. */
  known(): readonly string[] {
    return this.stored().known;
  }

  /** Whether anything has been switched on. */
  source(): 'stored' | 'default' {
    return this.stored().enabled.length > 0 ? 'stored' : 'default';
  }

  /**
   * What to tell the CLI for a run.
   *
   * Read at the point of use, like every other operational setting here, so a
   * change applies to the next run rather than to the next restart.
   */
  plan(): CliSkillPlan {
    const { enabled, known } = this.stored();
    if (enabled.length === 0) return { kind: 'floor' };

    // The union, not just `known`: a skill switched on and then dropped from
    // the CLI has to keep its `on` rather than vanish from the payload, or the
    // list the operator sees and the list the run gets disagree about it.
    const overrides: Record<string, 'on' | 'off'> = {};
    for (const name of new Set([...known, ...enabled])) {
      overrides[name] = enabled.includes(name) ? 'on' : 'off';
    }
    return { kind: 'overrides', overrides };
  }

  /** Store the chosen set, or `null` to go back to offering none. */
  setEnabled(names: readonly string[] | null): readonly string[] {
    const { known } = this.stored();
    const enabled = names === null ? [] : vet(names).sort();
    kvSet(this.db, KEY, { enabled, known } satisfies Stored);
    return enabled;
  }

  /**
   * Record what the CLI was seen to ship.
   *
   * Called wherever the CLI is actually asked. Refuses an empty list on
   * purpose: no CLI ships no skills, so an empty answer is a probe that
   * failed, and overwriting a good list with it would leave the run path
   * unable to name anything to switch off.
   */
  rememberKnown(names: readonly string[]): void {
    const known = vet(names).sort();
    if (known.length === 0) return;
    const { enabled } = this.stored();
    kvSet(this.db, KEY, { enabled, known } satisfies Stored);
  }

  /**
   * The row, vetted on the way out.
   *
   * Re-read rather than trusted: this is JSON in a key/value table, so nothing
   * but this class's own writes constrain it, and what comes out of it goes
   * into a settings payload handed to a subprocess. The repair belongs on the
   * read, where every door leads — including a hand edit and a downgrade from
   * a version that stored something else.
   */
  private stored(): { enabled: string[]; known: string[] } {
    const row = kvGet<Partial<Stored> | null>(this.db, KEY, null);
    return {
      enabled: Array.isArray(row?.enabled) ? vet(row.enabled).sort() : [],
      known: Array.isArray(row?.known) ? vet(row.known).sort() : [],
    };
  }
}
