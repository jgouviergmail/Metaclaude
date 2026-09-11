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
import type { Memory, Run, TranscriptEvent, Workspace, WorkspaceSettings } from '@metaclaude/shared';
import { AUTO_MODEL, WorkspaceSettings as WorkspaceSettingsSchema } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { HashingEmbedder } from '../learning/embeddings.js';
import { usageForRun } from '../learning/extension-usage.js';
import { KnowledgeStore } from '../learning/knowledge.js';
import { EventBus } from './bus.js';
import { delegationTimeoutFor, deriveTitle, Kernel, languageDirective, type ContextProvider } from './kernel.js';
import { ModelAvailability } from './model-availability.js';
import { capPermissionMode } from './permissions.js';
import { AttachmentService } from '../services/attachments.js';
import { RunRepo, SessionRepo, TranscriptRepo, WorkspaceRepo } from './repositories.js';
import type { RunOutcome, RunRequest, SupervisorCallbacks } from './supervisor.js';
import { POSIX } from '../testing/platform.js';

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
    quotaBlock: null,
    ...over,
  });

  /**
   * Outcomes to serve, one per call, in order.
   *
   * A quota switch is only observable across *several* attempts, and the plain
   * fake answered the same success to every call — so a loop that never
   * switched and one that switched three times looked identical.
   */
  const nextOutcomes: Array<Partial<RunOutcome>> = [];

  const supervisor = {
    hold: () => {
      hold = true;
    },
    started,
    interrupted,
    nextOutcomes,
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
      // Read off the object, not the captured const: a test that *assigns*
      // `supervisor.nextOutcomes = [...]` would otherwise leave the closure
      // holding the original array and script nothing at all.
      const scripted = supervisor.nextOutcomes.shift();
      callbacks.onClaudeSessionId(scripted?.claudeSessionId ?? 'sdk-session');
      if (!hold) return Promise.resolve(outcome(scripted ?? {}));
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

/** The policy a hand-written run row carries; nothing under test reads it. */
const DEFAULT_TEST_POLICY = {
  model: 'default',
  effort: null,
  permissionMode: 'default',
  thinking: 'adaptive',
  thinkingBudgetTokens: null,
  agentName: null,
  ultracode: false,
  source: 'workspace',
} as const;

function setup(options: { maxConcurrentRuns?: number; settings?: Partial<WorkspaceSettings>; delegationTimeoutMs?: number; standingSessionMaxEvents?: number } = {}) {
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
    /**
     * The learner's ranking, best first — what a quota switch picks from.
     *
     * Ordered as the real learner orders it once the prior became cost-aware:
     * cheapest at the top, so a switch away from an expensive model lands
     * somewhere sensible from the very first run.
     */
    list: vi.fn().mockReturnValue([
      { model: 'haiku', effort: null },
      { model: 'sonnet', effort: 'low' },
      { model: 'opus', effort: 'medium' },
      { model: 'fable', effort: 'high' },
    ]),
    update: vi.fn(),
    revise: vi.fn(),
  };
  // Real, against the same in-memory database: what is worth testing about a
  // quota hold lives between the kernel and the row, not in a double.
  const availability = new ModelAvailability(db);
  const reflexion = { reflect: vi.fn().mockResolvedValue(0) };
  const memory = {
    search: vi.fn().mockResolvedValue([]),
    standing: vi.fn<() => Memory[]>(() => []),
    recordUsage: vi.fn(),
    reinforce: vi.fn(),
  };
  // Real, against the same in-memory database: what is worth testing about
  // knowledge injection lives between the kernel, the store and the rows —
  // same reasoning as the repositories being genuine.
  const knowledge = new KnowledgeStore(db, new HashingEmbedder());
  // Typed rather than cast: the `as never` this used to reach the kernel
  // through hid a missing field for a whole release's worth of edits, and the
  // symptom was thirty-seven red tests that looked like a broken kernel.
  /**
   * `prepare` records the order it ran in, not merely that it ran.
   *
   * What it does for real — renewing an OAuth token, writing the workspace's
   * skills to disk — is worthless if it happens after `resolve` has already
   * read what it was meant to freshen, and "was it called" cannot tell the two
   * apart. One shared log, two pushes, one assertion.
   */
  const contextCalls: string[] = [];
  const contextProvider: ContextProvider = {
    resolve: vi.fn<ContextProvider['resolve']>().mockImplementation(() => {
      contextCalls.push('resolve');
      return { mcpServers: {}, agents: {}, skills: [] };
    }),
    prepare: vi.fn<NonNullable<ContextProvider['prepare']>>().mockImplementation(async () => {
      contextCalls.push('prepare');
    }),
  };
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
    knowledge,
    classifier: classifier as never,
    policy: policy as never,
    availability,
    reflexion: reflexion as never,
    contextProvider,
    supervisor: supervisor as never,
    // Real service against the same in-memory database — attachments are part
    // of the storage the kernel is tested against, not a learning collaborator.
    attachments: new AttachmentService(db),
    maxConcurrentRuns: () => options.maxConcurrentRuns ?? 2,
    runTimeoutMs: () => 60_000,
    ...(options.delegationTimeoutMs !== undefined
      ? { delegationTimeoutMs: options.delegationTimeoutMs }
      : {}),
    ...(options.standingSessionMaxEvents !== undefined
      ? { standingSessionMaxEvents: options.standingSessionMaxEvents }
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
    availability,
    reflexion,
    memory,
    knowledge,
    contextProvider,
    contextCalls,
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

  it.skipIf(!POSIX)('binds the message’s attachments to the run and hands them to the supervisor', async () => {
    const session = fixture.newSession();
    fixture.db
      .prepare(
        `INSERT INTO attachments (id, workspace_id, session_id, run_id, name, path, mime, bytes, sha256, created_at)
         VALUES ('att_1', ?, ?, NULL, 'shot.png', 'attachments/ab-shot.png', 'image/png', 10, 'hash', 0)`,
      )
      .run(fixture.workspace.id, session.id);

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'see the screenshot',
      attachmentIds: ['att_1'],
    });
    await settled(fixture, run.id);

    const bound = fixture.db
      .prepare<[string], { run_id: string | null }>('SELECT run_id FROM attachments WHERE id = ?')
      .get('att_1');
    expect(bound?.run_id).toBe(run.id);
    expect(fixture.supervisor.started[0]?.attachments).toMatchObject([
      { id: 'att_1', path: 'attachments/ab-shot.png', mime: 'image/png' },
    ]);
    // The absolute path is resolved inside the workspace's own jail.
    expect(fixture.supervisor.started[0]?.attachments[0]?.absolutePath.startsWith('/tmp/metaclaude-test')).toBe(true);
  });

  it('refuses an attachment that was already sent, and releases the session', async () => {
    const session = fixture.newSession();
    fixture.db
      .prepare(
        `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
         VALUES ('run_elsewhere', ?, ?, 'earlier message', 'succeeded', 0)`,
      )
      .run(session.id, fixture.workspace.id);
    fixture.db
      .prepare(
        `INSERT INTO attachments (id, workspace_id, session_id, run_id, name, path, mime, bytes, sha256, created_at)
         VALUES ('att_used', ?, ?, 'run_elsewhere', 'a.png', 'attachments/ab-a.png', 'image/png', 1, 'h', 0)`,
      )
      .run(fixture.workspace.id, session.id);

    await expect(
      fixture.kernel.submit({ sessionId: session.id, prompt: 'resend it', attachmentIds: ['att_used'] }),
    ).rejects.toThrow(/already sent/i);
    expect(fixture.supervisor.started).toHaveLength(0);

    // The admission failure must not leave the session reserved.
    const retry = await fixture.kernel.submit({ sessionId: session.id, prompt: 'plain message' });
    await settled(fixture, retry.id);
    expect(fixture.runs.get(retry.id)?.status).toBe('succeeded');
  });

  it('carries the message’s tool controls onto the policy the supervisor reads', async () => {
    // Like ultracode: per-message only — no stored default may quietly steer
    // the next prompt's tools.
    const session = fixture.newSession();

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'use the deploy skill',
      overrides: {
        toolControls: {
          requiredSkills: ['deploy'],
          excludedMcpServers: ['docs'],
          preferredMcpServers: [],
        },
      },
    });
    await settled(fixture, run.id);

    expect(fixture.supervisor.started[0]?.policy.toolControls).toEqual({
      requiredSkills: ['deploy'],
      excludedMcpServers: ['docs'],
      preferredMcpServers: [],
    });

    const plain = await fixture.kernel.submit({ sessionId: session.id, prompt: 'and now without' });
    await settled(fixture, plain.id);
    expect(fixture.supervisor.started[1]?.policy.toolControls).toBeUndefined();
  });

  it('asks the learner when the composer sends Auto, and not when a model is pinned', async () => {
    // The composer sends its pickers on *every* message, so `overrides.model`
    // is always defined; `default` is Metaclaude's Auto, the request for the
    // learner rather than a choice against it. `choosePolicy` gated the bandit
    // on `!overrides.model`, which is false for the string `'default'`, so the
    // learner was never consulted from the composer at all. Measured in
    // production: 46 runs stamped `explicit` against 7 `learned`, and all 42
    // submitted as Auto were served by the CLI's own default — the dearest
    // tier. Selecting Auto switched learning off and pinned the flagship.
    const session = fixture.newSession();
    fixture.policy.select.mockReturnValue({
      arm: { model: 'haiku', effort: null },
      confidence: 0.8,
    });

    const auto = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: AUTO_MODEL, effort: null },
    });
    await settled(fixture, auto.id);

    expect(fixture.policy.select).toHaveBeenCalled();
    expect(fixture.runs.get(auto.id)?.policy.model).toBe('haiku');
    expect(fixture.runs.get(auto.id)?.policy.source).toBe('learned');

    // And a real pin still wins outright — the operator's choice is the one
    // thing the learner may never overrule.
    fixture.policy.select.mockClear();
    const pinned = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'another question',
      overrides: { model: 'opus', effort: 'high' },
    });
    await settled(fixture, pinned.id);

    expect(fixture.policy.select).not.toHaveBeenCalled();
    expect(fixture.runs.get(pinned.id)?.policy.model).toBe('opus');
    expect(fixture.runs.get(pinned.id)?.policy.effort).toBe('high');
    expect(fixture.runs.get(pinned.id)?.policy.source).toBe('explicit');
  });

  it('opens on the learner’s cheapest arm when everything resolves to Auto', async () => {
    /*
     * The cold-start floor. Measured in production before it existed: a research
     * run whose session, workspace default and automation all said Auto, on a
     * category with one trial, was served `claude-opus-5[1m]` for $1.33 — while
     * the learner's own ranking for that workspace put haiku first and fable
     * last. It knew and could not say so, because `select` refuses below eight
     * trials and the fallback behind it was the CLI's dearest model.
     */
    const fx = setup({ settings: { defaultModel: AUTO_MODEL, defaultEffort: null } });
    try {
      fx.policy.select.mockReturnValue(null); // not enough evidence to act
      const session = fx.newSession();
      const run = await fx.kernel.submit({
        sessionId: session.id,
        prompt: 'a question',
        overrides: { model: AUTO_MODEL, effort: null },
      });
      await vi.waitFor(() => expect(fx.finished.map((r) => r.id)).toContain(run.id));

      // The head of the ranking, which the cost-aware prior puts at the cheapest.
      expect(fx.policy.list).toHaveBeenCalledWith(fx.workspace.id, 'code');
      expect(fx.runs.get(run.id)?.policy.model).toBe('haiku');
      expect(fx.runs.get(run.id)?.policy.source).toBe('learned');
    } finally {
      fx.db.close();
    }
  });

  it('does not overrule a workspace that names a real model', async () => {
    // The floor is for the case where nobody chose. A workspace default is a
    // choice, and the learner may not quietly replace it.
    const fx = setup({ settings: { defaultModel: 'opus', defaultEffort: 'high' } });
    try {
      fx.policy.select.mockReturnValue(null);
      const session = fx.newSession();
      const run = await fx.kernel.submit({
        sessionId: session.id,
        prompt: 'a question',
        overrides: { model: AUTO_MODEL, effort: null },
      });
      await vi.waitFor(() => expect(fx.finished.map((r) => r.id)).toContain(run.id));

      expect(fx.runs.get(run.id)?.policy.model).toBe('opus');
      expect(fx.runs.get(run.id)?.policy.source).toBe('workspace');
    } finally {
      fx.db.close();
    }
  });

  it('falls back to the workspace default, not the CLI default, when Auto has no evidence', async () => {
    // The cold-start path — taken until a (workspace, category) reaches eight
    // trials, so the common one in a young deployment. `session.model || ...`
    // treated Auto as a choice, because `'default'` is a non-empty string, so
    // the fallback resolved to `'default'` — which reaches the CLI as "pass no
    // --model" and lands on its own default. Measured: `claude-opus-5[1m]`.
    const fx = setup({ settings: { defaultModel: 'sonnet', defaultEffort: 'medium' } });
    try {
      fx.policy.select.mockReturnValue(null);
      const session = fx.newSession(); // stored model is 'default', i.e. Auto
      const run = await fx.kernel.submit({
        sessionId: session.id,
        prompt: 'a question',
        overrides: { model: AUTO_MODEL, effort: null },
      });
      await vi.waitFor(() => expect(fx.finished.map((r) => r.id)).toContain(run.id));

      expect(fx.runs.get(run.id)?.policy.model).toBe('sonnet');
      expect(fx.runs.get(run.id)?.policy.effort).toBe('medium');
    } finally {
      fx.db.close();
    }
  });

  it('does not record Auto as an explicit choice when the learner has nothing to say', async () => {
    // `source` is what the analytics read and what tells an operator whether a
    // run was decided or defaulted. `explicit` is a claim that somebody chose
    // this, and nobody did. With the workspace default also on Auto the
    // cold-start floor answers from the learner's ranking, so the honest stamp
    // is `learned` — with `trials` saying how much evidence stands behind it.
    const session = fixture.newSession();
    fixture.policy.select.mockReturnValue(null);

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: AUTO_MODEL, effort: null },
    });
    await settled(fixture, run.id);

    expect(fixture.policy.select).toHaveBeenCalled();
    expect(fixture.runs.get(run.id)?.policy.source).not.toBe('explicit');
    expect(fixture.runs.get(run.id)?.policy.source).toBe('learned');
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

