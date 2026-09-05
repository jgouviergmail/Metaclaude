/**
 * The steward — what Metaclaude can see and do about itself.
 *
 * This is the facade behind the `metaclaude_system` tools: one place that
 * decides, for every verb, which ring it belongs to and what it may never
 * touch. The tools are thin; the rules are here, and testable without an SDK.
 *
 * Three rings, by *reversibility* rather than by subject:
 *
 *  - **Ring 1 — reading.** Everything the operator can see in the interface,
 *    minus secrets, which the API never returns to anyone and this facade never
 *    projects: no credential, no token, no MCP environment value, no vault.
 *  - **Ring 2 — reversible.** A change a person can undo from the interface in
 *    one gesture: a memory edited, an automation paused, a proposal decided, a
 *    setting moved, a run started or interrupted. Audited as `metaclaude:<run>`
 *    so the audit log reads who did it, and *which run* — never as the operator.
 *  - **Ring 3 — irreversible.** Deleting, purging, applying an update, granting
 *    the agent more reach. None of it is exposed here. The next version adds a
 *    pending-action queue with an approval card; until then the steward says
 *    precisely what it would do and stops.
 *
 * Two lines it never crosses whatever the ring: the four safety settings that
 * decide what any agent can reach (`SYSTEM_WORKSPACE_SAFETY` for itself, and
 * the same four keys on every other workspace), and an approval of *high* risk
 * — the one decision an absent operator would want to have made themselves.
 */

import { WorkspaceSettings, patchSchema } from '@metaclaude/shared';
import type {
  AdvisorProposal,
  ApprovalRequest,
  AnalyticsSummary,
  AuditEntry,
  Automation,
  AutomationTrigger,
  DoctorReport,
  Insight,
  Memory,
  MemoryKind,
  RetrievalStatus,
  Run,
  RuntimeSettingKey,
  RuntimeSettingRecord,
  Session,
  UpdateApplyStatus,
  UpdateCheck,
  Workspace,
} from '@metaclaude/shared';
import type { Kernel } from '../kernel/kernel.js';
import type { RunRepo, SessionRepo, TranscriptRepo, WorkspaceRepo } from '../kernel/repositories.js';
import type { MemoryStore } from '../learning/memory.js';
import type { AuditLog } from '../security/audit.js';
import type { AdvisorService } from './advisor.js';
import type { AnalyticsService } from './analytics.js';
import type { Registry } from './registry.js';
import type { RuntimeSettings } from './runtime-settings.js';
import type { Scheduler } from './scheduler.js';

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

export class StewardError extends Error {
  constructor(
    message: string,
    /** Named so a tool result can say which line was crossed, not only that one was. */
    readonly ring: 'refused' | 'not-found' | 'irreversible',
  ) {
    super(message);
    this.name = 'StewardError';
  }
}

/** Who is acting: always a run of the system workspace, never a person. */
export interface StewardActor {
  runId: string;
  sessionId: string;
}

export interface StewardDeps {
  version: string;
  systemWorkspaceId: () => string | null;
  workspaces: Pick<WorkspaceRepo, 'get' | 'getBySlug' | 'list' | 'update'>;
  sessions: Pick<SessionRepo, 'get' | 'list' | 'update' | 'create'>;
  runs: Pick<RunRepo, 'get' | 'listRecent' | 'listBySession'>;
  transcript: Pick<TranscriptRepo, 'byRun' | 'countBySession'>;
  memory: Pick<
    MemoryStore,
    'get' | 'list' | 'search' | 'stats' | 'count' | 'update' | 'remember' | 'promote' | 'confine'
  >;
  insights: {
    list(options: { workspaceId?: string | null; status?: Insight['status']; limit?: number }): Insight[];
    setStatus(id: string, status: Insight['status']): boolean;
  };
  automations: Pick<Scheduler, 'list' | 'get' | 'create' | 'update' | 'fire'>;
  proposals: Pick<AdvisorService, 'list' | 'get' | 'accept' | 'dismiss'>;
  approvals: {
    listPending(): ApprovalRequest[];
    decide(
      decision: { approvalId: string; approved: boolean; remember: boolean; reason?: string },
      actor: { username: string; ipAddress: string | null; via: 'http' | 'websocket' },
    ): boolean;
  };
  settings: Pick<RuntimeSettings, 'all' | 'set'>;
  doctor: { run(): Promise<DoctorReport> };
  analytics: Pick<AnalyticsService, 'summary'>;
  audit: Pick<AuditLog, 'record' | 'list'>;
  registry: Pick<Registry, 'listSkills' | 'listAgents' | 'listMcpServers'>;
  /** Null when the deployment has no update channel configured. */
  updates: { check(): Promise<UpdateCheck>; status(): Promise<UpdateApplyStatus> } | null;
  /**
   * What retrieval *is* on this deployment. The steward once called memory
   * search "semantic" from a tool description, on a hashing deployment;
   * it reads this instead and says which regime it is in.
   */
  retrieval: () => RetrievalStatus;
  kernel: Pick<
    Kernel,
    'submit' | 'delegate' | 'activeCount' | 'queuedCount' | 'hasActiveRunForSession' | 'interrupt'
  >;
  /** Events a standing session may hold before a new one is opened beside it. */
  sessionMaxEvents?: number;
  now?: () => number;
}

