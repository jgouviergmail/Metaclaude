/**
 * The CLI-skills half of the System screen.
 *
 * Three things here can quietly lie, and each has a case: an empty answer from
 * the CLI read as "it ships nothing"; a chosen skill vanishing from the screen
 * once the CLI stops shipping it, which would make it unclearable; and the
 * enumerated payload the run path sends being built from a list nobody
 * refreshed. The last is the one that matters most and the hardest to see —
 * it is why reading this screen is also what teaches the run path what exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliSkillsReport } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let harness: ServerHarness;

/** Answer the CLI probe without spawning one. */
const ships = (skills: Array<{ name: string; tokens: number }>): void => {
  vi.spyOn(harness.context.builtInSkills, 'get').mockResolvedValue(skills);
};

const SHIPPED = [
  { name: 'code-review', tokens: 202 },
  { name: 'dataviz', tokens: 362 },
];

beforeEach(async () => {
  harness = await bootTestServer({ name: 'cli-skills', role: 'owner' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

describe('GET /api/system/cli-skills', () => {
  it('lists what the CLI ships, all off, with what each would cost', async () => {
    ships(SHIPPED);

    const report = await harness.get<CliSkillsReport>('/api/system/cli-skills');

    expect(report.probed).toBe(true);
    expect(report.source).toBe('default');
    expect(report.skills).toEqual([
      { name: 'code-review', enabled: false, offered: true, tokens: 202 },
      { name: 'dataviz', enabled: false, offered: true, tokens: 362 },
    ]);
  });

  /**
   * Reading the screen is how the run path learns what exists. Without this,
   * the first choice an operator made would produce an enumerated payload
   * naming *only* the chosen skill — and every other bundled skill would come
   * back on, silently, because nothing had told the policy to name them off.
   */
  it('teaches the policy what the CLI ships', async () => {
    ships(SHIPPED);

    await harness.get<CliSkillsReport>('/api/system/cli-skills');

    expect(harness.context.cliSkills.known()).toEqual(['code-review', 'dataviz']);
  });

  it('says the CLI could not be asked rather than showing an empty offering', async () => {
    ships([]);

    const report = await harness.get<CliSkillsReport>('/api/system/cli-skills');

    expect(report.probed).toBe(false);
    expect(report.skills).toEqual([]);
  });

  it('still shows what it last knew, unoffered, when the CLI cannot be asked', async () => {
    ships(SHIPPED);
    await harness.get<CliSkillsReport>('/api/system/cli-skills');
    ships([]);

    const report = await harness.get<CliSkillsReport>('/api/system/cli-skills');

    expect(report.probed).toBe(false);
    expect(report.skills.map((skill) => skill.name)).toEqual(['code-review', 'dataviz']);
    expect(report.skills.every((skill) => !skill.offered && skill.tokens === null)).toBe(true);
  });

  it('is owner-only', async () => {
    const operator = await bootTestServer({ name: 'cli-skills-op', role: 'operator' });
    try {
      const response = await operator.send('GET', '/api/system/cli-skills');
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    } finally {
      await operator.close();
    }
  });
});

describe('PUT /api/system/cli-skills', () => {
  it('switches a skill on and reports the choice as made', async () => {
    ships(SHIPPED);

    const response = await harness.send('PUT', '/api/system/cli-skills', {
      enabled: ['code-review'],
    });
    expect(response.status).toBe(200);
    const report = (await response.json()) as CliSkillsReport;

    expect(report.source).toBe('stored');
    expect(report.skills.find((skill) => skill.name === 'code-review')?.enabled).toBe(true);
    expect(report.skills.find((skill) => skill.name === 'dataviz')?.enabled).toBe(false);
  });

  /**
   * The whole point, end to end: once one is chosen, the run path must name
   * every other one off — and it can only do that because the GET above wrote
   * the list down. This is the payload `buildOptions` will send.
   */
  it('turns the choice into a payload that names every other skill off', async () => {
    ships(SHIPPED);
    await harness.get<CliSkillsReport>('/api/system/cli-skills');

    await (
      await harness.send('PUT', '/api/system/cli-skills', { enabled: ['code-review'] })
    ).arrayBuffer();

    expect(harness.context.cliSkills.plan()).toEqual({
      kind: 'overrides',
      overrides: { 'code-review': 'on', dataviz: 'off' },
    });
  });

  it('goes back to refusing the lot with one flag on null', async () => {
    ships(SHIPPED);
    await (
      await harness.send('PUT', '/api/system/cli-skills', { enabled: ['dataviz'] })
    ).arrayBuffer();

    const response = await harness.send('PUT', '/api/system/cli-skills', { enabled: null });
    const report = (await response.json()) as CliSkillsReport;

    expect(report.source).toBe('default');
    expect(harness.context.cliSkills.plan()).toEqual({ kind: 'floor' });
  });

  /**
   * A chosen skill the CLI has since dropped stays on the screen, or it can
   * never be unchosen — and it stays `on` in the payload, or the screen and
   * the run disagree about it.
   */
  it('keeps a chosen skill visible after the CLI stops shipping it', async () => {
    ships(SHIPPED);
    await (
      await harness.send('PUT', '/api/system/cli-skills', { enabled: ['dataviz'] })
    ).arrayBuffer();
    ships([{ name: 'code-review', tokens: 202 }]);

    const report = await harness.get<CliSkillsReport>('/api/system/cli-skills');
    const dataviz = report.skills.find((skill) => skill.name === 'dataviz');

    expect(dataviz).toEqual({ name: 'dataviz', enabled: true, offered: false, tokens: null });
  });

  it('refuses a name that is not a skill name, and stores nothing', async () => {
    ships(SHIPPED);
    await (
      await harness.send('PUT', '/api/system/cli-skills', { enabled: ['dataviz'] })
    ).arrayBuffer();

    const response = await harness.send('PUT', '/api/system/cli-skills', {
      enabled: ['code-review', '../etc/passwd'],
    });

    expect(response.status).toBe(400);
    await response.arrayBuffer();
    // The choice made before the bad request is untouched.
    expect(harness.context.cliSkills.enabled()).toEqual(['dataviz']);
  });

  it('writes an audit entry', async () => {
    ships(SHIPPED);
    await (
      await harness.send('PUT', '/api/system/cli-skills', { enabled: ['dataviz'] })
    ).arrayBuffer();

    expect(harness.context.audit.list({ action: 'system.cliSkills' })).toHaveLength(1);
  });

  it('is owner-only', async () => {
    const operator = await bootTestServer({ name: 'cli-skills-op2', role: 'operator' });
    try {
      const response = await operator.send('PUT', '/api/system/cli-skills', { enabled: [] });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    } finally {
      await operator.close();
    }
  });
});
