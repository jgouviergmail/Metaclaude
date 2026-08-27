/**
 * The kernel.
 *
 * Owns the lifecycle of every agent run: admission, scheduling, execution,
 * accounting, and the learning loop that closes after the run finishes.
 *
 * The shape of a run:
 *
 *   classify → choose policy → retrieve memory → execute → record →
 *   compute reward → update the bandit → reinforce memory → reflect
 *
 * Only the `execute` step talks to Claude. Everything around it is bookkeeping
 * that turns one run into evidence for the next one.
 */

import type {
  ApprovalRequest,
  MarketplaceSource,
  RewindResult,
  Run,
  RunPolicy,
  Session,
  TranscriptEvent,
  Workspace,
} from '@metaclaude/shared';
import { newId, sessionTopic, SYSTEM_TOPIC, workspaceTopic } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import type { PolicyLearner } from '../learning/bandit.js';
import { computeReward } from '../learning/bandit.js';
import type { TaskCategory, TaskClassifier } from '../learning/classifier.js';
import type { MemoryStore } from '../learning/memory.js';
import type { ReflexionEngine } from '../learning/reflexion.js';
import type { AttachmentService } from '../services/attachments.js';
import type { EventBus } from './bus.js';
import { selectMemoryContext } from './context.js';
import { PermissionBroker } from './permissions.js';
import { planRewind } from './rewind.js';
import type { RunRepo, SessionRepo, TranscriptRepo, WorkspaceRepo } from './repositories.js';
import { AgentSupervisor, type RunRequest } from './supervisor.js';

/**
 * How long a clean stop is given before the run is killed outright.
 *
 * Long enough for the CLI to finish the tool call it is inside and flush the
 * transcript; short enough that the operator who tapped Stop does not wonder
 * whether it worked.
 */
const INTERRUPT_GRACE_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface RuntimeContext {
  /** MCP servers to expose, already resolved with their decrypted secrets. */
  mcpServers: Record<string, unknown>;
  /** Custom agents available to the run. */
  agents: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  /**
   * Enabled plugin marketplaces, keyed by name. Optional because most
   * providers have none; the kernel normalises absence to an empty record.
   */
  marketplaces?: Record<string, { source: MarketplaceSource }>;
}

/** Supplies per-workspace runtime configuration. Implemented by the services layer. */
export interface ContextProvider {
  resolve(workspace: Workspace): RuntimeContext;
}

export interface SubmitOptions {
  sessionId: string;
  prompt: string;
  triggeredBy?: Run['triggeredBy'];
  /** Pending attachments this message carries; bound to the run at admission. */
  attachmentIds?: string[];
  /** Explicit overrides; when absent the workspace default or the bandit decides. */
  overrides?: Partial<
    Pick<RunPolicy, 'model' | 'effort' | 'permissionMode' | 'agentName' | 'ultracode' | 'toolControls'>
  >;
}

export interface KernelDeps {
  db: Db;
  bus: EventBus;
  workspaces: WorkspaceRepo;
  sessions: SessionRepo;
  runs: RunRepo;
  transcript: TranscriptRepo;
  memory: MemoryStore;
  classifier: TaskClassifier;
  policy: PolicyLearner;
  reflexion: ReflexionEngine;
  contextProvider: ContextProvider;
  supervisor: AgentSupervisor;
  attachments: AttachmentService;
  maxConcurrentRuns: number;
  /** How long a delegation waits for its run. Injectable so tests need not. */
  delegationTimeoutMs?: number;
  /**
   * Called once per run, after it reaches a terminal state and its usage has
   * been recorded. A direct hook rather than an event-bus subscription: run
   * frames are published to session and workspace topics, and adding them to
   * `system` purely so one server-side listener could see them would fan out a
   * frame to every connected client for every run in the OS.
   */
  onRunFinished?: (run: Run) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

interface ActiveRun {
  run: Run;
  session: Session;
  controller: AbortController;
  toolErrors: number;
}

/* -------------------------------------------------------------------------- */
/* Kernel                                                                      */
/* -------------------------------------------------------------------------- */

/** Thrown out of `acquireSlot` when a queued run is cancelled before it starts. */
class RunCancelled extends Error {
  constructor() {
    super('The run was cancelled before it started.');
    this.name = 'RunCancelled';
  }
}

/** Outlasts the run timeout, so the timeout's own report arrives first. */
const DELEGATION_TIMEOUT_MS = 50 * 60_000;

export class Kernel {
  readonly broker: PermissionBroker;

