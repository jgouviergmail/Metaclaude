/**
 * Installing a proposed skill, through the route an operator's click reaches.
 *
 * The proposal is written by a model and the registry's naming rule is not:
 * `upsertSkill` takes lowercase letters, digits and dashes, and a model asked
 * for a skill name answers `collaborate_with_reviewers` as readily as the
 * dashed spelling. That was refused at *install* — after the proposal had been
 * drafted, shown and approved — so the one screen offering the button offered
 * no way to fix what it complained about.
 *
 * Tested here rather than on `toSkillName` alone for the reason the edge-schema
 * trap keeps teaching: the unit was never the thing that refused. The route is.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultWorkspaceSettings } from '../kernel/repositories.js';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';

let server: ServerHarness;
let workspaceId: string;

beforeAll(async () => {
  server = await bootTestServer({ name: 'insight-install-skill' });
  workspaceId = server.context.workspaceRepo.create({
    name: 'Install', slug: 'install', description: '', path: '/tmp/metaclaude-install',
    color: '#000000', icon: 'folder', settings: defaultWorkspaceSettings(),
  }).id;
});

afterAll(async () => {
  await server?.close();
});

/** File a skill proposal the way the reflexion and synthesis passes do. */
function propose(name: string): string {
  server.context.reflexion.recordInsight({
    workspaceId,
    runId: null,
    kind: 'skill_proposal',
    title: `Proposed skill: ${name}`,
    body: 'Ce que la skill fait.',
    confidence: 0.6,
    payload: JSON.stringify({ name, description: 'Une description.', body: '# Étapes' }),
  });
  return server.context.db
    .prepare<[], { id: string }>('SELECT id FROM insights ORDER BY rowid DESC LIMIT 1')
    .get()!.id;
}

describe('POST /api/insights/:id/install-skill', () => {
  it('installs a proposal whose name the registry already accepts', async () => {
    const id = propose('revue-de-migration');
    const response = await server.send('POST', `/api/insights/${id}/install-skill`);

    expect(response.status).toBe(201);
    const { skill } = (await response.json()) as { skill: Record<string, unknown> };
    expect(skill.name).toBe('revue-de-migration');
    // Scoped to the workspace it was learned in, and enabled: a skill the
    // operator installed on purpose is one runs should see.
    expect(skill.workspaceId).toBe(workspaceId);
    expect(skill.enabled).toBe(true);
  });

  it('installs one whose name the model spelled with underscores', async () => {
    const id = propose('collaborate_with_reviewers');
    const response = await server.send('POST', `/api/insights/${id}/install-skill`);

    expect(response.status).toBe(201);
    const { skill } = (await response.json()) as { skill: Record<string, unknown> };
    expect(skill.name).toBe('collaborate-with-reviewers');
  });

  it('marks the proposal applied, which is how it stops being a decision', async () => {
    const id = propose('notes-de-version');
    expect((await server.send('POST', `/api/insights/${id}/install-skill`)).status).toBe(201);

    const row = server.context.db
      .prepare<[string], { status: string }>('SELECT status FROM insights WHERE id = ?')
      .get(id);
    expect(row?.status).toBe('applied');
  });

  it('refuses a name nothing usable survives, rather than inventing one', async () => {
    const id = propose('!!! ???');
    const response = await server.send('POST', `/api/insights/${id}/install-skill`);

    expect(response.status).toBe(422);
    // And the proposal stays where it was, so the operator can still see it.
    const row = server.context.db
      .prepare<[string], { status: string }>('SELECT status FROM insights WHERE id = ?')
      .get(id);
    expect(row?.status).toBe('new');
  });
});
