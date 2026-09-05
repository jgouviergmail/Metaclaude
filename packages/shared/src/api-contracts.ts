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
import { MAX_API_TOKEN_DAYS } from './constants.js';
import {
  ClaudeAccountInfo,
  ClaudeAgentInfo,
  ClaudeCliLoginInfo,
  ClaudeCommandInfo,
  ClaudeMcpServerStatus,
  ClaudeModelInfo,
  EffortLevel,
  MarketplacePlugin,
  GoogleGrant,
  LibraryCategory,
  McpTransport,
  Memory,
  MemoryKind,
  RunPolicy,
  Millis,
  ModelSelector,
  PluginSkill,
  WorkspaceSettings,
} from './domain.js';


/**
 * A field of a patch: optional, and stripped of the default it carried.
 *
 * The unwrapping is the whole point. `.partial()` alone leaves
 * `ZodOptional<ZodDefault<T>>`, and Zod applies the inner default *before* the
 * optionality is consulted, so an absent key arrives carrying a value.
 */
type PatchField<Field> = Field extends z.ZodDefault<infer Inner>
  ? z.ZodOptional<Inner>
  : z.ZodOptional<Field extends z.ZodTypeAny ? Field : never>;

type PatchShape<Shape extends z.ZodRawShape> = { [K in keyof Shape]: PatchField<Shape[K]> };

/**
 * The schema for a PATCH body: every field optional, and *absent means absent*.
 *
 * `z.object({…}).partial()` reads as exactly this and is not. A field declared
 * with `.default()` still fires that default when the key is missing, so a
 * patch naming one setting parses into an object carrying every other one at
 * its default value — and a repository that merges the patch over the stored
 * row then resets all of them.
 *
 * It cost real data. The automations list toggles an automation with
 * `PATCH { enabled }` and nothing else; `AutomationInput.partial()` handed the
 * route `description: ''`, `continuous: false` and `maxConsecutiveFailures: 3`
 * alongside it, and `scheduler.update` merged each one in. Flipping the switch
 * wiped the automation's description, ended a continuous loop and reset a
 * custom failure ceiling — on the control an operator touches most often, with
 * nothing anywhere to say it had happened.
 *
 * The one cast is on `Object.fromEntries`, which cannot be typed per key from
 * a runtime loop. The shape it produces is exactly `PatchShape`, `z.object`
 * infers the result from it, and `domain.test.ts` pins the runtime behaviour —
 * including a case that fails if a future Zod fixes `.partial()` itself.
 */
export function patchSchema<Shape extends z.ZodRawShape>(
  object: z.ZodObject<Shape>,
): z.ZodObject<PatchShape<Shape>> {
  const shape = Object.fromEntries(
    Object.entries(object.shape).map(([key, field]) => {
      // `removeDefault()` is declared as Zod's internal `$ZodType`, which does
      // not carry `.optional()`. The value it returns is the schema the default
      // wrapped, so this names what it is rather than widening anything: the
      // cast is on the upstream declaration, not on the runtime shape.
      const inner = (
        field instanceof z.ZodDefault ? field.removeDefault() : field
      ) as z.ZodTypeAny;
      return [key, inner.optional()];
    }),
  ) as PatchShape<Shape>;
  return z.object(shape);
}

/**
 * The operational settings an owner may change without restarting the server.
 *
 * Deliberately a short list, and the line it draws is not "hot versus cold" —
 * it is **operational versus security**. Bypass mode, allowed origins, proxy
 * trust, the master key and the bootstrap credentials stay in the environment,
 * because what protects them is being unreachable from a session cookie;
 * `docs/SECURITY.md` calls the first of those a deployment-level decision and
 * refuses it at three layers. The data directories and the embedder are absent
 * for a different reason: they cannot change while the process runs. Switching
 * the embedder would leave every stored vector a different width, and `cosine`
 * answers 0 when the dimensions disagree — retrieval would die in silence.
 */
export const RuntimeSettingKey = z.enum([
  'runTimeoutMs',
  'idleTimeoutMs',
  'maxConcurrentRuns',
  'quotaGuardPct',
  'runRetentionDays',
  'runKeepPerWorkspace',
  'logLevel',
  'language',
  'embeddings',
]);
export type RuntimeSettingKey = z.infer<typeof RuntimeSettingKey>;

