/**
 * API-only contracts — request bodies the API validates and records only it
 * assembles. Deliberately a separate module from domain.ts: the web entry's
 * runtime graph reaches domain.ts through parseWireFrame, and Rollup cannot
 * drop an unused `z.object(...)` declaration *inside* a used module — every
 * schema here used to ship in the entry chunk for nothing (see CLAUDE.md).
 * Out here, with `sideEffects: false`, the whole module vanishes from any
 * bundle that never imports one of its values. Types cost nothing anywhere.
 *
 * The one rule that keeps that true: nothing the web runs at runtime —
 * protocol.ts above all — may import from this file. Type imports are fine.
 */

import { z } from 'zod';
import {
  ClaudeAccountInfo,
  ClaudeAgentInfo,
  ClaudeCliLoginInfo,
  ClaudeCommandInfo,
  ClaudeMcpServerStatus,
  ClaudeModelInfo,
  EffortLevel,
  MarketplacePlugin,
  LibraryCategory,
  McpTransport,
  Memory,
  MemoryKind,
  Millis,
  ModelSelector,
  PluginSkill,
  WorkspaceSettings,
} from './domain.js';


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
  category: LibraryCategory.default('general'),
  tools: z.array(z.string()).nullable(),
  model: ModelSelector.nullable(),
  enabled: z.boolean(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type AgentDefinitionRecord = z.infer<typeof AgentDefinitionRecord>;

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

export const ClaudeCatalogue = z.object({
  models: z.array(ClaudeModelInfo).default([]),
  commands: z.array(ClaudeCommandInfo).default([]),
  agents: z.array(ClaudeAgentInfo).default([]),
  mcpServers: z.array(ClaudeMcpServerStatus).default([]),
  account: ClaudeAccountInfo.nullable().default(null),
  /**
   * What the CLI could not answer, by name.
   *
   * Reported rather than swallowed: an empty model list means something very
   * different depending on whether the question failed or the answer was empty,
   * and only one of those is worth telling the operator about.
   */
  unavailable: z.array(z.string()).default([]),
  /** When this was read from the CLI. The UI says how stale it is. */
  fetchedAt: Millis,
});
export type ClaudeCatalogue = z.infer<typeof ClaudeCatalogue>;

/**
 * One session as the Claude CLI itself lists it — the CLI's own transcript
 * store, not Metaclaude's session table. `adoptedBy` is the join between the
 * two worlds: the Metaclaude session already bound to this CLI session, when
 * one is, so the interface can offer "open" instead of a second adoption.
 */
export const ClaudeCliSession = z.object({
  sessionId: z.string(),
  summary: z.string(),
  lastModified: Millis,
  firstPrompt: z.string().nullable().default(null),
  gitBranch: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  createdAt: Millis.nullable().default(null),
  adoptedBy: z.string().nullable().default(null),
});
export type ClaudeCliSession = z.infer<typeof ClaudeCliSession>;

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
  /**
   * Which credential actually applies. `stored` and `environment` are tokens
   * Metaclaude injects; `cli-login` means it injects nothing and the CLI uses
   * its own account sign-in — which an injected token would override.
   */
  source: z.enum(['stored', 'environment', 'cli-login']).nullable(),
  hint: z.string().nullable(),
  /** The CLI's own sign-in, whether or not it is what applies. */
  cliLogin: ClaudeCliLoginInfo.nullable().default(null),
});
export type ClaudeCredentialStatus = z.infer<typeof ClaudeCredentialStatus>;

/**
 * Guided pairing: the server runs the same OAuth exchange `claude setup-token`
 * performs, so pairing needs no shell anywhere — the owner opens a link,
 * approves, and pastes the code back.
 *
 * `account` picks the sign-in surface: a Pro/Max subscription lives on
 * claude.ai, a Console (per-token billing) account on platform.claude.com.
 * The code is what Claude's callback page displays — `code#state`, though the
 * state half is optional here because some people copy only the first box.
 */
export const ClaudePairingBeginInput = z.object({
  account: z.enum(['claudeai', 'console']).default('claudeai'),
});
export type ClaudePairingBeginInput = z.infer<typeof ClaudePairingBeginInput>;

export const ClaudePairingCodeInput = z.object({
  code: z.string().min(1, 'Paste the code first.').max(4096),
});
export type ClaudePairingCodeInput = z.infer<typeof ClaudePairingCodeInput>;

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

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  /**
   * The second factor: a TOTP code, or one of the recovery codes.
   *
   * Both shapes, because both are real. Recovery codes are issued as
   * `XXXXX-XXXXX` and the sign-in form tells the operator in so many words that
   * one works here — but this was `/^\d{6}$/`, so the route answered 400 before
   * the code reached the verifier. Nothing recovered a lost TOTP device: the
   * codes were generated, shown once, told to be kept somewhere safe, and were
   * dead on arrival. The only way back in was editing SQLite on the box.
   *
   * Case-insensitive, because `consumeSecondFactor` upper-cases before
   * comparing and a schema stricter than the check behind it rejects codes that
   * would have worked. The alphabet is deliberately not spelled out here: this
   * bounds the input, and the constant-time comparison against the stored codes
   * is what decides.
   */
  totp: z
    .string()
    .regex(/^(?:\d{6}|[A-Za-z0-9]{5}-[A-Za-z0-9]{5})$/, 'Enter a 6-digit code or a recovery code.')
    .optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * A WebAuthn ceremony response from the browser.
 *
 * Only `id` is read by Metaclaude's own code — everything else is verified by
 * @simplewebauthn, which parses the full structure and throws on junk. The
 * `.passthrough()` is load-bearing: zod's default is to *strip* unknown keys,
 * which would silently delete `response.clientDataJSON` and friends between
 * the edge and the verifier, and every ceremony would fail as "did not
 * verify" with nothing wrong on either end.
 */
