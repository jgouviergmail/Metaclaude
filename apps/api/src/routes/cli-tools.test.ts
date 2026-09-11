/**
 * The CLI-tools screen's edge.
 *
 * What is worth testing here is not that a list round-trips — it is the three
 * places this route could quietly lie. It joins two sources whose failure
 * modes differ (a stored list, and a CLI that may not answer); it is the only
 * door onto a setting that can put fifteen thousand tokens back into every
 * prompt; and it reports a provenance an operator acts on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DISABLED_CLI_TOOLS, type CliToolsReport } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let harness: ServerHarness;

/**
 * What a run's opening frame taught the deployment.
 *
 * Not a stubbed probe: the CLI names its tools only on `system/init`, and it
 * sends that frame only with the first user message, so no probe can ask. A
 * run can, and does, on every start — this is that report, as the supervisor
 * hands it over. `[]` stands for "no run since boot".
 */
const offers = (tools: string[], forbidden: string[] = []): void => {
  if (tools.length === 0) return;
  harness.context.cliTools.rememberOffered(tools, forbidden, 1_700_000_000_000);
};

beforeEach(async () => {
  harness = await bootTestServer({ name: 'cli-tools', role: 'owner' });
});

afterEach(async () => {
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
   * Before any run has happened since boot, the deployment knows nothing about
   * what the CLI offers — and says so, rather than showing an empty offering
   * as a fact. "The CLI offers no tools" is never true.
   */
  it('says the offering is not known yet before a run has reported it', async () => {
    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');

    expect(report.probed).toBe(false);
    expect(report.seenAt).toBeNull();
    // Still the refused ones, because those are known without asking anybody.
    expect(report.tools.map((tool) => tool.name)).toEqual([...DEFAULT_DISABLED_CLI_TOOLS]);
    expect(report.tools.every((tool) => !tool.offered)).toBe(true);
  });

  it('says when the offering was seen', async () => {
    offers(['Bash']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');

    expect(report.probed).toBe(true);
    expect(report.seenAt).toBe(1_700_000_000_000);
  });

  /**
   * A run's frame lists the tools *after* its deny list took effect, so the
   * report carries what the run refused and the store adds it back. Without
   * that, every tool the deployment refuses would be badged as one the CLI had
   * dropped — the screen calling its own defaults obsolete.
   */
  it('shows a refused tool as still offered when the run that refused it says so', async () => {
    offers(['Bash', 'Read'], ['Artifact', 'CronCreate']);

    const report = await harness.get<CliToolsReport>('/api/system/cli-tools');

    expect(report.tools.find((tool) => tool.name === 'Artifact')).toMatchObject({
      disabled: true,
      offered: true,
    });
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
