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