/**
 * The rule three callers used to spell for themselves.
 *
 * The gateway's `MCP: <token>`, delegation's `Delegations` and the steward's
 * own session all want the same thing — reuse the standing one while it is
 * idle and has room, open a fresh one beside it otherwise — and all three had
 * written it out. Owned here now, so the copies cannot drift again.
 */
describe('the standing session', () => {
  const ask = (fx: Fixture, over: Partial<{ title: string; maxEvents: number }> = {}) =>
    fx.kernel.standingSession({
      workspaceId: fx.workspace.id,
      title: 'Delegations',
      maxEvents: 100,
      ...over,
    });

  it('reuses the one it finds while it is idle and under the ceiling', () => {
    expect(ask(fixture).id).toBe(ask(fixture).id);
  });

  it('opens a second one beside a busy one rather than refusing or queueing', async () => {
    const first = ask(fixture);
    fixture.supervisor.hold();
    await fixture.kernel.submit({ sessionId: first.id, prompt: 'holding it open' });
    // Wait for the run to actually be in the supervisor's hands: `submit`
    // returns as soon as the row exists, and finishing before it arrives
    // settles nothing and hangs the cleanup.
    await vi.waitFor(() => expect(fixture.supervisor.holding).toBe(1));

    expect(ask(fixture).id).not.toBe(first.id);

    fixture.supervisor.finish();
    await vi.waitFor(() => expect(fixture.finished).toHaveLength(1));
  });

  it('opens a second one beside a full one, under the same name', () => {
    const first = ask(fixture, { maxEvents: 1 });
    const run = fixture.runs.create({
      sessionId: first.id,
      workspaceId: fixture.workspace.id,
      prompt: 'x',
      policy: DEFAULT_TEST_POLICY,
      triggeredBy: 'user',
    });
    fixture.transcript.append(first.id, {
      kind: 'assistant_text', id: 'ev_1', runId: run.id, at: Date.now(), text: 'x', streaming: false,
    });

    const second = ask(fixture, { maxEvents: 1 });
    expect(second.id).not.toBe(first.id);
    expect(fixture.sessions.get(second.id)?.title).toBe('Delegations');
  });

  it('never crosses a title, so one caller’s session is not another’s', () => {
    expect(ask(fixture, { title: 'Delegations' }).id).not.toBe(ask(fixture, { title: 'MCP: n8n' }).id);
  });

  it('opens it on the workspace’s own model, effort and mode', () => {
    const session = fixture.sessions.get(ask(fixture).id);
    expect(session?.model).toBe(String(fixture.workspace.settings.defaultModel));
    expect(session?.effort).toBe(fixture.workspace.settings.defaultEffort);
    expect(session?.permissionMode).toBe(fixture.workspace.settings.defaultPermissionMode);
  });

  it('refuses a workspace that does not exist', () => {
    expect(() =>
      fixture.kernel.standingSession({ workspaceId: 'ws_gone', title: 'x', maxEvents: 10 }),
    ).toThrow(/unknown workspace/i);
  });
});

