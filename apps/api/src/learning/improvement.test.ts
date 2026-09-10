/**
 * The evidence half of loop four: what a window holds, and what counts as a
 * recurrence.
 *
 * Every threshold is tested from both sides — once at the number, once one
 * below it — because a threshold no test ever reaches is a feature that does
 * not exist, and this file is full of them. The lesson was paid for by
 * `remember`'s 0.92 merge: four passing tests, all on byte-identical text, and
 * the highest similarity any real pair of memories reached was 0.51.
 */

import type { RevisionReview } from '@metaclaude/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { recordExtensionUsage } from './extension-usage.js';
import {
  buildWindow,
  lastReview,
  listReviews,
  observe,
  pruneReviews,
  recordReview,
  reviewCursor,
  reviewDue,
  INSTRUCTIONS_MAX,
  OBSERVATION_MIN_DAYS,
  OBSERVATION_MIN_RUNS,
  REVIEW_MIN_DAYS,
  REVIEW_MIN_RUNS,
  UNUSED_MIN_RUNS,
  WINDOW_MAX_RUNS,
} from './improvement.js';

let db: Db;
const DAY = 86_400_000;
const START = 1_700_000_000_000;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, path, color, icon, archived, settings, created_at, updated_at)
     VALUES ('ws_1', 'Alpha', 'alpha', '/tmp/a', '#000000', 'folder', 0, '{}', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
     VALUES ('ses_1', 'ws_1', 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
  ).run();
});

interface RunSpec {
  id: string;
  at?: number;
  status?: string;
  prompt?: string;
  error?: string | null;
  turns?: number;
  sessionId?: string;
  triggeredBy?: string;
}

function seedRun(spec: RunSpec): string {
  const sessionId = spec.sessionId ?? 'ses_1';
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
     VALUES (?, 'ws_1', 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
  ).run(sessionId);
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, triggered_by, usage, started_at, finished_at, error)
     VALUES (?, ?, 'ws_1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spec.id,
    sessionId,
    spec.prompt ?? 'Do the thing',
    spec.status ?? 'succeeded',
    spec.triggeredBy ?? 'user',
    JSON.stringify({ turns: spec.turns ?? 3, costUsd: 0.01, durationMs: 1000 }),
    spec.at ?? START,
    spec.at ?? START,
    spec.error ?? null,
  );
  return spec.id;
}

let seq = 0;
function seedToolCall(runId: string, name: string, isError = false): void {
  seq += 1;
  db.prepare(
    `INSERT INTO transcript_events (id, run_id, session_id, seq, kind, at, payload)
     VALUES (?, ?, 'ses_1', ?, 'tool_call', ?, ?)`,
  ).run(
    `ev_${seq}`,
    runId,
    seq,
    START,
    JSON.stringify({
      kind: 'tool_call',
      id: `ev_${seq}`,
      runId,
      seq,
      at: START,
      toolUseId: `tu_${seq}`,
      name,
      input: {},
      status: isError ? 'error' : 'ok',
      result: null,
      resultIsError: isError,
      durationMs: null,
    }),
  );
}

function seedAnswer(runId: string, text: string): void {
  seq += 1;
  db.prepare(
    `INSERT INTO transcript_events (id, run_id, session_id, seq, kind, at, payload)
     VALUES (?, ?, 'ses_1', ?, 'assistant_text', ?, ?)`,
  ).run(
    `ev_${seq}`,
    runId,
    seq,
    START,
    JSON.stringify({ kind: 'assistant_text', id: `ev_${seq}`, runId, seq, at: START, text, streaming: false }),
  );
}

const offer = (runId: string, over: Partial<{ kind: 'skill' | 'agent'; id: string; name: string; invoked: number; failed: number }> = {}) =>
  recordExtensionUsage(db, runId, [
    {
      kind: over.kind ?? 'skill',
      extensionId: over.id ?? 'skl_1',
      name: over.name ?? 'review-migrations',
      available: true,
      invoked: over.invoked ?? 0,
      failed: over.failed ?? 0,
    },
  ]);

const window = (since = 0) => buildWindow(db, 'ws_1', { since, until: START + 100 * DAY });

/* -------------------------------------------------------------------------- */

