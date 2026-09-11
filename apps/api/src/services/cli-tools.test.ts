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
  /**
   * Where the offered list comes from, and why it is not a probe.
   *
   * The CLI names its tools on the `system/init` frame and on nothing else,
   * and — measured — it emits that frame only with the *first user message*:
   * twenty seconds of listening, `reinitialize()` and `initializationResult()`
   * all produced nothing, one prompt produced it at 817 ms. A probe that sends
   * no prompt can therefore never answer, which is exactly what production
   * showed. Every run sends a prompt, so every run is the measurement.
   */
  describe('what the CLI was last seen to offer', () => {
    it('knows nothing until a run has happened', () => {
      expect(policy.offered()).toEqual({ tools: [], seenAt: null });
    });

    /**
     * A run's frame lists the tools *after* the deny list took effect —
     * measured, a denied tool vanishes from `init.tools` — so the frame alone
     * would report every refused tool as one the CLI had dropped. The run
     * knows what it refused; adding that back is what makes the list the
     * CLI's offering rather than the run's leftovers.
     */
    it('adds back what the run itself had refused', () => {
      policy.rememberOffered(['Bash', 'Read', 'ToolSearch'], ['Artifact', 'CronCreate'], 1_000);

      expect(policy.offered()).toEqual({
        tools: ['Artifact', 'Bash', 'CronCreate', 'Read', 'ToolSearch'],
        seenAt: 1_000,
      });
    });

    it('keeps the newest run’s answer', () => {
      policy.rememberOffered(['Bash', 'OldThing'], [], 1_000);
      policy.rememberOffered(['Bash', 'NewThing'], [], 2_000);

      expect(policy.offered()).toEqual({ tools: ['Bash', 'NewThing'], seenAt: 2_000 });
    });

    it('ignores a frame that names no tools, which no CLI sends', () => {
      policy.rememberOffered(['Bash'], [], 1_000);
      policy.rememberOffered([], [], 2_000);

      expect(policy.offered()).toEqual({ tools: ['Bash'], seenAt: 1_000 });
    });

    it('strips MCP tools: those belong to a server, not to the CLI', () => {
      policy.rememberOffered(['Bash', 'mcp__docs__search'], [], 1_000);

      expect(policy.offered().tools).toEqual(['Bash']);
    });

    it('does not lose the choice when a run reports', () => {
      policy.set(['WebSearch']);
      policy.rememberOffered(['Bash', 'WebSearch'], ['WebSearch'], 1_000);

      expect(policy.disabled()).toEqual(['WebSearch']);
      expect(policy.source()).toBe('stored');
    });
  });

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