describe('delegation', () => {
  const makeTarget = (fx: Fixture, slug = 'docs', settings: Partial<WorkspaceSettings> = {}) =>
    fx.workspaces.create({
      name: slug,
      slug,
      description: '',
      path: `/tmp/metaclaude-${slug}`,
      color: '#6366f1',
      icon: 'folder',
      settings: WorkspaceSettingsSchema.parse(settings),
    });

  /**
   * A run row to delegate *from*.
   *
   * Written straight to the repository rather than submitted, because what
   * `delegate` reads is the row: which workspace the caller is in, what started
   * it, and the ceiling it was admitted under. Passing those as arguments — the
   * shape this had until the gateway could delegate — let a caller describe a
   * run that does not exist, which is the test-double trap from the other side:
   * `runAsk` declared every one of its calls `user`, and nothing checked.
   */
  const originRun = (
    fx: Fixture,
    over: { triggeredBy?: Run['triggeredBy']; ceiling?: Run['ceiling']; workspaceId?: string } = {},
  ): Run =>
    fx.runs.create({
      sessionId: fx.newSession('origin').id,
      workspaceId: over.workspaceId ?? fx.workspace.id,
      prompt: 'the run that asks',
      policy: DEFAULT_TEST_POLICY,
      triggeredBy: over.triggeredBy ?? 'user',
      ...(over.ceiling !== undefined ? { ceiling: over.ceiling } : {}),
    });

  it('runs the prompt in the target workspace and returns its final answer', async () => {
    const target = makeTarget(fixture);

    const result = await fixture.kernel.delegate({
      fromRunId: originRun(fixture).id,
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
      fromRunId: originRun(fixture).id,
      target: 'docs',
      prompt: 'first question',
    });
    const second = await fixture.kernel.delegate({
      fromRunId: originRun(fixture).id,
      target: 'docs',
      prompt: 'second question',
    });

    expect(second.sessionId).toBe(first.sessionId);
  });

  it('refuses delegation to the workspace the run is already in', async () => {
    await expect(
      fixture.kernel.delegate({
        fromRunId: originRun(fixture).id,
        target: 'test',
        prompt: 'ask yourself',
      }),
    ).rejects.toThrow(/different workspace/i);
  });

  it('refuses an unknown workspace by name', async () => {
    await expect(
      fixture.kernel.delegate({
        fromRunId: originRun(fixture).id,
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
        fromRunId: originRun(fx).id,
        target: 'docs',
        prompt: 'slow question',
      });
      await expect(attempt).rejects.toThrow(/did not finish in time/);

      fx.supervisor.finish();
      // `finish()` only resolves the supervisor's promise; the stash, the
      // settle and the slot release all happen across the microtask drain
      // that follows. An immediate check on the map passes *vacuously* —
      // empty because nothing has happened yet — and closing the database
      // then races the tail of the schedule chain, whose `publishMetrics`
      // reads runs from a connection that no longer exists. CI caught that.
      await vi.waitFor(() => expect(fx.finished).toHaveLength(1));
      // Everything after the finished hook — stash, settle, slot release —
      // is synchronous code across microtask continuations, never a timer,
      // so one queued macrotask runs strictly after all of it. This is an
      // ordering drain, not a sleep.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The one observable of a leak is the map itself; a typed escape is
      // the price of asserting absence.
      const settled = (fx.kernel as unknown as { delegationSettled: Map<string, unknown> })
        .delegationSettled;
      expect(settled.size).toBe(0);
    } finally {
      fx.db.close();
    }
  });

  /**
   * The same leak, reached through the other door.
   *
   * The gateway's `start_run` starts a run and walks away — by design, for work
   * too long to hold an HTTP request open. Stashing its outcome anyway would
   * grow the map by one entry, holding a whole run and its final text, for the
   * life of the process; an automation polling every minute would do it all
   * day. So the stash follows the caller's *declared* intent to wait, not the
   * kind of run it is: nobody waits, nothing is kept.
   */
  it('keeps nothing for a run nobody is waiting on', async () => {
    const fx = setup();
    try {
      // Started the way `start_run` starts one — an `api` run, and no waiter.
      // A plain `user` run would prove nothing: it was never stashed.
      const session = fx.newSession();
      await fx.kernel.submit({
        sessionId: session.id,
        prompt: 'fire and forget',
        triggeredBy: 'api',
      });
      await vi.waitFor(() => expect(fx.finished).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const settled = (fx.kernel as unknown as { delegationSettled: Map<string, unknown> })
        .delegationSettled;
      expect(settled.size).toBe(0);
    } finally {
      fx.db.close();
    }
  });

  /**
   * A run cancelled while queued never reaches the supervisor, so the path
   * that settles waiters never runs — and the caller blocks for the whole
   * timeout on a run that has been dead since the moment it was cancelled.
   * Fifty minutes for a delegation; ten for an HTTP caller holding a request
   * open. The answer exists immediately and has to be handed over.
   */
  it('answers a waiter whose run was cancelled before it started', async () => {
    const fx = setup({ maxConcurrentRuns: 1 });
    try {
      fx.workspaces.create({
        name: 'docs', slug: 'docs', description: '',
        path: '/tmp/metaclaude-docs', color: '#6366f1', icon: 'folder',
        settings: WorkspaceSettingsSchema.parse({}),
      });
      // Fill the only slot, so the delegation below queues behind it.
      fx.supervisor.hold();
      const blocker = fx.newSession();
      await fx.kernel.submit({ sessionId: blocker.id, prompt: 'the one running' });

      const attempt = fx.kernel.delegate({
        fromRunId: originRun(fx).id,
        target: 'docs',
        prompt: 'queued behind it',
      });

      // Cancel it while it is still queued.
      const queued = await vi.waitFor(() => {
        const found = fx.runs
          .listRecent({ limit: 20 })
          .find((run) => run.prompt === 'queued behind it');
        expect(found).toBeDefined();
        return found!;
      });
      fx.kernel.interrupt(queued.sessionId);

      const settled = await attempt;
      expect(settled.status).toBe('interrupted');
      expect(settled.error).toMatch(/cancelled/i);

      fx.supervisor.finish();
      await vi.waitFor(() => expect(fx.finished.length).toBeGreaterThanOrEqual(1));
    } finally {
      fx.db.close();
    }
  });

  /**
   * The ceiling is applied *and* recorded, and both halves matter.
   *
   * Applied, it bounds this run — that half always worked. Recorded, it bounds
   * what this run goes on to cause: a gateway run may now consult another
   * workspace exactly as a run started from the interface can, and the row is
   * where the cap is read from when it does. A ceiling written nowhere would
   * have bounded the first hop only.
   */
  it('applies the token’s ceiling to the run and records it on the row', async () => {
    const fx = setup({ settings: { defaultPermissionMode: 'acceptEdits' } });
    try {
      const { run } = await fx.kernel.startForToken({
        workspaceId: fx.workspace.id,
        prompt: 'what do you know about this?',
        ceiling: 'dontAsk',
        label: 'LIA',
        awaited: false,
      });

      const stored = fx.runs.get(run.id);
      expect(stored?.policy.permissionMode).toBe('dontAsk');
      expect(stored?.ceiling).toBe('dontAsk');
      expect(stored?.triggeredBy).toBe('api');

      await vi.waitFor(() => expect(fx.finished).toHaveLength(1));
    } finally {
      fx.db.close();
    }
  });

  it('records no ceiling on a run a person started, so nothing caps what it asks for', async () => {
    const run = await fixture.kernel.submit({ sessionId: fixture.newSession().id, prompt: 'hello' });

    expect(fixture.runs.get(run.id)?.ceiling).toBeNull();
  });

  /**
   * A standing session is the point — an integration's asks build on each
   * other. An unbounded one is the bill: a token used every minute for a year
   * has no natural end, and nobody is watching. Past the ceiling the next call
   * starts a fresh session rather than piling on.
   */
  it('starts a new gateway session once the standing one is full', async () => {
    const fx = setup({ standingSessionMaxEvents: 1 });
    try {
      const first = await fx.kernel.startForToken({
        workspaceId: fx.workspace.id,
        prompt: 'one',
        ceiling: 'plan',
        label: 'n8n',
        awaited: false,
      });
      await vi.waitFor(() => expect(fx.finished).toHaveLength(1));

      const second = await fx.kernel.startForToken({
        workspaceId: fx.workspace.id,
        prompt: 'two',
        ceiling: 'plan',
        label: 'n8n',
        awaited: false,
      });

      expect(second.sessionId).not.toBe(first.sessionId);
      // Same name: the history stays attributable to the token at a glance.
      expect(fx.sessions.get(second.sessionId)?.title).toBe('MCP: n8n');

      // Both runs must land before the database closes under them. The second
      // was started and not awaited, and the tail of its schedule chain reads
      // runs — on a connection this `finally` is about to shut. Same trap the
      // delegation leak test documents, and CI caught it here too.
      await vi.waitFor(() => expect(fx.finished).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      fx.db.close();
    }
  });

  it('reuses the standing session while it still has room', async () => {
    const fx = setup({ standingSessionMaxEvents: 10_000 });
    try {
      const first = await fx.kernel.startForToken({
        workspaceId: fx.workspace.id,
        prompt: 'one',
        ceiling: 'plan',
        label: 'n8n',
        awaited: false,
      });
      await vi.waitFor(() => expect(fx.finished).toHaveLength(1));

      const second = await fx.kernel.startForToken({
        workspaceId: fx.workspace.id,
        prompt: 'two',
        ceiling: 'plan',
        label: 'n8n',
        awaited: false,
      });

      expect(second.sessionId).toBe(first.sessionId);

      await vi.waitFor(() => expect(fx.finished).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
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
        fromRunId: originRun(fixture, { triggeredBy: 'delegation' }).id,
        target: 'docs',
        prompt: 'and now you ask someone else',
      }),
    ).rejects.toThrow(/cannot delegate/i);
  });

  /**
   * Two asks at once land in two sessions, not one refusal.
   *
   * The window looks open — the standing session is chosen, then the run is
   * submitted — and it is closed by construction rather than by a lock: every
   * step between the two is synchronous, and `submit` reserves the session
   * before its first `await`, so the second caller cannot observe the session
   * as idle. Worth pinning because the guarantee is a property of where the
   * awaits are, which a later refactor could move without noticing.
   */
  it('opens a second session for a concurrent ask rather than refusing one', async () => {
    const fx = setup({ maxConcurrentRuns: 4 });
    try {
      fx.workspaces.create({
        name: 'docs', slug: 'docs', description: '',
        path: '/tmp/metaclaude-docs', color: '#6366f1', icon: 'folder',
        settings: WorkspaceSettingsSchema.parse({}),
      });

      const [first, second] = await Promise.all([
        fx.kernel.delegate({ fromRunId: originRun(fx).id, target: 'docs', prompt: 'one' }),
        fx.kernel.delegate({ fromRunId: originRun(fx).id, target: 'docs', prompt: 'two' }),
      ]);

      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.status).toBe('succeeded');
      expect(second.status).toBe('succeeded');
    } finally {
      fx.db.close();
    }
  });

  it('refuses to delegate from a run that does not exist', async () => {
    // The origin row is where the workspace, the trigger and the ceiling all
    // come from. Answering "unknown run" beats defaulting any of the three.
    makeTarget(fixture);

    await expect(
      fixture.kernel.delegate({ fromRunId: 'run_gone', target: 'docs', prompt: 'hello?' }),
    ).rejects.toThrow(/no run/i);
  });

  /**
   * The ceiling has to survive the hop, or it bounds the first run only.
   *
   * A token capped at `dontAsk` reaches a workspace whose own default is
   * `acceptEdits`: without the cap the delegated run edits files on behalf of a
   * caller that was explicitly denied that, by the simple expedient of asking
   * an agent to ask another agent.
   */
  it('caps a delegated run by the ceiling the asking run was admitted under', async () => {
    makeTarget(fixture, 'docs', { defaultPermissionMode: 'acceptEdits' });

    const result = await fixture.kernel.delegate({
      fromRunId: originRun(fixture, { triggeredBy: 'api', ceiling: 'dontAsk' }).id,
      target: 'docs',
      prompt: 'edit the readme',
    });

    const delegated = fixture.runs.get(result.runId);
    expect(delegated?.policy.permissionMode).toBe('dontAsk');
    // And it carries the ceiling onwards, so the bound is a property of the
    // run rather than of the one call that applied it.
    expect(delegated?.ceiling).toBe('dontAsk');
  });

  it('leaves the target’s own mode alone when nothing bounded the asking run', async () => {
    // The interface path: a person asked, and the target's mode is the
    // operator's to set. Capping here would be this release's own change
    // applied where it was never meant to reach.
    makeTarget(fixture, 'docs', { defaultPermissionMode: 'acceptEdits' });

    const result = await fixture.kernel.delegate({
      fromRunId: originRun(fixture).id,
      target: 'docs',
      prompt: 'edit the readme',
    });

    expect(fixture.runs.get(result.runId)?.policy.permissionMode).toBe('acceptEdits');
    expect(fixture.runs.get(result.runId)?.ceiling).toBeNull();
  });

  it('never widens a target that is already narrower than the ceiling', () => {
    // `capPermissionMode` takes the lesser of the two; a ceiling is a maximum
    // and never a grant. Asserted here rather than only in permissions.test.ts
    // because this is the call site that could hand the arguments over the
    // wrong way round.
    expect(capPermissionMode('plan', 'acceptEdits')).toBe('plan');
    expect(capPermissionMode('acceptEdits', 'dontAsk')).toBe('dontAsk');
  });

  /**
   * The standing session of a delegation target used to grow without end.
   *
   * `startForToken` and the steward's own `runStart` both rotate theirs past an
   * event ceiling — "a session nobody closes grows its context every day" — and
   * this one, written first, only checked whether a run was in flight. Three
   * copies of one rule, and the copy that mattered most was the one that
   * accumulates a *second* workspace's context on every ask.
   */
  it('starts a new Delegations session once the standing one is full', async () => {
    const fx = setup({ standingSessionMaxEvents: 1 });
    try {
      fx.workspaces.create({
        name: 'docs', slug: 'docs', description: '',
        path: '/tmp/metaclaude-docs', color: '#6366f1', icon: 'folder',
        settings: WorkspaceSettingsSchema.parse({}),
      });

      const first = await fx.kernel.delegate({
        fromRunId: originRun(fx).id,
        target: 'docs',
        prompt: 'first question',
      });
      const second = await fx.kernel.delegate({
        fromRunId: originRun(fx).id,
        target: 'docs',
        prompt: 'second question',
      });

      expect(second.sessionId).not.toBe(first.sessionId);
      expect(fx.sessions.get(second.sessionId)?.title).toBe('Delegations');
    } finally {
      fx.db.close();
    }
  });
});

