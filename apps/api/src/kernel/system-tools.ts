/**
 * The steward's tools — an in-process MCP server, mounted for runs of the
 * system workspace only.
 *
 * Thin by design: every handler is one call into `Steward`, which owns the
 * rings and the refusals, so the tests that matter live beside the facade and
 * this file only has to prove that each tool reaches the right verb and that
 * a refusal comes back as a tool error rather than a crash.
 *
 * The table is the source of truth for three things at once: the tools the
 * server mounts, the names the system workspace pre-approves (`toolNames`),
 * and the list `CLAUDE.md` shows the agent. One table, so they cannot drift.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { AutomationTrigger, MemoryKind, MemoryShelf, PermissionMode, RunStatus, RuntimeSettingKey } from '@metaclaude/shared';
import { z } from 'zod';
import type { Steward, StewardActor } from '../services/steward.js';
import { StewardError } from '../services/steward.js';

export const SYSTEM_SERVER_NAME = 'metaclaude_system';

/** What the tools need — the real `Steward`, or a fake in tests. */
export type SystemFacade = Pick<
  Steward,
  | 'overview'
  | 'workspaces'
  | 'workspace'
  | 'sessions'
  | 'runs'
  | 'run'
  | 'memories'
  | 'memorySearch'
  | 'memoryRetire'
  | 'insights'
  | 'automations'
  | 'proposals'
  | 'approvals'
  | 'settings'
  | 'doctor'
  | 'analytics'
  | 'audit'
  | 'updates'
  | 'library'
  | 'memoryWrite'
  | 'memoryScope'
  | 'insightStatus'
  | 'proposalDecide'
  | 'automationToggle'
  | 'automationCreate'
  | 'automationUpdate'
  | 'automationFire'
  | 'sessionUpdate'
  | 'approvalDecide'
  | 'settingSet'
  | 'workspaceUpdate'
  | 'runAsk'
  | 'runStart'
  | 'runInterrupt'
>;

export type SystemToolScope = StewardActor;

const WORKSPACE = z.string().min(1).describe('A workspace slug or id, exactly as listed.');
const WORKSPACE_OR_GLOBAL = z
  .string()
  .min(1)
  .describe('A workspace slug or id, or "global" for the tier every workspace shares.');
const LIMIT = z.number().int().min(1).max(500).optional();
const ID = z.string().min(1);
const INSIGHT_STATUS = z.enum(['new', 'accepted', 'rejected', 'applied']);