/** The four settings that decide what an agent can reach. Ring 3 everywhere. */
export const REACH_SETTINGS = [
  'defaultPermissionMode',
  'allowedTools',
  'disallowedTools',
  'additionalDirectories',
] as const satisfies readonly (keyof WorkspaceSettings)[];

/** The title of the session `runStart` keeps in each workspace it works. */
export const STEWARD_SESSION_TITLE = 'Metaclaude';
/** The title of the session the Dashboard composer keeps in the system workspace. */
export const CONVERSATION_TITLE = 'Conversation';

const DEFAULT_SESSION_MAX_EVENTS = 400;
const SETTINGS_PATCH = patchSchema(WorkspaceSettings);
const PROMPT_EXCERPT = 300;
const CONTENT_EXCERPT = 1200;
const NOT_YET =
  'That is irreversible, and the steward cannot do it yet: the approval card for irreversible ' +
  'actions ships in the next version. Tell the operator exactly what you would do and why, ' +
  'and let them do it from the interface.';

const excerpt = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/* -------------------------------------------------------------------------- */
/* Projections — compact, and never a secret                                   */
/* -------------------------------------------------------------------------- */

const compactWorkspace = (workspace: Workspace, isSystem: boolean) => ({
  id: workspace.id,
  slug: workspace.slug,
  name: workspace.name,
  description: workspace.description,
  archived: workspace.archived,
  isSystem,
  settings: {
    defaultModel: workspace.settings.defaultModel,
    defaultEffort: workspace.settings.defaultEffort,
    defaultPermissionMode: workspace.settings.defaultPermissionMode,
    language: workspace.settings.language,
    memoryEnabled: workspace.settings.memoryEnabled,
    autoPolicyEnabled: workspace.settings.autoPolicyEnabled,
    allowedTools: workspace.settings.allowedTools,
    disallowedTools: workspace.settings.disallowedTools,
    additionalDirectories: workspace.settings.additionalDirectories,
  },
  updatedAt: workspace.updatedAt,
});

const compactSession = (session: Session) => ({
  id: session.id,
  workspaceId: session.workspaceId,
  title: session.title,
  status: session.status,
  model: session.model,
  effort: session.effort,
  permissionMode: session.permissionMode,
  pinned: session.pinned,
  archived: session.archived,
  runCount: session.runCount,
  totalCostUsd: session.totalCostUsd,
  lastActivityAt: session.lastActivityAt,
});

