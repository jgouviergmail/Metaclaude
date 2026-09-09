/**
 * An event trigger's `automations` survives the trip through the routes, and
 * the family propagation leaves it behind.
 *
 * Two traps from CLAUDE.md meet here, and only an end-to-end test sees either.
 *
 * The first is the edge schema: `scheduler.test.ts` proves the scheduler
 * stores and acts on sources, which is true and beside the point if the route
 * strips them before it ever gets there. `routes/registry.ts` validates with
 * the shared `AutomationTrigger`, so it should not — and "should not" is what
 * `notify` had going for it too, for a release.
 *
 * The second is propagation. A patch carrying a trigger is carried to the
 * family's other copies, which live in other workspaces by construction, where
 * those source ids do not exist. Before `sharedFields` learned to drop such a
 * trigger, saving a watcher that belonged to a family stored the original and
 * then failed on the copy — a 404 about an automation the operator never
 * named, after a write that had already landed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Automation, Workspace } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let alpha: Workspace;
let beta: Workspace;

const workspace = async (slug: string): Promise<Workspace> => {
  const response = await server.send('POST', '/api/workspaces', {
    name: slug,
    slug,
    description: 'A workspace',
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { workspace: Workspace }).workspace;
};

const create = async (
  workspaceId: string,
  name: string,
  trigger: unknown,
): Promise<Automation> => {
  const response = await server.send('POST', '/api/automations', {
    workspaceId,
    name,
    prompt: 'Do the thing.',
    trigger,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { automation: Automation }).automation;
};

beforeAll(async () => {
  server = await bootTestServer({ name: 'automation-sources' });
  alpha = await workspace('alpha');
  beta = await workspace('beta');
});

afterAll(async () => {
  await server?.close();
});

describe('an event trigger’s sources over HTTP', () => {
  it('accepts them on creation and hands them back', async () => {
    const source = await create(alpha.id, 'Tests', { type: 'manual' });
    const watcher = await create(alpha.id, 'Deploy', {
      type: 'event',
      event: 'run_succeeded',
      automations: [source.id],
    });

    expect(watcher.trigger).toEqual({
      type: 'event',
      event: 'run_succeeded',
      automations: [source.id],
    });

    // And on the way back out of the store, not only in the create response.
    const listed = await server.get<{ automations: Automation[] }>(
      `/api/automations?workspaceId=${alpha.id}`,
    );
    expect(listed.automations.find((entry) => entry.id === watcher.id)?.trigger).toEqual(
      watcher.trigger,
    );
  });

  /**
   * A source that is not there is a bad *body*, not a missing resource.
   *
   * 404 on a PATCH says the thing in the URL is gone, and the client would
   * report the automation being edited as deleted — about a row that is right
   * there, over an id it never showed. The same answer covers "no such
   * automation" and "it lives in another workspace", deliberately: they mean
   * the same thing here, and telling them apart would confirm ids across a
   * boundary this screen does not cross.
   */
  it('refuses an unknown source as a bad request, not as a missing automation', async () => {
    const watcher = await create(alpha.id, 'Reporter', { type: 'manual' });
    const abroad = await create(beta.id, 'Elsewhere', { type: 'manual' });

    for (const id of ['aut_nothing', abroad.id]) {
      const response = await server.send('PATCH', `/api/automations/${watcher.id}`, {
        trigger: { type: 'event', event: 'run_failed', automations: [id] },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /workspace has no automation/,
      );
    }

    // And the automation itself is untouched — the refusal is not a write.
    const listed = await server.get<{ automations: Automation[] }>(
      `/api/automations?workspaceId=${alpha.id}`,
    );
    expect(listed.automations.find((entry) => entry.id === watcher.id)?.trigger).toEqual({
      type: 'manual',
    });
  });

  it('refuses a loop with the status the client can act on', async () => {
    const first = await create(alpha.id, 'First', { type: 'manual' });
    const second = await create(alpha.id, 'Second', {
      type: 'event',
      event: 'run_succeeded',
      automations: [first.id],
    });

    const response = await server.send('PATCH', `/api/automations/${first.id}`, {
      trigger: { type: 'event', event: 'run_succeeded', automations: [second.id] },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/would loop/);
  });

  it('refuses to duplicate one, and says why rather than naming a missing id', async () => {
    const source = await create(alpha.id, 'Build', { type: 'manual' });
    const watcher = await create(alpha.id, 'Publish', {
      type: 'event',
      event: 'run_succeeded',
      automations: [source.id],
    });

    const response = await server.send('POST', `/api/automations/${watcher.id}/duplicate`, {
      workspaceId: beta.id,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /watches automations of its own workspace/,
    );
  });

  /**
   * The copy keeps its own trigger and the save still succeeds. Anything else
   * makes a family a trap: the operator edits the prompt of a watcher that
   * happens to have a copy, and the request fails on a field they did not
   * touch in a workspace they were not looking at.
   */
  it('carries a patch to the copies without carrying the sources', async () => {
    const original = await create(alpha.id, 'Nightly', { type: 'cron', expression: '0 3 * * *' });
    const duplicated = await server.send('POST', `/api/automations/${original.id}/duplicate`, {
      workspaceId: beta.id,
    });
    expect(duplicated.status).toBe(201);
    const copy = ((await duplicated.json()) as { automation: Automation }).automation;

    const source = await create(alpha.id, 'Upstream', { type: 'manual' });
    const response = await server.send('PATCH', `/api/automations/${original.id}`, {
      prompt: 'Read the upstream result.',
      trigger: { type: 'event', event: 'run_succeeded', automations: [source.id] },
      propagateTo: [copy.id],
    });
    expect(response.status).toBe(200);
    const patched = ((await response.json()) as { automation: Automation }).automation;
    expect(patched.trigger).toEqual({
      type: 'event',
      event: 'run_succeeded',
      automations: [source.id],
    });

    const listed = await server.get<{ automations: Automation[] }>(
      `/api/automations?workspaceId=${beta.id}`,
    );
    const sibling = listed.automations.find((entry) => entry.id === copy.id);
    // The prompt travelled, the trigger stayed home.
    expect(sibling?.prompt).toBe('Read the upstream result.');
    expect(sibling?.trigger).toEqual({ type: 'cron', expression: '0 3 * * *' });
  });

  it('prunes a deleted source, and the watcher says it watches nothing', async () => {
    const source = await create(alpha.id, 'Doomed', { type: 'manual' });
    const watcher = await create(alpha.id, 'Watcher', {
      type: 'event',
      event: 'run_failed',
      automations: [source.id],
    });

    const deleted = await server.send('DELETE', `/api/automations/${source.id}`);
    expect(deleted.status).toBe(200);
    await deleted.arrayBuffer();

    const listed = await server.get<{ automations: Automation[] }>(
      `/api/automations?workspaceId=${alpha.id}`,
    );
    expect(listed.automations.find((entry) => entry.id === watcher.id)?.trigger).toEqual({
      type: 'event',
      event: 'run_failed',
      automations: [],
    });
  });
});
