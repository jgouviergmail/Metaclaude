/**
 * Domain model — the single source of truth shared by the API and the web app.
 *
 * Every entity is declared once, as a Zod schema, and its TypeScript type is
 * inferred from it. The API validates at the edge with these schemas; the web
 * app imports the inferred types. A change here is a compile error on both
 * sides, which is exactly what we want from a contract.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** Unix epoch milliseconds. SQLite stores these as INTEGER. */
export const Millis = z.number().int().nonnegative();

/* -------------------------------------------------------------------------- */
/* Models, effort, permissions                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Model aliases understood by the Claude CLI. We deliberately keep aliases
 * rather than pinned ids so a subscription user always lands on the current
 * generation, and we allow an arbitrary string for explicit pinning.
 */
export const ModelAlias = z.enum(['default', 'opus', 'sonnet', 'haiku', 'opusplan']);
export type ModelAlias = z.infer<typeof ModelAlias>;

export const ModelSelector = z.union([ModelAlias, z.string().min(1).max(120)]);
export type ModelSelector = z.infer<typeof ModelSelector>;

export const EffortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ThinkingMode = z.enum(['adaptive', 'enabled', 'disabled']);
export type ThinkingMode = z.infer<typeof ThinkingMode>;

/**
 * Permission modes, mirroring the Agent SDK's `PermissionMode` exactly.
 *
 * - `default`           — prompt the operator for anything dangerous.
 * - `plan`              — research and propose; no tool ever executes.
 * - `acceptEdits`       — auto-approve file edits, still prompt for the rest.
 * - `dontAsk`           — never prompt; deny anything not pre-approved.
 * - `auto`              — a model classifier decides, prompting only when unsure.
 * - `bypassPermissions` — no checks at all.
 *
 * `bypassPermissions` is intentionally *not* a default anywhere: it is only
 * reachable when the operator opts in per workspace, and the API refuses it
 * unless `METACLAUDE_ALLOW_BYPASS_PERMISSIONS` is set on the container.
 */
