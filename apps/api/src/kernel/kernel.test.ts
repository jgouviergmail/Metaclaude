/**
 * The kernel — admission, scheduling, and the learning loop that closes after.
 *
 * This file used to test one pure helper and say so honestly: "what the kernel
 * needs is a fixture for its ten collaborators, which is a piece of work in its
 * own right". This is that fixture, and the tests it makes possible.
 *
 * The fixture is deliberately *half* real. The database, the repositories and
 * the event bus are the genuine articles against an in-memory SQLite, because
 * the things worth testing here are exactly the ones that live in the gaps
 * between the kernel and its storage — a run's status after a cancellation, a
 * session marked busy by one path and released by another. The learning
 * collaborators are fakes, because they have their own tests and because a real
 * reflexion pass would spawn a CLI.
 *
 * The supervisor is a fake the test can *hold open*, which is what makes the
 * concurrency behaviour observable at all: queueing, the reservation window,
 * and cancelling a run that has not started are all states that only exist
 * while something is still running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, Workspace, WorkspaceSettings } from '@metaclaude/shared';
import { WorkspaceSettings as WorkspaceSettingsSchema } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { EventBus } from './bus.js';
import { deriveTitle, Kernel } from './kernel.js';
import { RunRepo, SessionRepo, TranscriptRepo, WorkspaceRepo } from './repositories.js';
import type { RunOutcome, RunRequest, SupervisorCallbacks } from './supervisor.js';

/* -------------------------------------------------------------------------- */
/* The fixture                                                                 */
/* -------------------------------------------------------------------------- */

/** A supervisor whose runs the test starts, holds and finishes by hand. */
function fakeSupervisor() {
  const started: RunRequest[] = [];
  const pending: Array<{ request: RunRequest; settle: (outcome: RunOutcome) => void }> = [];
  const interrupted: string[] = [];
  /** Resolve immediately unless a test asks to hold runs open. */
  let hold = false;

  const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    status: 'succeeded',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      durationMs: 20,
      turns: 1,
    },
    error: null,
    finalText: 'done',
    claudeSessionId: 'sdk-session',
    servedModel: 'claude-opus-5',
    rewindPoint: null,
    ...over,
  });

  const supervisor = {
    hold: () => {
      hold = true;
    },
    started,
    interrupted,
    /** Finish the oldest held run. */
    finish: (over: Partial<RunOutcome> = {}) => {
      const next = pending.shift();
      next?.settle(outcome(over));
    },
    get holding(): number {
      return pending.length;
    },

    execute(request: RunRequest, callbacks: SupervisorCallbacks): Promise<RunOutcome> {
      started.push(request);
      // The real supervisor reports the CLI session id, and the kernel persists
      // it — a session that never records one cannot be resumed or rewound.
      callbacks.onClaudeSessionId('sdk-session');
      if (!hold) return Promise.resolve(outcome());
      return new Promise<RunOutcome>((resolve) => {
        pending.push({ request, settle: resolve });
      });
    },
    async interrupt(runId: string): Promise<boolean> {
      interrupted.push(runId);
      return true;
    },
    async rewind(): Promise<never> {
      throw new Error('not used here');
    },
  };

  return supervisor;
}

function setup(options: { maxConcurrentRuns?: number; settings?: Partial<WorkspaceSettings>; delegationTimeoutMs?: number } = {}) {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);

  const bus = new EventBus();
  const workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  const runs = new RunRepo(db);
  const transcript = new TranscriptRepo(db);
  const supervisor = fakeSupervisor();

  const classifier = {
    classify: vi.fn().mockResolvedValue({ category: 'code', confidence: 1 }),
    learn: vi.fn().mockResolvedValue(undefined),
  };
  const policy = {
    select: vi.fn().mockReturnValue(null),
    update: vi.fn(),
    revise: vi.fn(),
  };
  const reflexion = { reflect: vi.fn().mockResolvedValue(0) };
  const memory = {
    search: vi.fn().mockResolvedValue([]),
    recordUsage: vi.fn(),
    reinforce: vi.fn(),
  };
  const contextProvider = { resolve: vi.fn().mockReturnValue({ mcpServers: {}, agents: {} }) };
  const finished: Run[] = [];

  const settings = WorkspaceSettingsSchema.parse(options.settings ?? {});
  const workspace: Workspace = workspaces.create({
    name: 'Test',
    slug: 'test',
    description: '',
    path: '/tmp/metaclaude-test',
    color: '#6366f1',
    icon: 'folder',
    settings,
  });

  const kernel = new Kernel({
    db,
    bus,
    workspaces,
    sessions,
    runs,
    transcript,
    memory: memory as never,
    classifier: classifier as never,
    policy: policy as never,
    reflexion: reflexion as never,
    contextProvider: contextProvider as never,
    supervisor: supervisor as never,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
    ...(options.delegationTimeoutMs !== undefined
      ? { delegationTimeoutMs: options.delegationTimeoutMs }
      : {}),
    onRunFinished: (run) => finished.push(run),
    log: () => {},
  });

  const newSession = (title = '') =>
    sessions.create({
      workspaceId: workspace.id,
      title,
      model: 'default',
      effort: null,
      permissionMode: 'default',
    });

  return {
    db,
    kernel,
    workspace,
    workspaces,
    sessions,
    runs,
    transcript,
    supervisor,
    classifier,
    policy,
    reflexion,
    memory,
    finished,
    newSession,
  };
}