/**
 * One setting, with the value in force and where that value came from.
 *
 * The provenance is not decoration. `compose.yml` names every one of these
 * with a default of its own, so in a real deployment the environment is always
 * set — which is why a stored override has to win, and why a screen that did
 * not say so would be describing a value the operator cannot account for. The
 * same honesty the doctor applies to the embedder: what is *running*, versus
 * what was configured.
 */
export const RuntimeSettingRecord = z.object({
  key: RuntimeSettingKey,
  /** The value in force. A number, or one of `options` for a choice. */
  value: z.union([z.number(), z.string()]),
  source: z.enum(['stored', 'environment', 'default']),
  /**
   * What this would fall back to if the override were removed — the
   * environment's value, or the schema's default when the environment is
   * silent. Null only when the two cannot differ.
   */
  fallback: z.union([z.number(), z.string()]).nullable(),
  kind: z.enum(['duration', 'count', 'percent', 'choice']),
  /** Bounds for a number. `0` is admissible for a duration and means "off". */
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** The admissible values for a choice, in the order a form should show them. */
  options: z.array(z.string()),
  updatedAt: Millis.nullable(),
  updatedBy: z.string().nullable(),
});
export type RuntimeSettingRecord = z.infer<typeof RuntimeSettingRecord>;

/**
 * Setting a value, or clearing the override with `null`.
 *
 * The string is bounded even though the service refuses anything that is not
 * one of a setting's own options: an edge schema that accepts a megabyte and
 * relies on a later check to reject it has already done the expensive part.
 */
export const SetRuntimeSettingRequest = z.object({
  value: z.union([z.number(), z.string().max(128)]).nullable(),
});
export type SetRuntimeSettingRequest = z.infer<typeof SetRuntimeSettingRequest>;

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
  // Absent stays absent here too. `WorkspaceService.create` lays the defaults
  // down itself, so this only has to say what the caller actually chose.
  settings: patchSchema(WorkspaceSettings).optional(),
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
  // `consolidation` carries a ConsolidationProposal in `payload`. It is the
  // only kind the operator can *act* on from here besides a skill proposal,
  // and the only one the system also files pre-triaged: see the note on
  // ConsolidationProposal for why a "these are distinct" verdict is stored as
  // an already-rejected row rather than not stored at all.
  kind: z.enum(['lesson', 'pattern', 'failure', 'preference', 'skill_proposal', 'consolidation']),
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
  /**
   * How this server is authenticated.
   *
   * `none` covers both an open server and one carrying a static header the
   * operator pasted — from here they are the same thing, a configuration that
   * needs no flow. `oauth` means Metaclaude holds tokens for it and injects
   * the bearer at mount, because the agent SDK's server config takes headers
   * and has no OAuth field of its own.
   */
  authType: z.enum(['none', 'oauth']).default('none'),
  /**
   * The authorization server the stored credentials belong to. Credentials
   * obtained from one issuer are never sent to another, so a discovery that
   * disagrees with this discards the client registration rather than reusing it.
   */
  oauthIssuer: z.string().nullable().default(null),
  /** From dynamic registration or pasted; the client *secret* is in the vault. */
  oauthClientId: z.string().nullable().default(null),
  /** Null when the server stated no lifetime — not a promise that it never expires. */
  oauthExpiresAt: Millis.nullable().default(null),
  oauthScope: z.string().nullable().default(null),
  /**
   * Whether an access token is actually held. Derived from the vault rather
   * than from a column: "configured for OAuth" and "authorised" are different
   * states, and the card has to tell them apart to know which button to show.
   */
  oauthAuthorised: z.boolean().default(false),
  /**
   * What the last test learned, kept so it survives the page.
   *
   * Asking costs a connection per server, so it happens when an operator
   * presses Test and never on a page load — which used to mean everything
   * learned vanished on the next render. `at` is what keeps this honest: it is
   * what the server answered *then*, not a claim about now, and the card says
   * so. Live data from the catalogue still wins wherever there is any.
   */
  described: z
    .object({
      at: Millis,
      instructions: z.string().nullable(),
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
    })
    .nullable()
    .default(null),
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
 * Why one run was shaped the way it was, as GET /api/runs/:id/genesis serves
 * it — the classifier's verdict, the arm the policy stood on, and the
 * memories that were actually injected. A plain type for the same reason as
 * LibraryListingEntry below: every field is server-derived from rows the
 * schemas already validate, so a runtime schema here would be dead weight.
 */
