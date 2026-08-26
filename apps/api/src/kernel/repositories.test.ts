import type { Run, RunPolicy, Session, TranscriptEvent, Workspace } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import {
  RunRepo,
  SessionRepo,
  TranscriptRepo,
  WorkspaceRepo,
  defaultWorkspaceSettings,
} from './repositories.js';
import type { PendingTranscriptEvent } from './repositories.js';

let db: Db;
let workspaces: WorkspaceRepo;
let sessions: SessionRepo;
let runs: RunRepo;
let transcript: TranscriptRepo;

const POLICY: RunPolicy = {
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
  thinking: 'adaptive',
  thinkingBudgetTokens: null,
  agentName: null,
  source: 'workspace',
};

function makeWorkspace(slug = 'alpha', name = 'Alpha'): Workspace {
  return workspaces.create({
    name,
    slug,
    description: 'A workspace',
    path: `/data/workspaces/${slug}`,
    color: '#6366f1',
    icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });
}

function makeSession(workspaceId: string, title = ''): Session {
  return sessions.create({
    workspaceId,
    title,
    model: 'default',
    effort: null,
    permissionMode: 'default',
  });
}

function makeRun(session: Session, prompt = 'do the thing'): Run {
  return runs.create({
    sessionId: session.id,
    workspaceId: session.workspaceId,
    prompt,
    policy: POLICY,
    triggeredBy: 'user',
  });
}

/**
 * The repo's own input type, imported rather than restated. Its predecessor
 * here was a private copy plus a cast to the *non*-distributive
 * `Omit<TranscriptEvent, 'seq'>`, and the cast is what let the copy drift out
 * of step with the signature it was standing in for without anything noticing.
 */
type EventInput = PendingTranscriptEvent;

function append(sessionId: string, event: EventInput): TranscriptEvent {
  return transcript.append(sessionId, event);
}

function systemEvent(runId: string, at: number, message: string): EventInput {
  return { kind: 'system', id: newId('event'), runId, at, level: 'info', message };
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  workspaces = new WorkspaceRepo(db);
  sessions = new SessionRepo(db);
  runs = new RunRepo(db);
  transcript = new TranscriptRepo(db);
});

afterEach(() => {
  db.close();
});

