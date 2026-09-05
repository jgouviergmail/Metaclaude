/**
 * Every field of an automation's policy survives the trip through the routes.
 *
 * Written because one did not. `routes/registry.ts` carried a hand-written
 * copy of the policy shape; the copy never gained `notify`, and Zod strips
 * what it does not declare — so the browser sent the checkbox, the edge threw
 * it away without a word, the automation ran silent, and the form went on
 * showing it as enabled until the page was reloaded. Same family as the edge
 * schema trap in CLAUDE.md: `scheduler.test.ts` proved the scheduler stores a
 * policy it is handed, which was true and beside the point.
 *
 * The guard against the next one is structural rather than a list: the sample
 * below must name every key of `AutomationPolicy`, and the test fails if it
 * does not. A field added to the policy is therefore covered on the day it is
 * added, or the suite says so.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationPolicy, type Automation, type Workspace } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let workspace: Workspace;

/** A value per field, each different from that field's default. */
const SAMPLE: Record<keyof AutomationPolicy, unknown> = {
  model: 'opus',
  effort: 'high',
  permissionMode: 'plan',
  agentName: 'reviewer',
  maxTurns: 12,
  notify: true,
};

beforeAll(async () => {
  server = await bootTestServer({ name: 'automation-policy' });
  const created = await server.send('POST', '/api/workspaces', {
    name: 'Policy',
    slug: 'policy',
    description: 'A workspace',
  });
  expect(created.status).toBe(201);
  workspace = ((await created.json()) as { workspace: Workspace }).workspace;
});

afterAll(async () => {
  await server?.close();
});

const create = async (policy: Record<string, unknown>): Promise<Automation> => {
  const response = await server.send('POST', '/api/automations', {
    workspaceId: workspace.id,
    name: 'Morning review',
    prompt: 'Review the night.',
    trigger: { type: 'cron', expression: '0 8 * * *' },
    policy,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { automation: Automation }).automation;
};

describe('an automation’s policy over HTTP', () => {
  it('is sampled here in full — a new field fails this before it can be dropped', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(Object.keys(AutomationPolicy.shape).sort());
  });

  it('carries every field through creation', async () => {
    const automation = await create(SAMPLE);
    expect(automation.policy).toEqual(SAMPLE);
  });

  it('carries every field through a patch, one at a time, leaving the rest alone', async () => {
    const automation = await create(AutomationPolicy.parse({}));
    // Nothing was asked for, so everything is at its default — including the
    // field this test exists for.
    expect(automation.policy.notify).toBe(false);

    for (const [field, value] of Object.entries(SAMPLE)) {
      const response = await server.send('PATCH', `/api/automations/${automation.id}`, {
        policy: { [field]: value },
      });
      expect(response.status).toBe(200);
      const patched = ((await response.json()) as { automation: Automation }).automation;
      expect(patched.policy[field as keyof AutomationPolicy]).toEqual(value);
    }

    // Every one of them stood: a patch merges into the stored policy rather
    // than replacing it, so the last field written must not be the only one.
    const final = await server.get<{ automations: Automation[] }>(
      `/api/automations?workspaceId=${workspace.id}`,
    );
    const stored = final.automations.find((entry) => entry.id === automation.id);
    expect(stored?.policy).toEqual(SAMPLE);
  });

  it('refuses a value the shared schema refuses, rather than storing it', async () => {
    const response = await server.send('POST', '/api/automations', {
      workspaceId: workspace.id,
      name: 'Bad',
      prompt: 'x',
      trigger: { type: 'manual' },
      policy: { maxTurns: 0 },
    });
    expect(response.status).toBe(400);
  });
});