describe('buildWindow', () => {
  it('is empty for a workspace that has done nothing', () => {
    expect(window().runs).toEqual([]);
  });

  it('carries a run with its prompt, answer, tools and extensions', () => {
    seedRun({ id: 'run_1' });
    seedToolCall('run_1', 'Read');
    seedToolCall('run_1', 'Read', true);
    seedAnswer('run_1', 'Here is the answer.');
    offer('run_1', { invoked: 1 });

    const [run] = window().runs;
    expect(run).toMatchObject({
      id: 'run_1',
      status: 'succeeded',
      prompt: 'Do the thing',
      answer: 'Here is the answer.',
    });
    expect(run?.tools).toEqual([{ name: 'Read', calls: 2, errors: 1 }]);
    expect(run?.extensions).toEqual([
      { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', available: true, invoked: 1, failed: 0 },
    ]);
  });

  /**
   * Oldest first, because a window is a story: an instruction changed halfway
   * through it should be read against the runs that followed.
   */
  it('reads oldest first', () => {
    seedRun({ id: 'run_old', at: START });
    seedRun({ id: 'run_new', at: START + DAY });

    expect(window().runs.map((run) => run.id)).toEqual(['run_old', 'run_new']);
  });

  /**
   * The cap keeps the newest, then re-orders. Taking the oldest would answer
   * with the start of a backlog and never reach what is happening now.
   */
  it('keeps the newest when the window is over the cap, still oldest first', () => {
    for (let index = 0; index < WINDOW_MAX_RUNS + 5; index += 1) {
      seedRun({ id: `run_${String(index).padStart(3, '0')}`, at: START + index * 1000 });
    }

    const result = window();
    expect(result.runs).toHaveLength(WINDOW_MAX_RUNS);
    expect(result.runs[0]?.id).toBe('run_005');
    expect(result.runs.at(-1)?.id).toBe('run_044');
    expect(result.omitted).toBe(5);
  });

  it('says nothing was omitted when nothing was', () => {
    seedRun({ id: 'run_1' });
    expect(window().omitted).toBe(0);
  });

  /**
   * An operator who stops a run has said nothing about the instructions — the
   * same reasoning that keeps the classifier from learning a category from
   * one, and that scores an interruption neutrally in the reward.
   */
  it('leaves interrupted runs out', () => {
    seedRun({ id: 'run_ok' });
    seedRun({ id: 'run_stopped', status: 'interrupted' });

    expect(window().runs.map((run) => run.id)).toEqual(['run_ok']);
  });

  it('keeps failed runs, which are the informative ones', () => {
    seedRun({ id: 'run_bad', status: 'failed', error: 'it broke' });

    expect(window().runs[0]).toMatchObject({ status: 'failed', error: 'it broke' });
  });

  it('starts after the cursor, never at it', () => {
    seedRun({ id: 'run_before', at: START });
    seedRun({ id: 'run_after', at: START + DAY });

    expect(buildWindow(db, 'ws_1', { since: START, until: START + 100 * DAY }).runs.map((r) => r.id)).toEqual([
      'run_after',
    ]);
  });

  it('reads one tool through its MCP prefix, whatever the server is called', () => {
    seedRun({ id: 'run_1' });
    seedToolCall('run_1', 'mcp__my_server__Read');
    seedToolCall('run_1', 'Read');

    expect(window().runs[0]?.tools).toEqual([{ name: 'Read', calls: 2, errors: 0 }]);
  });

  it('names the automation whose session a firing ran in', () => {
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
       VALUES ('ses_auto', 'ws_1', 'A', 'idle', 'sonnet', 'default', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO automations (id, workspace_id, name, prompt, trigger, session_id, enabled, run_count, created_at, updated_at)
       VALUES ('aut_1', 'ws_1', 'Morning', 'p', '{"type":"manual"}', 'ses_auto', 1, 0, 1, 1)`,
    ).run();
    seedRun({ id: 'run_auto', sessionId: 'ses_auto', triggeredBy: 'automation' });

    expect(window().runs[0]?.automationId).toBe('aut_1');
  });

  it('leaves another workspace’s runs alone', () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, color, icon, archived, settings, created_at, updated_at)
       VALUES ('ws_2', 'Beta', 'beta', '/tmp/b', '#000000', 'folder', 0, '{}', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
       VALUES ('ses_2', 'ws_2', 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, session_id, workspace_id, prompt, status, usage, started_at, finished_at)
       VALUES ('run_other', 'ses_2', 'ws_2', 'p', 'succeeded', '{}', ?, ?)`,
    ).run(START, START);
    seedRun({ id: 'run_mine' });

    expect(window().runs.map((run) => run.id)).toEqual(['run_mine']);
  });

  it('takes an answer that is still streaming as no answer at all', () => {
    seedRun({ id: 'run_1' });
    seq += 1;
    db.prepare(
      `INSERT INTO transcript_events (id, run_id, session_id, seq, kind, at, payload)
       VALUES (?, 'run_1', 'ses_1', ?, 'assistant_text', ?, ?)`,
    ).run(
      `ev_${seq}`,
      seq,
      START,
      JSON.stringify({ kind: 'assistant_text', id: `ev_${seq}`, runId: 'run_1', seq, at: START, text: 'half a thou', streaming: true }),
    );

    expect(window().runs[0]?.answer).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('observe: an extension nobody reaches for', () => {
  const offerAcross = (runs: number, days: number, invokedOnLast = 0) => {
    for (let index = 0; index < runs; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + Math.floor((index * days) / runs) * DAY });
      offer(id, { invoked: index === runs - 1 ? invokedOnLast : 0 });
    }
  };

  it('says nothing below the run threshold', () => {
    offerAcross(UNUSED_MIN_RUNS - 1, 3);

    expect(observe(window()).filter((f) => f.kind === 'unused-extension')).toEqual([]);
  });

  it('names it at the run threshold', () => {
    offerAcross(UNUSED_MIN_RUNS, 3);

    const [finding] = observe(window()).filter((f) => f.kind === 'unused-extension');
    expect(finding?.summary).toContain('review-migrations');
    expect(finding?.runIds.length).toBeGreaterThanOrEqual(OBSERVATION_MIN_RUNS);
  });

  /**
   * Enough runs but all in one day is an afternoon, not a habit — the half of
   * every threshold here that stops a busy Tuesday from rewriting anything.
   */
  it('says nothing when every run was the same day', () => {
    for (let index = 0; index < UNUSED_MIN_RUNS + 4; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * 1000 });
      offer(id);
    }

    expect(observe(window()).filter((f) => f.kind === 'unused-extension')).toEqual([]);
  });

  it('says nothing the moment one run reaches for it', () => {
    offerAcross(UNUSED_MIN_RUNS + 2, 3, 1);

    expect(observe(window()).filter((f) => f.kind === 'unused-extension')).toEqual([]);
  });

  /** An invocation the registry does not own has no row to revise. */
  it('ignores an extension with no registry id', () => {
    for (let index = 0; index < UNUSED_MIN_RUNS + 2; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      recordExtensionUsage(db, id, [
        { kind: 'skill', extensionId: null, name: 'pdf', available: false, invoked: 0, failed: 0 },
      ]);
    }

    expect(observe(window()).filter((f) => f.kind === 'unused-extension')).toEqual([]);
  });

  it('counts only the runs it was actually offered to', () => {
    for (let index = 0; index < UNUSED_MIN_RUNS + 2; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      recordExtensionUsage(db, id, [
        {
          kind: 'skill',
          extensionId: 'skl_1',
          name: 'review-migrations',
          available: index < UNUSED_MIN_RUNS - 1,
          invoked: 0,
          failed: 0,
        },
      ]);
    }

    expect(observe(window()).filter((f) => f.kind === 'unused-extension')).toEqual([]);
  });
});

describe('observe: a subagent that fails when it is used', () => {
  const failAcross = (runs: number, failed: number) => {
    for (let index = 0; index < runs; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      offer(id, { kind: 'agent', id: 'agt_1', name: 'reviewer', invoked: 1, failed: index < failed ? 1 : 0 });
    }
  };

  it('names one that fails more often than not', () => {
    failAcross(OBSERVATION_MIN_RUNS, OBSERVATION_MIN_RUNS);

    const [finding] = observe(window()).filter((f) => f.kind === 'extension-errors');
    expect(finding?.summary).toContain('reviewer');
  });

  it('says nothing when it usually works', () => {
    failAcross(4, 1);

    expect(observe(window()).filter((f) => f.kind === 'extension-errors')).toEqual([]);
  });

  it('says nothing below the run threshold', () => {
    failAcross(OBSERVATION_MIN_RUNS - 1, OBSERVATION_MIN_RUNS - 1);

    expect(observe(window()).filter((f) => f.kind === 'extension-errors')).toEqual([]);
  });

  it('says nothing when it never failed at all', () => {
    failAcross(5, 0);

    expect(observe(window()).filter((f) => f.kind === 'extension-errors')).toEqual([]);
  });
});

describe('observe: a tool that keeps going wrong', () => {
  it('names it once it has failed in enough runs on enough days', () => {
    for (let index = 0; index < OBSERVATION_MIN_RUNS; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      seedToolCall(id, 'mcp__google__calendar_list_events', true);
    }

    const [finding] = observe(window()).filter((f) => f.kind === 'tool-errors');
    expect(finding?.summary).toContain('calendar_list_events');
  });

  it('says nothing for one bad afternoon', () => {
    for (let index = 0; index < OBSERVATION_MIN_RUNS + 3; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * 1000 });
      seedToolCall(id, 'Bash', true);
    }

    expect(observe(window()).filter((f) => f.kind === 'tool-errors')).toEqual([]);
  });

  it('says nothing when the tool worked', () => {
    for (let index = 0; index < OBSERVATION_MIN_RUNS + 2; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      seedToolCall(id, 'Bash');
    }

    expect(observe(window()).filter((f) => f.kind === 'tool-errors')).toEqual([]);
  });
});