export const PermissionMode = z.enum([
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Operator-facing copy for each mode, surfaced in the UI's mode picker. */
export const PERMISSION_MODE_INFO: Readonly<
  Record<PermissionMode, { label: string; description: string; risk: 'low' | 'medium' | 'high' }>
> = {
  plan: {
    label: 'Plan',
    description: 'Research and propose only. No tool is ever executed.',
    risk: 'low',
  },
  default: {
    label: 'Ask',
    description: 'Ask before anything that writes, deletes or runs a command.',
    risk: 'low',
  },
  acceptEdits: {
    label: 'Accept edits',
    description: 'File edits apply automatically; commands still need approval.',
    risk: 'medium',
  },
  auto: {
    label: 'Auto',
    description: 'A classifier decides, and asks you only when it is unsure.',
    risk: 'medium',
  },
  dontAsk: {
    label: "Don't ask",
    description: 'Never prompt. Anything not pre-approved is denied outright.',
    risk: 'medium',
  },
  bypassPermissions: {
    label: 'Bypass',
    description: 'No permission checks at all. Only for disposable sandboxes.',
    risk: 'high',
  },
};

/* -------------------------------------------------------------------------- */
/* Users & auth                                                                */
/* -------------------------------------------------------------------------- */

export const UserRole = z.enum(['owner', 'operator', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

export const User = z.object({
  id: z.string(),
  username: z.string().min(3).max(64),
  displayName: z.string().max(120),
  role: UserRole,
  totpEnabled: z.boolean(),
  createdAt: Millis,
  lastLoginAt: Millis.nullable(),
});
export type User = z.infer<typeof User>;



export const LoginResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), user: User, csrfToken: z.string() }),
  z.object({ status: z.literal('totp_required') }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;



/* -------------------------------------------------------------------------- */
/* Workspaces                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A workspace is the unit of isolation: a directory on disk, plus the default
 * agent policy applied to sessions created inside it.
 */
export const WorkspaceSettings = z.object({
  defaultModel: ModelSelector.default('default'),
  defaultEffort: EffortLevel.nullable().default(null),
  defaultPermissionMode: PermissionMode.default('default'),
  thinking: ThinkingMode.default('adaptive'),
  thinkingBudgetTokens: z.number().int().min(1024).max(200_000).nullable().default(null),
  maxTurns: z.number().int().min(1).max(1000).nullable().default(null),
  maxBudgetUsd: z.number().min(0).max(1000).nullable().default(null),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  additionalDirectories: z.array(z.string()).default([]),
  systemPromptAppend: z.string().max(20_000).default(''),
  /**
   * The language the agent answers in.
   *
   * `auto` is the default and changes nothing: the model follows the language
   * it is written to, which is right most of the time. It is *sub*agents that
   * drift — the 23 in the library carry English prompts and English
   * descriptions, so work delegated out of a French conversation comes back in
   * English, and nothing in the run stack had an opinion about it. One line in
   * the system prompt settles it for the whole run, delegations included,
   * which is cheaper and more reliable than translating a catalogue.
   */
  language: z.enum(['auto', 'fr', 'en']).default('auto'),
  /** Inject retrieved long-term memory into the system prompt. */
  memoryEnabled: z.boolean().default(true),
  /**
   * Whether runs in this workspace retrieve from the knowledge library —
   * the operator's reference documents, workspace shelf plus the global one.
   * Distinct from memoryEnabled on purpose: what the system learned and what
   * it was handed to read are different trusts, switched separately.
   */
  knowledgeEnabled: z.boolean().default(true),
  /** Let the learning subsystem pick model/effort from past performance. */
  autoPolicyEnabled: z.boolean().default(true),
  /** Run the post-hoc reflexion pass that distils lessons from each run. */
  reflexionEnabled: z.boolean().default(true),
  /** Enable file checkpointing so runs can be rewound. */
  checkpointing: z.boolean().default(true),
  /**
   * Mirror this workspace's sessions to claude.ai as view-only. Off by
   * default: it publishes transcripts to the account, and it only has an
   * effect when the CLI's own account sign-in is the live credential — a
   * token is inference-only and cannot upload sessions.
   */
  mirrorSessions: z.boolean().default(false),
  /**
   * The board autopilot: when a card run ends, start the next To do card by
   * itself — one card at a time, success landing in Review, the quota guard
   * consulted before every automatic start. Off by default: draining a
   * backlog unattended is a decision, not a discovery.
   */
  autoWorkBoard: z.boolean().default(false),
  /**
   * Marketplace plugins enabled here, keyed `plugin@marketplace` — the CLI's
   * own `enabledPlugins` format. A key without its marketplace half would be
   * meaningless to the CLI, so the shape refuses it at the edge.
   */
  enabledPlugins: z.record(z.string().regex(/^[^@\s]+@[^@\s]+$/), z.boolean()).default({}),
  /**
   * Let the advisor analyse this workspace by itself, at most once a day:
   * a run that reads the state of things and proposes tickets, automations,
   * skills, agents and vetted MCP servers. Off by default — an agent that
   * studies your workspace unprompted is a decision, not a discovery. The
   * manual "Ask the advisor" button works either way.
   */
  advisorAuto: z.boolean().default(false),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().max(2000),
  /** Absolute path inside the container. Always under the workspaces root. */
  path: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: z.string().max(48),
  archived: z.boolean(),
  settings: WorkspaceSettings,
  createdAt: Millis,
  updatedAt: Millis,
});
export type Workspace = z.infer<typeof Workspace>;






/* -------------------------------------------------------------------------- */
/* Sessions & runs                                                             */
/* -------------------------------------------------------------------------- */

export const SessionStatus = z.enum(['idle', 'running', 'waiting_approval', 'error', 'archived']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().max(200),
  /** The Claude CLI session id, once the first run has initialised. */
  claudeSessionId: z.string().nullable(),
  status: SessionStatus,
  model: ModelSelector,
  effort: EffortLevel.nullable(),
  permissionMode: PermissionMode,
  agentName: z.string().nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  totalCostUsd: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  createdAt: Millis,
  updatedAt: Millis,
  lastActivityAt: Millis,
});
export type Session = z.infer<typeof Session>;

export const RunStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * The composer's Tools picker, as a contract. A name may not be both cut and
 * preferred — the refinement rejects the contradiction where it is typed
 * rather than letting the run resolve it arbitrarily.
 */
export const ToolControls = z
  .object({
    requiredSkills: z.array(z.string().min(1).max(128)).max(16).default([]),
    excludedMcpServers: z.array(z.string().min(1).max(128)).max(32).default([]),
    preferredMcpServers: z.array(z.string().min(1).max(128)).max(32).default([]),
  })
  .refine(
    (controls) =>
      !controls.excludedMcpServers.some((name) => controls.preferredMcpServers.includes(name)),
    { message: 'An MCP server cannot be both excluded and preferred.' },
  );
export type ToolControls = z.infer<typeof ToolControls>;

export const RunPolicy = z.object({
  model: ModelSelector,
  effort: EffortLevel.nullable(),
  permissionMode: PermissionMode,
  thinking: ThinkingMode,
  thinkingBudgetTokens: z.number().int().nullable(),
  agentName: z.string().nullable(),
  /**
   * Standing multi-agent orchestration for this run (the CLI's "ultracode"):
   * xhigh effort plus fan-out workflows by default. Costs tokens accordingly,
   * and needs an xhigh-capable model — the CLI falls back gracefully on one
   * that is not. Defaulted so every policy stored before the field existed
   * still parses.
   */
  ultracode: z.boolean().default(false),
  /**
   * Per-message tool steering, from the composer's Tools picker. Three honest
   * levers, none of which widens a permission: required skills narrow what
   * the CLI loads to exactly those (its `skills` option is a context filter,
   * not a sandbox — the permission gates still apply); an excluded MCP server
   * is simply not mounted for this run; a preferred one stays mounted and the
   * preference is written into the system prompt, because an availability
   * filter can force absence but only words can ask for use. Absent means
   * the agent's own judgement over everything the workspace offers.
   */
  toolControls: ToolControls.optional(),
  /** Where this policy came from — user choice, workspace default, or the bandit. */
  source: z.enum(['explicit', 'workspace', 'learned']),
});
export type RunPolicy = z.infer<typeof RunPolicy>;

export const RunUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  prompt: z.string(),
  status: RunStatus,
  policy: RunPolicy,
  usage: RunUsage,
  /** Task category assigned by the classifier, used for policy learning. */
  category: z.string().nullable(),
  error: z.string().nullable(),
  /** Explicit user feedback, -1 (bad) .. +1 (good). Null until rated. */
  rating: z.number().min(-1).max(1).nullable(),
  /** Composite reward computed by the learning subsystem, 0..1. */
  reward: z.number().min(0).max(1).nullable(),
  /** Whether this run was started by an automation rather than a human. */
  /**
   * `delegation` marks a run another workspace's agent asked for; `api` marks
   * one an outside application asked for through the MCP gateway.
   *
   * `api` is not cosmetic. The run history is the only place an operator sees
   * what the agent actually did, and a run started by a token nobody was
   * watching must not read there as a run somebody typed.
   */
  triggeredBy: z.enum(['user', 'automation', 'loop', 'system', 'delegation', 'api']),
  /**
   * The CLI's uuid for the user message that started this run.
   *
   * The anchor a rewind restores to. Null when the run cannot be rewound —
   * checkpointing was off, the CLI sent no acknowledgement, or the run predates
   * the feature. The UI treats all three the same way: no rewind offered.
   */
  rewindPoint: z.string().nullable(),
  /**
   * The model that actually served the run, from the CLI's own init message.
   * The policy records what was *asked for* — under Auto that can be
   * literally 'default', with the CLI choosing. Null when the CLI never said.
   */
  servedModel: z.string().nullable().default(null),
  startedAt: Millis,
  finishedAt: Millis.nullable(),
});
export type Run = z.infer<typeof Run>;




