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
import type { EventBus } from './bus.js';
import { buildMemoryContext } from './context.js';
import { PermissionBroker } from './permissions.js';
import type { RunRepo, SessionRepo, TranscriptRepo, WorkspaceRepo } from './repositories.js';
import { AgentSupervisor, type RunRequest } from './supervisor.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface RuntimeContext {
  /** MCP servers to expose, already resolved with their decrypted secrets. */
  mcpServers: Record<string, unknown>;
  /** Custom agents available to the run. */
  agents: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
}

/** Supplies per-workspace runtime configuration. Implemented by the services layer. */
export interface ContextProvider {
  resolve(workspace: Workspace): RuntimeContext;
}

export interface SubmitOptions {
  sessionId: string;
  prompt: string;
  triggeredBy?: Run['triggeredBy'];
  /** Explicit overrides; when absent the workspace default or the bandit decides. */
  overrides?: Partial<Pick<RunPolicy, 'model' | 'effort' | 'permissionMode' | 'agentName'>>;
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
  maxConcurrentRuns: number;
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

export class Kernel {
  readonly broker: PermissionBroker;

  private readonly active = new Map<string, ActiveRun>();
  /** Runs admitted but waiting for a concurrency slot, FIFO. */
  private readonly queue: Array<{ runId: string; resolve: () => void }> = [];
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

    /* -- Classify, then pick a policy ------------------------------------ */
    const classification = await this.deps.classifier.classify(prompt, workspace.id);
    const policy = this.choosePolicy(workspace, session, classification.category, options.overrides);

    const run = this.deps.runs.create({
      sessionId: session.id,
      workspaceId: workspace.id,
      prompt,
      policy,
      triggeredBy: options.triggeredBy ?? 'user',
      category: classification.category,
    });

    // The first prompt names the session, so the sidebar is readable at a glance.
    if (!session.title.trim()) {
      const title = deriveTitle(prompt);
      this.deps.sessions.setTitle(session.id, title);
      this.publishSession(session.id);
    }

    this.publishRun(run);
    void this.schedule(run, session, workspace, classification.category);
    return run;
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
      // Cancelled while queued.
      this.deps.runs.finish(run.id, { status: 'interrupted', usage: run.usage, error: 'Cancelled while queued.' });
      this.publishRun(this.deps.runs.get(run.id) as Run);
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
      this.releaseSlot();
    }
  }

  private acquireSlot(runId: string): Promise<void> {
    if (this.active.size < this.deps.maxConcurrentRuns) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.queue.push({ runId, resolve });
      this.publishMetrics();
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) next.resolve();
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
          this.deps.memory.recordUsage(run.id, retrieved);
          systemPromptAppend = [systemPromptAppend, buildMemoryContext(retrieved)]
            .filter(Boolean)
            .join('\n\n');
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

    this.active.delete(run.id);
    this.broker.cancelRun(run.id);

    /* -- Record ----------------------------------------------------------- */
    const finished =
      this.deps.runs.finish(run.id, {
        status: outcome.status,
        usage: outcome.usage,
        error: outcome.error,
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
   * This is the strongest signal the learner gets, so it re-runs the reward
   * computation and re-applies it to both the bandit and memory confidence.
   */
  rateRun(runId: string, rating: number): Run | null {
    const run = this.deps.runs.get(runId);
    if (!run || run.status === 'running' || run.status === 'queued') return null;

    const clamped = Math.max(-1, Math.min(1, rating));
    this.deps.runs.setRating(runId, clamped);

    const reward = computeReward({
      status: run.status === 'succeeded' ? 'succeeded' : run.status === 'failed' ? 'failed' : 'interrupted',
      usage: run.usage,
      rating: clamped,
    });
    this.deps.runs.setReward(runId, reward);

    const workspace = this.deps.workspaces.get(run.workspaceId);
    if (workspace?.settings.autoPolicyEnabled && run.category) {
      this.deps.policy.update({
        workspaceId: workspace.id,
        category: run.category,
        arm: { model: run.policy.model, effort: run.policy.effort },
        reward,
        usage: run.usage,
      });
    }
    this.deps.memory.reinforce(runId, reward);

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
      entry.controller.abort();
      this.broker.cancelRun(runId);
      return true;
    }

    // Also drop it if it is still queued.
    const index = this.queue.findIndex((q) => {
      const run = this.deps.runs.get(q.runId);
      return run?.sessionId === sessionId;
    });
    if (index >= 0) {
      const [entry] = this.queue.splice(index, 1);
      entry?.resolve();
      return true;
    }
    return false;
  }

  hasActiveRunForSession(sessionId: string): boolean {
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
    for (const entry of this.active.values()) entry.controller.abort();
    for (const queued of this.queue.splice(0)) queued.resolve();

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