  private readonly active = new Map<string, ActiveRun>();
  /**
   * Runs admitted but waiting for a concurrency slot, FIFO.
   *
   * `reject` is what makes cancellation real: resolving a queued waiter would
   * *grant* it the slot and start the run the operator just asked to stop.
   */
  private readonly queue: Array<{
    runId: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  /**
   * Sessions with a run admitted but not yet in `active`.
   *
   * `submit()` awaits the classifier before the run reaches the scheduler, and
   * `execute()` only registers in `active` a microtask later. Without a
   * synchronous reservation across that window, two concurrent submits both
   * pass the "already running?" check, resume the same Claude session id and
   * interleave their transcripts.
   */
  private readonly reserved = new Set<string>();

  /**
   * Delegated runs waiting to be observed.
   *
   * The final text exists only on the `RunOutcome`, and a delegation's caller
   * may register interest either before or after the run settles — the fake
   * supervisor resolves in a microtask, and the real one can race a slow
   * caller the same way. So completion stashes the result, the slot release
   * marks it ready, and `waitForDelegation` consumes a ready stash or waits.
   */
  private readonly delegationWaiters = new Map<
    string,
    (result: { run: Run; finalText: string }) => void
  >();
  /** `ready` flips once the slot is released — the only point a waiter may resolve. */
  private readonly delegationSettled = new Map<
    string,
    { run: Run; finalText: string; ready: boolean }
  >();
  /**
   * Delegations whose waiter gave up (timeout). Their stash arrives later and
   * nobody will ever consume it, so settlement discards it — without this,
   * every timed-out delegation leaked one entry for the life of the process.
   */
  private readonly delegationAbandoned = new Set<string>();

  private shuttingDown = false;

  constructor(private readonly deps: KernelDeps) {
    this.broker = new PermissionBroker({
      onRequest: (request) => this.onApprovalRequested(request),
      onResolved: (approvalId, approved) => this.onApprovalResolved(approvalId, approved),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Submission                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Admit a run and start it (or queue it).
   *
   * Returns as soon as the run row exists, so the HTTP request that triggered it
   * can respond immediately; the work proceeds on the event bus.
   */
  async submit(options: SubmitOptions): Promise<Run> {
    if (this.shuttingDown) throw new Error('The server is shutting down.');

    const session = this.deps.sessions.get(options.sessionId);
    if (!session) throw new Error(`Unknown session: ${options.sessionId}`);

    const workspace = this.deps.workspaces.get(session.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${session.workspaceId}`);

    if (this.hasActiveRunForSession(session.id)) {
      throw new Error('This session already has a run in flight. Interrupt it or wait for it to finish.');
    }

    const prompt = options.prompt.trim();
    if (!prompt) throw new Error('The prompt is empty.');

    // Claim the session synchronously, before the first await. Everything from
    // here to the point the run enters `active` must be covered.
    this.reserved.add(session.id);

    try {
      /* -- Classify, then pick a policy ---------------------------------- */
      const classification = await this.deps.classifier.classify(prompt, workspace.id);
      const policy = this.choosePolicy(
        workspace,
        session,
        classification.category,
        options.overrides,
      );

      const run = this.deps.runs.create({
        sessionId: session.id,
        workspaceId: workspace.id,
        prompt,
        policy,
        triggeredBy: options.triggeredBy ?? 'user',
        category: classification.category,
      });

      // Bind the message's attachments before anything can execute. The
      // service's UPDATE only lands where run_id IS NULL, so a pending upload
      // is consumed exactly once; a failed bind (already sent, wrong session)
      // fails the whole admission rather than running with half the files.
      if (options.attachmentIds?.length) {
        try {
          this.deps.attachments.bind(options.attachmentIds, session.id, run.id);
        } catch (error) {
          this.deps.runs.finish(run.id, {
            status: 'failed',
            usage: run.usage,
            error: (error as Error).message,
          });
          this.publishRun(this.deps.runs.get(run.id) as Run);
          throw error;
        }
      }

      // The first prompt names the session, so the sidebar reads well at a glance.
      if (!session.title.trim()) {
        this.deps.sessions.setTitle(session.id, deriveTitle(prompt));
        this.publishSession(session.id);
      }

      this.publishRun(run);
      void this.schedule(run, session, workspace, classification.category);
      return run;
    } catch (error) {
      // The run never reached the scheduler, so nothing else will release it.
      this.reserved.delete(session.id);
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Delegation — the society of sessions                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Run a prompt in *another* workspace on behalf of a running agent, and
   * wait for the answer.
   *
   * The delegated run is a real run: recorded in the target workspace's
   * history, counted in its usage, learned from like any other — and it runs
   * with the *target's* context: its memory, skills, conventions and
   * permission mode. That asymmetry is the point; a workspace consulted
   * through its own agent answers better than its files read cold.
   *
   * Depth is one, structurally: a run triggered by delegation cannot
   * delegate again, so every delegation chain is exactly two runs long and
   * attributable to the human-started run at its root. A→B→A loops cannot
   * form, and quota cannot burn in a circle with nobody watching.
   */
  async delegate(input: {
    fromWorkspaceId: string;
    fromTriggeredBy: Run['triggeredBy'];
    /** The target workspace's slug (exact) — never an id, agents speak names. */
    target: string;
    prompt: string;
  }): Promise<{ runId: string; sessionId: string; status: Run['status']; finalText: string; error: string | null }> {
    if (input.fromTriggeredBy === 'delegation') {
      throw new Error(
        'A delegated run cannot delegate further — take the answer back and continue yourself.',
      );
    }

    const target = this.deps.workspaces.list().find((workspace) => workspace.slug === input.target);
    if (!target) {
      throw new Error(`There is no workspace with the slug "${input.target}".`);
    }
    if (target.id === input.fromWorkspaceId) {
      throw new Error('Delegation is for consulting a different workspace — this is your own.');
    }

    // One standing session per workspace accumulates delegation context, the
    // same way a continuous automation does. Busy (a delegation already in
    // flight there) means a parallel session rather than a refusal.
    const sessions = this.deps.sessions.list(target.id, { includeArchived: false });
    let session = sessions.find(
      (candidate) => candidate.title === 'Delegations' && !this.hasActiveRunForSession(candidate.id),
    );
    session ??= this.deps.sessions.create({
      workspaceId: target.id,
      title: 'Delegations',
      model: String(target.settings.defaultModel),
      effort: target.settings.defaultEffort,
      permissionMode: target.settings.defaultPermissionMode,
    });

    const run = await this.submit({
      sessionId: session.id,
      prompt: input.prompt,
      triggeredBy: 'delegation',
    });

    const settled = await this.waitForDelegation(
      run.id,
      this.deps.delegationTimeoutMs ?? DELEGATION_TIMEOUT_MS,
    );
    return {
      runId: settled.run.id,
      sessionId: session.id,
      status: settled.run.status,
      finalText: settled.finalText,
      error: settled.run.error,
    };
  }

  /** Consume a ready stash, or wait for settleDelegation to hand one over. */
  private waitForDelegation(
    runId: string,
    timeoutMs: number,
  ): Promise<{ run: Run; finalText: string }> {
    const stashed = this.delegationSettled.get(runId);
    if (stashed?.ready) {
      this.delegationSettled.delete(runId);
      return Promise.resolve(stashed);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.delegationWaiters.delete(runId);
        this.delegationAbandoned.add(runId);
        reject(new Error('The delegated run did not finish in time.'));
      }, timeoutMs);
      timer.unref?.();
      this.delegationWaiters.set(runId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /**
   * Decide model, effort and permission mode for a run.
   *
   * Precedence: explicit request → learned policy (when enabled and confident)
   * → workspace default. The operator's choice always wins.
   */
  private choosePolicy(
    workspace: Workspace,
    session: Session,
    category: TaskCategory,
    overrides: SubmitOptions['overrides'],
  ): RunPolicy {
    const settings = workspace.settings;

    const base: RunPolicy = {
      model: session.model || settings.defaultModel,
      effort: session.effort ?? settings.defaultEffort,
      permissionMode: session.permissionMode || settings.defaultPermissionMode,
      thinking: settings.thinking,
      thinkingBudgetTokens: settings.thinkingBudgetTokens,
      agentName: session.agentName,
      ultracode: false,
      source: 'workspace',
    };

    if (settings.autoPolicyEnabled && !overrides?.model && !overrides?.effort) {
      const learned = this.deps.policy.select(workspace.id, category);
      if (learned) {
        base.model = learned.arm.model;
        base.effort = learned.arm.effort;
        base.source = 'learned';
      }
    }

    if (overrides?.model !== undefined) {
      base.model = overrides.model;
      base.source = 'explicit';
    }
    if (overrides?.effort !== undefined) {
      base.effort = overrides.effort;
      base.source = 'explicit';
    }
    if (overrides?.permissionMode !== undefined) base.permissionMode = overrides.permissionMode;
    if (overrides?.agentName !== undefined) base.agentName = overrides.agentName;
    // Never learned, never a workspace default: orchestration multiplies cost,
    // so it exists only as a per-message choice. The bandit cannot pick it and
    // a stored setting cannot leave it quietly on.
    if (overrides?.ultracode !== undefined) base.ultracode = overrides.ultracode;
    // Same rule: tool steering is a per-message decision, never a stored one.
    if (overrides?.toolControls !== undefined) base.toolControls = overrides.toolControls;

    return base;
  }

  /* ---------------------------------------------------------------------- */
  /* Scheduling                                                              */
  /* ---------------------------------------------------------------------- */

  /** Wait for a concurrency slot, then execute. */
  private async schedule(
    run: Run,
    session: Session,
    workspace: Workspace,
    category: TaskCategory,
  ): Promise<void> {
    try {
      await this.acquireSlot(run.id);
    } catch {
      // Cancelled while queued: no slot was ever held, so none is released.
      this.reserved.delete(session.id);
      this.deps.runs.finish(run.id, {
        status: 'interrupted',
        usage: run.usage,
        error: 'Cancelled before it started.',
      });
      this.deps.sessions.setStatus(session.id, 'idle');
      this.publishRun(this.deps.runs.get(run.id) as Run);
      this.publishSession(session.id);
      this.publishMetrics();
      return;
    }

    try {
      await this.execute(run, session, workspace, category);
    } catch (error) {
      this.deps.log('error', `unhandled kernel error on run ${run.id}`, {
        message: (error as Error).message,
      });
      this.deps.runs.finish(run.id, {
        status: 'failed',
        usage: run.usage,
        error: (error as Error).message,
      });
      this.deps.sessions.setStatus(session.id, 'error');
      this.publishRun(this.deps.runs.get(run.id) as Run);
      this.publishSession(session.id);
    } finally {
      // `execute` owns removing itself from `active`; this only frees the slot
      // and lets the next queued run in.
      this.reserved.delete(session.id);
      this.releaseSlot();
    }
  }

  private acquireSlot(runId: string): Promise<void> {
    if (this.active.size < this.deps.maxConcurrentRuns) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ runId, resolve, reject });
      this.publishMetrics();
    });
  }

  private releaseSlot(): void {
    this.queue.shift()?.resolve();
    this.publishMetrics();
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                               */
  /* ---------------------------------------------------------------------- */

  private async execute(
    run: Run,
    session: Session,
    workspace: Workspace,
    category: TaskCategory,
  ): Promise<void> {
    const controller = new AbortController();
    const activeRun: ActiveRun = { run, session, controller, toolErrors: 0 };
    this.active.set(run.id, activeRun);

    // Anything between the `set` above and the supervisor call can throw —
    // vault decryption in `contextProvider.resolve`, a SQLITE_BUSY, a synchronous
    // throw out of `buildOptions`. Without this the entry stays in `active`
    // forever: that session can never run again and a slot is gone for good.
    try {
      await this.runToCompletion(run, session, workspace, category, activeRun, controller);
    } finally {
      this.active.delete(run.id);
      this.broker.cancelRun(run.id);
      // Only after the slot is truly released: a delegation resolved earlier
      // would see its own just-finished run as "still active" and open a
      // needless parallel session for the next sequential ask.
      this.settleDelegation(run);
    }
  }

  /** Resolve a delegation's waiter, or mark its stash consumable. */
  private settleDelegation(run: Run): void {
    if (run.triggeredBy !== 'delegation') return;

    if (this.delegationAbandoned.delete(run.id)) {
      this.delegationSettled.delete(run.id);
      return;
    }

    let settled = this.delegationSettled.get(run.id);
    if (!settled) {
      // runToCompletion threw before stashing — a failure path, but the
      // waiter must still get an answer rather than a 50-minute timeout.
      const current = this.deps.runs.get(run.id) ?? run;
      settled = { run: current, finalText: '', ready: true };
      this.delegationSettled.set(run.id, settled);
    }
    settled.ready = true;

    const waiter = this.delegationWaiters.get(run.id);
    if (waiter) {
      this.delegationWaiters.delete(run.id);
      this.delegationSettled.delete(run.id);
      waiter(settled);
    }
  }

  private async runToCompletion(
    run: Run,
    session: Session,
    workspace: Workspace,
    category: TaskCategory,
    activeRun: ActiveRun,
    controller: AbortController,
  ): Promise<void> {
    this.deps.runs.setStatus(run.id, 'running');
    this.deps.sessions.setStatus(session.id, 'running');
    this.publishRun({ ...run, status: 'running' });
    this.publishSession(session.id);
    this.publishMetrics();

    /* -- Retrieve memory -------------------------------------------------- */
    let systemPromptAppend = workspace.settings.systemPromptAppend;
    if (workspace.settings.memoryEnabled) {
      try {
        const retrieved = await this.deps.memory.search(run.prompt, {
          workspaceId: workspace.id,
          limit: 8,
        });
        if (retrieved.length > 0) {
          // Credit what was injected, not what was retrieved: the budget can
          // drop the tail, and a memory the model never saw must not be
          // reinforced for the outcome — nor have its decay clock reset, which
          // is what would make it unreapable. See selectMemoryContext.
          const { text, injected } = selectMemoryContext(retrieved);
          if (injected.length > 0) this.deps.memory.recordUsage(run.id, injected);
          systemPromptAppend = [systemPromptAppend, text].filter(Boolean).join('\n\n');
        }
      } catch (error) {
        // Retrieval is an enhancement. If it fails, run without it.
        this.deps.log('warn', 'memory retrieval failed', { message: (error as Error).message });
      }
    }

    /* -- Execute ---------------------------------------------------------- */
    const runtime = this.deps.contextProvider.resolve(workspace);
    const topic = sessionTopic(session.id);

    const request: RunRequest = {
      runId: run.id,
      sessionId: session.id,
      workspace,
      prompt: run.prompt,
      policy: run.policy,
      resumeSessionId: session.claudeSessionId,
      systemPromptAppend,
      mcpServers: runtime.mcpServers,
      agents: runtime.agents,
      marketplaces: runtime.marketplaces ?? {},
      triggeredBy: run.triggeredBy,
      attachments: this.deps.attachments.byRun(run.id).map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        path: attachment.path,
        mime: attachment.mime,
        bytes: attachment.bytes,
        absolutePath: this.deps.attachments.absolutePath(attachment, workspace.path),
      })),
      abortSignal: controller.signal,
    };

    const outcome = await this.deps.supervisor.execute(request, {
      onEvent: (event, isUpdate) => {
        try {
          if (isUpdate) {
            this.deps.transcript.update(event);
          } else {
            this.deps.transcript.append(session.id, event);
          }
        } catch (error) {
          this.deps.log('warn', 'failed to persist a transcript event', {
            message: (error as Error).message,
          });
        }
        if (event.kind === 'tool_call' && event.resultIsError) activeRun.toolErrors += 1;
        this.deps.bus.publish(topic, { type: 'transcript', topic, event });
      },
      onDelta: (eventId, channel, text) => {
        this.deps.bus.publish(topic, {
          type: 'delta',
          topic,
          runId: run.id,
          eventId,
          channel,
          text,
        });
      },
      onClaudeSessionId: (claudeSessionId) => {
        if (session.claudeSessionId !== claudeSessionId) {
          this.deps.sessions.setClaudeSessionId(session.id, claudeSessionId);
          session.claudeSessionId = claudeSessionId;
        }
      },
      onWaitingChange: (waiting) => {
        const status = waiting ? 'waiting_approval' : 'running';
        this.deps.runs.setStatus(run.id, status);
        this.deps.sessions.setStatus(session.id, status);
        this.publishSession(session.id);
      },
    });

    /* -- Record ----------------------------------------------------------- */
    const finished =
      this.deps.runs.finish(run.id, {
        status: outcome.status,
        usage: outcome.usage,
        error: outcome.error,
        rewindPoint: outcome.rewindPoint,
        servedModel: outcome.servedModel,
      }) ?? run;

    this.deps.sessions.addUsage(session.id, {
      costUsd: outcome.usage.costUsd,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    });
    this.deps.sessions.setStatus(session.id, outcome.status === 'failed' ? 'error' : 'idle');

    const resultEvent: TranscriptEvent = {
      kind: 'result',
      id: newId('event'),
      runId: run.id,
      seq: Number.MAX_SAFE_INTEGER, // Placeholder; the repo assigns the real one.
      at: Date.now(),
      status: outcome.status,
      usage: outcome.usage,
      error: outcome.error,
    };
    const stored = this.deps.transcript.append(session.id, { ...resultEvent, seq: undefined });
    this.deps.bus.publish(topic, { type: 'transcript', topic, event: stored });

    this.publishRun(finished);
    this.publishSession(session.id);
    this.publishMetrics();

    try {
      this.deps.onRunFinished?.(finished);
    } catch (error) {
      // A listener must never be able to fail the run that just succeeded.
      this.deps.log('warn', 'onRunFinished listener threw', {
        message: (error as Error).message,
      });
    }

    // Delegations only: stash the outcome — the final text exists nowhere
    // else — but never resolve the waiter here. Resolution waits for the
    // slot release in `execute`'s finally (see settleDelegation), or the
    // next sequential delegation would find this run still "active".
    if (finished.triggeredBy === 'delegation') {
      this.delegationSettled.set(finished.id, {
        run: finished,
        finalText: outcome.finalText,
        ready: false,
      });
    }

    this.notifyCompletion(finished, workspace, session);

    /* -- Learn ------------------------------------------------------------ */
    // Learning runs after the operator already has their answer, and its
    // failures are contained: a broken learner degrades the OS's improvement,
    // never its correctness.
    void this.learn(finished, workspace, category, activeRun.toolErrors);
  }

  /* ---------------------------------------------------------------------- */
  /* Learning loop                                                           */
  /* ---------------------------------------------------------------------- */

  private async learn(
    run: Run,
    workspace: Workspace,
    category: TaskCategory,
    toolErrors: number,
  ): Promise<void> {
    try {
      const reward = computeReward({
        status: run.status === 'succeeded' ? 'succeeded' : run.status === 'failed' ? 'failed' : 'interrupted',
        usage: run.usage,
        rating: run.rating,
        hitLimit: Boolean(run.error?.includes('maximum number of turns')),
        toolErrors,
      });
      this.deps.runs.setReward(run.id, reward);

      if (workspace.settings.autoPolicyEnabled) {
        this.deps.policy.update({
          workspaceId: workspace.id,
          category,
          arm: { model: run.policy.model, effort: run.policy.effort },
          reward,
          usage: run.usage,
        });
      }

      this.deps.memory.reinforce(run.id, reward);

      // Only teach the classifier from runs that went well; learning the
      // category of a run that failed for unrelated reasons is still valid,
      // but an interrupted run tells us nothing about intent.
      if (run.status !== 'interrupted') {
        await this.deps.classifier.learn(run.prompt, category, workspace.id);
      }

      if (workspace.settings.reflexionEnabled) {
        const events = this.deps.transcript.byRun(run.id);
        const written = await this.deps.reflexion.reflect(run, events);
        if (written > 0) {
          this.deps.bus.publish(SYSTEM_TOPIC, {
            type: 'notification',
            topic: SYSTEM_TOPIC,
            level: 'info',
            title: 'Learned something new',
            message: `Recorded ${written} new memor${written === 1 ? 'y' : 'ies'} from the last run.`,
            href: `/memory?workspace=${workspace.id}`,
          });
        }
      }
    } catch (error) {
      this.deps.log('warn', `learning loop failed for run ${run.id}`, {
        message: (error as Error).message,
      });
    }
  }

  /**
   * Apply an operator rating to a finished run.
   *
   * This is the strongest signal the learner gets, so the reward is recomputed
   * and re-applied. The subtlety is that `learn()` already fed this run's
   * inferred reward to the bandit and to memory: applying the rated reward
   * naively would count one run twice, and rating it N times would count it N
   * times. Both are therefore updated with the **delta** from the reward
   * previously applied, which leaves the posterior exactly where a single
   * observation of the rated value would have put it.
   */
  rateRun(runId: string, rating: number): Run | null {
    const run = this.deps.runs.get(runId);
    if (!run || run.status === 'running' || run.status === 'queued') return null;

    const clamped = Math.max(-1, Math.min(1, rating));
    this.deps.runs.setRating(runId, clamped);

    const status =
      run.status === 'succeeded' ? 'succeeded' : run.status === 'failed' ? 'failed' : 'interrupted';

    // Rating 0 means "un-rate": fall back to the inferred signal rather than
    // pinning quality at the neutral 0.5 that `rating: 0` would produce.
    const reward = computeReward({
      status,
      usage: run.usage,
      rating: clamped === 0 ? null : clamped,
      hitLimit: Boolean(run.error?.includes('maximum number of turns')),
      toolErrors: this.deps.transcript
        .byRun(runId)
        .filter((event) => event.kind === 'tool_call' && event.resultIsError).length,
    });

    const previous = run.reward;
    this.deps.runs.setReward(runId, reward);

    const workspace = this.deps.workspaces.get(run.workspaceId);
    if (workspace?.settings.autoPolicyEnabled && run.category) {
      this.deps.policy.revise({
        workspaceId: workspace.id,
        category: run.category,
        arm: { model: run.policy.model, effort: run.policy.effort },
        previousReward: previous,
        reward,
      });
    }
    this.deps.memory.reinforce(runId, reward, previous);

    const updated = this.deps.runs.get(runId) as Run;
    this.publishRun(updated);
    return updated;
  }

  /* ---------------------------------------------------------------------- */
  /* Control                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Stop the run attached to a session. Returns false if nothing was running. */
  interrupt(sessionId: string): boolean {
    for (const [runId, entry] of this.active) {
      if (entry.session.id !== sessionId) continue;
      this.broker.cancelRun(runId);

      // Ask the CLI to stop this turn cleanly. Aborting the controller is a
      // SIGKILL: the transcript loses whatever the model was mid-way through
      // writing, and the run is recorded as a failure the bandit then learns
      // from — so stopping a run yourself taught the learner that the model and
      // effort it had chosen were bad ones.
      void this.deps.supervisor.interrupt(runId).catch(() => {
        entry.controller.abort();
      });

      // And keep the kill as a guarantee. A CLI that ignores the request, or
      // one already wedged, must not leave the operator holding a button that
      // did nothing. Aborting a run that has already finished is a no-op, so
      // this needs no cleanup; unref'd so it cannot hold the process open.
      const fallback = setTimeout(() => entry.controller.abort(), INTERRUPT_GRACE_MS);
      fallback.unref?.();
      return true;
    }

    // Also drop it if it is still queued. `reject`, not `resolve`: resolving
    // would hand the waiter its slot and start the run the operator just
    // stopped, while reporting success to them.
    const index = this.queue.findIndex((q) => {
      const run = this.deps.runs.get(q.runId);
      return run?.sessionId === sessionId;
    });
    if (index >= 0) {
      const [entry] = this.queue.splice(index, 1);
      entry?.reject(new RunCancelled());
      return true;
    }
    return false;
  }

  /**
   * Restore the files a run changed, or preview what that would restore.
   *
   * Thin on purpose: `planRewind` owns every refusal and the supervisor owns
   * the CLI conversation. What is left here is resolving the three records the
   * plan needs, which is the one thing the kernel is uniquely able to do.
   */
  async rewindRun(runId: string, dryRun: boolean): Promise<RewindResult> {
    const refuse = (reason: string): RewindResult => ({
      canRewind: false,
      error: reason,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      skippedLinks: 0,
      applied: false,
    });

    const run = this.deps.runs.get(runId);
    if (!run) return refuse('That run no longer exists.');

    const session = this.deps.sessions.get(run.sessionId);
    if (!session) return refuse('That run’s session no longer exists.');

    const workspace = this.deps.workspaces.get(run.workspaceId);
    if (!workspace) return refuse('That run’s workspace no longer exists.');

    // `planRewind` judges the *target* run, and only the target run. A finished
    // run in a session that has since started another is rewindable by that
    // test and must not be: both resume the same Claude session id, so this
    // would open a second CLI onto the id the live run is appending to and
    // restore files under a process still writing them. The UI does not
    // compensate — the button is gated on `run.rewindPoint` alone.
    //
    // Asked here rather than inside `planRewind` because the answer is not a
    // property of the two rows: `hasActiveRunForSession` also covers the
    // reservation window and the queue, which only the kernel can see.
    if (this.hasActiveRunForSession(session.id)) {
      return refuse('This session has a run in flight. Stop it first, then rewind.');
    }

    const plan = planRewind(run, session);
    if (!plan.ok) return refuse(plan.reason);

    return this.deps.supervisor.rewind({
      claudeSessionId: plan.claudeSessionId,
      rewindPoint: plan.rewindPoint,
      workspacePath: workspace.path,
      dryRun,
    });
  }

  hasActiveRunForSession(sessionId: string): boolean {
    if (this.reserved.has(sessionId)) return true;
    for (const entry of this.active.values()) {
      if (entry.session.id === sessionId) return true;
    }
    return this.queue.some((q) => this.deps.runs.get(q.runId)?.sessionId === sessionId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Stop accepting work and abort everything in flight. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Cancel the queue first, and by rejection: resolving would spawn a fresh
    // CLI subprocess for every queued run *during shutdown*, which would then
    // still be writing transcripts when the database closes underneath it.
    for (const queued of this.queue.splice(0)) queued.reject(new RunCancelled());
    for (const entry of this.active.values()) entry.controller.abort();

    // Give aborts a moment to unwind so transcripts are flushed.
    const deadline = Date.now() + 5000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Publishing                                                              */
  /* ---------------------------------------------------------------------- */

  private onApprovalRequested(request: ApprovalRequest): void {
    const topic = sessionTopic(request.sessionId);
    this.deps.runs.setStatus(request.runId, 'waiting_approval');
    this.deps.sessions.setStatus(request.sessionId, 'waiting_approval');

    this.deps.bus.publish(topic, { type: 'approval_request', topic, request });
    // Mirror onto `system` so a client on a different screen still sees it.
    this.deps.bus.publish(SYSTEM_TOPIC, {
      type: 'approval_request',
      topic: SYSTEM_TOPIC,
      request,
    });
    this.publishSession(request.sessionId);
  }

  private onApprovalResolved(approvalId: string, approved: boolean): void {
    for (const topic of [SYSTEM_TOPIC]) {
      this.deps.bus.publish(topic, { type: 'approval_resolved', topic, approvalId, approved });
    }
    // The session-scoped copy needs the session id, which only the pending entry
    // knew; publishing on `system` is enough for the client to reconcile.
  }

  private notifyCompletion(run: Run, workspace: Workspace, session: Session): void {
    const level = run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'error' : 'warning';
    const title =
      run.status === 'succeeded'
        ? 'Run finished'
        : run.status === 'failed'
          ? 'Run failed'
          : 'Run interrupted';

    this.deps.bus.publish(SYSTEM_TOPIC, {
      type: 'notification',
      topic: SYSTEM_TOPIC,
      level,
      title,
      message: `${workspace.name} · ${session.title || 'Untitled session'}${
        run.error ? ` — ${run.error.slice(0, 160)}` : ''
      }`,
      href: `/w/${workspace.id}/s/${session.id}`,
    });
  }

  private publishRun(run: Run): void {
    const topic = sessionTopic(run.sessionId);
    this.deps.bus.publish(topic, { type: 'run', topic, run });
    const wsTopic = workspaceTopic(run.workspaceId);
    this.deps.bus.publish(wsTopic, { type: 'run', topic: wsTopic, run });
  }

  private publishSession(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;
    const topic = sessionTopic(sessionId);
    this.deps.bus.publish(topic, { type: 'session', topic, session });
    const wsTopic = workspaceTopic(session.workspaceId);
    this.deps.bus.publish(wsTopic, { type: 'session', topic: wsTopic, session });
  }

  private publishMetrics(): void {
    const since = startOfToday();
    const costTodayUsd = this.deps.runs
      .listRecent({ since, limit: 1000 })
      .reduce((sum, run) => sum + run.usage.costUsd, 0);

    this.deps.bus.publish(SYSTEM_TOPIC, {
      type: 'metrics',
      topic: SYSTEM_TOPIC,
      activeRuns: this.active.size,
      queuedRuns: this.queue.length,
      costTodayUsd,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** First meaningful line of a prompt, trimmed to a sidebar-friendly length. */
export function deriveTitle(prompt: string, maxLength = 60): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    // Skip markdown headings and list markers so the title reads naturally.
    .find((line) => line.length > 0 && !/^[#>*\-\d.]+\s*$/.test(line));

  const cleaned = (firstLine ?? prompt)
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxLength) return cleaned || 'New session';

  // Cut on a word boundary rather than mid-word.
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