/* -------------------------------------------------------------------------- */
/* Transcript events                                                           */
/* -------------------------------------------------------------------------- */

export const ToolCallStatus = z.enum(['pending', 'approved', 'denied', 'running', 'ok', 'error']);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

/**
 * A transcript event is the atomic, persisted unit of a conversation. The web
 * app renders a run purely from its ordered event list, which means reload,
 * replay and live streaming all share one code path.
 */
export const TranscriptEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user_message'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    text: z.string(),
    // `attachmentId` and `mime` are optional because events persisted before
    // attachments shipped carry neither; the renderer degrades to a plain chip.
    attachments: z
      .array(
        z.object({
          name: z.string(),
          path: z.string(),
          bytes: z.number(),
          attachmentId: z.string().optional(),
          mime: z.string().optional(),
        }),
      )
      .default([]),
  }),
  z.object({
    kind: z.literal('assistant_text'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    text: z.string(),
    /** Set while the model is still streaming this block. */
    streaming: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('thinking'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    text: z.string(),
    streaming: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('tool_call'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: ToolCallStatus,
    /** Truncated, display-ready result. Full payload lives in `resultPath`. */
    result: z.string().nullable().default(null),
    resultIsError: z.boolean().default(false),
    durationMs: z.number().int().nullable().default(null),
  }),
  z.object({
    kind: z.literal('subagent'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    agentName: z.string(),
    description: z.string(),
    status: z.enum(['running', 'ok', 'error']),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('todo'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    items: z.array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
        activeForm: z.string().optional(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('diff'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    path: z.string(),
    additions: z.number().int(),
    deletions: z.number().int(),
    patch: z.string(),
  }),
  z.object({
    kind: z.literal('system'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('result'),
    id: z.string(),
    runId: z.string(),
    seq: z.number().int(),
    at: Millis,
    status: RunStatus,
    usage: RunUsage,
    error: z.string().nullable().default(null),
  }),
]);
export type TranscriptEvent = z.infer<typeof TranscriptEvent>;

/* -------------------------------------------------------------------------- */
/* Tool approvals                                                              */
/* -------------------------------------------------------------------------- */

export const ApprovalRequest = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  /** Human-readable one-liner, e.g. `Bash: rm -rf build/`. */
  summary: z.string(),
  /** Heuristic risk assessment used to colour the UI and pick defaults. */
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string().nullable(),
  createdAt: Millis,
  expiresAt: Millis,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ApprovalDecision = z.object({
  approvalId: z.string(),
  approved: z.boolean(),
  /** Remember this decision for the rest of the session. */
  remember: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/* -------------------------------------------------------------------------- */
/* Memory & learning                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Three memory types, following the standard cognitive-architecture split:
 *
 * - `episodic`   — what happened during a specific run.
 * - `semantic`   — durable facts about the user, the projects, the conventions.
 * - `procedural` — how to do something; the seed material for skills.
 */
/**
 * The one place a memory tag's shape is decided, shared because two sides
 * decide it.
 *
 * Three writers reach memory — the web form, the reflexion pass, and the edit
 * route — and none agreed with the others: the form lowercased what it
 * parsed, reflexion handed over whatever case the model produced. `new Set`
 * over strings is case-sensitive, so merging a repeated observation kept
 * `Bail` *and* `bail`, and every repeat added another variant until the
 * 24-tag cap began evicting real ones (measured: 20 distinct tags filling all
 * 24 slots with case pairs).
 *
 * It lives here rather than in the API because the web needs the same rule to
 * show the user what will actually be stored. Folding happens before the cap,
 * so the budget is never spent on variants of one word.
 */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 24);
}

export const MemoryKind = z.enum(['episodic', 'semantic', 'procedural']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const Memory = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  kind: MemoryKind,
  /** Short retrieval key, ~1 sentence. */
  title: z.string().max(300),
  /** Full body injected into context when retrieved. */
  content: z.string(),
  tags: z.array(z.string()).default([]),
  /** 0..1 — how much we trust this memory. Reinforced on use, decayed by time. */
  confidence: z.number().min(0).max(1),
  /** Number of times this memory was retrieved into a run. */
  useCount: z.number().int().nonnegative(),
  /** Times a run that used this memory succeeded. Drives reinforcement. */
  successCount: z.number().int().nonnegative(),
  /** Pinned memories are never decayed or garbage-collected. */
  pinned: z.boolean(),
  sourceRunId: z.string().nullable(),
  createdAt: Millis,
  updatedAt: Millis,
  lastUsedAt: Millis.nullable(),
});
export type Memory = z.infer<typeof Memory>;







/* -------------------------------------------------------------------------- */
/* Skills, agents, MCP                                                         */
/* -------------------------------------------------------------------------- */





export const McpTransport = z.enum(['stdio', 'sse', 'http']);
export type McpTransport = z.infer<typeof McpTransport>;



/* -------------------------------------------------------------------------- */
/* Automations (the "loop" engine)                                             */
/* -------------------------------------------------------------------------- */

export const AutomationTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cron'), expression: z.string().min(1).max(200) }),
  z.object({ type: z.literal('interval'), everyMs: z.number().int().min(60_000) }),
  z.object({ type: z.literal('manual') }),
  /**
   * Fired by the outcome of another run in the same workspace — one a person,
   * a token or a delegation started, never another automation, which would
   * chain. `run_failed` and `run_succeeded` have an emitter; `session_idle`
   * and `file_changed` are named here since the first schema and have none,
   * so the scheduler refuses them at creation rather than accept a trigger
   * that never fires. `filter` is a word that must appear in the run's
   * category or prompt.
   */
  z.object({
    type: z.literal('event'),
    event: z.enum(['run_failed', 'run_succeeded', 'session_idle', 'file_changed']),
    filter: z.string().max(300).optional(),
  }),
]);

/** The event triggers something actually emits. The other two are declared and refused. */
export const EMITTED_AUTOMATION_EVENTS = ['run_failed', 'run_succeeded'] as const;
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const Automation = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  prompt: z.string().min(1).max(100_000),
  trigger: AutomationTrigger,
  policy: z
    .object({
      model: ModelSelector.default('default'),
      effort: EffortLevel.nullable().default(null),
      permissionMode: PermissionMode.default('default'),
      agentName: z.string().nullable().default(null),
      maxTurns: z.number().int().min(1).max(500).nullable().default(null),
      /**
       * Push the operator when a firing ends. Off by default: the machinery
       * works while they sleep, and a channel that wakes them for it gets
       * disabled within a week — but a brief nobody hears about is a brief
       * read ten hours late, so the automations whose whole point is to be
       * read opt in.
       */
      notify: z.boolean().default(false),
    })
    .default({
      model: 'default',
      effort: null,
      permissionMode: 'default',
      agentName: null,
      maxTurns: null,
      notify: false,
    }),
  /**
   * When set, each firing continues the same Claude session instead of starting
   * fresh — this is what turns an automation into a long-running agentic loop
   * that accumulates context across firings.
   */
  continuous: z.boolean().default(false),
  sessionId: z.string().nullable(),
  /** Stop the loop after this many consecutive failures. 0 disables the guard. */
  maxConsecutiveFailures: z.number().int().min(0).max(100).default(3),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  enabled: z.boolean(),
  lastRunAt: Millis.nullable(),
  lastStatus: RunStatus.nullable(),
  nextRunAt: Millis.nullable(),
  runCount: z.number().int().nonnegative(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type Automation = z.infer<typeof Automation>;

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */





/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a message may carry, and how much.
 *
 * Files land under the workspace's `attachments/` directory — on disk, where
 * the agent's own Read tool handles images and PDFs natively and every other
 * type through its ordinary tooling. Small images and PDFs additionally ride
 * the prompt itself as content blocks (the API caps a block around 5 MB of
 * base64, hence the conservative inline ceilings); everything else reaches
 * the model as a named path, which is the robust channel for any size.
 */
export const ATTACHMENT_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxPerMessage: 8,
  inlineImageBytes: 2 * 1024 * 1024,
  inlinePdfBytes: 4 * 1024 * 1024,
} as const;

/**
 * The types a message accepts. An allowlist rather than a denylist: the point
 * of an attachment is that the agent can do something with it, and honesty
 * about what is supported beats accepting bytes that will sit inert.
 */
export const ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/**
 * A type, not a schema, on purpose — same exception as `Brief` and
 * `UpdateCheck`: the server produces attachments from its own ledger and
 * nothing ever parses one at an edge (uploads are validated by their own
 * request schema; the transcript's copy rides `TranscriptEvent`). A z.object
 * here would ride the web entry chunk for nothing — which is exactly how the
 * bundle ratchet caught its first draft.
 */
export interface Attachment {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** Bound when the message is submitted; null while still pending in the composer. */
  runId: string | null;
  /** The name the user gave the file, for display. */
  name: string;
  /** Workspace-relative path under `attachments/`, derived from the content hash. */
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: number;
}

/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* Library categories — how skills and agents are shelved                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a skill or agent belongs on the shelf.
 *
 * Two halves, in this order: the domains of work, then the domains of a life.
 * The second half exists because nothing in this system is specific to code —
 * the memory, the policy and the board serve a house move or a week of meals
 * exactly as they serve a refactor — and a library that only spoke of
 * engineering quietly said otherwise.
 *
 * `general` stays last on purpose: a taxonomy without an "everything else"
 * drawer forces bad filing.
 */
export const LibraryCategory = z.enum([
  'engineering',
  'writing',
  'data',
  'ops',
  'research',
  'product',
  'home',
  'health',
  'money',
  'learning',
  'travel',
  'career',
  'general',
]);
export type LibraryCategory = z.infer<typeof LibraryCategory>;
export const LIBRARY_CATEGORIES = LibraryCategory.options;

/* -------------------------------------------------------------------------- */
/* Google — the one connector Metaclaude authorises for itself                 */
/* -------------------------------------------------------------------------- */

/**
 * What the operator is granting, one checkbox each.
 *
 * Deliberately finer than "Gmail, Calendar, Drive": reading mail and sending
 * mail are different powers, and an agent that can read your inbox to prepare
 * a summary has no business also being able to send from it unless you said
 * so. Each entry maps to exactly one Google scope in
 * `apps/api/src/integrations/google/scopes.ts`, and the granted set decides
 * both the consent screen and which tools the MCP server registers — so a
 * capability you did not grant does not merely fail, it does not exist.
 */
export const GoogleGrant = z.enum([
  'gmail.read',
  'gmail.send',
  'calendar.read',
  'calendar.write',
  'drive.read',
  'drive.write',
]);
export type GoogleGrant = z.infer<typeof GoogleGrant>;
export const GOOGLE_GRANTS = GoogleGrant.options;

/* The board — tasks the operator and the agents share                         */
/* -------------------------------------------------------------------------- */

export const TaskStatus = z.enum(['backlog', 'todo', 'in_progress', 'review', 'done']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/**
 * One card. A real schema, not a type: board updates ride the socket, so
 * `parseWireFrame` genuinely reaches this at runtime.
 *
 * `orderKey` is a fractional position within (workspace, status) — the server
 * assigns it on every move, so ordering survives concurrent edits without a
 * renumbering sweep. `archivedAt` is a timestamp rather than a status: an
 * archived card keeps the column it died in, which is what a restore should
 * restore. `assignee` names who works it — the operator or this workspace's
 * agent; the agent half becomes actionable in the delegation lot.
 */
export const BoardTask = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Set when this card was decomposed out of a larger one. */
  parentId: z.string().nullable().default(null),
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).default(''),
  status: TaskStatus,
  priority: TaskPriority.default('normal'),
  assignee: z.enum(['user', 'agent']).nullable().default(null),
  /** The run currently (or last) working this card. */
  runId: z.string().nullable().default(null),
  dueAt: Millis.nullable().default(null),
  orderKey: z.string(),
  /** Why the card cannot advance — human-readable, cleared on movement. */
  blockedReason: z.string().nullable().default(null),
  /** 'user:<name>' or 'agent:<runId>' — who created it is part of the record. */
  createdBy: z.string(),
  createdAt: Millis,
  updatedAt: Millis,
  archivedAt: Millis.nullable().default(null),
});
export type BoardTask = z.infer<typeof BoardTask>;

export const TaskComment = z.object({
  id: z.string(),
  taskId: z.string(),
  /** 'user:<name>' or 'agent:<runId>'. */
  author: z.string(),
  body: z.string().min(1).max(10_000),
  createdAt: Millis,
});
export type TaskComment = z.infer<typeof TaskComment>;

/**
 * One entry of a card's history. A type, not a schema — same exception as
 * `Brief`: the server writes these append-only and the drawer reads them
 * over REST; nothing parses one at an edge.
 */
export interface TaskActivity {
  id: string;
  taskId: string;
  actor: string;
  kind:
    | 'created'
    | 'moved'
    | 'updated'
    | 'assigned'
    | 'commented'
    | 'run_linked'
    | 'archived'
    | 'restored';
  detail: string;
  at: number;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                   */
/* -------------------------------------------------------------------------- */






/**
 * A claude.ai account sign-in held by the CLI itself (`claude auth login`,
 * run in the container). Distinct from a paired token: the CLI maintains and
 * refreshes it on its own, and its scopes decide what the account can do —
 * `full` means it carries the session-sync scopes a setup token never has.
 */
export const ClaudeCliLoginInfo = z.object({
  full: z.boolean(),
  scopes: z.array(z.string()),
  subscriptionType: z.string().nullable(),
  /**
   * When the *access* token expires — hours away, and rotated by the CLI on
   * its own. Almost never the number anybody wants.
   */
  expiresAt: z.number().nullable(),
  /**
   * When the sign-in itself ends, and nothing can extend it.
   *
   * The refresh token's expiry, and the only date worth watching: measured on
   * a live deployment, two backups a day apart showed `expiresAt` move while
   * this stayed at exactly the same instant. It is fixed-term, not rolling, so
   * activity does not push it back — and when it passes, every run fails to
   * authenticate at once.
   *
   * Null when the store does not carry one, which means *unknown* rather than
   * expired: a setup token has no such field, and neither does an older CLI.
   */
  signInEndsAt: z.number().nullable().default(null),
});
export type ClaudeCliLoginInfo = z.infer<typeof ClaudeCliLoginInfo>;







/** Type-only on purpose: only the API builds it. */
export interface PushStatus {
  /** The VAPID public key browsers subscribe with. Public by design. */
  publicKey: string;
  /** Live subscriptions across the deployment, all devices confounded. */
  devices: number;
}

/** Type-only on purpose: only the API builds these, so no runtime schema. */
export interface ClaudePairingStart {
  /** The authorization URL to open and approve. */
  url: string;
  /** When this attempt stops being accepted (epoch ms). */
  expiresAt: number;
}

export interface ClaudePairingState {
  active: boolean;
  expiresAt: number | null;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One workspace's share of the usage.
 *
 * Analytics could already scope to one workspace, which answers "how much did
 * this one cost" and never "which one is eating the quota" — and on a
 * subscription with a weekly ceiling, that second question is the one that
 * matters. It needs every workspace at once, so it cannot be a filter.
 */
export const WorkspaceUsage = z.object({
  workspaceId: z.string(),
  name: z.string(),
  /** The workspace's own colour, so the ranking is readable at a glance. */
  color: z.string(),
  runs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
});
export type WorkspaceUsage = z.infer<typeof WorkspaceUsage>;

/**
 * The aggregate view of a period.
 *
 * Lives here rather than in the analytics service because both sides read it:
 * the shape was written out twice — once as an interface in `services/`, once
 * inline in the web client's `request<…>` — and the copies had already started
 * to matter, since adding a field to one silently left the other describing a
 * response it no longer receives.
 */
export const AnalyticsSummary = z.object({
  totalRuns: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  totalCostUsd: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  medianDurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  averageReward: z.number().nullable(),
  byModel: z.array(
    z.object({
      model: z.string(),
      runs: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
      successRate: z.number().min(0).max(1),
    }),
  ),
  byCategory: z.array(
    z.object({
      category: z.string(),
      runs: z.number().int().nonnegative(),
      averageReward: z.number().nullable(),
    }),
  ),
  byWorkspace: z.array(WorkspaceUsage),
});
export type AnalyticsSummary = z.infer<typeof AnalyticsSummary>;

/* -------------------------------------------------------------------------- */
/* What Claude itself offers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue the CLI reports for a workspace.
 *
 * Metaclaude used to describe Claude's capabilities from a hard-coded list
 * written when the page was built — three model names and their prices. The CLI
 * knows the real answer, and it changes without a Metaclaude release: which
 * models the subscription grants, which of them take an effort level, which
 * slash commands and subagents exist here, and whether each MCP server actually
 * connected.
 *
 * Everything is optional-with-a-default rather than required, because an older
 * CLI answers some of these and not others, and one missing control method must
 * not cost the operator the whole catalogue.
 */
export const ClaudeModelInfo = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string().default(''),
  /** Present when the alias resolves to a dated model id. */
  resolvedModel: z.string().nullable().default(null),
  supportsEffort: z.boolean().default(false),
  supportedEffortLevels: z.array(EffortLevel).default([]),
  supportsAdaptiveThinking: z.boolean().default(false),
});
export type ClaudeModelInfo = z.infer<typeof ClaudeModelInfo>;

export const ClaudeCommandInfo = z.object({
  name: z.string(),
  description: z.string().default(''),
  argumentHint: z.string().default(''),
  aliases: z.array(z.string()).default([]),
});
export type ClaudeCommandInfo = z.infer<typeof ClaudeCommandInfo>;

export const ClaudeAgentInfo = z.object({
  name: z.string(),
  description: z.string().default(''),
  model: z.string().nullable().default(null),
});
export type ClaudeAgentInfo = z.infer<typeof ClaudeAgentInfo>;

export const ClaudeMcpTool = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** The server's own advertised safety hints. Displayed, never enforced. */
  readOnly: z.boolean().nullable().default(null),
  destructive: z.boolean().nullable().default(null),
});
export type ClaudeMcpTool = z.infer<typeof ClaudeMcpTool>;

