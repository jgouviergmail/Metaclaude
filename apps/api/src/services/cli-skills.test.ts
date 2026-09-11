/**
 * The CLI's own skills, governed the way the operator's are.
 *
 * What is worth pinning is the shape the *measurement* forced. Against CLI
 * 2.1.267, `disableBundledSkills` is a floor nothing climbs back over: the same
 * session with `skillOverrides: { 'code-review': 'on' }` beside it still
 * carried zero built-in skills. So there is no "floor plus exceptions" — a
 * deployment either refuses the lot with one flag, or names every skill it
 * knows about one by one. Which of those a run gets is the interesting
 * behaviour here, and the reason the empty case keeps the flag is that the
 * flag is the only form that covers a skill a future CLI has not shipped yet.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kvSet, migrate, openDatabase, type Db } from '../db/index.js';
import { CliSkillPolicy } from './cli-skills.js';

let db: Db;
let policy: CliSkillPolicy;

const SHIPPED = ['code-review', 'dataviz', 'design', 'keybindings-help'];

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  policy = new CliSkillPolicy(db);
});

afterEach(() => {
  db.close();
});

describe('CliSkillPolicy', () => {
  it('offers none, and says nothing has been chosen', () => {
    expect(policy.enabled()).toEqual([]);
    expect(policy.source()).toBe('default');
  });

  /**
   * The empty case is the one that has to survive a CLI bump, and only the
   * flag does: a skill shipped tomorrow is not on any list here, so an
   * enumerated payload would let it in. This is why the two forms exist.
   */
  it('refuses the lot with one flag while nothing is chosen', () => {
    policy.rememberKnown(SHIPPED);

    expect(policy.plan()).toEqual({ kind: 'floor' });
  });

  it('names every known skill once something is chosen', () => {
    policy.rememberKnown(SHIPPED);
    policy.setEnabled(['code-review']);

    expect(policy.plan()).toEqual({
      kind: 'overrides',
      overrides: {
        'code-review': 'on',
        dataviz: 'off',
        design: 'off',
        'keybindings-help': 'off',
      },
    });
    expect(policy.source()).toBe('stored');
  });

  /**
   * A skill switched on and then dropped by the CLI keeps its `on` rather than
   * falling out of the payload, or the list on screen and the list a run gets
   * disagree about it — and the row becomes unclearable for the same reason a
   * refused-but-absent tool would be.
   */
  it('keeps a chosen skill in the payload after the CLI stops shipping it', () => {
    policy.rememberKnown(SHIPPED);
    policy.setEnabled(['code-review', 'retired-thing']);
    policy.rememberKnown(SHIPPED);

    const plan = policy.plan();
    expect(plan.kind).toBe('overrides');
    expect(plan.kind === 'overrides' && plan.overrides['retired-thing']).toBe('on');
  });

  it('goes back to the flag when the choice is cleared', () => {
    policy.rememberKnown(SHIPPED);
    policy.setEnabled(['dataviz']);
    expect(policy.setEnabled(null)).toEqual([]);

    expect(policy.plan()).toEqual({ kind: 'floor' });
    expect(policy.source()).toBe('default');
  });

  it('remembers what the CLI ships across a change of choice', () => {
    policy.rememberKnown(SHIPPED);
    policy.setEnabled(['design']);

    expect(policy.known()).toEqual([...SHIPPED].sort());
  });

  /**
   * No CLI ships no skills, so an empty answer is a probe that failed —
   * and overwriting a good list with it would leave the run path with nothing
   * to name `off`, which is the enumerated form quietly becoming a no-op.
   */
  it('ignores an empty answer rather than forgetting what it knew', () => {
    policy.rememberKnown(SHIPPED);
    policy.rememberKnown([]);

    expect(policy.known()).toEqual([...SHIPPED].sort());
  });

  describe('a row that was not written by this class', () => {
    it('drops entries that are not skill names', () => {
      kvSet(db, 'cli.skills', { enabled: ['dataviz', 42, '../etc', ''], known: ['dataviz'] });

      expect(policy.enabled()).toEqual(['dataviz']);
    });

    it('falls back to offering none when the shape is wrong', () => {
      kvSet(db, 'cli.skills', { enabled: 'dataviz', known: 7 });

      expect(policy.enabled()).toEqual([]);
      expect(policy.plan()).toEqual({ kind: 'floor' });
    });
  });
});
