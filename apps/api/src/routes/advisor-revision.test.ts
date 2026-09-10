/**
 * A revision through the edge.
 *
 * The service's own tests already pin what it decides; these exist because a
 * contract in `packages/shared` decides what may be *submitted*, and a feature
 * can be dead at the edge while every test below it stays green — the recovery
 * codes that `LoginRequest` rejected before the verifier ever saw them. So the
 * status codes, the audit lines and the guards are exercised against the real
 * server, and every response body is drained: a case that reads a status and
 * leaves the body unread holds the socket, and `app.close()` then waits its
 * full timeout and reports a hung server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionPayload } from '@metaclaude/shared';
import { bootTestServer, type ServerHarness } from '../test/server-harness.js';
import { defaultWorkspaceSettings, WorkspaceRepo } from '../kernel/repositories.js';

let harness: ServerHarness;
let workspaceId: string;

beforeEach(async () => {
  harness = await bootTestServer({ name: 'advisor-revision' });
  const created = await harness.send('POST', '/api/workspaces', {
    name: 'Alpha',
    description: 'bench',
  });
  workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
  await harness.send('PATCH', `/api/workspaces/${workspaceId}`, {
    settings: { systemPromptAppend: 'Always answer in French.' },
  });
});

afterEach(async () => {
  await harness.close();
});

const propose = (after: string) =>
  harness.context.advisor.proposeRevision({
    workspaceId,
    runId: null,
    target: { kind: 'workspace', id: workspaceId, name: 'Alpha', workspaceId },
    field: 'systemPromptAppend',
    after,
    rationale: 'Four runs stated a version without saying where it came from.',
  });

const settings = async () => {
  const body = await harness.get<{ workspaces: Array<{ id: string; settings: { systemPromptAppend: string } }> }>(
    '/api/workspaces',
  );
  return body.workspaces.find((entry) => entry.id === workspaceId)?.settings;
};

describe('the revision routes', () => {
  it('lists a pending revision with the diff the card will draw', async () => {
    propose('Always answer in French.\nCite what you read.');

    const body = await harness.get<{ proposals: Array<{ kind: string; payload: unknown }> }>(
      `/api/advisor/proposals?workspaceId=${workspaceId}`,
    );
    const [proposal] = body.proposals;
    expect(proposal?.kind).toBe('revision');
    const payload = RevisionPayload.parse(proposal?.payload);
    expect(payload.diff).toContain('+Cite what you read.');
    expect(payload.before).toBe('Always answer in French.');
  });

  it('applies it on accept and records who did it', async () => {
    const proposal = propose('Always answer in French.\nCite what you read.');

    const response = await harness.send('POST', `/api/advisor/proposals/${proposal.id}/accept`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();

    expect((await settings())?.systemPromptAppend).toBe('Always answer in French.\nCite what you read.');
    expect(
      harness.context.audit.list({ limit: 50 }).some((entry) => entry.action === 'advisor.accept'),
    ).toBe(true);
  });

  it('answers 409 when the text moved between proposing and accepting', async () => {
    const proposal = propose('Always answer in French.\nCite what you read.');
    await harness.send('PATCH', `/api/workspaces/${workspaceId}`, {
      settings: { systemPromptAppend: 'Answer in English.' },
    });

    const response = await harness.send('POST', `/api/advisor/proposals/${proposal.id}/accept`);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toMatch(/changed since/i);
    expect((await settings())?.systemPromptAppend).toBe('Answer in English.');
  });

  it('takes an applied revision back', async () => {
    const proposal = propose('Always answer in French.\nCite what you read.');
    await (await harness.send('POST', `/api/advisor/proposals/${proposal.id}/accept`)).arrayBuffer();

    const response = await harness.send('POST', `/api/advisor/proposals/${proposal.id}/revert`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();

    expect((await settings())?.systemPromptAppend).toBe('Always answer in French.');
    expect(
      harness.context.audit.list({ limit: 50 }).some((entry) => entry.action === 'advisor.revert'),
    ).toBe(true);
  });

  it('refuses to take back a revision that was never applied', async () => {
    const proposal = propose('Always answer in French.\nCite what you read.');

    const response = await harness.send('POST', `/api/advisor/proposals/${proposal.id}/revert`);
    expect(response.status).toBe(409);
    await response.arrayBuffer();
  });

  it('answers 404 for a revert of nothing', async () => {
    const response = await harness.send('POST', '/api/advisor/proposals/prop_nope/revert');
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });

  /**
   * The Dashboard's second list. Without a status filter an applied revision
   * would be unreachable from the interface the moment it was accepted, and
   * `revert` would be a route with no button.
   */
  it('lists applied revisions so they can be taken back', async () => {
    const proposal = propose('Always answer in French.\nCite what you read.');
    await (await harness.send('POST', `/api/advisor/proposals/${proposal.id}/accept`)).arrayBuffer();

    const pending = await harness.get<{ proposals: unknown[] }>(
      `/api/advisor/proposals?workspaceId=${workspaceId}`,
    );
    expect(pending.proposals).toHaveLength(0);

    const applied = await harness.get<{ proposals: Array<{ id: string }> }>(
      `/api/advisor/proposals?workspaceId=${workspaceId}&status=accepted`,
    );
    expect(applied.proposals.map((entry) => entry.id)).toEqual([proposal.id]);
  });

  it('ignores a status it does not know rather than answering everything', async () => {
    propose('Always answer in French.\nCite what you read.');

    const body = await harness.get<{ proposals: unknown[] }>(
      `/api/advisor/proposals?workspaceId=${workspaceId}&status=nonsense`,
    );
    expect(body.proposals).toHaveLength(1);
  });
});

