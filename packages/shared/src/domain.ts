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

export const IsoDateTime = z.string().datetime({ offset: true });

/** Unix epoch milliseconds. SQLite stores these as INTEGER. */
export const Millis = z.number().int().nonnegative();

export const NonEmptyString = z.string().min(1).max(10_000);

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

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), user: User, csrfToken: z.string() }),
  z.object({ status: z.literal('totp_required') }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const AuthSessionInfo = z.object({
  id: z.string(),
  createdAt: Millis,
  lastSeenAt: Millis,
  expiresAt: Millis,
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  current: z.boolean(),
});
export type AuthSessionInfo = z.infer<typeof AuthSessionInfo>;

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
  /** Inject retrieved long-term memory into the system prompt. */
  memoryEnabled: z.boolean().default(true),
  /** Let the learning subsystem pick model/effort from past performance. */
  autoPolicyEnabled: z.boolean().default(true),
  /** Run the post-hoc reflexion pass that distils lessons from each run. */
  reflexionEnabled: z.boolean().default(true),
  /** Enable file checkpointing so runs can be rewound. */
  checkpointing: z.boolean().default(true),
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

export const CreateWorkspaceRequest = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  icon: z.string().max(48).default('folder'),
  /** Optional git repository to clone into the new workspace. */
  gitUrl: z.string().url().max(500).optional(),
  settings: WorkspaceSettings.partial().optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

/**
 * Attaching a repository to a workspace that already exists.
 *
 * `gitUrl` omitted means "track this directory locally" — `git init` and
 * nothing else — which is the honest option for work that has no remote yet.
 */
export const ConnectRepositoryRequest = z.object({
  gitUrl: z.string().url().max(500).nullable().default(null),
});
export type ConnectRepositoryRequest = z.infer<typeof ConnectRepositoryRequest>;

export const ConnectRepositoryResult = z.object({
  /** cloned: the directory was empty. fetched: files were already there, so the
   *  remote was added and fetched without touching the working tree.
   *  initialised: a local repository with no remote. */
  mode: z.enum(['cloned', 'fetched', 'initialised']),
  branch: z.string().nullable(),
});
export type ConnectRepositoryResult = z.infer<typeof ConnectRepositoryResult>;

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

export const RunPolicy = z.object({
  model: ModelSelector,
  effort: EffortLevel.nullable(),
  permissionMode: PermissionMode,
  thinking: ThinkingMode,
  thinkingBudgetTokens: z.number().int().nullable(),
  agentName: z.string().nullable(),
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
  triggeredBy: z.enum(['user', 'automation', 'loop', 'system']),
  /**
   * The CLI's uuid for the user message that started this run.
   *
   * The anchor a rewind restores to. Null when the run cannot be rewound —
   * checkpointing was off, the CLI sent no acknowledgement, or the run predates
   * the feature. The UI treats all three the same way: no rewind offered.
   */
  rewindPoint: z.string().nullable(),
  startedAt: Millis,
  finishedAt: Millis.nullable(),
});
export type Run = z.infer<typeof Run>;

/**
 * What a rewind did, or would do.
 *
 * The same shape answers both questions, because the preview has to be
 * trustworthy: it is produced by the CLI's own dry run, not by a second
 * implementation that could disagree with the real one.
 */
export const RewindResult = z.object({
  /** False when the CLI declined — no checkpoints, session gone, files moved. */
  canRewind: z.boolean(),
  /** The CLI's own words when it declined. Shown verbatim; never paraphrased. */
  error: z.string().nullable(),
  /** Workspace-relative paths that changed, or would change. */
  filesChanged: z.array(z.string()),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /**
   * Files the CLI refused to touch because a symlink, a hard link or a moved
   * parent directory made the restore unsafe. Only ever set on a real rewind —
   * a preview cannot know — so a non-zero count here is the operator's signal
   * that the restore was partial.
   */
  skippedLinks: z.number().int().nonnegative(),
  /** False for a preview, true when the files were actually restored. */
  applied: z.boolean(),
});
export type RewindResult = z.infer<typeof RewindResult>;

export const RewindRequest = z.object({
  /** Preview only. Defaults to true so a mistaken call cannot destroy work. */
  dryRun: z.boolean().default(true),
});
export type RewindRequest = z.infer<typeof RewindRequest>;

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
    attachments: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number() })).default([]),
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
export type TranscriptEventKind = TranscriptEvent['kind'];

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