type Fixture = ReturnType<typeof setup>;
let fixture: Fixture;

beforeEach(() => {
  fixture = setup();
});

afterEach(() => {
  fixture.db.close();
});

/** Wait for a run to reach a terminal status. */
async function settled(fx: Fixture, runId: string): Promise<Run> {
  return vi.waitFor(() => {
    const run = fx.runs.get(runId);
    if (!run || ['queued', 'running', 'waiting_approval'].includes(run.status)) {
      throw new Error(`run ${runId} is ${run?.status ?? 'missing'}`);
    }
    return run;
  });
}

/* -------------------------------------------------------------------------- */
/* Admission                                                                   */
/* -------------------------------------------------------------------------- */

describe('admission', () => {
  it('records a run and hands it to the supervisor', async () => {
    const session = fixture.newSession();

    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do the thing' });
    await settled(fixture, run.id);

    expect(fixture.supervisor.started).toHaveLength(1);
    expect(fixture.runs.get(run.id)?.status).toBe('succeeded');
  });

  it('records the model that actually served, off the outcome', async () => {
    // The policy can say 'default' under Auto; the CLI's init message is the
    // one place the concrete choice is named, and it exists only on the wire.
    const session = fixture.newSession();

    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do the thing' });
    await settled(fixture, run.id);

    expect(fixture.runs.get(run.id)?.servedModel).toBe('claude-opus-5');
  });

  it('names the session from its first prompt', async () => {
    // Otherwise the sidebar is a column of "New session".
    const session = fixture.newSession();

    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'Fix the parser bug' });
    await settled(fixture, run.id);

    expect(fixture.sessions.get(session.id)?.title).toBe('Fix the parser bug');
  });

  it('carries an explicit ultracode ask through to the run, and never invents one', async () => {
    // The whole chain is what matters: the field exists on the contract, the
    // route forwards it, and this proves the kernel writes it onto the policy
    // the supervisor will read. Off by default because orchestration multiplies
    // cost — only a per-message choice may turn it on.
    const session = fixture.newSession();

    const plain = await fixture.kernel.submit({ sessionId: session.id, prompt: 'estimate this' });
    await settled(fixture, plain.id);
    expect(fixture.runs.get(plain.id)?.policy.ultracode).toBe(false);

    const orchestrated = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'audit the whole codebase',
      overrides: { ultracode: true },
    });
    await settled(fixture, orchestrated.id);
    expect(fixture.runs.get(orchestrated.id)?.policy.ultracode).toBe(true);
  });

  it('refuses an empty prompt', async () => {
    const session = fixture.newSession();

    await expect(fixture.kernel.submit({ sessionId: session.id, prompt: '   ' })).rejects.toThrow(
      /empty/i,
    );
  });

  it('refuses an unknown session', async () => {
    await expect(fixture.kernel.submit({ sessionId: 'ses_nope', prompt: 'x' })).rejects.toThrow(
      /session/i,
    );
  });

  it('refuses a second run in a session that is already busy', async () => {
    fixture.supervisor.hold();
    const session = fixture.newSession();
    await fixture.kernel.submit({ sessionId: session.id, prompt: 'first' });

    await expect(fixture.kernel.submit({ sessionId: session.id, prompt: 'second' })).rejects.toThrow(
      /in flight/i,
    );
  });

  it('lets one of two simultaneous submits through, and only one', async () => {
    // The subtle one. `submit` awaits the classifier before the run reaches the
    // scheduler, and `execute` only registers in `active` a microtask later.
    // Without a synchronous reservation across that window both submits pass the
    // "already running?" check, resume the same Claude session and interleave
    // their transcripts.
    fixture.supervisor.hold();
    const session = fixture.newSession();

    const results = await Promise.allSettled([
      fixture.kernel.submit({ sessionId: session.id, prompt: 'first' }),
      fixture.kernel.submit({ sessionId: session.id, prompt: 'second' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('frees the session again once the run is over', async () => {
    // The reservation is taken synchronously; a path that failed to release it
    // would lock the session for the life of the process.
    const session = fixture.newSession();
    const first = await fixture.kernel.submit({ sessionId: session.id, prompt: 'first' });
    await settled(fixture, first.id);

    const second = await fixture.kernel.submit({ sessionId: session.id, prompt: 'second' });
    expect(second.id).not.toBe(first.id);
  });
});

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

describe('scheduling', () => {
  it('queues past the concurrency limit rather than running everything', async () => {
    const fx = setup({ maxConcurrentRuns: 1 });
    fx.supervisor.hold();

    const a = await fx.kernel.submit({ sessionId: fx.newSession().id, prompt: 'a' });
    const b = await fx.kernel.submit({ sessionId: fx.newSession().id, prompt: 'b' });

    await vi.waitFor(() => expect(fx.supervisor.started).toHaveLength(1));
    expect(fx.runs.get(a.id)?.status).toBe('running');
    expect(fx.runs.get(b.id)?.status).toBe('queued');

    fx.supervisor.finish();
    await vi.waitFor(() => expect(fx.supervisor.started).toHaveLength(2));
    fx.db.close();
  });

  it('cancelling a queued run never starts it', async () => {
    // `reject`, not `resolve`, on the waiter: resolving would hand it the slot
    // and start the run the operator just stopped, while reporting success.
    const fx = setup({ maxConcurrentRuns: 1 });
    fx.supervisor.hold();

    await fx.kernel.submit({ sessionId: fx.newSession().id, prompt: 'a' });
    const queuedSession = fx.newSession();
    const queued = await fx.kernel.submit({ sessionId: queuedSession.id, prompt: 'b' });

    expect(fx.kernel.interrupt(queuedSession.id)).toBe(true);
    fx.supervisor.finish();

    const run = await settled(fx, queued.id);
    expect(run.status).toBe('interrupted');
    expect(fx.supervisor.started.map((r) => r.runId)).not.toContain(queued.id);
    fx.db.close();
  });

  it('asks the CLI to stop a run that is already going', async () => {
    fixture.supervisor.hold();
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'a' });
    await vi.waitFor(() => expect(fixture.supervisor.started).toHaveLength(1));

    expect(fixture.kernel.interrupt(session.id)).toBe(true);
    expect(fixture.supervisor.interrupted).toContain(run.id);
    fixture.supervisor.finish({ status: 'interrupted', error: 'stopped' });
    await settled(fixture, run.id);
  });

  it('reports nothing to stop when the session is idle', () => {
    expect(fixture.kernel.interrupt(fixture.newSession().id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The learning loop                                                           */
/* -------------------------------------------------------------------------- */

describe('the loop that closes after a run', () => {
  it('scores the run and reinforces the memories it used', async () => {
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do it' });
    await settled(fixture, run.id);

    await vi.waitFor(() => expect(fixture.memory.reinforce).toHaveBeenCalled());
    expect(fixture.runs.get(run.id)?.reward).toBeGreaterThan(0);
  });

  it('teaches the classifier from a run that finished', async () => {
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do it' });
    await settled(fixture, run.id);

    await vi.waitFor(() => expect(fixture.classifier.learn).toHaveBeenCalled());
  });

  it('does not teach the classifier from an interrupted run', async () => {
    // A run the operator stopped says nothing about what they meant.
    fixture.supervisor.hold();
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do it' });
    await vi.waitFor(() => expect(fixture.supervisor.started).toHaveLength(1));
    fixture.supervisor.finish({ status: 'interrupted', error: 'stopped' });
    await settled(fixture, run.id);

    await vi.waitFor(() => expect(fixture.memory.reinforce).toHaveBeenCalled());
    expect(fixture.classifier.learn).not.toHaveBeenCalled();
  });

  it('leaves the bandit alone when the workspace has not asked it to learn', async () => {
    // `autoPolicyEnabled` off means the operator chooses the model; updating
    // arms from runs they picked would teach the learner their preferences and
    // then present them back as its own recommendation.
    const fx = setup({ settings: { autoPolicyEnabled: false } });
    const run = await fx.kernel.submit({ sessionId: fx.newSession().id, prompt: 'do it' });
    await settled(fx, run.id);

    await vi.waitFor(() => expect(fx.memory.reinforce).toHaveBeenCalled());
    expect(fx.policy.update).not.toHaveBeenCalled();
    fx.db.close();
  });

  it('updates the bandit when it is the one choosing', async () => {
    const fx = setup({ settings: { autoPolicyEnabled: true } });
    const run = await fx.kernel.submit({ sessionId: fx.newSession().id, prompt: 'do it' });
    await settled(fx, run.id);

    await vi.waitFor(() => expect(fx.policy.update).toHaveBeenCalled());
    fx.db.close();
  });

  it('announces the run to whatever is listening', async () => {
    // The scheduler's automation bookkeeping hangs off this hook; a run that
    // finished without firing it leaves an automation showing its last outcome
    // forever.
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do it' });
    await settled(fixture, run.id);

    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));
  });

  it('records a failure as a failure, and still closes the loop', async () => {
    fixture.supervisor.hold();
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do it' });
    await vi.waitFor(() => expect(fixture.supervisor.started).toHaveLength(1));
    fixture.supervisor.finish({ status: 'failed', error: 'it broke' });

    const settledRun = await settled(fixture, run.id);
    expect(settledRun.status).toBe('failed');
    expect(settledRun.error).toContain('it broke');
    await vi.waitFor(() => expect(fixture.memory.reinforce).toHaveBeenCalled());
  });
});

/* -------------------------------------------------------------------------- */
/* Rewind                                                                      */
/* -------------------------------------------------------------------------- */

describe('rewindRun', () => {
  it('refuses a run that does not exist, rather than throwing', async () => {
    // Reached from a button. A rejection is a 500 on top of whatever the
    // operator was already trying to recover from.
    const result = await fixture.kernel.rewindRun('run_nope', true);

    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('refuses a run that recorded no anchor, and says why', async () => {
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do it' });
    await settled(fixture, run.id);

    const result = await fixture.kernel.rewindRun(run.id, true);

    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/checkpoint/i);
  });

  it('refuses a finished run whose session has since started another', async () => {
    // `planRewind` tests `IN_FLIGHT` against the *target* run only, so an
    // earlier, finished run in a session looked rewindable while a newer run in
    // the same session was mid-`Edit`. Both resume the same Claude session id,
    // so `supervisor.rewind` opens a second CLI onto the id the live run is
    // appending to and restores files under it. The UI does not compensate:
    // the button is gated on `run.rewindPoint` alone.
    //
    // The kernel already knows the answer — `hasActiveRunForSession` covers the
    // reservation window and the queue as well as `active` — it simply was not
    // asked.
    const fx = setup();
    const session = fx.newSession();

    // Held so the first run can finish *with* an anchor — otherwise the
    // refusal below could be the boring "no checkpoint" one.
    fx.supervisor.hold();
    const first = await fx.kernel.submit({ sessionId: session.id, prompt: 'edit the parser' });
    await vi.waitFor(() => expect(fx.supervisor.started).toHaveLength(1));
    fx.supervisor.finish({ rewindPoint: 'msg_1' });
    const done = await settled(fx, first.id);
    expect(done.rewindPoint).toBe('msg_1');

    const second = await fx.kernel.submit({ sessionId: session.id, prompt: 'and again' });
    await vi.waitFor(() => expect(fx.supervisor.started.map((r) => r.runId)).toContain(second.id));

    // The fake supervisor's `rewind` throws "not used here". Reaching it is the
    // failure this test is about, so a clean refusal is the whole assertion.
    const result = await fx.kernel.rewindRun(first.id, true);
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/in flight/i);

    fx.supervisor.finish();
    await settled(fx, second.id);
    fx.db.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The pure helper                                                             */
/* -------------------------------------------------------------------------- */

describe('deriveTitle', () => {
  it('uses the first meaningful line', () => {
    expect(deriveTitle('Fix the login bug\nand then deploy')).toBe('Fix the login bug');
    expect(deriveTitle('\n\n  \nFix the login bug')).toBe('Fix the login bug');
    expect(deriveTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('strips markdown heading markers', () => {
    expect(deriveTitle('# Heading here\nbody')).toBe('Heading here');
    expect(deriveTitle('###### Deep heading')).toBe('Deep heading');
    expect(deriveTitle('#Tight heading')).toBe('Tight heading');
  });

  it('strips list markers', () => {
    expect(deriveTitle('- item one\nitem two')).toBe('item one');
    expect(deriveTitle('* item one')).toBe('item one');
    expect(deriveTitle('-   spaced item')).toBe('spaced item');
  });
});

/* -------------------------------------------------------------------------- */
/* Delegation — the society of sessions                                        */
/* -------------------------------------------------------------------------- */

describe('delegation', () => {
  const makeTarget = (fx: Fixture, slug = 'docs') =>
    fx.workspaces.create({
      name: slug,
      slug,
      description: '',
      path: `/tmp/metaclaude-${slug}`,
      color: '#6366f1',
      icon: 'folder',
      settings: WorkspaceSettingsSchema.parse({}),
    });

  it('runs the prompt in the target workspace and returns its final answer', async () => {
    const target = makeTarget(fixture);

    const result = await fixture.kernel.delegate({
      fromWorkspaceId: fixture.workspace.id,
      fromTriggeredBy: 'user',
      target: 'docs',
      prompt: 'summarise the readme',
    });

    expect(result.status).toBe('succeeded');
    expect(result.finalText).toBe('done');
    // A real, recorded run in the target workspace — visible in its history,
    // counted in its usage, learned from like any other.
    const run = fixture.runs.get(result.runId);
    expect(run?.workspaceId).toBe(target.id);
    expect(run?.triggeredBy).toBe('delegation');
  });

  it('reuses one Delegations session, so context accumulates across asks', async () => {
    makeTarget(fixture);

    const first = await fixture.kernel.delegate({
      fromWorkspaceId: fixture.workspace.id,
      fromTriggeredBy: 'user',
      target: 'docs',
      prompt: 'first question',
    });
    const second = await fixture.kernel.delegate({
      fromWorkspaceId: fixture.workspace.id,
      fromTriggeredBy: 'user',
      target: 'docs',
      prompt: 'second question',
    });

    expect(second.sessionId).toBe(first.sessionId);
  });

  it('refuses delegation to the workspace the run is already in', async () => {
    await expect(
      fixture.kernel.delegate({
        fromWorkspaceId: fixture.workspace.id,
        fromTriggeredBy: 'user',
        target: 'test',
        prompt: 'ask yourself',
      }),
    ).rejects.toThrow(/different workspace/i);
  });

  it('refuses an unknown workspace by name', async () => {
    await expect(
      fixture.kernel.delegate({
        fromWorkspaceId: fixture.workspace.id,
        fromTriggeredBy: 'user',
        target: 'nowhere',
        prompt: 'hello?',
      }),
    ).rejects.toThrow(/no workspace/i);
  });

  it('discards the stash of a delegation whose waiter timed out — no leak', async () => {
    // The waiter gives up, the run finishes later, and nobody will ever
    // consume the stashed outcome. Settlement must drop it, or every
    // timed-out delegation grows the map for the life of the process.
    const fx = setup({ delegationTimeoutMs: 30 });
    try {
      fx.workspaces.create({
        name: 'docs', slug: 'docs', description: '',
        path: '/tmp/metaclaude-docs', color: '#6366f1', icon: 'folder',
        settings: WorkspaceSettingsSchema.parse({}),
      });
      fx.supervisor.hold();

      const attempt = fx.kernel.delegate({
        fromWorkspaceId: fx.workspace.id,
        fromTriggeredBy: 'user',
        target: 'docs',
        prompt: 'slow question',
      });
      await expect(attempt).rejects.toThrow(/did not finish in time/);

      fx.supervisor.finish();
      await vi.waitFor(() => {
        // The one observable of a leak is the map itself; a typed escape is
        // the price of asserting absence.
        const settled = (fx.kernel as unknown as { delegationSettled: Map<string, unknown> })
          .delegationSettled;
        expect(settled.size).toBe(0);
      });
    } finally {
      fx.db.close();
    }
  });

  it('refuses a delegated run delegating again — depth is one, so no loops', async () => {
    // A→B→A would burn quota in a circle with nobody watching. One hop keeps
    // every delegation attributable to a human-started run.
    makeTarget(fixture);

    await expect(
      fixture.kernel.delegate({
        fromWorkspaceId: fixture.workspace.id,
        fromTriggeredBy: 'delegation',
        target: 'docs',
        prompt: 'and now you ask someone else',
      }),
    ).rejects.toThrow(/cannot delegate/i);
  });
});