export const ClaudeMcpServerStatus = z.object({
  name: z.string(),
  status: z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown']),
  error: z.string().nullable().default(null),
  serverName: z.string().nullable().default(null),
  serverVersion: z.string().nullable().default(null),
  scope: z.string().nullable().default(null),
  tools: z.array(ClaudeMcpTool).default([]),
});
export type ClaudeMcpServerStatus = z.infer<typeof ClaudeMcpServerStatus>;

export const ClaudeAccountInfo = z.object({
  /** Never shown in full; the API returns only what the operator already knows. */
  email: z.string().nullable().default(null),
  organization: z.string().nullable().default(null),
  subscriptionType: z.string().nullable().default(null),
  apiProvider: z.string().nullable().default(null),
});
export type ClaudeAccountInfo = z.infer<typeof ClaudeAccountInfo>;



/**
 * The subscription's quota picture, as the CLI itself reports it.
 *
 * Every window — the five-hour session window, the weekly ones, and the
 * per-model buckets — is normalised into one flat list so the screen renders
 * them uniformly and a bucket the server adds tomorrow costs nothing here.
 * The behaviours block is the CLI's own attribution of what has been eating
 * the quota, from its local transcripts: approximate by its own admission
 * (other devices and claude.ai are invisible to it), which the UI must say.
 */