export const CreateMemoryRequest = z.object({
  workspaceId: z.string().nullable().default(null),
  kind: MemoryKind.default('semantic'),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(20_000),
  tags: z.array(z.string().max(48)).max(24).default([]),
  pinned: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>;

export const MemorySearchResult = z.object({
  memory: Memory,
  score: z.number(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

/**
 * A learned policy arm. The bandit maintains one row per
 * (workspace, category, arm) triple and samples from the Beta posterior.
 */
export const PolicyArm = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  category: z.string(),
  model: ModelSelector,
  effort: EffortLevel.nullable(),
  /** Beta(alpha, beta) posterior over the success probability of this arm. */
  alpha: z.number().positive(),
  beta: z.number().positive(),
  trials: z.number().int().nonnegative(),
  totalReward: z.number(),
  meanCostUsd: z.number().nonnegative(),
  meanDurationMs: z.number().nonnegative(),
  updatedAt: Millis,
});
export type PolicyArm = z.infer<typeof PolicyArm>;

/** A distilled, human-reviewable observation produced by the reflexion pass. */
export const Insight = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  runId: z.string().nullable(),
  kind: z.enum(['lesson', 'pattern', 'failure', 'preference', 'skill_proposal']),
  title: z.string(),
  body: z.string(),
  /** 0..1 confidence reported by the reflector. */
  confidence: z.number().min(0).max(1),
  status: z.enum(['new', 'accepted', 'rejected', 'applied']),
  /** For `skill_proposal`, the generated skill markdown awaiting approval. */
  payload: z.string().nullable(),
  createdAt: Millis,
});
export type Insight = z.infer<typeof Insight>;

/* -------------------------------------------------------------------------- */
/* Skills, agents, MCP                                                         */
/* -------------------------------------------------------------------------- */

export const SkillDefinition = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1).max(1024),
  body: z.string().max(200_000),
  enabled: z.boolean(),
  /** Set when the learning loop generated this skill rather than the user. */
  autoGenerated: z.boolean(),
  useCount: z.number().int().nonnegative(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type SkillDefinition = z.infer<typeof SkillDefinition>;

export const AgentDefinitionRecord = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1).max(1024),
  prompt: z.string().min(1).max(100_000),
  tools: z.array(z.string()).nullable(),
  model: ModelSelector.nullable(),
  enabled: z.boolean(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type AgentDefinitionRecord = z.infer<typeof AgentDefinitionRecord>;

export const McpTransport = z.enum(['stdio', 'sse', 'http']);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpServerRecord = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  transport: McpTransport,
  command: z.string().nullable(),
  args: z.array(z.string()).default([]),
  url: z.string().nullable(),
  /** Env var names only; values live in the encrypted vault. */
  envKeys: z.array(z.string()).default([]),
  /**
   * Header names only; values live in the encrypted vault alongside the env
   * secrets. An HTTP MCP server authenticates with `Authorization`, so a header
   * value is a credential far more often than it is metadata — storing the map
   * on the row would put a bearer token in plaintext and hand it to anyone who
   * can read the server list.
   */
  headerKeys: z.array(z.string()).default([]),
  enabled: z.boolean(),
  status: z.enum(['unknown', 'connected', 'failed', 'disabled']),
  lastError: z.string().nullable(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type McpServerRecord = z.infer<typeof McpServerRecord>;

/* -------------------------------------------------------------------------- */
/* Automations (the "loop" engine)                                             */
/* -------------------------------------------------------------------------- */

export const AutomationTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cron'), expression: z.string().min(1).max(200) }),
  z.object({ type: z.literal('interval'), everyMs: z.number().int().min(60_000) }),
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('event'),
    event: z.enum(['run_failed', 'run_succeeded', 'session_idle', 'file_changed']),
    filter: z.string().max(300).optional(),
  }),
]);
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
    })
    .default({
      model: 'default',
      effort: null,
      permissionMode: 'default',
      agentName: null,
      maxTurns: null,
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

export const FileEntry = z.object({
  name: z.string(),
  /** Workspace-relative POSIX path. Never absolute, never contains `..`. */
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  modifiedAt: Millis,
  /** Present for files only. */
  language: z.string().nullable().default(null),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const GitStatus = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  staged: z.array(z.string()),
  modified: z.array(z.string()),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
});
export type GitStatus = z.infer<typeof GitStatus>;

/* -------------------------------------------------------------------------- */
/* Analytics                                                                   */
/* -------------------------------------------------------------------------- */

export const UsagePoint = z.object({
  bucket: Millis,
  runs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  medianDurationMs: z.number().nonnegative(),
});
export type UsagePoint = z.infer<typeof UsagePoint>;

export const SystemHealth = z.object({
  version: z.string(),
  uptimeMs: z.number().int().nonnegative(),
  claudeCli: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    authenticated: z.boolean(),
    authMode: z.enum(['subscription', 'api_key', 'none']),
    /**
     * Where the credential came from. `environment` means .env on the server;
     * `stored` means the owner paired it from the interface and it is sealed in
     * the vault. The distinction matters to the person deciding whether they
     * still need a shell to change it.
     */
    authSource: z.enum(['stored', 'environment']).nullable(),
    /** Last four characters. Enough to tell two credentials apart, never enough to use one. */
    authHint: z.string().nullable(),
  }),
  activeRuns: z.number().int().nonnegative(),
  queuedRuns: z.number().int().nonnegative(),
  memoryCount: z.number().int().nonnegative(),
  embeddingProvider: z.string(),
  diskFreeBytes: z.number().int().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
});
export type SystemHealth = z.infer<typeof SystemHealth>;