export type RunGenesis = {
  category: string | null;
  source: RunPolicy['source'];
  /** Best-first, with the rank-normalised retrieval score in [0, 1]. */
  memories: Array<{ id: string; title: string; kind: MemoryKind; confidence: number; score: number }>;
  /**
   * The knowledge-library passages this run was actually shown — what was
   * injected after the budget, not merely retrieved. Empty for runs that
   * predate the library, and for workspaces that switched it off.
   */
  documents: Array<{ chunkId: string; documentId: string; title: string; heading: string; score: number }>;
  /** The (category, model, effort) arm this run stood on; null when none matches. */
  arm: PolicyArm | null;
  /** The learner's own sentence about this category, empty when unlearned. */
  explanation: string;
};

/* -------------------------------------------------------------------------- */
/* The knowledge library                                                       */
/* -------------------------------------------------------------------------- */

/** What may be submitted as a document. The API validates with this at the edge. */
export const SaveKnowledgeRequest = z
  .object({
    id: z.string().optional(),
    workspaceId: z.string().nullable().default(null),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(512 * 1024),
    enabled: z.boolean().optional(),
  })
  .strict();
export type SaveKnowledgeRequest = z.infer<typeof SaveKnowledgeRequest>;

/**
 * One document as GET /api/knowledge lists it — metadata only, the content
 * comes from GET /api/knowledge/:id. Plain types, like the listings above:
 * server-derived, pinned by the store's own tests.
 */
export type KnowledgeDocumentMeta = {
  id: string;
  workspaceId: string | null;
  title: string;
  contentLength: number;
  enabled: boolean;
  chunkCount: number;
  /** The embedder the chunks were vectorised with; `''` while they wait for one. */
  embeddingModel: string;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeSearchHit = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  workspaceId: string | null;
  heading: string;
  text: string;
  score: number;
};

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

/**
 * One entry of the built-in connector directory as GET /api/connectors serves
 * it — a remote or packaged MCP server this repository has read the
 * documentation for. A plain type for the same reason as LibraryListingEntry:
 * server-authored constants, pinned by their own tests.
 *
 * `credential` carries the *name* of what the operator must supply and where
 * to get it. Never a value: those go straight into the vault and the API has
 * no path that reads one back.
 */
export type ConnectorListingEntry = {
  name: string;
  title: string;
  publisher: string;
  category: LibraryCategory;
  description: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  credential: {
    kind: 'header' | 'env';
    key: string;
    /** Prepended to the pasted value, e.g. `Bearer `. Often empty. */
    prefix: string;
    hint: string;
    required: boolean;
  } | null;
  /** The publisher's own page the entry's facts were read from. */
  docsUrl: string;
  /** True when a *global* MCP server already carries this name. */
  installed: boolean;
};

/**
 * Metaclaude's own Google connection, as GET /api/integrations/google serves
 * it. A plain type, like the two listings above: server-derived, and pinned by
 * the service's own tests.
 *
 * There is no token here and there is no path that returns one. `clientId` is
 * not a secret — it appears in every authorisation URL the browser has ever
 * navigated to — and the operator needs it to recognise which Cloud project
 * this connection belongs to.
 */
export type GoogleConnectionState = {
  connection: {
    connected: boolean;
    /** Which Google account the stored refresh token belongs to. */
    accountEmail: string | null;
    grants: GoogleGrant[];
    clientId: string | null;
    connectedAt: number | null;
    connectedBy: string | null;
  };
  /**
   * The exact string to register as an authorised redirect URI in the Google
   * Cloud console. Null when the request carried no usable origin.
   */
  redirectUri: string | null;
  /**
   * Grants that oblige a Cloud project to pass Google's verification — and,
   * while its consent screen is still in "Testing", make the refresh token
   * expire after seven days. Shown as a warning rather than left to be
   * discovered a week later.
   */
  restrictedGrants: GoogleGrant[];
};

/**
 * What the machine is doing, as the app can actually see it.
 *
 * Every figure is nullable, and that is the contract's main job: this runs in a
 * container on Linux in production and bare on macOS or Windows in
 * development, where neither `/proc` nor `/sys/fs/cgroup` exists. A missing
 * measurement must read as "not measured" everywhere it is displayed — never
 * as a zero, which would draw an empty meter on a machine under load.
 *
 * Two vantage points, deliberately kept apart rather than blended. The cgroup
 * figures are the container's own, and they are the ones that matter: the
 * ceiling that gets a process OOM-killed is its cgroup's, not the host's. The
 * host figures are context — what the box has, and what everything else on it
 * is doing.
 */