describe('observe: an automation that keeps failing', () => {
  const seedAutomation = () => {
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
       VALUES ('ses_auto', 'ws_1', 'A', 'idle', 'sonnet', 'default', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO automations (id, workspace_id, name, prompt, trigger, session_id, enabled, run_count, created_at, updated_at)
       VALUES ('aut_1', 'ws_1', 'Morning', 'p', '{"type":"manual"}', 'ses_auto', 1, 0, 1, 1)`,
    ).run();
  };

  it('names one whose firings fail', () => {
    seedAutomation();
    for (let index = 0; index < OBSERVATION_MIN_RUNS; index += 1) {
      seedRun({ id: `run_${index}`, at: START + index * DAY, sessionId: 'ses_auto', status: 'failed', error: 'x' });
    }

    expect(observe(window()).filter((f) => f.kind === 'automation-drift')).toHaveLength(1);
  });

  it('says nothing when every firing succeeded', () => {
    seedAutomation();
    for (let index = 0; index < OBSERVATION_MIN_RUNS + 2; index += 1) {
      seedRun({ id: `run_${index}`, at: START + index * DAY, sessionId: 'ses_auto' });
    }

    expect(observe(window()).filter((f) => f.kind === 'automation-drift')).toEqual([]);
  });

  it('says nothing about ordinary runs that failed', () => {
    for (let index = 0; index < OBSERVATION_MIN_RUNS + 2; index += 1) {
      seedRun({ id: `run_${index}`, at: START + index * DAY, status: 'failed', error: 'x' });
    }

    expect(observe(window()).filter((f) => f.kind === 'automation-drift')).toEqual([]);
  });
});

describe('observe: instructions that have grown too long', () => {
  it('says so past the share of the ceiling, and not before', () => {
    seedRun({ id: 'run_1' });

    expect(observe(window(), { instructionsLength: INSTRUCTIONS_MAX * 0.5 })).toEqual([]);
    expect(observe(window(), { instructionsLength: INSTRUCTIONS_MAX * 0.8 })).toHaveLength(1);
  });

  it('says nothing when there are no instructions to speak of', () => {
    seedRun({ id: 'run_1' });

    expect(observe(window(), { instructionsLength: 0 })).toEqual([]);
    expect(observe(window(), {})).toEqual([]);
  });
});

describe('observe, in general', () => {
  it('says nothing about an empty window, whatever else is true', () => {
    expect(observe(window(), { instructionsLength: INSTRUCTIONS_MAX })).toEqual([]);
  });

  /**
   * Every run an observation names has to be one the window actually holds.
   * It is what lets the rules downstream drop a revision whose evidence was
   * invented, and it would be worth nothing if the observations themselves
   * could point outside.
   */
  it('never names a run outside the window', () => {
    for (let index = 0; index < UNUSED_MIN_RUNS + 2; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      offer(id);
      seedToolCall(id, 'Bash', true);
    }

    const held = new Set(window().runs.map((run) => run.id));
    for (const finding of observe(window())) {
      for (const runId of finding.runIds) expect(held.has(runId)).toBe(true);
    }
  });

  it('gives every finding a key that says what it is about', () => {
    for (let index = 0; index < UNUSED_MIN_RUNS + 2; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * DAY });
      offer(id);
    }

    for (const finding of observe(window())) {
      expect(finding.key).toContain(finding.kind);
      expect(finding.key.length).toBeGreaterThan(finding.kind.length);
    }
  });

  it('needs at least two distinct days for every kind of finding it makes', () => {
    // One busy day, everything wrong at once: no finding of any kind.
    for (let index = 0; index < UNUSED_MIN_RUNS + 5; index += 1) {
      const id = `run_${index}`;
      seedRun({ id, at: START + index * 60_000, status: 'failed', error: 'x' });
      offer(id, { kind: 'agent', id: 'agt_1', name: 'reviewer', invoked: 1, failed: 1 });
      seedToolCall(id, 'Bash', true);
    }

    expect(observe(window()).filter((f) => f.kind !== 'instructions-oversize')).toEqual([]);
    expect(OBSERVATION_MIN_DAYS).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('the review log', () => {
  const review = (over: Partial<RevisionReview> = {}): RevisionReview => ({
    id: `rev_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'ws_1',
    at: START,
    windowFrom: START - DAY,
    windowTo: START,
    runsExamined: 12,
    observations: [],
    findings: [],
    proposed: 0,
    dropped: [],
    model: 'haiku',
    durationMs: 900,
    error: null,
    ...over,
  });

  /**
   * A pass that found nothing is the common, correct answer — and it has to
   * leave a row, or "nothing to change" and "the pass never ran" render as the
   * same empty screen. That was the `reflected_at` defect exactly: eighteen
   * successful runs, no memories, and no way to tell a quiet week from ten
   * consecutive failures.
   */
  it('records a pass that proposed nothing', () => {
    recordReview(db, review());

    const [stored] = listReviews(db, 'ws_1');
    expect(stored).toMatchObject({ runsExamined: 12, proposed: 0, error: null });
  });

  it('records what it refused to propose, and why', () => {
    recordReview(db, review({ dropped: [{ target: 'skill:skl_1', reason: 'named a run outside the window' }] }));

    expect(listReviews(db, 'ws_1')[0]?.dropped).toEqual([
      { target: 'skill:skl_1', reason: 'named a run outside the window' },
    ]);
  });

  it('records a pass that could not complete, which is a different fact', () => {
    recordReview(db, review({ error: 'the arbiter answered with nothing usable' }));

    expect(listReviews(db, 'ws_1')[0]?.error).toBe('the arbiter answered with nothing usable');
  });

  it('reads newest first', () => {
    recordReview(db, review({ at: START }));
    recordReview(db, review({ at: START + DAY }));

    expect(listReviews(db, 'ws_1').map((entry) => entry.at)).toEqual([START + DAY, START]);
  });

  it('goes away with its workspace', () => {
    recordReview(db, review());
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws_1');

    expect(listReviews(db, 'ws_1')).toEqual([]);
  });

  /**
   * A pass that died does not move the cursor. Its runs were never judged, and
   * advancing past them loses them for good — the same discipline that leaves
   * a run unmarked when the reflexion gate throws.
   */
  it('advances the cursor only for a pass that completed', () => {
    recordReview(db, review({ at: START, windowTo: START, error: 'died' }));
    expect(reviewCursor(db, 'ws_1')).toBe(0);

    recordReview(db, review({ at: START + 1, windowTo: START + 1 }));
    expect(reviewCursor(db, 'ws_1')).toBe(START + 1);
  });

  it('starts at nothing for a workspace never reviewed', () => {
    expect(reviewCursor(db, 'ws_1')).toBe(0);
    expect(lastReview(db, 'ws_1')).toBeNull();
  });

  it('drops reviews past the retention horizon', () => {
    recordReview(db, review({ at: START - 200 * DAY }));
    recordReview(db, review({ at: START }));

    expect(pruneReviews(db, 90, START)).toBe(1);
    expect(listReviews(db, 'ws_1')).toHaveLength(1);
  });
});

