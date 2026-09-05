/**
 * The morning brief — one page answering "what happened, what needs me".
 *
 * The database is real; the doctor and the quota are injected, because the
 * brief's job is composition and judgement, not re-testing its sources. The
 * property that matters most: a source that cannot answer (the quota, most
 * likely) costs its section, never the brief.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeUsage, DoctorReport } from '@metaclaude/shared';
import { AnalyticsService } from './analytics.js';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { BriefService, type BriefDeps } from './brief.js';

let db: Db;

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

const healthyDoctor: DoctorReport = {
  status: 'ok',
  checks: [],
  version: '0.1.0',
  ranAt: NOW,
};

const quota: ClaudeUsage = {
  subscriptionType: 'max',
  windows: [{ key: 'seven_day', label: 'Week — all models', utilization: 61, resetsAt: null }],
  extraUsage: null,
  behaviors: null,
  unavailable: [],
  fetchedAt: NOW,
};

function seedWorkspace(id: string, name: string) {
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, '#6366f1', 'folder', '{}', 0, 0)`,
  ).run(id, name, name.toLowerCase(), `/srv/metaclaude/workspaces/${name.toLowerCase()}`);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at, model, permission_mode)
     VALUES (?, ?, 0, 0, 0, 'default', 'default')`,
  ).run(`ses_${id}`, id);
}

function seedRun(id: string, workspaceId: string, status: string, at: number, error: string | null = null) {
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `ses_${workspaceId}`, workspaceId, `prompt for ${id}`, status, error, at, at + 1000);
}

function makeService(overrides: Partial<BriefDeps> = {}) {
  return new BriefService({
    db,
    analytics: new AnalyticsService(db),
    doctor: { run: async () => healthyDoctor },
    usage: async () => quota,
    pendingApprovals: () => 0,
    now: () => NOW,
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  seedWorkspace('ws_1', 'Alpha');
});

afterEach(() => db.close());

describe('composition', () => {
  it('covers the last 24 hours and carries every section', async () => {
    seedRun('run_1', 'ws_1', 'succeeded', NOW - 2 * HOUR);
    seedRun('run_2', 'ws_1', 'failed', NOW - 3 * HOUR, 'the build broke');
    seedRun('run_old', 'ws_1', 'failed', NOW - 30 * HOUR, 'yesterday problem');

    const brief = await makeService().generate();

    expect(brief.since).toBe(NOW - 24 * HOUR);
    expect(brief.activity.totalRuns).toBe(2);
    expect(brief.failures).toHaveLength(1);
    expect(brief.failures[0]).toMatchObject({
      runId: 'run_2',
      workspaceName: 'Alpha',
      error: 'the build broke',
    });
    expect(brief.doctor.status).toBe('ok');
    expect(brief.quota?.windows[0]?.utilization).toBe(61);
  });

  it('names the silently-disabled automations and the next scheduled one', async () => {
    db.prepare(
      `INSERT INTO automations (id, workspace_id, name, prompt, trigger, max_consecutive_failures,
                                consecutive_failures, enabled, next_run_at, created_at, updated_at)
       VALUES ('aut_1', 'ws_1', 'runaway', 'p', '{}', 3, 3, 0, NULL, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO automations (id, workspace_id, name, prompt, trigger, enabled, next_run_at, created_at, updated_at)
       VALUES ('aut_2', 'ws_1', 'nightly', 'p', '{}', 1, ?, 0, 0)`,
    ).run(NOW + HOUR);

    const brief = await makeService().generate();

    expect(brief.automations.disabledByGuard).toEqual(['runaway']);
    expect(brief.automations.nextRun).toEqual({ name: 'nightly', at: NOW + HOUR });
  });

  it('counts the insights the period added, not the all-time pile', async () => {
    db.prepare(
      `INSERT INTO insights (id, workspace_id, kind, title, body, created_at)
       VALUES ('ins_1', 'ws_1', 'lesson', 't', 'b', ?)`,
    ).run(NOW - HOUR);
    db.prepare(
      `INSERT INTO insights (id, workspace_id, kind, title, body, created_at)
       VALUES ('ins_2', 'ws_1', 'lesson', 't', 'b', ?)`,
    ).run(NOW - 48 * HOUR);

    const brief = await makeService().generate();
    expect(brief.newInsights).toBe(1);
  });

  /**
   * "New insights" is a number an operator reads as "things waiting for me".
   * One already triaged is not, and the consolidation pass files its "these
   * are distinct" answers pre-rejected — bookkeeping that stops it paying to
   * ask the same question on every sweep, and that no screen ever shows. A
   * plain `COUNT(*)` had the brief announce a dozen new insights after a sweep
   * that produced nothing to read.
   */
  it('counts only what is still waiting on a person', async () => {
    const insert = db.prepare(
      `INSERT INTO insights (id, workspace_id, kind, title, body, status, created_at)
       VALUES (?, 'ws_1', ?, 't', 'b', ?, ?)`,
    );
    insert.run('ins_new', 'lesson', 'new', NOW - HOUR);
    insert.run('ins_marker', 'consolidation', 'rejected', NOW - HOUR);
    insert.run('ins_done', 'skill_proposal', 'applied', NOW - HOUR);
    insert.run('ins_seen', 'lesson', 'accepted', NOW - HOUR);

    const brief = await makeService().generate();
    expect(brief.newInsights).toBe(1);
  });
});