export const SystemResources = z.object({
  cpu: z.object({
    /**
     * Percentage of the container's allowance, 0–100 across all the cores it
     * may use. Null until two samples exist: usage is a rate, and the first
     * reading after a boot has nothing to subtract from. Reporting zero there
     * would show an idle machine mid-run.
     */
    usagePct: z.number().min(0).max(100).nullable(),
    /** Cores the container may use — its quota, or the host's count when unbounded. */
    cores: z.number().positive().nullable(),
    /** The host's one-minute load average, for context. */
    load1: z.number().nonnegative().nullable(),
  }),
  memory: z.object({
    /** The container's own usage and ceiling, from its cgroup. */
    usedBytes: z.number().int().nonnegative().nullable(),
    limitBytes: z.number().int().nonnegative().nullable(),
    /** What the machine has in total. Context for the two above. */
    hostTotalBytes: z.number().int().nonnegative().nullable(),
    /** This process's resident set — the app's own share of the container's usage. */
    rssBytes: z.number().int().nonnegative(),
  }),
  /**
   * The filesystem holding the data directory. On the shipped layout that is
   * the host's root filesystem, which is also what fills up.
   */
  disk: z.object({
    freeBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
  }),
});
export type SystemResources = z.infer<typeof SystemResources>;

/**
 * What one MCP server says about itself, asked directly.
 *
 * Separate from `ClaudeMcpServerStatus` on purpose, and the difference is the
 * point: that one is the CLI's verdict on whether a server *connects*, mounted
 * exactly as a run would mount it, and it is the only thing allowed to answer
 * that question. This one is text — each tool's description, which the CLI's
 * status drops, and the `instructions` string the protocol has for "what this
 * server is for". Never a health signal.
 */
export const McpServerDescription = z.object({
  instructions: z.string().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
});
export type McpServerDescription = z.infer<typeof McpServerDescription>;

/** What the Dashboard composer sends to Metaclaude. */
export const AskMetaclaudeRequest = z.object({
  prompt: z.string().trim().min(1, 'Say something.').max(100_000),
  attachmentIds: z.array(z.string().min(1)).max(20).optional(),
});
export type AskMetaclaudeRequest = z.infer<typeof AskMetaclaudeRequest>;

export const RetrievalStatus = z.object({
  embedder: z.string(),
  family: z.enum(['hash', 'st']),
  state: z.enum(['ready', 'loading', 'lexical-only']),
  /** True only while a sentence-transformer is loaded and answering. */
  semantic: z.boolean(),
  /** Rows written pending, or under another provider, that the rebuild has not reached. */
  pending: z.object({
    memories: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    exemplars: z.number().int().nonnegative(),
  }),
});
export type RetrievalStatus = z.infer<typeof RetrievalStatus>;

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
  /**
   * What retrieval *is* on this deployment, not only which embedder is named:
   * a sentence-transformer that is loading or failed to load answers words,
   * and `semantic` says which regime the next search runs in.
   */
  retrieval: RetrievalStatus,
  /** Metaclaude's own workspace. Null only if preparing it failed at boot. */
  systemWorkspaceId: z.string().nullable(),
  resources: SystemResources,
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

/* -------------------------------------------------------------------------- */
/* API tokens — the MCP gateway's identities                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a token may do at all.
 *
 * Two capabilities rather than a role, because the roles this application has
 * describe people: an operator is someone who can be asked what they meant. A
 * token is a capability handed to a program, and the only question worth
 * asking about it is whether it may *start a run* — everything else it can
 * reach is reading.
 */
export const ApiTokenScope = z.enum(['run', 'read']);
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;

/**
 * The most a run started by this token may do without asking a human.
 *
 * Deliberately not the full `PermissionMode` set. `default` and `auto` can
 * open a permission prompt, and nobody is watching one: the request would sit
 * for ten minutes and then fail, which is a worse answer than a refusal.
 * `bypassPermissions` is absent because a token is exactly the caller that
 * must never have it.
 *
 * Ordered by capability — `plan` executes nothing at all, `dontAsk` runs what
 * the workspace has already allowed and refuses the rest, `acceptEdits` adds
 * file edits. A run takes the *lesser* of this and the workspace's own mode.
 */
export const ApiTokenCeiling = z.enum(['plan', 'dontAsk', 'acceptEdits']);
export type ApiTokenCeiling = z.infer<typeof ApiTokenCeiling>;