const compactRun = (run: Run) => ({
  id: run.id,
  sessionId: run.sessionId,
  workspaceId: run.workspaceId,
  status: run.status,
  triggeredBy: run.triggeredBy,
  prompt: excerpt(run.prompt, PROMPT_EXCERPT),
  error: run.error,
  category: run.category,
  model: run.policy.model,
  permissionMode: run.policy.permissionMode,
  costUsd: run.usage.costUsd,
  durationMs: run.usage.durationMs,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

const compactMemory = (memory: Memory) => ({
  id: memory.id,
  scope: memory.workspaceId === null ? 'global' : memory.workspaceId,
  kind: memory.kind,
  title: memory.title,
  content: excerpt(memory.content, CONTENT_EXCERPT),
  tags: memory.tags,
  confidence: memory.confidence,
  pinned: memory.pinned,
  useCount: memory.useCount,
  updatedAt: memory.updatedAt,
});

const compactInsight = (insight: Insight) => ({
  id: insight.id,
  workspaceId: insight.workspaceId,
  kind: insight.kind,
  title: insight.title,
  body: excerpt(insight.body, CONTENT_EXCERPT),
  confidence: insight.confidence,
  status: insight.status,
  createdAt: insight.createdAt,
});

const compactAutomation = (automation: Automation) => ({
  id: automation.id,
  workspaceId: automation.workspaceId,
  name: automation.name,
  description: automation.description,
  trigger: automation.trigger,
  enabled: automation.enabled,
  continuous: automation.continuous,
  prompt: excerpt(automation.prompt, PROMPT_EXCERPT),
  lastRunAt: automation.lastRunAt,
  lastStatus: automation.lastStatus,
  nextRunAt: automation.nextRunAt,
  runCount: automation.runCount,
  consecutiveFailures: automation.consecutiveFailures,
  maxConsecutiveFailures: automation.maxConsecutiveFailures,
});

const compactProposal = (proposal: AdvisorProposal) => ({
  id: proposal.id,
  workspaceId: proposal.workspaceId,
  kind: proposal.kind,
  name: proposal.name,
  summary: proposal.summary,
  rationale: excerpt(proposal.rationale, CONTENT_EXCERPT),
  status: proposal.status,
  createdAt: proposal.createdAt,
});

const compactApproval = (approval: ApprovalRequest) => ({
  id: approval.id,
  runId: approval.runId,
  sessionId: approval.sessionId,
  workspaceId: approval.workspaceId,
  toolName: approval.toolName,
  summary: approval.summary,
  risk: approval.risk,
  reason: approval.reason,
  createdAt: approval.createdAt,
  expiresAt: approval.expiresAt,
});

/* -------------------------------------------------------------------------- */
/* The facade                                                                  */
/* -------------------------------------------------------------------------- */

export class Steward {
  constructor(private readonly deps: StewardDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private actorName(actor: StewardActor): string {
    return `metaclaude:${actor.runId}`;
  }

  private record(actor: StewardActor, action: string, target: string | null, detail: string | null) {
    this.deps.audit.record({ actor: this.actorName(actor), action, target, detail });
  }

  private isSystem(workspaceId: string): boolean {
    return this.deps.systemWorkspaceId() === workspaceId;
  }

  /** A workspace by id or slug — agents speak names, the interface speaks ids. */
  private findWorkspace(ref: string): Workspace {
    const workspace = this.deps.workspaces.get(ref) ?? this.deps.workspaces.getBySlug(ref);
    if (!workspace) throw new StewardError(`No workspace is called "${ref}".`, 'not-found');
    return workspace;
  }

  /* ---------------------------------------------------------------------- */
  /* Ring 1 — reading                                                        */
  /* ---------------------------------------------------------------------- */

  overview() {
    const workspaces = this.deps.workspaces.list(false);
    const since = this.now() - 24 * 3600_000;
    const recent = this.deps.runs.listRecent({ since, limit: 500 });
    return {
      version: this.deps.version,
      systemWorkspaceId: this.deps.systemWorkspaceId(),
      workspaces: workspaces.length,
      activeRuns: this.deps.kernel.activeCount,
      queuedRuns: this.deps.kernel.queuedCount,
      pendingApprovals: this.deps.approvals.listPending().length,
      last24h: {
        runs: recent.length,
        failed: recent.filter((run) => run.status === 'failed').length,
        costUsd: Number(recent.reduce((sum, run) => sum + run.usage.costUsd, 0).toFixed(4)),
      },
      memories: this.deps.memory.count(),
      retrieval: this.retrievalNote(),
      newInsights: this.deps.insights.list({ status: 'new', limit: 500 }).length,
      pendingProposals: this.deps.proposals.list(undefined, 'pending').length,
      automations: this.deps.automations.list().filter((automation) => automation.enabled).length,
    };
  }

  /** The retrieval regime, with the sentence the steward should repeat rather than assume. */
  private retrievalNote() {
    const status = this.deps.retrieval();
    const note = status.semantic
      ? 'A sentence-transformer is answering: search matches meaning, in French and English alike.'
      : status.state === 'loading'
        ? 'The model is still loading: search matches words meanwhile, and new memories wait for their vectors.'
        : status.family === 'st'
          ? 'The model did not load: search matches words, not meaning, until it does. Check system_doctor.'
          : 'The built-in hashing embedder: search matches words, not meaning — title memories with the words you will search for.';
    return { ...status, note };
  }

  workspaces(includeArchived = false) {
    return this.deps.workspaces
      .list(includeArchived)
      .map((workspace) => compactWorkspace(workspace, this.isSystem(workspace.id)));
  }

  workspace(ref: string) {
    const workspace = this.findWorkspace(ref);
    return {
      ...compactWorkspace(workspace, this.isSystem(workspace.id)),
      path: workspace.path,
      sessions: this.deps.sessions.list(workspace.id, { limit: 20 }).map(compactSession),
      memoryStats: this.deps.memory.stats(workspace.id),
      automations: this.deps.automations.list(workspace.id).map(compactAutomation),
    };
  }

  sessions(ref: string, options: { includeArchived?: boolean; limit?: number } = {}) {
    const workspace = this.findWorkspace(ref);
    return this.deps.sessions
      .list(workspace.id, { includeArchived: options.includeArchived ?? false, limit: options.limit ?? 50 })
      .map(compactSession);
  }

  runs(options: { workspace?: string; sinceHours?: number; limit?: number; status?: Run['status'] } = {}) {
    const workspaceId = options.workspace ? this.findWorkspace(options.workspace).id : undefined;
    const since = options.sinceHours ? this.now() - options.sinceHours * 3600_000 : undefined;
    const limit = Math.min(options.limit ?? 50, 500);
    // The status filter runs on a wider window than the limit, or "the last
    // ten failures" would mean "the failures among the last ten runs" and
    // answer nothing on a day that went well until the evening.
    const window = options.status ? 500 : limit;
    return this.deps.runs
      .listRecent({ workspaceId, since, limit: window })
      .filter((run) => !options.status || run.status === options.status)
      .slice(0, limit)
      .map(compactRun);
  }

  run(runId: string) {
    const run = this.deps.runs.get(runId);
    if (!run) throw new StewardError(`No run is called "${runId}".`, 'not-found');
    const events = this.deps.transcript.byRun(run.id);
    const toolCalls = events.flatMap((event) =>
      event.kind === 'tool_call' ? [{ name: event.name, status: event.status }] : [],
    );
    const texts = events.flatMap((event) => (event.kind === 'assistant_text' ? [event.text] : []));
    return {
      ...compactRun(run),
      prompt: run.prompt,
      usage: run.usage,
      eventCount: events.length,
      toolCalls: toolCalls.slice(-60),
      finalText: texts.length > 0 ? excerpt(texts[texts.length - 1]!, 4000) : null,
    };
  }

  memories(options: { workspace?: string | 'global'; kind?: MemoryKind; search?: string; limit?: number } = {}) {
    const workspaceId =
      options.workspace === 'global' ? null : options.workspace ? this.findWorkspace(options.workspace).id : undefined;
    return this.deps.memory
      .list({ workspaceId, kind: options.kind, search: options.search, limit: options.limit ?? 50 })
      .map(compactMemory);
  }

  async memorySearch(query: string, options: { workspace?: string; limit?: number } = {}) {
    const workspaceId = options.workspace ? this.findWorkspace(options.workspace).id : undefined;
    const results = await this.deps.memory.search(query, { workspaceId, limit: options.limit ?? 10 });
    return results.map((result) => ({ ...compactMemory(result.memory), score: result.score }));
  }

  insights(options: { workspace?: string | 'global'; status?: Insight['status']; limit?: number } = {}) {
    const workspaceId =
      options.workspace === 'global' ? null : options.workspace ? this.findWorkspace(options.workspace).id : undefined;
    return this.deps.insights
      .list({ workspaceId, status: options.status, limit: options.limit ?? 50 })
      .map(compactInsight);
  }

  automations(ref?: string) {
    const workspaceId = ref ? this.findWorkspace(ref).id : undefined;
    return this.deps.automations.list(workspaceId).map(compactAutomation);
  }

  proposals(status: AdvisorProposal['status'] = 'pending', ref?: string) {
    const workspaceId = ref ? this.findWorkspace(ref).id : undefined;
    return this.deps.proposals.list(workspaceId, status).map(compactProposal);
  }

  approvals() {
    return this.deps.approvals.listPending().map(compactApproval);
  }

  settings(): RuntimeSettingRecord[] {
    return this.deps.settings.all();
  }

  doctor(): Promise<DoctorReport> {
    return this.deps.doctor.run();
  }

  analytics(options: { workspace?: string; sinceDays?: number } = {}): AnalyticsSummary {
    const workspaceId = options.workspace ? this.findWorkspace(options.workspace).id : undefined;
    const since = this.now() - (options.sinceDays ?? 7) * 24 * 3600_000;
    return this.deps.analytics.summary({ workspaceId, since });
  }

  audit(options: { limit?: number; action?: string } = {}): AuditEntry[] {
    return this.deps.audit.list({ limit: Math.min(options.limit ?? 50, 500), action: options.action });
  }

  async updates() {
    if (!this.deps.updates) return { configured: false as const };
    const [check, apply] = await Promise.all([this.deps.updates.check(), this.deps.updates.status()]);
    return { configured: true as const, check, apply };
  }

  /** What runs can use — names and states, never a value from an environment. */
  library(ref?: string) {
    const workspaceId = ref ? this.findWorkspace(ref).id : undefined;
    return {
      skills: this.deps.registry.listSkills(workspaceId).map((skill) => ({
        id: skill.id,
        workspaceId: skill.workspaceId,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        enabled: skill.enabled,
        useCount: skill.useCount,
      })),
      agents: this.deps.registry.listAgents(workspaceId).map((agent) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        name: agent.name,
        description: agent.description,
        model: agent.model,
        enabled: agent.enabled,
      })),
      mcpServers: this.deps.registry.listMcpServers(workspaceId).map((server) => ({
        id: server.id,
        workspaceId: server.workspaceId,
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        status: server.status,
        lastError: server.lastError,
        authType: server.authType,
        // The *names* of the keys say what the server needs; the values stay sealed.
        envKeys: server.envKeys,
      })),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Ring 2 — reversible, and audited                                        */
  /* ---------------------------------------------------------------------- */

  async memoryWrite(
    actor: StewardActor,
    input:
      | { id: string; patch: Partial<Pick<Memory, 'title' | 'content' | 'tags' | 'confidence' | 'pinned' | 'kind'>> }
      | { workspace: string | 'global'; kind: MemoryKind; title: string; content: string; tags?: string[] },
  ) {
    if ('id' in input) {
      const memory = await this.deps.memory.update(input.id, input.patch);
      if (!memory) throw new StewardError(`No memory is called "${input.id}".`, 'not-found');
      this.record(actor, 'steward.memory.update', memory.id, Object.keys(input.patch).join(', '));
      return compactMemory(memory);
    }
    const workspaceId = input.workspace === 'global' ? null : this.findWorkspace(input.workspace).id;
    const { memory, merged } = await this.deps.memory.remember({
      workspaceId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      sourceRunId: actor.runId,
    });
    this.record(actor, 'steward.memory.remember', memory.id, merged ? 'merged into an existing memory' : null);
    return { ...compactMemory(memory), merged };
  }

  async memoryScope(actor: StewardActor, input: { id: string; workspace: string | 'global' }) {
    if (!this.deps.memory.get(input.id)) {
      throw new StewardError(`No memory is called "${input.id}".`, 'not-found');
    }
    const result =
      input.workspace === 'global'
        ? await this.deps.memory.promote(input.id)
        : await this.deps.memory.confine(input.id, this.findWorkspace(input.workspace).id);
    this.record(
      actor,
      input.workspace === 'global' ? 'steward.memory.promote' : 'steward.memory.confine',
      input.id,
      input.workspace === 'global' ? null : input.workspace,
    );
    return { ...compactMemory(result.memory), moved: result.moved, absorbed: result.absorbed };
  }

  insightStatus(actor: StewardActor, id: string, status: Insight['status']) {
    if (!this.deps.insights.setStatus(id, status)) {
      throw new StewardError(`No insight is called "${id}".`, 'not-found');
    }
    this.record(actor, `steward.insight.${status}`, id, null);
    return { id, status };
  }

  proposalDecide(actor: StewardActor, id: string, decision: 'accept' | 'dismiss') {
    if (!this.deps.proposals.get(id)) throw new StewardError(`No proposal is called "${id}".`, 'not-found');
    const username = this.actorName(actor);
    const proposal =
      decision === 'accept' ? this.deps.proposals.accept(id, username).proposal : this.deps.proposals.dismiss(id, username);
    this.record(actor, `steward.proposal.${decision}`, id, proposal.name);
    return compactProposal(proposal);
  }

  automationToggle(actor: StewardActor, id: string, enabled: boolean) {
    const automation = this.deps.automations.update(id, { enabled });
    if (!automation) throw new StewardError(`No automation is called "${id}".`, 'not-found');
    this.record(actor, enabled ? 'steward.automation.enable' : 'steward.automation.disable', id, automation.name);
    return compactAutomation(automation);
  }

  automationCreate(
    actor: StewardActor,
    input: {
      workspace: string;
      name: string;
      description?: string;
      prompt: string;
      trigger: AutomationTrigger;
      enabled?: boolean;
    },
  ) {
    const workspace = this.findWorkspace(input.workspace);
    // Disabled unless asked, like the advisor's proposals: a schedule that
    // starts running the moment it is written is a surprise, not a service.
    const automation = this.deps.automations.create({
      workspaceId: workspace.id,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      trigger: input.trigger,
      enabled: input.enabled ?? false,
    });
    this.record(actor, 'steward.automation.create', automation.id, `${automation.name} in ${workspace.slug}`);
    return compactAutomation(automation);
  }

  async automationFire(actor: StewardActor, id: string) {
    const automation = this.deps.automations.get(id);
    if (!automation) throw new StewardError(`No automation is called "${id}".`, 'not-found');
    const sessionId = await this.deps.automations.fire(id, 'user');
    this.record(actor, 'steward.automation.fire', id, automation.name);
    return { id, sessionId };
  }

  sessionUpdate(
    actor: StewardActor,
    id: string,
    patch: Partial<Pick<Session, 'title' | 'pinned' | 'archived'>>,
  ) {
    const session = this.deps.sessions.update(id, patch);
    if (!session) throw new StewardError(`No session is called "${id}".`, 'not-found');
    this.record(actor, 'steward.session.update', id, Object.keys(patch).join(', '));
    return compactSession(session);
  }

  /**
   * Decide a pending approval on the operator's behalf.
   *
   * Denying is always reversible — the run's agent can ask again. Allowing is
   * bounded by the card's own risk: a high-risk call is the one decision an
   * absent operator would want to have made themselves, so it stays theirs.
   * And a run cannot answer its own cards, whatever the risk.
   */
  approvalDecide(actor: StewardActor, id: string, approved: boolean, reason?: string) {
    const pending = this.deps.approvals.listPending().find((approval) => approval.id === id);
    if (!pending) throw new StewardError(`No approval "${id}" is pending.`, 'not-found');
    if (pending.runId === actor.runId) {
      throw new StewardError('A run cannot decide its own approval.', 'refused');
    }
    if (approved && pending.risk === 'high') {
      throw new StewardError(
        `Allowing a high-risk call (${pending.toolName}: ${pending.summary}) is the operator's decision. ` +
          'You may deny it, or tell the operator what is waiting.',
        'refused',
      );
    }
    const resolved = this.deps.approvals.decide(
      { approvalId: id, approved, remember: false, ...(reason ? { reason } : {}) },
      { username: this.actorName(actor), ipAddress: null, via: 'http' },
    );
    if (!resolved) throw new StewardError('That approval was already decided or has expired.', 'not-found');
    return { id, approved, toolName: pending.toolName, risk: pending.risk };
  }

  settingSet(actor: StewardActor, key: RuntimeSettingKey, value: number | string) {
    this.deps.settings.set(key, value, this.actorName(actor));
    this.record(actor, 'steward.setting.set', key, String(value));
    return this.deps.settings.all().find((setting) => setting.key === key) ?? { key, value };
  }

  /**
   * Change a workspace's name, description or ordinary settings.
   *
   * The four reach settings are refused on *every* workspace, not only on the
   * system one: widening what any agent may do is a ring-3 act whoever the
   * workspace belongs to. Archiving is refused for the same reason deletion is
   * absent — it hides work rather than changing it.
   */
  workspaceUpdate(
    actor: StewardActor,
    ref: string,
    patch: { name?: string; description?: string; settings?: Partial<WorkspaceSettings> },
  ) {
    const workspace = this.findWorkspace(ref);
    // Through the same schema the route uses: the tool's wire shape is a
    // record of unknowns, and a repository that merges whatever it is given
    // would store an unknown key or a number where a model alias belongs.
    let settings: Partial<WorkspaceSettings> | undefined;
    if (patch.settings) {
      const parsed = SETTINGS_PATCH.safeParse(patch.settings);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new StewardError(
          `Invalid settings: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unreadable'}.`,
          'refused',
        );
      }
      settings = parsed.data as Partial<WorkspaceSettings>;
    }
    const touched = REACH_SETTINGS.filter((key) => settings?.[key] !== undefined);
    if (touched.length > 0) {
      throw new StewardError(
        `Changing ${touched.join(', ')} widens or narrows what an agent can reach — ${NOT_YET}`,
        'irreversible',
      );
    }
    const updated = this.deps.workspaces.update(workspace.id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(settings ? { settings } : {}),
    });
    if (!updated) throw new StewardError(`No workspace is called "${ref}".`, 'not-found');
    this.record(
      actor,
      'steward.workspace.update',
      workspace.id,
      [...(patch.name !== undefined ? ['name'] : []), ...(patch.description !== undefined ? ['description'] : []), ...Object.keys(settings ?? {})].join(', '),
    );
    return compactWorkspace(updated, this.isSystem(updated.id));
  }

  /** Ask another workspace's agent and wait for its answer — a delegation. */
  async runAsk(actor: StewardActor, target: string, prompt: string) {
    const workspace = this.findWorkspace(target);
    const own = this.deps.systemWorkspaceId();
    if (!own) throw new StewardError('The system workspace is not ready.', 'refused');
    if (workspace.id === own) {
      throw new StewardError('That is your own workspace — answer it yourself.', 'refused');
    }
    this.record(actor, 'steward.run.ask', workspace.id, excerpt(prompt, PROMPT_EXCERPT));
    const result = await this.deps.kernel.delegate({
      fromWorkspaceId: own,
      fromTriggeredBy: 'user',
      target: workspace.slug,
      prompt,
    });
    return {
      runId: result.runId,
      sessionId: result.sessionId,
      status: result.status,
      error: result.error,
      answer: result.finalText,
    };
  }

  /**
   * Start a run in another workspace and come back at once.
   *
   * One standing session per workspace, reused while it is idle and under the
   * event ceiling — the same rotation the gateway applies to a token's session,
   * for the same reason: a session nobody closes grows its context every day.
   */
  async runStart(actor: StewardActor, target: string, prompt: string) {
    const workspace = this.findWorkspace(target);
    if (workspace.id === this.deps.systemWorkspaceId()) {
      throw new StewardError('That is your own workspace — do the work in this run.', 'refused');
    }
    const ceiling = this.deps.sessionMaxEvents ?? DEFAULT_SESSION_MAX_EVENTS;
    let session = this.deps.sessions
      .list(workspace.id, { includeArchived: false })
      .find(
        (candidate) =>
          candidate.title === STEWARD_SESSION_TITLE &&
          !this.deps.kernel.hasActiveRunForSession(candidate.id) &&
          this.deps.transcript.countBySession(candidate.id) < ceiling,
      );
    session ??= this.deps.sessions.create({
      workspaceId: workspace.id,
      title: STEWARD_SESSION_TITLE,
      model: String(workspace.settings.defaultModel),
      effort: workspace.settings.defaultEffort,
      permissionMode: workspace.settings.defaultPermissionMode,
    });
    const run = await this.deps.kernel.submit({
      sessionId: session.id,
      prompt,
      triggeredBy: 'delegation',
      awaited: false,
    });
    this.record(actor, 'steward.run.start', run.id, `${workspace.slug}: ${excerpt(prompt, PROMPT_EXCERPT)}`);
    return { runId: run.id, sessionId: session.id, status: run.status };
  }

  runInterrupt(actor: StewardActor, runId: string) {
    const run = this.deps.runs.get(runId);
    if (!run) throw new StewardError(`No run is called "${runId}".`, 'not-found');
    if (run.id === actor.runId) throw new StewardError('You cannot interrupt yourself from a tool.', 'refused');
    const interrupted = this.deps.kernel.interrupt(run.sessionId);
    this.record(actor, 'steward.run.interrupt', runId, interrupted ? null : 'nothing was running');
    return { runId, interrupted };
  }

  /* ---------------------------------------------------------------------- */
  /* The conversation — how the operator talks to it                        */
  /* ---------------------------------------------------------------------- */

  /** Where the conversation stands: the standing session, whether it is busy, its last run. */
  conversation() {
    const own = this.deps.systemWorkspaceId();
    if (!own) return { workspaceId: null, session: null, running: false, lastRun: null };
    // The session the next message would land in: the one answering, else
    // the one with room, else the newest. Not merely the most recent — two
    // sessions rotated in the same millisecond share a timestamp, and the
    // card must name the one `converse` will actually use.
    const standing = this.deps.sessions
      .list(own, { includeArchived: false })
      .filter((candidate) => candidate.title === CONVERSATION_TITLE);
    const ceiling = this.deps.sessionMaxEvents ?? DEFAULT_SESSION_MAX_EVENTS;
    const session =
      standing.find((candidate) => this.deps.kernel.hasActiveRunForSession(candidate.id)) ??
      standing.find((candidate) => this.deps.transcript.countBySession(candidate.id) < ceiling) ??
      standing[0] ??
      null;
    const lastRun = session ? (this.deps.runs.listBySession(session.id).at(-1) ?? null) : null;
    return {
      workspaceId: own,
      session: session ? compactSession(session) : null,
      running: session ? this.deps.kernel.hasActiveRunForSession(session.id) : false,
      lastRun: lastRun ? compactRun(lastRun) : null,
    };
  }

  /**
   * Hand the operator's message to Metaclaude.
   *
   * One standing session, rotated at the event ceiling like every other
   * standing session here. A busy one is reported rather than worked
   * around: a second conversation opened beside an answer in progress is
   * how an operator ends up reading two half-answers, so the client is
   * told where the running one is and sent there.
   */
  async converse(input: { prompt: string; attachmentIds?: string[] }) {
    const own = this.deps.systemWorkspaceId();
    const workspace = own ? this.deps.workspaces.get(own) : null;
    if (!own || !workspace) throw new StewardError('The system workspace is not ready.', 'refused');

    const standing = this.deps.sessions
      .list(own, { includeArchived: false })
      .filter((candidate) => candidate.title === CONVERSATION_TITLE);
    const busy = standing.find((candidate) => this.deps.kernel.hasActiveRunForSession(candidate.id));
    if (busy) return { status: 'busy' as const, workspaceId: own, sessionId: busy.id };

    const ceiling = this.deps.sessionMaxEvents ?? DEFAULT_SESSION_MAX_EVENTS;
    let session = standing.find(
      (candidate) => this.deps.transcript.countBySession(candidate.id) < ceiling,
    );
    session ??= this.deps.sessions.create({
      workspaceId: own,
      title: CONVERSATION_TITLE,
      model: String(workspace.settings.defaultModel),
      effort: workspace.settings.defaultEffort,
      permissionMode: workspace.settings.defaultPermissionMode,
    });
    const run = await this.deps.kernel.submit({
      sessionId: session.id,
      prompt: input.prompt,
      triggeredBy: 'user',
      awaited: false,
      ...(input.attachmentIds && input.attachmentIds.length > 0
        ? { attachmentIds: input.attachmentIds }
        : {}),
    });
    return { status: 'started' as const, workspaceId: own, sessionId: session.id, runId: run.id };
  }

  /* ---------------------------------------------------------------------- */
  /* Ring 3 — named, so the refusal can be precise                           */
  /* ---------------------------------------------------------------------- */

  /** What the steward will not do yet, in the words it should use to say so. */
  static readonly IRREVERSIBLE = NOT_YET;
}