/**
 * Conventions reach a run whole, whatever the prompt. Measured before this
 * existed: a pinned "propose defaults rather than ask" was never recalled for a
 * request about deployments, because the prior only ranks what retrieval
 * already found. So the standing shelf is injected first and left out of the
 * similarity search, or the same rule would arrive twice.
 */
describe('surviving a quota refusal', () => {
  /*
   * Measured against the real CLI on a genuinely exhausted Fable bucket: the
   * attempt fails with "You've reached your Fable 5 limit", and that was the
   * whole of it — a hard stop for a condition another model could serve, since
   * Sonnet answered the same prompt seconds later.
   */
  /**
   * A reset time *relative to now*, and that is the whole point.
   *
   * `ModelAvailability` is the one collaborator here the kernel drives with
   * the wall clock: `block()` and `blocked()` both default their `now` to
   * `Date.now()`, and a hold whose reset has passed is dropped on read. So an
   * absolute date in this fixture is a test that passes until that instant
   * and fails for ever after — this one was `Date.UTC(2026, 8, 8, 16, 0, 0)`
   * and went red on 2026-09-08 at 16:00 UTC, on a subsystem nobody had
   * touched. An hour ahead of whenever the suite runs cannot expire.
   */
  const refusal = (model: string, scope: 'model' | 'global' = 'model') => ({
    status: 'failed' as const,
    error: `You've reached your ${model} limit.`,
    quotaBlock: { model, scope, resetsAt: Date.now() + 60 * 60 * 1000 },
  });

  const notes = (fx: Fixture, runId: string): string[] =>
    fx.transcript
      .byRun(runId)
      .filter((event) => event.kind === 'system')
      .map((event) => (event as Extract<TranscriptEvent, { kind: 'system' }>).message);

  it('switches model, says so, and finishes the run', async () => {
    const session = fixture.newSession();
    fixture.supervisor.nextOutcomes = [refusal('fable'), { status: 'succeeded' }];

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: 'fable', effort: 'high' },
    });
    await settled(fixture, run.id);

    // The run succeeded rather than dying on a refusal another model could serve.
    expect(fixture.runs.get(run.id)?.status).toBe('succeeded');
    // Two attempts, the second on a different model.
    expect(fixture.supervisor.started).toHaveLength(2);
    expect(fixture.supervisor.started[1]?.policy.model).not.toBe('fable');
    // And the operator was told, in words that name both models.
    const warned = notes(fixture, run.id).find((m) => m.includes('fable'));
    expect(warned).toBeDefined();
    expect(warned).toContain('switch 1 of 3');
  });

  it('resumes the CLI session the refused attempt opened', async () => {
    // Measured: a refused attempt still yields a resumable session id, and it
    // carries no user turn — so re-pushing the prompt does not duplicate it.
    const session = fixture.newSession();
    fixture.supervisor.nextOutcomes = [
      { ...refusal('fable'), claudeSessionId: 'cli-session-1' },
      { status: 'succeeded' },
    ];

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: 'fable', effort: 'high' },
    });
    await settled(fixture, run.id);

    expect(fixture.supervisor.started[1]?.resumeSessionId).toBe('cli-session-1');
    expect(fixture.supervisor.started[1]?.prompt).toBe('a question');
  });

  it('does not switch when the window every model draws on is the one that ran out', async () => {
    // Switching would buy three more refusals and a transcript that claims to
    // have tried something it could not.
    const session = fixture.newSession();
    fixture.supervisor.nextOutcomes = [refusal('fable', 'global')];

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: 'fable', effort: 'high' },
    });
    await settled(fixture, run.id);

    expect(fixture.supervisor.started).toHaveLength(1);
    expect(fixture.runs.get(run.id)?.status).toBe('failed');
    expect(notes(fixture, run.id).some((m) => m.includes('overall usage limit'))).toBe(true);
  });

  it('gives up after three switches rather than pretending to keep trying', async () => {
    const session = fixture.newSession();
    fixture.supervisor.nextOutcomes = [
      refusal('fable'),
      refusal('opus'),
      refusal('sonnet'),
      refusal('haiku'),
    ];

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: 'fable', effort: 'high' },
    });
    await settled(fixture, run.id);

    // Four attempts: the original plus three switches, and no more.
    expect(fixture.supervisor.started).toHaveLength(4);
    expect(fixture.runs.get(run.id)?.status).toBe('failed');
    expect(notes(fixture, run.id).some((m) => m.includes('changed model 3 times'))).toBe(true);
  });

  it('remembers the refusal so the next run does not rediscover it', async () => {
    const session = fixture.newSession();
    fixture.supervisor.nextOutcomes = [refusal('fable'), { status: 'succeeded' }];
    const first = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'one',
      overrides: { model: 'fable', effort: 'high' },
    });
    await settled(fixture, first.id);

    expect(fixture.availability.blocked()).toContain('fable');

    // A second run on Auto must not be handed the model that just refused.
    fixture.supervisor.started.length = 0;
    fixture.policy.select.mockReturnValue({ arm: { model: 'fable', effort: 'high' }, confidence: 1 });
    fixture.supervisor.nextOutcomes = [refusal('fable'), { status: 'succeeded' }];
    const second = await fixture.kernel.submit({ sessionId: session.id, prompt: 'two' });
    await settled(fixture, second.id);

    const switched = fixture.supervisor.started.at(-1);
    expect(switched?.policy.model).not.toBe('fable');
  });

  it('credits the arm that ran, not the one that was refused', async () => {
    // A quota refusal says nothing about a model's quality. Crediting the
    // refused arm would teach the bandit about a model that never answered.
    const session = fixture.newSession();
    fixture.supervisor.nextOutcomes = [refusal('fable'), { status: 'succeeded' }];

    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'a question',
      overrides: { model: 'fable', effort: 'high' },
    });
    await settled(fixture, run.id);

    const stored = fixture.runs.get(run.id);
    expect(stored?.policy.model).not.toBe('fable');
    await vi.waitFor(() => expect(fixture.policy.update).toHaveBeenCalled());
    const credited = fixture.policy.update.mock.calls.at(-1)?.[0] as { arm: { model: string } };
    expect(credited.arm.model).not.toBe('fable');
  });
});