const WebAuthnCeremonyResponse = z.object({ id: z.string().min(1).max(1024) }).passthrough();

export const PasskeyRegisterBeginRequest = z.object({
  password: z.string().min(1).max(1024),
});
export type PasskeyRegisterBeginRequest = z.infer<typeof PasskeyRegisterBeginRequest>;

export const PasskeyRegisterFinishRequest = z.object({
  label: z.string().max(60),
  response: WebAuthnCeremonyResponse,
});
export type PasskeyRegisterFinishRequest = z.infer<typeof PasskeyRegisterFinishRequest>;

export const PasskeyLoginFinishRequest = z.object({
  ceremonyId: z.string().min(1).max(128),
  response: WebAuthnCeremonyResponse,
});
export type PasskeyLoginFinishRequest = z.infer<typeof PasskeyLoginFinishRequest>;

export const PasskeyRemoveRequest = z.object({
  password: z.string().min(1).max(1024),
});
export type PasskeyRemoveRequest = z.infer<typeof PasskeyRemoveRequest>;

/** One enrolled passkey, as the management list renders it. */
export const PasskeyRecord = z.object({
  id: z.string(),
  label: z.string(),
  /** The domain the passkey answers for — a credential never crosses domains. */
  rpId: z.string(),
  createdAt: Millis,
  lastUsedAt: Millis.nullable(),
});
export type PasskeyRecord = z.infer<typeof PasskeyRecord>;

export const MarketplaceCatalogue = z.object({
  marketplaceId: z.string(),
  name: z.string(),
  fetchedAt: Millis,
  plugins: z.array(MarketplacePlugin),
  /** The fetch or parse failure, verbatim, when the catalogue could not load. */
  error: z.string().nullable().default(null),
});
export type MarketplaceCatalogue = z.infer<typeof MarketplaceCatalogue>;

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

export const MemorySearchResult = z.object({
  memory: Memory,
  score: z.number(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResult>;

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

/**
 * A browser push subscription, as `PushManager.subscribe` hands it over.
 * The endpoint must be https: it is where the server will POST encrypted
 * notification payloads, and a plaintext push service is not a push service.
 */
export const PushSubscriptionInput = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith('https://'), 'The push endpoint must be https.'),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(256),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

export const RewindRequest = z.object({
  /** Preview only. Defaults to true so a mistaken call cannot destroy work. */
  dryRun: z.boolean().default(true),
});
export type RewindRequest = z.infer<typeof RewindRequest>;

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
  category: LibraryCategory.default('general'),
  enabled: z.boolean(),
  /** Set when the learning loop generated this skill rather than the user. */
  autoGenerated: z.boolean(),
  useCount: z.number().int().nonnegative(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type SkillDefinition = z.infer<typeof SkillDefinition>;

/**
 * A proposal the advisor left in the inbox — a skill, agent, MCP server or
 * plugin it believes this deployment should have, waiting for one click.
 *
 * Tickets and automations never appear here: the advisor creates tickets
 * directly on the board (they are inert until worked) and automations
 * directly but disabled (inert until enabled). What lands in the inbox is
 * exactly what would *act* the moment it exists — so it does not exist until
 * a person accepts it.
 */
export const AdvisorProposalKind = z.enum(['skill', 'agent', 'mcp', 'plugin']);
export type AdvisorProposalKind = z.infer<typeof AdvisorProposalKind>;

export const AdvisorProposal = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** The advisor run that proposed it; null when the run is gone. */
  runId: z.string().nullable(),
  kind: AdvisorProposalKind,
  name: z.string().min(1).max(120),
  /** One line: what this is. */
  summary: z.string().min(1).max(500),
  /** Why the advisor thinks you want it — shown beside the Accept button. */
  rationale: z.string().min(1).max(4000),
  /** Kind-specific creation payload, applied verbatim on accept. */
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'accepted', 'dismissed']),
  createdAt: Millis,
  decidedAt: Millis.nullable(),
  decidedBy: z.string().nullable(),
});
export type AdvisorProposal = z.infer<typeof AdvisorProposal>;

/**
 * One entry of the built-in library as GET /api/library serves it.
 *
 * A plain type rather than a Zod schema on purpose: the catalogue is
 * server-authored constants whose validity is pinned by its own tests, so no
 * unchecked input ever crosses this shape — a runtime schema would be dead
 * weight. The API's service types its listing with this, which is what keeps
 * the two sides from drifting.
 */
export type LibraryListingEntry = {
  name: string;
  category: LibraryCategory;
  description: string;
  installed: boolean;
} & ({ kind: 'agent'; prompt: string } | { kind: 'skill'; body: string });

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
    authSource: z.enum(['stored', 'environment', 'cli-login']).nullable(),
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
