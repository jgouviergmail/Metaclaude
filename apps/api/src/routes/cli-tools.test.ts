/**
 * The CLI-tools screen's edge.
 *
 * What is worth testing here is not that a list round-trips — it is the three
 * places this route could quietly lie. It joins two sources whose failure
 * modes differ (a stored list, and a CLI that may not answer); it is the only
 * door onto a setting that can put fifteen thousand tokens back into every
 * prompt; and it reports a provenance an operator acts on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DISABLED_CLI_TOOLS, type ClaudeCatalogue, type CliToolsReport } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let harness: ServerHarness;

/** A catalogue the CLI probe would have produced, with these tools on it. */
const offering = (tools: string[], unavailable: string[] = []): ClaudeCatalogue => ({
  models: [],
  commands: [],
  agents: [],
  tools,
  mcpServers: [],
  account: null,
  unavailable,
  fetchedAt: Date.now(),
});

/** Answer the catalogue read without spawning a CLI. */
const offers = (tools: string[], unavailable: string[] = []): void => {
  vi.spyOn(harness.context.claudeCatalogue, 'get').mockResolvedValue(offering(tools, unavailable));
};

beforeEach(async () => {
  harness = await bootTestServer({ name: 'cli-tools', role: 'owner' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

describe('GET /api/system/cli-tools', () => {
  it('lists what the CLI offers, marking what the deployment refuses', async () => {
    offers(['Bash', 'Artifact', 'Read']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');

    expect(report.probed).toBe(true);
    expect(report.source).toBe('default');
    // The union of what the CLI offers and what the deployment refuses, sorted
    // — the second half is why `Read` is not simply followed by nothing: the
    // shipped default names nine tools this fake CLI does not offer, and each
    // has to stay visible or its row could never be cleared.
    expect(report.tools.map((tool) => tool.name)).toEqual(
      [...new Set(['Artifact', 'Bash', 'Read', ...DEFAULT_DISABLED_CLI_TOOLS])].sort(),
    );
    expect(report.tools.find((tool) => tool.name === 'Artifact')).toMatchObject({
      disabled: true,
      offered: true,
      locked: null,
    });
    expect(report.tools.find((tool) => tool.name === 'Bash')).toMatchObject({
      disabled: false,
      offered: true,
    });
  });

  /**
   * A refused tool the CLI no longer ships still has to appear, or its row is
   * unclearable: the operator cannot untick what is not on the screen, and the
   * stored list silently accumulates names nobody can see or explain.
   */
  it('keeps a refused tool on the list after the CLI stops offering it', async () => {
    offers(['Bash']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');
    const artifact = report.tools.find((tool) => tool.name === 'Artifact');

    expect(artifact).toMatchObject({ disabled: true, offered: false });
  });

  /**
   * "The CLI offers no tools" is never true, so a screen that showed an empty
   * list would be describing a state that cannot exist. The honest answer is
   * that the question could not be asked — the same rule the rest of the
   * catalogue follows with `unavailable`.
   */
  it('says the CLI could not be asked rather than showing an empty catalogue', async () => {
    offers([], ['tools']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');

    expect(report.probed).toBe(false);
    // Still the refused ones, because those are known without asking anybody.
    expect(report.tools.map((tool) => tool.name)).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);
    expect(report.tools.every((tool) => !tool.offered)).toBe(true);
  });

  /**
   * The same emptiness by a different door, which is the one that got through.
   *
   * The first version asked `unavailable.includes('tools')` — and when the CLI
   * session cannot be opened at all (no binary, no credential) the catalogue
   * records that under `session`, not `tools`. So the screen was told the
   * question had been answered, showed an empty offering as fact, and marked
   * every tool the deployment refuses as one the CLI had dropped — with no
   * warning. Enumerating failure names is a list that goes stale; the answer
   * itself is not.
   */
  it('reports "could not measure" when the CLI session never opened', async () => {
    offers([], ['session']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');

    expect(report.probed).toBe(false);
    expect(report.tools.every((tool) => !tool.offered)).toBe(true);
  });

  it('locks ToolSearch, with the reason on the row', async () => {
    offers(['Bash', 'ToolSearch']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');
    const search = report.tools.find((tool) => tool.name === 'ToolSearch');

    expect(search?.locked).toContain('loads every other tool');
    expect(search?.disabled).toBe(false);
  });

  it('is owner-only', async () => {
    const operator = await bootTestServer({ name: 'cli-tools-op', role: 'operator' });
    try {
      const response = await operator.send('GET', '/api/system/cli-tools');
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    } finally {
      await operator.close();
    }
  });
});

describe('PUT /api/system/cli-tools', () => {
  it('stores a choice and reports it as chosen', async () => {
    offers(['Bash', 'Artifact', 'WebSearch']);

    const response = await harness.send('PUT', '/api/system/cli-tools', {
      disabled: ['WebSearch'],
    });
    expect(response.status).toBe(200);
    const report = (await response.json()) as CliToolsReport;

    expect(report.source).toBe('stored');
    expect(report.tools.find((tool) => tool.name === 'WebSearch')?.disabled).toBe(true);
    expect(report.tools.find((tool) => tool.name === 'Artifact')?.disabled).toBe(false);
    expect(harness.context.cliTools.disabled()).toEqual(['WebSearch']);
  });

  it('keeps an empty choice as a choice rather than restoring the default', async () => {
    offers(['Bash']);

    const response = await harness.send('PUT', '/api/system/cli-tools', { disabled: [] });
    const report = (await response.json()) as CliToolsReport;

    expect(report.source).toBe('stored');
    expect(harness.context.cliTools.disabled()).toEqual([]);
  });

  it('hands the deployment default back on null', async () => {
    offers(['Bash']);
    await (await harness.send('PUT', '/api/system/cli-tools', { disabled: [] })).arrayBuffer();

    const response = await harness.send('PUT', '/api/system/cli-tools', { disabled: null });
    const report = (await response.json()) as CliToolsReport;

    expect(report.source).toBe('default');
    expect(harness.context.cliTools.disabled()).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);
  });

  /**
   * The one name that must never be stored, refused at the edge with its
   * reason — not merely dropped. An operator who ticked it is owed the
   * sentence explaining why the box will not stay ticked; silently discarding
   * it is a form that lies about what it saved.
   */
  it('refuses ToolSearch with the reason, and stores nothing', async () => {
    offers(['Bash', 'ToolSearch']);

    const response = await harness.send('PUT', '/api/system/cli-tools', {
      disabled: ['ToolSearch'],
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      'loads every other tool',
    );
    expect(harness.context.cliTools.source()).toBe('default');
  });

  /**
   * A 400 must not cost the operator the list they had.
   *
   * The first version stored the vetted names and undid it on a rejection —
   * and the undo hands the deployment back its *default*, so one bad entry
   * threw away a list somebody had built. It read as correct against the
   * obvious test, which starts from the default and cannot tell "the rollback
   * was harmless" from "the rollback was right". This one starts from a stored
   * list, which is the only state where the two differ.
   */
  it('leaves a stored list untouched when the request is refused', async () => {
    offers(['Bash', 'WebSearch', 'ToolSearch']);
    await (
      await harness.send('PUT', '/api/system/cli-tools', { disabled: ['WebSearch'] })
    ).arrayBuffer();

    const response = await harness.send('PUT', '/api/system/cli-tools', {
      disabled: ['Bash', 'ToolSearch'],
    });
    expect(response.status).toBe(400);
    await response.arrayBuffer();

    expect(harness.context.cliTools.source()).toBe('stored');
    expect(harness.context.cliTools.disabled()).toEqual(['WebSearch']);
  });

  it('refuses a name that is not a tool name', async () => {
    offers(['Bash']);

    const response = await harness.send('PUT', '/api/system/cli-tools', {
      disabled: ['Web Search'],
    });

    expect(response.status).toBe(400);
    await response.arrayBuffer();
    expect(harness.context.cliTools.source()).toBe('default');
  });

  it('writes an audit entry naming what was set', async () => {
    offers(['Bash', 'WebSearch']);
    await (
      await harness.send('PUT', '/api/system/cli-tools', { disabled: ['WebSearch'] })
    ).arrayBuffer();

    const entries = harness.context.audit.list({ limit: 10 });
    expect(entries.some((entry) => entry.action === 'system.cliTools')).toBe(true);
  });

  it('is owner-only', async () => {
    const operator = await bootTestServer({ name: 'cli-tools-op2', role: 'operator' });
    try {
      const response = await operator.send('PUT', '/api/system/cli-tools', { disabled: [] });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    } finally {
      await operator.close();
    }
  });
});