describe('WorkspaceRepo', () => {
  it('creates and reads back a workspace', () => {
    const created = makeWorkspace();
    expect(created.id.startsWith('ws_')).toBe(true);
    expect(created.name).toBe('Alpha');
    expect(created.slug).toBe('alpha');
    expect(created.path).toBe('/data/workspaces/alpha');
    expect(created.archived).toBe(false);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);

    expect(workspaces.get(created.id)).toEqual(created);
    expect(workspaces.getBySlug('alpha')).toEqual(created);
  });

  it('returns null for unknown ids and slugs', () => {
    expect(workspaces.get('ws_nope')).toBeNull();
    expect(workspaces.getBySlug('nope')).toBeNull();
  });

  it('reports whether a slug is taken', () => {
    makeWorkspace('alpha');
    expect(workspaces.slugExists('alpha')).toBe(true);
    expect(workspaces.slugExists('beta')).toBe(false);
  });

  it('lists non-archived workspaces by default, newest activity first', () => {
    const a = makeWorkspace('alpha', 'Alpha');
    const b = makeWorkspace('beta', 'Beta');
    workspaces.update(b.id, { archived: true });

    expect(workspaces.list().map((w) => w.id)).toEqual([a.id]);
    expect(workspaces.list(true).map((w) => w.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('patches only the fields it is given', () => {
    const created = makeWorkspace();
    const updated = workspaces.update(created.id, { name: 'Renamed', color: '#ff0000' })!;

    expect(updated.name).toBe('Renamed');
    expect(updated.color).toBe('#ff0000');
    expect(updated.description).toBe(created.description);
    expect(updated.icon).toBe(created.icon);
    expect(updated.slug).toBe(created.slug);
    expect(updated.path).toBe(created.path);
    expect(updated.settings).toEqual(created.settings);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    expect(workspaces.update('ws_nope', { name: 'x' })).toBeNull();
  });

  it('round-trips settings and merges a partial patch', () => {
    const created = workspaces.create({
      name: 'Alpha',
      slug: 'alpha',
      description: '',
      path: '/data/workspaces/alpha',
      color: '#6366f1',
      icon: 'folder',
      settings: {
        ...defaultWorkspaceSettings(),
        defaultModel: 'opus',
        defaultEffort: 'high',
        maxTurns: 42,
        allowedTools: ['Read', 'Grep'],
        systemPromptAppend: 'Always use pnpm.',
        memoryEnabled: false,
      },
    });

    expect(created.settings.defaultModel).toBe('opus');
    expect(created.settings.defaultEffort).toBe('high');
    expect(created.settings.maxTurns).toBe(42);
    expect(created.settings.allowedTools).toEqual(['Read', 'Grep']);
    expect(created.settings.systemPromptAppend).toBe('Always use pnpm.');
    expect(created.settings.memoryEnabled).toBe(false);

    const patched = workspaces.update(created.id, { settings: { maxTurns: 7 } })!;
    expect(patched.settings.maxTurns).toBe(7);
    // Everything else survives the merge.
    expect(patched.settings.defaultModel).toBe('opus');
    expect(patched.settings.allowedTools).toEqual(['Read', 'Grep']);
    expect(patched.settings.memoryEnabled).toBe(false);
  });

  it('applies schema defaults for keys a stored row is missing', () => {
    const created = makeWorkspace();
    // Simulate a row written by an older version that knew fewer settings.
    db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(
      JSON.stringify({ maxTurns: 9 }),
      created.id,
    );

    const loaded = workspaces.get(created.id)!;
    expect(loaded.settings.maxTurns).toBe(9);
    expect(loaded.settings).toEqual({ ...defaultWorkspaceSettings(), maxTurns: 9 });
    expect(loaded.settings.defaultModel).toBe('default');
    expect(loaded.settings.memoryEnabled).toBe(true);
    expect(loaded.settings.autoPolicyEnabled).toBe(true);
    expect(loaded.settings.reflexionEnabled).toBe(true);
    expect(loaded.settings.checkpointing).toBe(true);
    expect(loaded.settings.allowedTools).toEqual([]);
  });

  it('falls back to the full default settings for an unparseable row', () => {
    const created = makeWorkspace();
    db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run('{not json', created.id);
    expect(workspaces.get(created.id)!.settings).toEqual(defaultWorkspaceSettings());
  });

  it('deletes a workspace and cascades to its sessions, runs and transcript', () => {
    const workspace = makeWorkspace();
    const session = makeSession(workspace.id);
    const run = makeRun(session);
    append(session.id, systemEvent(run.id, Date.now(), 'hello'));

    expect(workspaces.delete(workspace.id)).toBe(true);
    expect(workspaces.get(workspace.id)).toBeNull();
    expect(sessions.get(session.id)).toBeNull();
    expect(runs.get(run.id)).toBeNull();
    expect(transcript.byRun(run.id)).toEqual([]);

    expect(workspaces.delete(workspace.id)).toBe(false);
  });
});

describe('SessionRepo', () => {
  let workspace: Workspace;

  beforeEach(() => {
    workspace = makeWorkspace();
  });

  it('creates a session with sensible initial state', () => {
    const session = makeSession(workspace.id, 'First session');
    expect(session.id.startsWith('ses_')).toBe(true);
    expect(session.workspaceId).toBe(workspace.id);
    expect(session.title).toBe('First session');
    expect(session.status).toBe('idle');
    expect(session.claudeSessionId).toBeNull();
    expect(session.pinned).toBe(false);
    expect(session.archived).toBe(false);
    expect(session.totalCostUsd).toBe(0);
    expect(session.runCount).toBe(0);

    expect(sessions.get(session.id)).toEqual(session);
    expect(sessions.get('ses_nope')).toBeNull();
  });

  it('lists sessions of a workspace, pinned first then most recently active', () => {
    const older = makeSession(workspace.id, 'older');
    const newer = makeSession(workspace.id, 'newer');
    const pinned = makeSession(workspace.id, 'pinned');
    const archived = makeSession(workspace.id, 'archived');

    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(1000, older.id);
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(2000, newer.id);
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(500, pinned.id);
    sessions.update(pinned.id, { pinned: true });
    sessions.update(archived.id, { archived: true });
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(500, pinned.id);

    expect(sessions.list(workspace.id).map((s) => s.title)).toEqual(['pinned', 'newer', 'older']);
    expect(sessions.list(workspace.id, { includeArchived: true }).map((s) => s.title)).toContain(
      'archived',
    );
    expect(sessions.list(workspace.id, { limit: 1 })).toHaveLength(1);

    // Another workspace's sessions never leak in.
    const other = makeWorkspace('beta', 'Beta');
    expect(sessions.list(other.id)).toEqual([]);
  });

  it('sets status and bumps activity', () => {
    const session = makeSession(workspace.id);
    sessions.setStatus(session.id, 'running');
    const running = sessions.get(session.id)!;
    expect(running.status).toBe('running');
    expect(running.lastActivityAt).toBeGreaterThanOrEqual(session.lastActivityAt);

    sessions.setStatus(session.id, 'error');
    expect(sessions.get(session.id)!.status).toBe('error');
  });

  it('stores the Claude session id and the title', () => {
    const session = makeSession(workspace.id);
    sessions.setClaudeSessionId(session.id, 'claude-abc-123');
    expect(sessions.get(session.id)!.claudeSessionId).toBe('claude-abc-123');

    sessions.setTitle(session.id, 'A new title');
    expect(sessions.get(session.id)!.title).toBe('A new title');

    sessions.setTitle(session.id, 'x'.repeat(500));
    expect(sessions.get(session.id)!.title).toHaveLength(200);
  });

  it('patches with update(), distinguishing "absent" from an explicit null', () => {
    const session = sessions.create({
      workspaceId: workspace.id,
      title: 'T',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      agentName: 'reviewer',
    });

    const modelOnly = sessions.update(session.id, { model: 'opus' })!;
    expect(modelOnly.model).toBe('opus');
    expect(modelOnly.effort).toBe('high');
    expect(modelOnly.agentName).toBe('reviewer');

    const cleared = sessions.update(session.id, { effort: null, agentName: null })!;
    expect(cleared.effort).toBeNull();
    expect(cleared.agentName).toBeNull();

    expect(sessions.update('ses_nope', { model: 'opus' })).toBeNull();
  });

  it('accumulates usage across runs', () => {
    const session = makeSession(workspace.id);
    sessions.addUsage(session.id, { costUsd: 0.25, inputTokens: 100, outputTokens: 40 });
    sessions.addUsage(session.id, { costUsd: 0.5, inputTokens: 20, outputTokens: 10 });

    const after = sessions.get(session.id)!;
    expect(after.totalCostUsd).toBeCloseTo(0.75, 10);
    expect(after.totalInputTokens).toBe(120);
    expect(after.totalOutputTokens).toBe(50);
    expect(after.runCount).toBe(2);
    expect(after.lastActivityAt).toBeGreaterThanOrEqual(session.lastActivityAt);
  });

  it('recovers sessions left mid-flight by an unclean shutdown', () => {
    const running = makeSession(workspace.id, 'running');
    const waiting = makeSession(workspace.id, 'waiting');
    const idle = makeSession(workspace.id, 'idle');
    const errored = makeSession(workspace.id, 'errored');
    sessions.setStatus(running.id, 'running');
    sessions.setStatus(waiting.id, 'waiting_approval');
    sessions.setStatus(errored.id, 'error');

    expect(sessions.recoverOrphaned()).toBe(2);
    expect(sessions.get(running.id)!.status).toBe('idle');
    expect(sessions.get(waiting.id)!.status).toBe('idle');
    expect(sessions.get(idle.id)!.status).toBe('idle');
    // A genuine error state is history, not an orphan.
    expect(sessions.get(errored.id)!.status).toBe('error');

    expect(sessions.recoverOrphaned()).toBe(0);
  });

  it('deletes a session and cascades to its runs', () => {
    const session = makeSession(workspace.id);
    const run = makeRun(session);
    expect(sessions.delete(session.id)).toBe(true);
    expect(runs.get(run.id)).toBeNull();
    expect(sessions.delete(session.id)).toBe(false);
  });
});

describe('RunRepo', () => {
  let workspace: Workspace;
  let session: Session;

  beforeEach(() => {
    workspace = makeWorkspace();
    session = makeSession(workspace.id);
  });

  it('creates a queued run with an empty usage record', () => {
    const run = makeRun(session, 'fix the bug');
    expect(run.id.startsWith('run_')).toBe(true);
    expect(run.status).toBe('queued');
    expect(run.prompt).toBe('fix the bug');
    expect(run.triggeredBy).toBe('user');
    expect(run.category).toBeNull();
    expect(run.error).toBeNull();
    expect(run.rating).toBeNull();
    expect(run.reward).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.policy).toEqual(POLICY);
    expect(run.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
    });

    expect(runs.get(run.id)).toEqual(run);
    expect(runs.get('run_nope')).toBeNull();
  });

  it('records the category when one is supplied', () => {
    const run = runs.create({
      sessionId: session.id,
      workspaceId: workspace.id,
      prompt: 'p',
      policy: POLICY,
      triggeredBy: 'automation',
      category: 'debug',
    });
    expect(run.category).toBe('debug');
    expect(run.triggeredBy).toBe('automation');
  });

  it('finishes a run with its usage and error, stamping finishedAt', () => {
    const run = makeRun(session);
    const usage = {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: 0.0123,
      durationMs: 45_000,
      turns: 4,
    };

    const finished = runs.finish(run.id, { status: 'succeeded', usage })!;
    expect(finished.status).toBe('succeeded');
    expect(finished.usage).toEqual(usage);
    expect(finished.error).toBeNull();
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.finishedAt!).toBeGreaterThanOrEqual(run.startedAt);

    const failed = runs.finish(run.id, { status: 'failed', usage, error: 'x'.repeat(20_000) })!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toHaveLength(8000);
  });

  it('sets status, category, rating and reward independently', () => {
    const run = makeRun(session);
    runs.setStatus(run.id, 'running');
    expect(runs.get(run.id)!.status).toBe('running');

    runs.setCategory(run.id, 'refactor');
    runs.setRating(run.id, -1);
    runs.setReward(run.id, 0.42);

    const after = runs.get(run.id)!;
    expect(after.category).toBe('refactor');
    expect(after.rating).toBe(-1);
    expect(after.reward).toBe(0.42);
  });

  it('lists a session’s runs oldest first', () => {
    const first = makeRun(session, 'first');
    const second = makeRun(session, 'second');
    const third = makeRun(session, 'third');
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1000, first.id);
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(2000, second.id);
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(3000, third.id);

    expect(runs.listBySession(session.id).map((r) => r.prompt)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(runs.listBySession(session.id, 2).map((r) => r.prompt)).toEqual(['first', 'second']);

    const otherSession = makeSession(workspace.id);
    expect(runs.listBySession(otherSession.id)).toEqual([]);
  });

  it('lists recent runs newest first, filtered by workspace and start time', () => {
    const otherWorkspace = makeWorkspace('beta', 'Beta');
    const otherSession = makeSession(otherWorkspace.id);

    const a = makeRun(session, 'a');
    const b = makeRun(session, 'b');
    const c = runs.create({
      sessionId: otherSession.id,
      workspaceId: otherWorkspace.id,
      prompt: 'c',
      policy: POLICY,
      triggeredBy: 'user',
    });
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1000, a.id);
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(2000, b.id);
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(3000, c.id);

    expect(runs.listRecent().map((r) => r.prompt)).toEqual(['c', 'b', 'a']);
    expect(runs.listRecent({ workspaceId: workspace.id }).map((r) => r.prompt)).toEqual(['b', 'a']);
    expect(runs.listRecent({ since: 2000 }).map((r) => r.prompt)).toEqual(['c', 'b']);
    expect(runs.listRecent({ workspaceId: workspace.id, since: 2000 }).map((r) => r.prompt)).toEqual(
      ['b'],
    );
    expect(runs.listRecent({ limit: 1 }).map((r) => r.prompt)).toEqual(['c']);
  });

  it('counts only the runs that are actually in flight', () => {
    expect(runs.countActive()).toBe(0);
    const queued = makeRun(session, 'queued');
    expect(runs.countActive()).toBe(0);

    runs.setStatus(queued.id, 'running');
    expect(runs.countActive()).toBe(1);

    const waiting = makeRun(session, 'waiting');
    runs.setStatus(waiting.id, 'waiting_approval');
    expect(runs.countActive()).toBe(2);

    runs.setStatus(queued.id, 'succeeded');
    expect(runs.countActive()).toBe(1);
  });

  it('marks runs abandoned by a crash as interrupted', () => {
    const queued = makeRun(session, 'queued');
    const running = makeRun(session, 'running');
    const waiting = makeRun(session, 'waiting');
    const done = makeRun(session, 'done');
    runs.setStatus(running.id, 'running');
    runs.setStatus(waiting.id, 'waiting_approval');
    runs.setStatus(done.id, 'succeeded');

    expect(runs.recoverOrphaned()).toBe(3);
    for (const id of [queued.id, running.id, waiting.id]) {
      const run = runs.get(id)!;
      expect(run.status).toBe('interrupted');
      expect(run.error).toBe('Interrupted by a server restart.');
      expect(run.finishedAt).not.toBeNull();
    }
    expect(runs.get(done.id)!.status).toBe('succeeded');
    expect(runs.get(done.id)!.error).toBeNull();

    expect(runs.recoverOrphaned()).toBe(0);
  });
});