export const ClaudeUsageWindow = z.object({
  /** Stable identity: 'five_hour', 'seven_day', … or 'model:<display name>'. */
  key: z.string(),
  label: z.string(),
  /** Percentage of the window used, 0–100; null when the server did not say. */
  utilization: z.number().nullable(),
  resetsAt: Millis.nullable(),
});
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

export const ClaudeUsageShare = z.object({ name: z.string(), pct: z.number() });
export type ClaudeUsageShare = z.infer<typeof ClaudeUsageShare>;

export const ClaudeUsageBehaviorWindow = z.object({
  requestCount: z.number(),
  sessionCount: z.number(),
  /** Overlapping categories — not a partition, so shares do not sum to 100. */
  behaviors: z.array(z.object({ key: z.string(), pct: z.number(), count: z.number() })),
  agents: z.array(ClaudeUsageShare),
  skills: z.array(ClaudeUsageShare),
  plugins: z.array(ClaudeUsageShare),
  mcpServers: z.array(ClaudeUsageShare),
});
export type ClaudeUsageBehaviorWindow = z.infer<typeof ClaudeUsageBehaviorWindow>;

/**
 * The doctor — the system examining itself, read-only.
 *
 * Every check is named, has one of three statuses, and speaks in sentences.
 * The report's own status is the worst of its checks, so a screen (or an
 * agent) can act on one field and drill into the rest.
 */