describe('the board section', () => {
  const seedTask = (id: string, over: Record<string, unknown> = {}) => {
    const row = {
      status: 'todo',
      blocked_reason: null,
      run_id: null,
      due_at: null,
      archived_at: null,
      ...over,
    };
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, order_key, blocked_reason, run_id, due_at,
                          archived_at, created_by, created_at, updated_at)
       VALUES (?, 'ws_1', ?, ?, 'i', ?, ?, ?, ?, 'user:jules', 0, 0)`,
    ).run(id, id, row.status, row.blocked_reason, row.run_id, row.due_at, row.archived_at);
  };

  it('counts review, blocked, in-flight and due-soon cards — active ones only', async () => {
    seedRun('run_live', 'ws_1', 'running', NOW - HOUR);
    seedRun('run_dead', 'ws_1', 'failed', NOW - HOUR);
    seedTask('tsk_review', { status: 'review' });
    seedTask('tsk_blocked', { blocked_reason: 'stuck' });
    seedTask('tsk_live', { status: 'in_progress', run_id: 'run_live' });
    seedTask('tsk_settled', { status: 'in_progress', run_id: 'run_dead' });
    seedTask('tsk_due', { due_at: NOW + 24 * HOUR });
    seedTask('tsk_due_far', { due_at: NOW + 200 * HOUR });
    seedTask('tsk_due_done', { status: 'done', due_at: NOW + HOUR });
    // Archived cards are off the board, whatever else they are.
    seedTask('tsk_ghost', { status: 'review', blocked_reason: 'stuck', archived_at: NOW });

    const brief = await makeService().generate();
    expect(brief.board).toEqual({ inReview: 1, blocked: 1, inFlight: 1, dueSoon: 1 });
  });

  it('review cards break the quiet-day headline', async () => {
    seedTask('tsk_review', { status: 'review' });
    const brief = await makeService().generate();
    expect(brief.headline).not.toMatch(/quiet/i);
    expect(brief.headline).toMatch(/review/);
  });
});

describe('the headline', () => {
  it('says what needs attention when something does', async () => {
    seedRun('run_2', 'ws_1', 'failed', NOW - HOUR, 'boom');
    const brief = await makeService({ pendingApprovals: () => 2 }).generate();

    expect(brief.headline).toMatch(/1 failure/);
    expect(brief.headline).toMatch(/2 approvals waiting/);
  });

  it('says all quiet when nothing happened', async () => {
    const brief = await makeService().generate();
    expect(brief.headline).toMatch(/quiet|no runs/i);
  });
});

describe('resilience', () => {
  it('stands without the quota when the CLI cannot answer', async () => {
    seedRun('run_1', 'ws_1', 'succeeded', NOW - HOUR);
    const brief = await makeService({
      usage: async () => {
        throw new Error('spawn claude ENOENT');
      },
    }).generate();

    expect(brief.quota).toBeNull();
    expect(brief.activity.totalRuns).toBe(1);
  });
});