describe('reviewDue', () => {
  const workspace = (auto = true) => ({ id: 'ws_1', settings: { improvementAuto: auto } });

  const runs = (count: number, from = START) => {
    for (let index = 0; index < count; index += 1) {
      seedRun({ id: `run_${index}`, at: from + index * 1000 });
    }
  };

  it('is not due for a workspace that opted out, whatever it has done', () => {
    runs(REVIEW_MIN_RUNS + 10);

    expect(reviewDue(db, workspace(false), START + DAY)).toMatchObject({ due: false, reason: 'opted-out' });
  });

  it('is not due for a workspace that has done nothing', () => {
    expect(reviewDue(db, workspace(), START)).toMatchObject({ due: false, reason: 'no-runs' });
  });

  it('is not due below the run threshold', () => {
    runs(REVIEW_MIN_RUNS - 1);

    expect(reviewDue(db, workspace(), START + DAY)).toMatchObject({ due: false, reason: 'too-few-runs' });
  });

  it('is due at the run threshold', () => {
    runs(REVIEW_MIN_RUNS);

    expect(reviewDue(db, workspace(), START + DAY)).toMatchObject({ due: true });
  });

  /**
   * A refusal turns into nagging if the next pass looks at almost the same
   * runs a day later. The clock is the other half of the gate.
   */
  it('is not due again within the week, however many runs arrived', () => {
    recordReview(db, {
      id: 'rev_1', workspaceId: 'ws_1', at: START, windowFrom: 0, windowTo: START,
      runsExamined: 10, observations: [], findings: [], proposed: 0, dropped: [],
      model: 'haiku', durationMs: 1, error: null,
    });
    runs(REVIEW_MIN_RUNS + 5, START + DAY);

    expect(reviewDue(db, workspace(), START + 2 * DAY)).toMatchObject({ due: false, reason: 'too-soon' });
    expect(reviewDue(db, workspace(), START + (REVIEW_MIN_DAYS + 1) * DAY)).toMatchObject({ due: true });
  });

  /** Runs already judged do not count towards the next pass's threshold. */
  it('counts only the runs since the cursor', () => {
    runs(REVIEW_MIN_RUNS + 5);
    recordReview(db, {
      id: 'rev_1', workspaceId: 'ws_1', at: START, windowFrom: 0, windowTo: START + 10 * DAY,
      runsExamined: REVIEW_MIN_RUNS + 5, observations: [], findings: [], proposed: 0, dropped: [],
      model: 'haiku', durationMs: 1, error: null,
    });

    expect(reviewDue(db, workspace(), START + (REVIEW_MIN_DAYS + 1) * DAY)).toMatchObject({
      due: false,
      reason: 'no-runs',
    });
  });
});