describe('TranscriptRepo', () => {
  let session: Session;
  let run: Run;

  beforeEach(() => {
    const workspace = makeWorkspace();
    session = makeSession(workspace.id);
    run = makeRun(session);
  });

  it('assigns increasing sequence numbers per run', () => {
    const first = append(session.id, systemEvent(run.id, 1000, 'one'));
    const second = append(session.id, systemEvent(run.id, 1001, 'two'));
    const third = append(session.id, systemEvent(run.id, 1002, 'three'));

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(third.seq).toBe(2);
  });

  it('numbers each run independently', () => {
    const otherRun = makeRun(session, 'second run');
    append(session.id, systemEvent(run.id, 1000, 'a'));
    append(session.id, systemEvent(run.id, 1001, 'b'));
    const fresh = append(session.id, systemEvent(otherRun.id, 1002, 'c'));
    expect(fresh.seq).toBe(0);
    expect(transcript.byRun(run.id).map((e) => e.seq)).toEqual([0, 1]);
  });

  it('honours an explicit sequence number', () => {
    const explicit = append(session.id, {
      ...systemEvent(run.id, 1000, 'explicit'),
      seq: 41,
    });
    expect(explicit.seq).toBe(41);
    expect(append(session.id, systemEvent(run.id, 1001, 'next')).seq).toBe(42);
  });

  it('reads a run’s events back in sequence order', () => {
    for (let i = 0; i < 5; i += 1) {
      // Deliberately out of chronological order — `seq` is the ordering key.
      append(session.id, systemEvent(run.id, 5000 - i * 100, `message ${i}`));
    }
    const events = transcript.byRun(run.id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((e) => (e as { message: string }).message)).toEqual([
      'message 0',
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ]);
  });

  it('round-trips the whole payload, not just the columns', () => {
    const toolCall: EventInput = {
      kind: 'tool_call',
      id: newId('event'),
      runId: run.id,
      at: 1000,
      toolUseId: 'tu_1',
      name: 'Bash',
      input: { command: 'ls -la', nested: { deep: [1, 2, 3] } },
      status: 'ok',
      result: 'total 0',
      resultIsError: false,
      durationMs: 12,
    };
    const appended = append(session.id, toolCall);
    expect(transcript.byRun(run.id)).toEqual([appended]);
    expect(transcript.byRun(run.id)[0]).toMatchObject({ ...toolCall, seq: 0 });
  });

  it('update() replaces the stored payload in place', () => {
    const streaming = append(session.id, {
      kind: 'assistant_text',
      id: newId('event'),
      runId: run.id,
      at: 1000,
      text: 'partial',
      streaming: true,
    });

    const finalised = { ...streaming, text: 'the complete answer', streaming: false, at: 2000 };
    transcript.update(finalised);

    const stored = transcript.byRun(run.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(finalised);
    expect((stored[0] as { text: string }).text).toBe('the complete answer');
    expect(
      db
        .prepare<[string], { at: number }>('SELECT at FROM transcript_events WHERE id = ?')
        .get(streaming.id)!.at,
    ).toBe(2000);
  });

  it('returns the newest N session events but hands them back oldest first', () => {
    for (let i = 0; i < 5; i += 1) {
      append(session.id, systemEvent(run.id, 1000 + i * 1000, `message ${i}`));
    }

    const all = transcript.bySession(session.id);
    expect(all.map((e) => (e as { message: string }).message)).toEqual([
      'message 0',
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ]);

    // The window keeps the *newest* three, then presents them oldest first.
    const windowed = transcript.bySession(session.id, 3);
    expect(windowed.map((e) => (e as { message: string }).message)).toEqual([
      'message 2',
      'message 3',
      'message 4',
    ]);
    expect(windowed.map((e) => e.at)).toEqual([3000, 4000, 5000]);
  });

  it('spans every run of the session and counts them', () => {
    const otherRun = makeRun(session, 'second run');
    append(session.id, systemEvent(run.id, 1000, 'from run one'));
    append(session.id, systemEvent(otherRun.id, 2000, 'from run two'));

    expect(transcript.bySession(session.id).map((e) => (e as { message: string }).message)).toEqual([
      'from run one',
      'from run two',
    ]);
    expect(transcript.countBySession(session.id)).toBe(2);
    expect(transcript.countBySession('ses_nope')).toBe(0);
    expect(transcript.bySession('ses_nope')).toEqual([]);
  });

  it('refuses a duplicate (run, seq) pair', () => {
    append(session.id, { ...systemEvent(run.id, 1000, 'a'), seq: 0 });
    expect(() =>
      append(session.id, { ...systemEvent(run.id, 1001, 'b'), seq: 0 }),
    ).toThrow();
    // The failed insert leaves no partial state behind.
    expect(transcript.byRun(run.id)).toHaveLength(1);
    expect(db.inTransaction).toBe(false);
  });
});
