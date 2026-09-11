import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DEFAULT_DISABLED_CLI_TOOLS, MAX_DISABLED_CLI_TOOLS } from '@metaclaude/shared';
import { kvSet, migrate, openDatabase, type Db } from '../db/index.js';
import { CliToolPolicy } from './cli-tools.js';

let db: Db;
let policy: CliToolPolicy;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  policy = new CliToolPolicy(db);
});

afterEach(() => {
  db.close();
});

describe('CliToolPolicy', () => {
  it('ships the deployment default, and says that is what it is', () => {
    expect(policy.disabled()).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);
    expect(policy.source()).toBe('default');
  });

  it('stores a choice, sorted, and reports it as chosen', () => {
    expect(policy.set(['WebSearch', 'Artifact'])).toEqual({
      allowed: ['Artifact', 'WebSearch'],
      rejected: [],
    });

    expect(policy.disabled()).toEqual(['Artifact', 'WebSearch']);
    expect(policy.source()).toBe('stored');
  });

  /**
   * "Refuse nothing" is a decision, and it is not the deployment's default.
   *
   * An empty stored list that fell back to the default would make the one
   * choice an operator cannot express the one that looks easiest to make: they
   * would clear every box, save, and watch nine come back.
   */
  it('keeps an empty choice as a choice', () => {
    policy.set([]);

    expect(policy.disabled()).toEqual([]);
    expect(policy.source()).toBe('stored');
  });

  it('hands the default back when the choice is cleared', () => {
    policy.set(['WebSearch']);
    expect(policy.set(null).allowed).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);

    expect(policy.disabled()).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);
    expect(policy.source()).toBe('default');
  });

  it('reports a refused name instead of losing the rest of the edit', () => {
    const review = policy.set(['Artifact', 'ToolSearch', 'Web Search', 'CronList']);

    expect(review.allowed).toEqual(['Artifact', 'CronList']);
    expect(review.rejected.map((entry) => entry.name)).toEqual(['Web Search', 'ToolSearch']);
    expect(policy.disabled()).toEqual(['Artifact', 'CronList']);
  });

  /**
   * The row is JSON in a key/value table, so nothing but this class constrains
   * what is in it. The repair belongs on the *read* — every door leads there,
   * including a hand-edited database and a downgrade from a future version
   * that stored something else.
   */
  describe('a row that was not written by this class', () => {
    it('drops ToolSearch rather than putting every tool schema back in the prompt', () => {
      kvSet(db, 'cli.disabledTools', { tools: ['ToolSearch', 'Artifact'] });

      expect(policy.disabled()).toEqual(['Artifact']);
    });

    it('drops entries that are not tool names at all', () => {
      kvSet(db, 'cli.disabledTools', { tools: ['Artifact', 42, null, 'Web Search', ''] });

      expect(policy.disabled()).toEqual(['Artifact']);
    });

    it('falls back to the default when the shape is wrong', () => {
      kvSet(db, 'cli.disabledTools', { tools: 'Artifact' });

      expect(policy.disabled()).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);
      expect(policy.source()).toBe('default');
    });

    it('bounds a row that names more tools than any CLI has', () => {
      const many = Array.from({ length: MAX_DISABLED_CLI_TOOLS + 50 }, (_, i) => `Tool${i}`);
      kvSet(db, 'cli.disabledTools', { tools: many });

      expect(policy.disabled()).toHaveLength(MAX_DISABLED_CLI_TOOLS);
    });
  });
});