/**
 * Pairing the deployment with a Claude subscription, from the interface.
 *
 * A single field rather than a kind plus a value: the two credential shapes are
 * distinguishable by prefix, and asking someone who has just pasted a token to
 * also classify it is a question with a knowable answer.
 */
export const ClaudeCredentialInput = z.object({
  value: z.string().min(1, 'Paste a token first.').max(4096),
});
export type ClaudeCredentialInput = z.infer<typeof ClaudeCredentialInput>;

export const ClaudeCredentialStatus = z.object({
  mode: z.enum(['subscription', 'api_key', 'none']),
  source: z.enum(['stored', 'environment']).nullable(),
  hint: z.string().nullable(),
});
export type ClaudeCredentialStatus = z.infer<typeof ClaudeCredentialStatus>;

export const AuditEntry = z.object({
  id: z.string(),
  at: Millis,
  actor: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  ipAddress: z.string().nullable(),
  outcome: z.enum(['success', 'failure']),
  detail: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

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

export const PluginMcpFile = z.object({
  $schema: z.string(),
  mcpServers: z.record(z.string(), PluginMcpServer),
});
export type PluginMcpFile = z.infer<typeof PluginMcpFile>;

/** One skill found under `skills/`, as loaded from disk. */
export const PluginSkill = z.object({
  name: z.string(),
  description: z.string(),
  /** Absolute path to the skill's SKILL.md. */
  path: z.string(),
});
export type PluginSkill = z.infer<typeof PluginSkill>;

/** An installed plugin, as the API reports it. */
export const PluginRecord = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  license: z.string().nullable(),
  keywords: z.array(z.string()),
  /** Where it came from: a git URL, or a path on the server. */
  source: z.string(),
  /** Absolute path of the plugin root inside the container. */
  root: z.string(),
  enabled: z.boolean(),
  skills: z.array(PluginSkill),
  mcpServers: z.array(z.string()),
  /**
   * Per-component problems. The spec requires that a failure isolated to one
   * component type must not stop the others loading, so these are reported
   * beside a plugin that is otherwise working rather than replacing it.
   */
  warnings: z.array(z.string()),
  installedAt: Millis,
  updatedAt: Millis,
});
export type PluginRecord = z.infer<typeof PluginRecord>;

export const InstallPluginRequest = z
  .object({
    /** A git URL to clone, or an absolute path already on the server. */
    source: z.string().min(1).max(500),
  })
  .strict();
export type InstallPluginRequest = z.infer<typeof InstallPluginRequest>;