/**
 * The system workspace's fixed settings are fixed against a revision too.
 *
 * Nothing about a proposal having come from a machine lowers that bar, and a
 * revision writes through the same repository the settings form does — so the
 * guard has to be on the write, not on the form.
 */
describe('a revision of the system workspace', () => {
  it('may rewrite its instructions, which are not a safety setting', async () => {
    const systemId = harness.context.systemWorkspace.id();
    expect(systemId).toBeTruthy();

    const proposal = harness.context.advisor.proposeRevision({
      workspaceId: systemId as string,
      runId: null,
      target: { kind: 'workspace', id: systemId as string, name: 'Metaclaude', workspaceId: systemId },
      field: 'systemPromptAppend',
      after: 'Cite the tool you read something from.',
      rationale: 'r',
    });

    const response = await harness.send('POST', `/api/advisor/proposals/${proposal.id}/accept`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });
});

/**
 * Asking for a review by hand.
 *
 * The pass is a button as well as a schedule, and the button waives the weekly
 * clock and the opt-in — those exist to stop the machine asking unprompted,
 * not to stop a person asking. What it cannot waive is the floor.
 */
describe('the review route', () => {
  const seedRuns = async (count: number) => {
    const { db } = harness.context;
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
       VALUES ('ses_r', ?, 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
    ).run(workspaceId);
    const day = 86_400_000;
    for (let index = 0; index < count; index += 1) {
      db.prepare(
        `INSERT INTO runs (id, session_id, workspace_id, prompt, status, triggered_by, usage, started_at, finished_at)
         VALUES (?, 'ses_r', ?, 'p', 'succeeded', 'user', '{"turns":2}', ?, ?)`,
      ).run(`run_r_${index}`, workspaceId, Date.now() - (count - index) * day, Date.now() - (count - index) * day);
    }
  };

  it('refuses to start on a window with almost nothing in it, and says so', async () => {
    await seedRuns(2);

    const response = await harness.send('POST', `/api/workspaces/${workspaceId}/review-instructions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ started: false, reason: 'too-few-runs' });
  });

  it('starts, and answers before the pass has finished', async () => {
    await seedRuns(12);
    // The arbiter would spawn a CLI; the route must never be the thing that
    // does. Stubbed on the instance, the way the harness prescribes.
    const spy = vi
      .spyOn(harness.context.improvement, 'review')
      .mockResolvedValue({ status: 'reviewed', runsExamined: 12, proposed: 0, reviewId: 'rvw_1' });

    const response = await harness.send('POST', `/api/workspaces/${workspaceId}/review-instructions`);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ started: true });
    expect(spy).toHaveBeenCalledWith(workspaceId, { force: true });
  });

  it('lists the reviews, including one that found nothing', async () => {
    harness.context.db
      .prepare(
        `INSERT INTO revision_reviews (id, workspace_id, at, window_from, window_to, runs_examined, proposed)
         VALUES ('rvw_1', ?, ?, 0, 1, 9, 0)`,
      )
      .run(workspaceId, Date.now());

    const body = await harness.get<{ reviews: Array<{ id: string; proposed: number }> }>(
      `/api/workspaces/${workspaceId}/revision-reviews`,
    );
    expect(body.reviews).toEqual([expect.objectContaining({ id: 'rvw_1', proposed: 0 })]);
  });

  /*
   * One review at a time — per workspace, and only per workspace.
   *
   * The reviewer already refuses a second pass over the same workspace, and
   * says in its own source that the guard lives there because the route is
   * only one of two doors. A second, coarser lock at the route answered 409
   * for *every* workspace while any one of them was being reviewed: two
   * workspaces read disjoint runs and propose against disjoint texts, so there
   * was nothing to protect and a pass an operator asked for was refused.
   */
  it('refuses a second review of the same workspace', async () => {
    await seedRuns(12);
    vi.spyOn(harness.context.improvement, 'busy').mockReturnValue(true);

    const response = await harness.send('POST', `/api/workspaces/${workspaceId}/review-instructions`);
    expect(response.status).toBe(409);
    await response.arrayBuffer();
  });

  it('lets another workspace be reviewed while this one is running', async () => {
    await seedRuns(12);
    // The repository, not the service: the service creates a directory and a
    // CLAUDE.md, and this case is about routing rather than about the disk.
    const other = new WorkspaceRepo(harness.context.db).create({
      name: 'Beta',
      slug: 'beta-review',
      description: 'Another project',
      path: '/tmp/beta-review',
      color: '#ef4444',
      icon: 'folder',
      settings: defaultWorkspaceSettings(),
    });
    const { db } = harness.context;
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
       VALUES ('ses_b', ?, 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
    ).run(other.id);
    const day = 86_400_000;
    for (let index = 0; index < 12; index += 1) {
      db.prepare(
        `INSERT INTO runs (id, session_id, workspace_id, prompt, status, triggered_by, usage, started_at, finished_at)
         VALUES (?, 'ses_b', ?, 'p', 'succeeded', 'user', '{"turns":2}', ?, ?)`,
      ).run(`run_b_${index}`, other.id, Date.now() - (12 - index) * day, Date.now() - (12 - index) * day);
    }

    // This one is busy; the other is not, and must not be refused for it.
    const busy = vi
      .spyOn(harness.context.improvement, 'busy')
      .mockImplementation((id: string) => id === workspaceId);
    const review = vi
      .spyOn(harness.context.improvement, 'review')
      .mockResolvedValue({ status: 'reviewed', runsExamined: 12, proposed: 0, reviewId: 'rvw_2' });

    const response = await harness.send('POST', `/api/workspaces/${other.id}/review-instructions`);
    expect(response.status).toBe(202);
    await response.arrayBuffer();
    expect(review).toHaveBeenCalledWith(other.id, { force: true });
    // And it asked about *this* workspace and nothing else. Without this the
    // case would pass against a route holding one global flag, which is the
    // defect it was written for: a flag starts false, so a single request gets
    // its 202 either way.
    expect(busy.mock.calls).toEqual([[other.id]]);
  });

  it('answers 404 for a workspace that does not exist', async () => {
    const response = await harness.send('POST', '/api/workspaces/ws_nope/review-instructions');
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });
});