/** A token as the interface sees it. The secret itself appears nowhere. */
export const ApiTokenRecord = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(ApiTokenScope),
  /**
   * The workspaces this token can reach, by id.
   *
   * Never empty, and never a wildcard: "every workspace" is not offered,
   * because a token minted for one integration would then follow the
   * deployment into every workspace created afterwards. Widening it is an
   * edit somebody makes on purpose.
   */
  workspaceIds: z.array(z.string()),
  ceiling: ApiTokenCeiling,
  createdBy: z.string(),
  createdAt: Millis,
  /** Always set: a token that never expires is a credential nobody retires. */
  expiresAt: Millis,
  lastUsedAt: Millis.nullable(),
  revokedAt: Millis.nullable(),
  /** The leading characters of the value, enough to tell two tokens apart. */
  hint: z.string(),
});
export type ApiTokenRecord = z.infer<typeof ApiTokenRecord>;

export const CreateApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(ApiTokenScope).min(1),
  workspaceIds: z.array(z.string()).min(1),
  ceiling: ApiTokenCeiling,
  expiresInDays: z.number().int().min(1).max(MAX_API_TOKEN_DAYS),
});
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequest>;

/** The one moment the secret exists outside the client's own storage. */
export const CreateApiTokenResponse = z.object({
  token: ApiTokenRecord,
  /** Shown once. Only its SHA-256 is kept, so this cannot be recovered. */
  secret: z.string(),
});
export type CreateApiTokenResponse = z.infer<typeof CreateApiTokenResponse>;

/* -------------------------------------------------------------------------- */
/* Memory consolidation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A memory a consolidation proposal is about, as it stood when the proposal
 * was drawn up.
 *
 * The fingerprint is the load-bearing field. A proposal is a plan written
 * against particular text and reviewed by a person some time later; between
 * the two, a run can reinforce a memory, the operator can edit one, and the
 * plan then describes something that no longer exists. Applying it anyway
 * would fold an edit away without ever showing it to anybody, so the apply
 * step compares this against the live row and refuses on any drift.
 */
export const ConsolidationMember = z.object({
  id: z.string(),
  title: z.string(),
  /** Digest of the exact title and content this plan was drawn against. */
  fingerprint: z.string(),
  workspaceId: z.string().nullable(),
});
export type ConsolidationMember = z.infer<typeof ConsolidationMember>;

/**
 * What the consolidation pass proposes about one group of memories, carried in
 * `Insight.payload`.
 *
 * Two verdicts reach an operator. `duplicate` is the one that saves budget:
 * several rows saying one thing, folded into the survivor the pass names.
 * `contradictory` is the one that saves correctness — two memories that
 * *disagree*, which is far more dangerous than a duplicate, because today both
 * are injected side by side and nothing anywhere notices. There is no merged
 * text for that case: what to keep is a judgement only the operator can make.
 *
 * The third verdict, `complementary`, never becomes a payload. It is the
 * arbiter saying "these are related but distinct", which is the common and
 * correct answer, and it is recorded as an already-triaged insight purely so
 * the pass does not pay to ask the same question every six hours.
 */
export const ConsolidationProposal = z.object({
  /**
   * The group's identity: its member ids, sorted and joined. Two passes over
   * an unchanged corpus produce the same key, which is what lets a proposal
   * the operator has already answered stay answered.
   */
  key: z.string(),
  verdict: z.enum(['duplicate', 'contradictory']),
  /** One sentence from the arbiter, saying why. */
  reason: z.string(),
  members: z.array(ConsolidationMember).min(2).max(8),
  /** The row that survives — always one of `members`. */
  winnerId: z.string(),
  /** What the survivor should say afterwards. Absent for `contradictory`. */
  merged: z
    .object({
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()),
    })
    .optional(),
  /**
   * Whether the arbiter judged the fact to hold beyond this project.
   *
   * Only ever an invitation to promote, never to demote: a global memory is
   * something an operator put on the global tier, and no model judgement moves
   * it back down. The apply route makes promotion a separate button anyway, so
   * this is a suggestion twice over.
   */
  promotable: z.boolean(),
});
export type ConsolidationProposal = z.infer<typeof ConsolidationProposal>;

/** Body of `POST /api/insights/:id/consolidate`. */
export const ApplyConsolidationRequest = z.object({
  /** Also move the survivor to the global tier. Refused unless `promotable`. */
  promote: z.boolean().default(false),
});
export type ApplyConsolidationRequest = z.infer<typeof ApplyConsolidationRequest>;