/** A JSON tool result, or the error's message flagged as one. */
const asToolResult = async (fn: () => unknown | Promise<unknown>) => {
  try {
    const value = await fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const message =
      error instanceof StewardError ? `[${error.ring}] ${error.message}` : (error as Error).message;
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
};

interface SystemTool {
  name: string;
  ring: 1 | 2;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handle: (facade: SystemFacade, scope: SystemToolScope, args: never) => unknown | Promise<unknown>;
}

const tool = <S extends Record<string, z.ZodTypeAny>>(definition: {
  name: string;
  ring: 1 | 2;
  description: string;
  schema: S;
  handle: (
    facade: SystemFacade,
    scope: SystemToolScope,
    args: z.infer<z.ZodObject<S>>,
  ) => unknown | Promise<unknown>;
}): SystemTool => definition as unknown as SystemTool;

export const SYSTEM_TOOLS: readonly SystemTool[] = [
  /* ------------------------------ ring 1 ------------------------------ */
  tool({
    name: 'system_overview',
    ring: 1,
    description:
      'Where the deployment stands right now: version, runs in flight and queued, approvals waiting, ' +
      'the last 24 hours of runs and their cost, memories, new insights, pending proposals, enabled ' +
      'automations. Start here.',
    schema: {},
    handle: (facade) => facade.overview(),
  }),
  tool({
    name: 'system_workspaces',
    ring: 1,
    description: 'Every workspace with its slug, its permission mode and tool settings, and which one is yours.',
    schema: { includeArchived: z.boolean().optional() },
    handle: (facade, _scope, args) => facade.workspaces(args.includeArchived ?? false),
  }),
  tool({
    name: 'system_workspace',
    ring: 1,
    description: 'One workspace in depth: recent sessions, memory counts by kind, its automations.',
    schema: { workspace: WORKSPACE },
    handle: (facade, _scope, args) => facade.workspace(args.workspace),
  }),
  tool({
    name: 'system_sessions',
    ring: 1,
    description: "A workspace's sessions, most recent first.",
    schema: { workspace: WORKSPACE, includeArchived: z.boolean().optional(), limit: LIMIT },
    handle: (facade, _scope, args) =>
      facade.sessions(args.workspace, { includeArchived: args.includeArchived, limit: args.limit }),
  }),
  tool({
    name: 'system_runs',
    ring: 1,
    description:
      'Recent runs across the deployment or in one workspace, with status, cost and who started them. ' +
      'Filter by status to find failures.',
    schema: {
      workspace: WORKSPACE.optional(),
      sinceHours: z.number().int().min(1).max(24 * 90).optional(),
      status: RunStatus.optional(),
      limit: LIMIT,
    },
    handle: (facade, _scope, args) => facade.runs(args),
  }),
  tool({
    name: 'system_run',
    ring: 1,
    description: 'One run in full: the prompt, usage, the tools it called and its final answer.',
    schema: { runId: ID },
    handle: (facade, _scope, args) => facade.run(args.runId),
  }),
  tool({
    name: 'system_memories',
    ring: 1,
    description:
      'Browse memories — a workspace\'s plus the global tier, or "global" alone. Filter by kind or a text fragment.',
    schema: {
      workspace: WORKSPACE_OR_GLOBAL.optional(),
      kind: MemoryKind.optional(),
      search: z.string().optional(),
      limit: LIMIT,
      includeRetired: z.boolean().optional().describe('Also list retired memories — the ones system_memory_retire can restore.'),
    },
    handle: (facade, _scope, args) => facade.memories(args),
  }),
  tool({
    name: 'system_memory_search',
    ring: 1,
    description:
      'Search the memories with the same hybrid retrieval a run gets: the embedder in force plus word matching. ' +
      'Semantic only when a sentence-transformer is loaded — read `retrieval` in system_overview first; with the ' +
      'built-in hashing embedder, or while a model loads, it matches words, so title memories with the words you will search for.',
    schema: { query: z.string().min(1), workspace: WORKSPACE.optional(), limit: LIMIT },
    handle: (facade, _scope, args) => facade.memorySearch(args.query, { workspace: args.workspace, limit: args.limit }),
  }),
  tool({
    name: 'system_insights',
    ring: 1,
    description: 'What the reflexion pass has proposed: lessons, failures, patterns, consolidations. New ones await a decision.',
    schema: { workspace: WORKSPACE_OR_GLOBAL.optional(), status: INSIGHT_STATUS.optional(), limit: LIMIT },
    handle: (facade, _scope, args) => facade.insights(args),
  }),
  tool({
    name: 'system_automations',
    ring: 1,
    description: 'Every automation, or one workspace\'s: trigger, state, last outcome, failure streak.',
    schema: { workspace: WORKSPACE.optional() },
    handle: (facade, _scope, args) => facade.automations(args.workspace),
  }),
  tool({
    name: 'system_proposals',
    ring: 1,
    description: "The advisor's proposals by status.",
    schema: { status: z.enum(['pending', 'accepted', 'dismissed']).optional(), workspace: WORKSPACE.optional() },
    handle: (facade, _scope, args) => facade.proposals(args.status ?? 'pending', args.workspace),
  }),
  tool({
    name: 'system_approvals',
    ring: 1,
    description: 'Approval cards waiting for someone, with the tool, the risk and the reason.',
    schema: {},
    handle: (facade) => facade.approvals(),
  }),
  tool({
    name: 'system_settings',
    ring: 1,
    description: 'The operational settings in force, each with where its value comes from.',
    schema: {},
    handle: (facade) => facade.settings(),
  }),
  tool({
    name: 'system_doctor',
    ring: 1,
    description: 'Run the self-diagnosis: database, disk, CLI, credential, network. Read-only.',
    schema: {},
    handle: (facade) => facade.doctor(),
  }),
  tool({
    name: 'system_analytics',
    ring: 1,
    description: 'Runs, success rate, cost and tokens over a period, by model, category and workspace.',
    schema: { workspace: WORKSPACE.optional(), sinceDays: z.number().int().min(1).max(365).optional() },
    handle: (facade, _scope, args) => facade.analytics(args),
  }),
  tool({
    name: 'system_audit',
    ring: 1,
    description: 'The audit log, newest first. Filter by action, e.g. "workspace.update" or "steward.".',
    schema: { limit: LIMIT, action: z.string().optional() },
    handle: (facade, _scope, args) => facade.audit(args),
  }),
  tool({
    name: 'system_updates',
    ring: 1,
    description: 'Whether a newer release exists and what the last update attempt did. Applying one is not yours to do.',
    schema: {},
    handle: (facade) => facade.updates(),
  }),
  tool({
    name: 'system_library',
    ring: 1,
    description: 'Skills, agents and MCP servers available to runs — names and states, never a secret value.',
    schema: { workspace: WORKSPACE.optional() },
    handle: (facade, _scope, args) => facade.library(args.workspace),
  }),

  /* ------------------------------ ring 2 ------------------------------ */
  tool({
    name: 'system_memory_write',
    ring: 2,
    description:
      'Create a memory, or edit one by id. Reversible: an edit keeps the row, and a new memory can be edited again.',
    schema: {
      id: ID.optional().describe('Edit this memory; omit to create one.'),
      workspace: WORKSPACE_OR_GLOBAL.optional().describe('Where a new memory lives.'),
      kind: MemoryKind.optional(),
      title: z.string().min(1).max(300).optional(),
      content: z.string().min(1).max(20_000).optional(),
      tags: z.array(z.string().min(1).max(64)).max(20).optional(),
      confidence: z.number().min(0).max(1).optional(),
      pinned: z.boolean().optional(),
      shelf: MemoryShelf.optional().describe(
        'standing = a convention or preference the operator stated, injected into every run; durable = the default; volatile = a fact that can stop being true.',
      ),
      supersedes: ID.optional().describe(
        'A volatile memory this one replaces — the same subject at a later time. It is retired pointing at this one; a pinned, durable or standing memory is refused.',
      ),
    },
    handle: (facade, scope, args) => {
      if (args.id) {
        const { id, workspace: _workspace, supersedes, ...patch } = args;
        return facade.memoryWrite(scope, { id, patch, ...(supersedes ? { supersedes } : {}) });
      }
      if (!args.workspace || !args.kind || !args.title || !args.content) {
        throw new StewardError('A new memory needs workspace, kind, title and content.', 'refused');
      }
      // Every field the schema accepts on a creation reaches the store. The
      // first version forwarded four of six, so a memory asked for as pinned
      // at confidence 1 came back unpinned at 0.7 — reported by the steward.
      return facade.memoryWrite(scope, {
        workspace: args.workspace,
        kind: args.kind,
        title: args.title,
        content: args.content,
        tags: args.tags,
        confidence: args.confidence,
        pinned: args.pinned,
        shelf: args.shelf,
        supersedes: args.supersedes,
      });
    },
  }),
  tool({
    name: 'system_memory_retire',
    ring: 2,
    description:
      'Retire a memory that no longer holds — a soft delete: it leaves recall at once, stays readable for thirty days and can be restored with restore: true. ' +
      'Prefer this over editing a title to say "[obsolete]". A pinned memory or a standing convention is refused.',
    schema: { id: ID, restore: z.boolean().optional() },
    handle: (facade, scope, args) => facade.memoryRetire(scope, args),
  }),
  tool({
    name: 'system_memory_scope',
    ring: 2,
    description: 'Move a memory between tiers: to "global" so every workspace recalls it, or into one workspace.',
    schema: { id: ID, workspace: WORKSPACE_OR_GLOBAL },
    handle: (facade, scope, args) => facade.memoryScope(scope, args),
  }),
  tool({
    name: 'system_insight_status',
    ring: 2,
    description: 'Accept or reject an insight. Reversible: set it back to "new".',
    schema: { id: ID, status: INSIGHT_STATUS },
    handle: (facade, scope, args) => facade.insightStatus(scope, args.id, args.status),
  }),
  tool({
    name: 'system_proposal_decide',
    ring: 2,
    description:
      "Accept or dismiss one of the advisor's proposals. Accepting an automation proposal creates it disabled.",
    schema: { id: ID, decision: z.enum(['accept', 'dismiss']) },
    handle: (facade, scope, args) => facade.proposalDecide(scope, args.id, args.decision),
  }),
  tool({
    name: 'system_automation_toggle',
    ring: 2,
    description: 'Enable or pause an automation.',
    schema: { id: ID, enabled: z.boolean() },
    handle: (facade, scope, args) => facade.automationToggle(scope, args.id, args.enabled),
  }),
  tool({
    name: 'system_automation_create',
    ring: 2,
    description:
      'Create an automation in a workspace. Disabled unless enabled is true — say so to the operator either way. ' +
      'Triggers: cron (read in the server timezone, see system_overview), interval, manual, or event — ' +
      'run_failed / run_succeeded fire on the outcome of a run a person, a token or a delegation started in ' +
      'that workspace, never another automation; session_idle and file_changed have no emitter and are refused.',
    schema: {
      workspace: WORKSPACE,
      name: z.string().min(1).max(120),
      description: z.string().max(2000).optional(),
      prompt: z.string().min(1).max(100_000),
      trigger: AutomationTrigger,
      enabled: z.boolean().optional(),
      notify: z.boolean().optional().describe('Push the operator when a firing ends. Default false.'),
      permissionMode: PermissionMode.optional().describe(
        'How the firing may act unattended; dontAsk uses only pre-approved tools and never waits. Default: default.',
      ),
    },
    handle: (facade, scope, args) => facade.automationCreate(scope, args),
  }),
  tool({
    name: 'system_automation_update',
    ring: 2,
    description:
      'Edit an automation in place — name, description, prompt, trigger, notify or permissionMode; only the fields named change, ' +
      'and its history and streak stay with it. Pausing or enabling is system_automation_toggle.',
    schema: {
      id: ID,
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      prompt: z.string().min(1).max(100_000).optional(),
      trigger: AutomationTrigger.optional(),
      notify: z.boolean().optional(),
      permissionMode: PermissionMode.optional(),
    },
    handle: (facade, scope, args) => facade.automationUpdate(scope, args),
  }),
  tool({
    name: 'system_automation_fire',
    ring: 2,
    description: 'Run an automation now, once, whatever its schedule.',
    schema: { id: ID },
    handle: (facade, scope, args) => facade.automationFire(scope, args.id),
  }),
  tool({
    name: 'system_session_update',
    ring: 2,
    description: 'Rename, pin or archive a session. Archiving hides it; it can be restored.',
    schema: { id: ID, title: z.string().max(200).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() },
    handle: (facade, scope, args) => {
      const { id, ...patch } = args;
      return facade.sessionUpdate(scope, id, patch);
    },
  }),
  tool({
    name: 'system_approval_decide',
    ring: 2,
    description:
      'Allow or deny a pending approval card on the operator\'s behalf. You may deny anything; you may allow ' +
      'low and medium risk only — a high-risk call stays the operator\'s decision. Never your own run\'s cards.',
    schema: { id: ID, approved: z.boolean(), reason: z.string().max(500).optional() },
    handle: (facade, scope, args) => facade.approvalDecide(scope, args.id, args.approved, args.reason),
  }),
  tool({
    name: 'system_setting_set',
    ring: 2,
    description: 'Change an operational setting. Hot — takes effect on the next run — and reversible.',
    schema: { key: RuntimeSettingKey, value: z.union([z.number(), z.string()]) },
    handle: (facade, scope, args) => facade.settingSet(scope, args.key, args.value),
  }),
  tool({
    name: 'system_workspace_update',
    ring: 2,
    description:
      "Rename or describe a workspace, or change its ordinary settings (model, effort, language, memory switches). " +
      'Permission mode, tool lists and extra directories are refused: those widen what an agent can reach.',
    schema: {
      workspace: WORKSPACE,
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    },
    handle: (facade, scope, args) =>
      facade.workspaceUpdate(scope, args.workspace, {
        name: args.name,
        description: args.description,
        settings: args.settings as never,
      }),
  }),
  tool({
    name: 'system_run_ask',
    ring: 2,
    description:
      "Ask another workspace's agent something and wait for its answer. It runs with that workspace's " +
      'own memory, skills and permission mode. Costs a full run there; can take minutes.',
    schema: { workspace: WORKSPACE, prompt: z.string().min(1).describe('Self-contained — the target does not see this conversation.') },
    handle: (facade, scope, args) => facade.runAsk(scope, args.workspace, args.prompt),
  }),
  tool({
    name: 'system_run_start',
    ring: 2,
    description:
      "Start a run in another workspace and come back at once with its id. Check on it later with system_run. " +
      'Use this for work that takes a while or that the operator did not ask to wait for.',
    schema: { workspace: WORKSPACE, prompt: z.string().min(1) },
    handle: (facade, scope, args) => facade.runStart(scope, args.workspace, args.prompt),
  }),
  tool({
    name: 'system_run_interrupt',
    ring: 2,
    description: 'Interrupt a running run. The session survives; its agent can be asked again.',
    schema: { runId: ID },
    handle: (facade, scope, args) => facade.runInterrupt(scope, args.runId),
  }),
];

/** The names as the CLI and the broker see them — what the system workspace pre-approves. */
export function systemToolNames(): string[] {
  return SYSTEM_TOOLS.map((entry) => `mcp__${SYSTEM_SERVER_NAME}__${entry.name}`);
}

/** Bind every tool to one facade and one run — what a test drives directly. */
export function createSystemHandlers(facade: SystemFacade, scope: SystemToolScope) {
  return Object.fromEntries(
    SYSTEM_TOOLS.map((entry) => [
      entry.name,
      (args: Record<string, unknown> = {}) =>
        asToolResult(() => entry.handle(facade, scope, args as never)),
    ]),
  ) as Record<string, (args?: Record<string, unknown>) => ReturnType<typeof asToolResult>>;
}

export function buildSystemServer(
  facade: SystemFacade,
  scope: SystemToolScope,
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createSystemHandlers(facade, scope);
  return createSdkMcpServer({
    name: SYSTEM_SERVER_NAME,
    version: '1.0.0',
    tools: SYSTEM_TOOLS.map((entry) =>
      sdkTool(entry.name, entry.description, entry.schema, async (args) =>
        handlers[entry.name]!(args as Record<string, unknown>),
      ),
    ),
  });
}