describe('standing conventions', () => {
  it('injects the standing shelf ahead of recall, credits it, and keeps it out of the search', async () => {
    const convention: Memory = {
      id: 'mem_rule', workspaceId: fixture.workspace.id, kind: 'procedural', shelf: 'standing', retiredAt: null,
      supersededBy: null, title: 'Propose defaults', content: 'Offer a default rather than ask three questions.',
      tags: [], confidence: 0.9, useCount: 0, successCount: 0, pinned: true, sourceRunId: null,
      createdAt: 0, updatedAt: 0, lastUsedAt: null,
    };
    fixture.memory.standing.mockReturnValue([convention]);

    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'Deploy the latest tag to production.' });
    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));

    const request = fixture.supervisor.started[0]!;
    // The standing shelf is the counter-example to the preamble rule: it is
    // injected whole regardless of the request, so it is stable across the
    // session and belongs in the cached prefix. Recall is not, and does not.
    expect(request.systemPromptAppend).toContain('## Standing conventions');
    expect(request.systemPromptAppend).toContain('Offer a default rather than ask three questions.');
    expect(request.contextPreamble).not.toContain('## Standing conventions');
    expect(fixture.memory.recordUsage).toHaveBeenCalledWith(run.id, [{ memory: convention, score: 1 }]);
    expect(fixture.memory.search).toHaveBeenCalledWith(
      'Deploy the latest tag to production.',
      expect.objectContaining({ excludeStanding: true }),
    );
  });
});