export const DoctorCheck = z.object({
  name: z.string(),
  status: z.enum(['ok', 'warn', 'fail']),
  summary: z.string(),
  /** Supporting evidence — the broken entry id, the failing slots, the path. */
  detail: z.string().nullable().default(null),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  status: z.enum(['ok', 'warn', 'fail']),
  checks: z.array(DoctorCheck),
  version: z.string(),
  ranAt: Millis,
});
export type DoctorReport = z.infer<typeof DoctorReport>;

/**
 * The morning brief — one page answering "what happened, what needs me".
 *
 * Types rather than schemas for the same reason as UpdateCheck below: the
 * server composes it from already-validated data and nothing parses it at an
 * edge, so a Zod declaration would only cost the web entry a kilobyte.
 */
export interface BriefFailure {
  runId: string;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  /** The prompt that failed, truncated to a line. */
  prompt: string;
  error: string | null;
  at: number;
}

export interface Brief {
  since: number;
  generatedAt: number;
  /** The one sentence to read when nothing else gets read. */
  headline: string;
  activity: AnalyticsSummary;
  failures: BriefFailure[];
  pendingApprovals: number;
  automations: {
    /** Switched off by the failure guard — silently, which is why it is here. */
    disabledByGuard: string[];
    nextRun: { name: string; at: number } | null;
  };
  doctor: DoctorReport;
  /** Null when the CLI could not answer — the brief still stands. */
  quota: ClaudeUsage | null;
  /** Insights the reflexion pass added in the period. */
  newInsights: number;
  /** The kanban board's pulse — active cards only, across every workspace. */
  board: BriefBoard;
}

