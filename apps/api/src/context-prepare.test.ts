/**
 * The seam that makes the world match the database before a run reads it.
 *
 * `kernel.test.ts` proves the kernel calls `prepare` before `resolve` on every
 * trigger, against a fake provider. That is half the promise, and it is the
 * half that cannot fail quietly — the other half is that the *real* provider
 * does something, and a fake can never show it.
 *
 * It is worth a test of its own because of what went wrong: writing the
 * workspace's skills to disk lived at the call sites that submit a run, three
 * of the eight had it, and the five without were the scheduler, the steward,
 * the advisor, delegation and the MCP gateway. Every unattended run, in other
 * words, went to the CLI with whatever the last interactive message had left
 * behind. Nothing reported it, because the run succeeded either way.
 *
 * The real server, the real registry, a real directory. No CLI is spawned:
 * `prepare` is called directly, which is exactly what the kernel does with it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from './test/server-harness.js';

let harness: ServerHarness;
let workspace: Workspace;

const skillFile = (name: string): string =>
  join(workspace.path, '.claude', 'skills', name, 'SKILL.md');

/** What the kernel does before every run, with nothing else moving. */
const prepare = async (): Promise<void> => {
  await harness.context.contextProvider.prepare?.(workspace);
};

beforeEach(async () => {
  harness = await bootTestServer({ name: 'prepare' });
  workspace = await harness.context.workspaces.create({
    name: 'Prepared',
    description: '',
    color: '#6366f1',
    icon: 'folder',
  });
});

afterEach(async () => {
  await harness.close();
});

describe('ContextProvider.prepare', () => {
  it('writes the workspace’s enabled skills where the CLI looks for them', async () => {
    harness.context.registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'deploy-check',
      description: 'Use before a deploy.',
      body: 'Run the checks.',
    });

    await prepare();

    expect(readFileSync(skillFile('deploy-check'), 'utf8')).toContain('Run the checks.');
  });

  /**
   * The defect's own shape, from the side an operator would meet it.
   *
   * A workspace driven only by an automation never sees the interactive route
   * that used to carry the write, so a skill added after the last message was
   * invisible to it — for ever, since nothing else would ever write the
   * directory. The second `prepare` here stands for the next automation
   * firing, with no message typed in between.
   */
  it('picks up a skill added since the last run, with nothing interactive in between', async () => {
    await prepare();
    expect(existsSync(join(workspace.path, '.claude', 'skills'))).toBe(false);

    harness.context.registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'nightly',
      description: 'Use at night.',
      body: 'Sweep the logs.',
    });
    await prepare();

    expect(existsSync(skillFile('nightly'))).toBe(true);
  });

  /**
   * And the other direction, which is the worse of the two: a skill the
   * operator switched off went on being offered to unattended runs, and the
   * registry no longer listed it — so the invocation was recorded against no
   * row at all, as though a plugin had provided it.
   */
  it('takes a disabled skill off the disk on the next run', async () => {
    const skill = harness.context.registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'retired',
      description: 'Use never.',
      body: 'Nothing.',
    });
    await prepare();
    expect(existsSync(skillFile('retired'))).toBe(true);

    harness.context.registry.setSkillsEnabled([skill.id], false);
    await prepare();

    expect(existsSync(skillFile('retired'))).toBe(false);
  });
  /**
   * Two subsystems freshened here, and neither may take the other down.
   *
   * The OAuth refresh runs first and is documented as never throwing — which
   * was a property of one implementation rather than of the seam, and it is a
   * network call to a third party. Sequential and unguarded, a token endpoint
   * having a bad afternoon would have stopped the workspace's skills reaching
   * disk: a degradation in one place silently causing a different one
   * somewhere else, on every run, with the run still landing as a success.
   */
  it('writes the skills even when renewing a credential fails', async () => {
    // `upsertMcpServer` takes no `authType` — the OAuth flow sets the column
    // when a server is authorised — so the row is put in that state directly.
    // Passing the field to the upsert typechecks as an excess property and
    // would be silently dropped, which is a fixture that proves nothing.
    const server = harness.context.registry.upsertMcpServer({
      workspaceId: workspace.id,
      name: 'oauthy',
      transport: 'http',
      url: 'https://example.invalid/mcp',
    });
    harness.context.db
      .prepare('UPDATE mcp_servers SET auth_type = ? WHERE id = ?')
      .run('oauth', server.id);
    harness.context.registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'survivor',
      description: 'Use anyway.',
      body: 'Still here.',
    });
    const refresh = vi
      .spyOn(harness.context.mcpOAuth, 'refreshIfExpiring')
      .mockRejectedValue(new Error('the token endpoint is down'));

    await prepare();

    expect(refresh).toHaveBeenCalled();
    expect(existsSync(skillFile('survivor'))).toBe(true);
    refresh.mockRestore();
  });
});