describe('knowledge injection', () => {
  it('injects retrieved passages into the per-message preamble and credits exactly them', async () => {
    await fixture.knowledge.upsert({
      workspaceId: fixture.workspace.id,
      title: 'Bail — 12 rue des Lilas',
      content: '## Résiliation\nLe préavis de résiliation du bail est de 45 jours en zone tendue.',
    });
    await fixture.knowledge.upsert({
      workspaceId: null,
      title: 'Conventions',
      content: '## Style\nLes messages de commit se rédigent au présent.',
    });

    const session = fixture.newSession();
    const run = await fixture.kernel.submit({
      sessionId: session.id,
      prompt: 'Quel est le préavis de résiliation du bail ?',
    });
    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));

    const request = fixture.supervisor.started[0]!;
    // The passage travelled, with its source named so the model can cite it —
    // in the preamble, because retrieval is keyed on this prompt and so differs
    // run to run, and a system prompt that differs rewrites the cached prefix.
    expect(request.contextPreamble).toContain('45 jours');
    expect(request.contextPreamble).toContain('Bail — 12 rue des Lilas');
    expect(request.systemPromptAppend).not.toContain('45 jours');
    // And the genesis can say so: usage was credited for this run.
    const consulted = fixture.knowledge.consultedFor(run.id);
    expect(consulted.length).toBeGreaterThan(0);
    expect(consulted[0]!.title).toBe('Bail — 12 rue des Lilas');
  });

  it('injects nothing and credits nothing when the workspace switched it off', async () => {
    const fx = setup({ settings: { knowledgeEnabled: false } });
    try {
      await fx.knowledge.upsert({
        workspaceId: fx.workspace.id,
        title: 'Bail',
        content: '## Résiliation\nLe préavis de résiliation du bail est de 45 jours.',
      });

      const session = fx.newSession();
      const run = await fx.kernel.submit({
        sessionId: session.id,
        prompt: 'Quel est le préavis de résiliation du bail ?',
      });
      await vi.waitFor(() => expect(fx.finished.map((r) => r.id)).toContain(run.id));

      expect(fx.supervisor.started[0]!.contextPreamble ?? '').not.toContain('45 jours');
      expect(fx.supervisor.started[0]!.systemPromptAppend ?? '').not.toContain('45 jours');
      expect(fx.knowledge.consultedFor(run.id)).toEqual([]);
    } finally {
      fx.db.close();
    }
  });

  it('a failing knowledge store never fails the run', async () => {
    vi.spyOn(fixture.knowledge, 'search').mockRejectedValueOnce(new Error('index corrompu'));

    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'peu importe' });
    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));

    expect(fixture.runs.get(run.id)?.status).toBe('succeeded');
  });
});