/**
 * The floor, answered on its own terms.
 *
 * `reviewDue`'s reasons are ordered and the first one wins, so a workspace that
 * has opted out reports `opted-out` and says nothing at all about whether it
 * has the traffic for a pass. A caller that waives the opt-in — the button —
 * would then be told it may proceed about a window of two runs, promise a
 * pass, and watch it skip silently. That is the shape of a feature nobody
 * trusts.
 */
describe('reviewDue answers the run floor whatever else is true', () => {
  const optedOut = { id: 'ws_1', settings: { improvementAuto: false } };

  it('reports too few runs even for a workspace that opted out', () => {
    for (let index = 0; index < REVIEW_MIN_RUNS - 1; index += 1) {
      seedRun({ id: `run_${index}`, at: START + index * DAY });
    }

    const answer = reviewDue(db, optedOut, START + 20 * DAY);
    expect(answer).toMatchObject({ due: false, reason: 'opted-out', enoughRuns: false });
    expect(answer.fresh).toBe(REVIEW_MIN_RUNS - 1);
  });

  it('reports enough runs for a workspace that opted out but has the traffic', () => {
    for (let index = 0; index < REVIEW_MIN_RUNS; index += 1) {
      seedRun({ id: `run_${index}`, at: START + index * DAY });
    }

    expect(reviewDue(db, optedOut, START + 20 * DAY)).toMatchObject({
      due: false,
      reason: 'opted-out',
      enoughRuns: true,
    });
  });

  it('reports enough runs for one that is merely too soon', () => {
    recordReview(db, {
      id: 'rev_1', workspaceId: 'ws_1', at: START, windowFrom: 0, windowTo: START,
      runsExamined: 1, observations: [], findings: [], proposed: 0, dropped: [],
      model: null, durationMs: 0, error: null,
    });
    for (let index = 0; index < REVIEW_MIN_RUNS; index += 1) {
      seedRun({ id: `run_${index}`, at: START + (index + 1) * DAY });
    }

    expect(reviewDue(db, { id: 'ws_1', settings: { improvementAuto: true } }, START + 2 * DAY)).toMatchObject({
      reason: 'too-soon',
      enoughRuns: true,
    });
  });
});