export interface BriefBoard {
  /** Cards waiting on the operator's word — the agent never moves past review. */
  inReview: number;
  /** Cards flagged blocked, by the agent or the operator. */
  blocked: number;
  /** Cards a live run is working right now. */
  inFlight: number;
  /** Cards due within 48 hours (or overdue) and not done. */
  dueSoon: number;
}

/**
 * The update check's answer — the informational half of guarded self-update.
 *
 * A type rather than a schema, deliberately: the server produces it and
 * nothing validates it at an edge, and every Zod declaration in this package
 * ships in the web entry chunk (see the bitten-before note in CLAUDE.md).
 * Promote it to a schema only when something starts parsing it.
 */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  /** Null when either version does not parse — "cannot tell", not "no". */
  updateAvailable: boolean | null;
  releaseUrl: string | null;
  error: string | null;
  checkedAt: number;
}

/**
 * The apply half — what the host updater's handshake directory says. A type
 * for the same reason as UpdateCheck above.
 */
export interface UpdateApplyStatus {
  /** False when this host never installed the updater unit. */
  available: boolean;
  state: 'idle' | 'requested' | 'running' | 'succeeded' | 'failed';
  version: string | null;
  message: string | null;
  at: number | null;
}

export const ClaudeUsage = z.object({
  /** 'pro', 'max', … — null for API-key or third-party-provider sessions. */
  subscriptionType: z.string().nullable(),
  windows: z.array(ClaudeUsageWindow),
  /** The overage-credits arrangement, when the plan has one. */
  extraUsage: z
    .object({
      isEnabled: z.boolean(),
      monthlyLimit: z.number().nullable(),
      usedCredits: z.number().nullable(),
      utilization: z.number().nullable(),
    })
    .nullable(),
  behaviors: z
    .object({ day: ClaudeUsageBehaviorWindow, week: ClaudeUsageBehaviorWindow })
    .nullable(),
  /** What could not be read, by name — same convention as the catalogue. */
  unavailable: z.array(z.string()),
  fetchedAt: Millis,
});
export type ClaudeUsage = z.infer<typeof ClaudeUsage>;