/**
 * The language directive.
 *
 * `auto` has to add nothing — not "answer in whatever language", which would
 * spend tokens on every run to restate the default — and the two explicit
 * settings have to reach subagents, since that is the whole reason the
 * setting exists: the library's twenty-three agents all carry English
 * prompts, so delegated work came back in English out of a French
 * conversation.
 */
describe('languageDirective', () => {
  it('says nothing at all on auto', () => {
    expect(languageDirective('auto')).toBe('');
  });

  it('names the language, and reaches the subagents', () => {
    for (const [setting, name] of [['fr', 'French'], ['en', 'English']] as const) {
      const directive = languageDirective(setting);
      expect(directive).toContain(name);
      expect(directive).toMatch(/subagent/i);
    }
  });

  it('exempts what must not be translated', () => {
    // A run that renamed identifiers or translated command output to satisfy
    // a language setting would be worse than one that answered in English.
    expect(languageDirective('fr')).toMatch(/code|identifier/i);
  });
});

/**
 * A delegation must outlast the run it is waiting on, whatever that run's
 * ceiling is.
 *
 * The constant was 50 minutes with a comment saying it "outlasts the run
 * timeout" — true against the 45-minute default of the day, and silently false
 * the moment an operator raised `METACLAUDE_RUN_TIMEOUT_MS` past it. The waiter
 * would then give up first and report a delegation as timed out while the
 * delegated run was still working, which is the worst of both: a wrong answer
 * and a run nobody is reading any more.
 *
 * Raising the default to four hours made the comment false in the shipped
 * configuration, which is what forced the derivation.
 */
describe('the delegation waiter against the run ceiling', () => {
  it('waits longer than the run may possibly take', () => {
    for (const runTimeoutMs of [45 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000]) {
      expect(delegationTimeoutFor(runTimeoutMs)).toBeGreaterThan(runTimeoutMs);
    }
  });

  /**
   * A run with no absolute ceiling still cannot make the waiter wait forever:
   * the caller of a delegation is itself a run, and a promise nobody settles
   * would hold its slot until its own ceiling. So an unbounded run gets a
   * bounded wait, and the wait is the thing that reports.
   */
  it('stays finite when the run has no ceiling at all', () => {
    const unbounded = delegationTimeoutFor(0);
    expect(unbounded).toBeGreaterThan(0);
    expect(Number.isFinite(unbounded)).toBe(true);
  });
});

/**
 * What a run was offered, and what it reached for.
 *
 * Driven through the real kernel rather than by calling the fold directly,
 * because the fold's own tests already pin what it makes of an event list and
 * would not notice the two things that can go wrong here: an availability list
 * assembled from the wrong place, and a write that never happens because the
 * workspace switched something off. Measured in production before this
 * existed: ten extensions mounted, zero invocations, and nothing anywhere that
 * could tell that from ten extensions doing their job.
 */
describe('extension usage', () => {
  const skillCall = (skill: string, runId: string): TranscriptEvent => ({
    kind: 'tool_call',
    id: `ev_${skill}`,
    runId,
    seq: 1,
    at: Date.now(),
    toolUseId: `tu_${skill}`,
    name: 'Skill',
    input: { skill },
    status: 'ok',
    result: null,
    resultIsError: false,
    durationMs: null,
  });

  /** Offer the run one skill and one subagent, the way the registry would. */
  function offer(fixture: ReturnType<typeof setup>): void {
    (fixture.contextProvider.resolve as ReturnType<typeof vi.fn>).mockReturnValue({
      mcpServers: {},
      agents: { 'code-reviewer': { description: 'd', prompt: 'p' } },
      skills: [{ id: 'skl_1', name: 'review-migrations' }],
    });
  }

  it('records what was offered even when nothing was invoked', async () => {
    const fixture = setup();
    offer(fixture);
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'Do a thing please' });
    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));

    await vi.waitFor(() => expect(usageForRun(fixture.db, run.id)).toHaveLength(2));
    expect(usageForRun(fixture.db, run.id)).toEqual([
      { kind: 'agent', extensionId: 'code-reviewer', name: 'code-reviewer', available: true, invoked: 0, failed: 0 },
      { kind: 'skill', extensionId: 'skl_1', name: 'review-migrations', available: true, invoked: 0, failed: 0 },
    ]);
  });

  it('counts an invocation the run actually made', async () => {
    const fixture = setup();
    offer(fixture);
    fixture.supervisor.hold();
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'Review the migration' });

    await vi.waitFor(() => expect(fixture.supervisor.holding).toBe(1));
    fixture.transcript.append(session.id, { ...skillCall('review-migrations', run.id), seq: undefined } as never);
    fixture.supervisor.finish();

    await vi.waitFor(() =>
      expect(usageForRun(fixture.db, run.id).find((row) => row.kind === 'skill')).toMatchObject({ invoked: 1 }),
    );
  });

  /**
   * Reflexion is a workspace setting; whether a skill was opened is not an
   * opinion. Recording this under that gate would leave a workspace that
   * turned reflexion off unable to see that its own extensions go unused —
   * which is the one question the table exists for.
   */
  it('records usage even where reflexion is switched off', async () => {
    const fixture = setup({ settings: { reflexionEnabled: false } });
    offer(fixture);
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'Do a thing please' });
    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));

    await vi.waitFor(() => expect(usageForRun(fixture.db, run.id)).toHaveLength(2));
  });

  it('writes nothing at all for a workspace that offers nothing', async () => {
    const fixture = setup();
    const session = fixture.newSession();
    const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'Do a thing please' });
    await vi.waitFor(() => expect(fixture.finished.map((r) => r.id)).toContain(run.id));

    expect(usageForRun(fixture.db, run.id)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Freshening the workspace before a run reads it                              */
/* -------------------------------------------------------------------------- */

/**
 * Whatever has to be *fresh at mount* is prepared here, for every run.
 *
 * This is the guard on a defect that shipped for a long time and could not be
 * seen from any screen. Writing the workspace's skills to disk lived at the
 * call sites instead — and there are eight places that submit a run, of which
 * three had the call: the session route, the board route and the autopilot.
 * The five without it were the scheduler, the steward, the advisor, delegation
 * and the MCP gateway, which is to say every run nobody is watching. Those ran
 * against whatever the last interactive message had left on disk: a skill
 * created that morning was invisible to the nightly automation, and a skill
 * deleted went on being offered to it for ever.
 *
 * The run still succeeded, so nothing reported it; and `run_extension_usages`
 * recorded the skill as offered-and-never-opened from the *database* list,
 * which is the sentence the weekly instruction review reads and acts on. It
 * would have proposed rewriting a description that was never the problem.
 *
 * Moving it into `execute` is what makes forgetting impossible, and the table
 * below is what says so: a trigger added later fails here rather than in
 * production six months on.
 */
describe('preparing the workspace', () => {
  const triggers = ['user', 'automation', 'loop', 'system', 'delegation', 'api'] as const;

  it.each(triggers)('prepares before resolving, whatever started the run (%s)', async (triggeredBy) => {
    const fixture = setup();
    try {
      const session = fixture.newSession();
      const run = await fixture.kernel.submit({
        sessionId: session.id,
        prompt: 'do the thing',
        triggeredBy,
      });
      await settled(fixture, run.id);

      // Order, not merely presence: freshening after the read is not freshening.
      expect(fixture.contextCalls).toEqual(['prepare', 'resolve']);
    } finally {
      fixture.db.close();
    }
  });

  /**
   * A workspace that cannot be freshened is a workspace that runs anyway.
   *
   * The alternative — failing the run — trades a degraded run for no run at
   * all, on a path where the usual cause is a directory permission rather than
   * anything about the message. `context.ts` swallows what it can inside
   * `prepare`; this covers the case it cannot, so a future failure there is a
   * line in the log and not a workspace that has stopped answering.
   */
  it('runs anyway when preparation fails', async () => {
    const fixture = setup();
    try {
      (fixture.contextProvider.prepare as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('EACCES'),
      );
      const session = fixture.newSession();
      const run = await fixture.kernel.submit({ sessionId: session.id, prompt: 'do the thing' });

      expect((await settled(fixture, run.id)).status).toBe('succeeded');

      // And it says so where the run is read. A run that behaved differently
      // from the one before it — stale skills — must be able to account for
      // itself on screen, not only in a log nobody opens.
      const notes = fixture.transcript
        .byRun(run.id)
        .filter((event) => event.kind === 'system');
      expect(notes.map((note) => note.message).join(' ')).toContain('could not be prepared');
    } finally {
      fixture.db.close();
    }
  });
});