/* -------------------------------------------------------------------------- */
/* Agent Plugins 1.0.0                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The vendor-neutral plugin format published on 2026-08-06 by Amazon, Cursor,
 * Microsoft, OpenAI and Vercel, with Google joining as a core maintainer.
 *
 * One directory packages Agent Skills and MCP servers so the same folder works
 * across every client that implements the spec. The schemas below are a
 * transcription of 1.0.0, not an interpretation of it: where the spec says a
 * field is the only permitted set, this refuses the rest, because a manifest
 * that validates here and nowhere else would defeat the point of a standard.
 *
 * https://github.com/agentplugins/agent-plugins-spec
 */
export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const PLUGIN_MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

export const PluginAuthor = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

export const PluginManifest = z
  .object({
    $schema: z.string(),
    /** Lowercase alphanumeric, hyphens and periods; 1–64 characters. */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9.-]*$/, 'A plugin name is lowercase letters, digits, hyphens and periods.'),
    version: z.string().optional(),
    description: z.string().optional(),
    author: PluginAuthor.optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    /**
     * Client-specific data, keyed by reverse-domain namespace. The spec says a
     * client MUST ignore members it does not implement *without validating
     * them*, so this stays deliberately unshaped.
     */
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  // "The only permitted top-level fields are …" — an unknown key is reported
  // rather than accepted, but per the spec it is not fatal, so the loader
  // strips and warns instead of refusing the plugin.
  .strict();
export type PluginManifest = z.infer<typeof PluginManifest>;

const PluginMcpStdio = z.object({
  type: z.literal('stdio'),
  /** A bare executable name, or a ./ path relative to the plugin root. */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const PluginMcpHttp = z.object({
  type: z.literal('streamable-http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** Legacy in 1.0.0, and still permitted. */
const PluginMcpSse = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const PluginMcpServer = z.discriminatedUnion('type', [
  PluginMcpStdio,
  PluginMcpHttp,
  PluginMcpSse,
]);
export type PluginMcpServer = z.infer<typeof PluginMcpServer>;

/**
 * The shape of a plugin's `mcp.json`, as the Agent Plugins spec defines it.
 *
 * A type rather than a Zod schema, deliberately. The spec requires a client to
 * isolate per-component failures, so the loader must never validate this file
 * as a whole — one malformed server has to be skipped with a warning while its
 * neighbours load, which is what `services/plugins.ts` does by running
 * `PluginMcpServer.safeParse` per entry. A whole-file schema could only ever
 * reject the lot, so there is nothing here for one to do; as a runtime schema
 * it was unreferenced and cost the web app's entry chunk bytes for a validation
 * that must not happen.
 */
export interface PluginMcpFile {
  $schema: string;
  mcpServers: Record<string, PluginMcpServer>;
}

/** One skill found under `skills/`, as loaded from disk. */
export const PluginSkill = z.object({
  name: z.string(),
  description: z.string(),
  /** Absolute path to the skill's SKILL.md. */
  path: z.string(),
});
export type PluginSkill = z.infer<typeof PluginSkill>;


export const InstallPluginRequest = z
  .object({
    /** A git URL to clone, or an absolute path already on the server. */
    source: z.string().min(1).max(500),
  })
  .strict();
export type InstallPluginRequest = z.infer<typeof InstallPluginRequest>;

/**
 * A plugin marketplace — a source the Claude CLI itself fetches plugins from.
 *
 * The shape mirrors the CLI's own `extraKnownMarketplaces` settings key, kept
 * to the two source kinds an operator can point at from a browser: a GitHub
 * repository or a direct `marketplace.json` URL. Adding one is owner-level:
 * a marketplace supplies skills, hooks and MCP servers the agent will run.
 */
export const MarketplaceSource = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('github'),
      /**
       * `owner/repo`, one repository exactly. The owner-wildcard form
       * (`owner/*`) is meaningful only in managed policy lists; everywhere
       * else the CLI takes the `*` literally and the clone fails, so it is
       * refused here rather than stored broken.
       */
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      /** Branch or tag; the repository default when absent. */
      ref: z.string().min(1).max(120).optional(),
      /** Path to marketplace.json when it is not at the CLI's default. */
      path: z.string().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal('url'),
      /** https only: this file names code the agent will execute. */
      url: z.string().url().startsWith('https://').max(500),
    })
    .strict(),
]);
export type MarketplaceSource = z.infer<typeof MarketplaceSource>;

export const MarketplaceInput = z
  .object({
    /**
     * The marketplace id: the `extraKnownMarketplaces` key, and the suffix of
     * every `plugin@marketplace` entry — so no spaces and no `@`.
     */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    source: MarketplaceSource,
  })
  .strict();
export type MarketplaceInput = z.infer<typeof MarketplaceInput>;

export const Marketplace = MarketplaceInput.extend({
  id: z.string(),
  enabled: z.boolean(),
  createdAt: Millis,
});
export type Marketplace = z.infer<typeof Marketplace>;

/**
 * One plugin as a marketplace's own `marketplace.json` describes it. Parsed
 * leniently: the catalogue exists to be browsed, and a marketplace that adds
 * fields tomorrow must not stop listing today.
 */
export const MarketplacePlugin = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
});
export type MarketplacePlugin = z.infer<typeof MarketplacePlugin>;


