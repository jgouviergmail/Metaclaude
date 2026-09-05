/**
 * Application container.
 *
 * Constructs every subsystem once, wires them together, and hands routes a
 * single typed object. Explicit construction (rather than a DI framework) keeps
 * the dependency graph readable and makes it trivial to build a fully in-memory
 * instance for tests.
 */

import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { APP_VERSION, SYSTEM_TOPIC, type RetrievalStatus } from '@metaclaude/shared';
import type { ClaudeUsage } from '@metaclaude/shared';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { migrate, openDatabase, type Db } from './db/index.js';
import { EventBus } from './kernel/bus.js';
import { Kernel } from './kernel/kernel.js';
import {
  RunRepo,
  SessionRepo,
  TranscriptRepo,
  WorkspaceRepo,
} from './kernel/repositories.js';
import { AgentSupervisor } from './kernel/supervisor.js';
import { ADVISOR_SERVER_NAME, ADVISOR_TOOL_CATALOGUE, advisorToolNames } from './kernel/advisor-tools.js';
import { BOARD_SERVER_NAME, BOARD_TOOL_CATALOGUE, boardToolNames } from './kernel/board-tools.js';
import { SYSTEM_SERVER_NAME, SYSTEM_TOOLS, systemToolNames } from './kernel/system-tools.js';
import { decideApproval } from './http/approvals.js';
import { PolicyLearner } from './learning/bandit.js';
import { TaskClassifier } from './learning/classifier.js';
import { createEmbedderSwitch } from './learning/embedder-switch.js';
import {
  createEmbeddingProvider,
  describeEmbedder,
  SwitchableEmbedder,
  type EmbeddingProvider,
} from './learning/embeddings.js';
import { MemoryStore } from './learning/memory.js';
import {
  CONSOLIDATION_SCHEMA,
  CONSOLIDATION_SYSTEM_PROMPT,
  Consolidator,
  buildConsolidationPrompt,
  readConsolidationOutput,
  type ConsolidationOutput,
} from './learning/consolidation.js';
import { contentLanguageDirective, resolveContentLanguage } from './learning/language.js';
import { listInsights, setInsightStatus, withLanguage } from './learning/reflexion.js';
import { countStale, createRebuildTrigger, reindexStale } from './learning/reindex.js';
import { KnowledgeStore } from './learning/knowledge.js';
import { ReflexionEngine } from './learning/reflexion.js';
import { createGateCall, Gatekeeper } from './learning/gatekeeper.js';
import { AuditLog } from './security/audit.js';
import { ApiTokenService } from './security/api-tokens.js';
import { AuthService } from './security/auth.js';
import { WebAuthnService } from './security/webauthn.js';
import { Vault } from './security/vault.js';
import { BoardAutopilot, planUtilization } from './services/board-autopilot.js';
import { startTaskRun } from './services/board-run.js';
import { buildPushEventHandlers, PushService } from './services/push.js';
import { readCliLogin } from './services/claude-cli-login.js';
import { ClaudeCredentials } from './services/claude-credentials.js';
import { ClaudePairing } from './services/claude-pairing.js';
import { CatalogueCache, TtlCache } from './services/claude-catalogue.js';
import { AttachmentService } from './services/attachments.js';
import { RunRetention } from './services/run-retention.js';
import { McpOAuth } from './services/mcp-oauth.js';
import { createOutboundGuard } from './security/outbound.js';
import { BoardService } from './services/board.js';
import { BoardGateway } from './services/board-gateway.js';
import { ClaudeSessions } from './services/claude-sessions.js';
import { Doctor } from './services/doctor.js';
import { RuntimeSettings } from './services/runtime-settings.js';
import { MarketplacesService } from './services/marketplaces.js';
import { UpdateChecker } from './services/update-check.js';
import { UpdateApplier } from './services/update-apply.js';
import { BriefService } from './services/brief.js';
import { SkillSynthesizer, SYNTHESIS_SCHEMA, SYNTHESIS_SYSTEM_PROMPT, type SynthesisOutput } from './learning/synthesis.js';
import { structuredCall } from './learning/structured-call.js';
import { PluginRegistry } from './services/plugin-registry.js';
import { AnalyticsService } from './services/analytics.js';
import { FileService } from './services/files.js';
import { GitService } from './services/git.js';
import { Registry } from './services/registry.js';
import { LibraryService } from './library/service.js';
import { AdvisorService } from './services/advisor.js';
import { Scheduler } from './services/scheduler.js';
import { Steward } from './services/steward.js';
import { seedSystemAutomation } from './services/system-automation.js';
import { readGenerated, SYSTEM_WORKSPACE_SAFETY, SystemWorkspace } from './services/system-workspace.js';
import { relocateWorkspaces, WorkspaceService } from './services/workspaces.js';

export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  bus: EventBus;

  auth: AuthService;
  /** Machine identities — what the MCP gateway authenticates. */
  apiTokens: ApiTokenService;
  webauthn: WebAuthnService;
  audit: AuditLog;
  vault: Vault;
  claudeCredentials: ClaudeCredentials;
  claudePairing: ClaudePairing;
  push: PushService;
  autopilot: BoardAutopilot;
  plugins: PluginRegistry;
  claudeCatalogue: CatalogueCache;
  claudeUsage: TtlCache<ClaudeUsage>;
  claudeSessions: ClaudeSessions;
  marketplaces: MarketplacesService;
  doctor: Doctor;
  runtimeSettings: RuntimeSettings;
  brief: BriefService;
  synthesizer: SkillSynthesizer;
  /** Null when METACLAUDE_UPDATE_REPO is set empty. */
  updateChecker: UpdateChecker | null;
  /** Unavailable (dir null) unless the host installed the updater. */
  updateApplier: UpdateApplier;

  workspaceRepo: WorkspaceRepo;
  /** Metaclaude's own workspace — the one its steward runs in. */
  systemWorkspace: SystemWorkspace;
  sessionRepo: SessionRepo;
  runRepo: RunRepo;
  transcriptRepo: TranscriptRepo;

  embedder: EmbeddingProvider;
  /** What retrieval is right now: embedder, state, whether it is semantic, what waits for a rebuild. */
  retrieval: () => RetrievalStatus;
  memory: MemoryStore;
  knowledge: KnowledgeStore;
  classifier: TaskClassifier;
  policy: PolicyLearner;
  reflexion: ReflexionEngine;
  consolidator: Consolidator;

  registry: Registry;
  mcpOAuth: McpOAuth;
  library: LibraryService;
  advisor: AdvisorService;
  /** What Metaclaude may see and do about itself — the facade behind its tools. */
  steward: Steward;
  workspaces: WorkspaceService;
  files: FileService;
  attachments: AttachmentService;
  runRetention: RunRetention;
  board: BoardGateway;
  git: GitService;
  analytics: AnalyticsService;
  scheduler: Scheduler;
  kernel: Kernel;

  startedAt: number;
  shutdown: () => Promise<void>;
}

/**
 * Environment handed to every Claude CLI subprocess.
 *
 * Deliberately built from an allow-list rather than spreading `process.env`:
 * the CLI is a child process with filesystem and network access, and it has no
 * business inheriting the master key, bootstrap credentials, or anything else
 * this service holds.
 */
export function buildClaudeEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/home/metaclaude',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    // Suppress the CLI's own telemetry prompts and update checks; this process
    // is not interactive.
    CI: '1',
  };

  for (const key of ['TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  // Subscription auth takes precedence: that is the whole point of the deployment.
  if (config.claude.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.claude.oauthToken;
  } else if (config.claude.apiKey) {
    env.ANTHROPIC_API_KEY = config.claude.apiKey;
  }

  return env;
}

const execFileAsync = promisify(execFile);

/**
 * Where the shipped documentation is. The image copies `docs/` beside `apps/`
 * under the working directory; a dev checkout runs from `apps/api` and finds
 * it two levels up. Null when neither exists, and the system workspace then
 * says so rather than pointing the agent at files it does not have.
 */
function findDocsDir(): string | null {
  for (const candidate of [resolve(process.cwd(), 'docs'), resolve(process.cwd(), '../../docs')]) {
    if (existsSync(join(candidate, 'ARCHITECTURE.md'))) return candidate;
  }
  return null;
}

/**
 * Same idea for the sources: `source/` under the image's root (the Dockerfile
 * ships the trees `SOURCE_TREES` names there), the repository root in a
 * checkout — whether the server runs from it or from `apps/api`.
 */
function findSourceRoot(): string | null {
  for (const candidate of [
    resolve(process.cwd(), 'source'),
    process.cwd(),
    resolve(process.cwd(), '../..'),
  ]) {
    if (existsSync(join(candidate, 'apps/api/src/index.ts'))) return candidate;
  }
  return null;
}

export async function createAppContext(config: Config, log: Logger): Promise<AppContext> {
  const db = openDatabase({ path: config.databasePath });
  const applied = migrate(db, (message) => log.info(message));
  if (applied > 0) log.info(`applied ${applied} database migration(s)`);

  const bus = new EventBus();
  const vault = new Vault(db, config.masterKey);

  const vaultCheck = vault.selfTest();
  if (vaultCheck.failed.length > 0) {
    // Almost always a changed or lost master key. Failing loudly here beats
    // silently handing empty credentials to every MCP server.
    log.error(
      { failed: vaultCheck.failed },
      'the secret vault could not decrypt some entries — is METACLAUDE_MASTER_KEY correct?',
    );
  }

  /*
   * The operational settings an owner may change without a restart.
   *
   * Constructed here, before anything that reads one, and handed to those
   * consumers as a getter rather than a number — that is the whole of "hot":
   * a change is read at the point of use on the next run, with no event and
   * nothing to keep in step. Only the log level needs doing rather than
   * reading, because it lives on the logger object.
   */
  // The hot half of the embeddings setting, bound once the stores exist.
  // `applyStored()` below runs before then and is ignored on purpose: the
  // initial provider is built from `choice('embeddings')`, which already
  // honours a stored override.
  let switchEmbedder: ((provider: string) => void) | null = null;
  const runtimeSettings = new RuntimeSettings({
    db,
    config,
    declared: config.declaredEnv,
    apply: (key, value) => {
      if (key === 'logLevel') log.level = String(value);
      if (key === 'embeddings') switchEmbedder?.(String(value));
    },
  });
  // A level chosen through the screen has to survive a restart, or the screen
  // would go on reporting a value the process never adopted.
  runtimeSettings.applyStored();

  const auth = new AuthService(db);
  const apiTokens = new ApiTokenService(db);
  const audit = new AuditLog(db);

  const workspaceRepo = new WorkspaceRepo(db);
  const sessionRepo = new SessionRepo(db);
  const runRepo = new RunRepo(db);
  const transcriptRepo = new TranscriptRepo(db);

  // Anything left `running` belongs to a process that no longer exists.
  const orphanedRuns = runRepo.recoverOrphaned();
  const orphanedSessions = sessionRepo.recoverOrphaned();
  // And the transcript, which the other two do not touch: a tool call is
  // written as `running` when it starts and closed only in-process, so a crash
  // left a card spinning in the history forever.
  const orphanedToolCalls = transcriptRepo.recoverOrphaned();
  if (orphanedRuns > 0 || orphanedSessions > 0 || orphanedToolCalls > 0) {
    log.warn(
      { runs: orphanedRuns, sessions: orphanedSessions, toolCalls: orphanedToolCalls },
      'recovered state left behind by an unclean shutdown',
    );
  }

  // A workspace records where its directory is, and the root that answer was
  // derived from is configuration. Move the root — as the shipped layout did,
  // once — and every row names an address the volume no longer mounts.
  const relocation = relocateWorkspaces(workspaceRepo, config.workspacesDir);
  for (const move of relocation.moved) {
    const level = move.present ? 'info' : 'warn';
    log[level](
      { workspace: move.slug, from: move.from, to: move.to },
      move.present
        ? 'workspaces root moved — re-pointed this workspace at its directory'
        : 'workspaces root moved — re-pointed this workspace, but nothing is at the new path',
    );
  }
  for (const stranded of relocation.skipped) {
    // Same `workspaces root moved` prefix as the two above, deliberately: the
    // operator is told to grep for one string, and a third case that the grep
    // cannot match is a case they will never see.
    log.warn(
      { workspace: stranded.slug, path: stranded.path },
      'workspaces root moved — this workspace cannot be re-pointed automatically: it sits ' +
        'outside the root and its directory is not named after its slug',
    );
  }

  // Work deferred to the end of the boot: a callback that needs a service
  // built further down (the push service, for the fallback notice) queues
  // here rather than reaching for a binding that may not exist yet.
  const afterBoot: Array<() => void> = [];
  let booted = false;
  const onceBooted = (work: () => void): void => {
    if (booted) work();
    else afterBoot.push(work);
  };
  const embeddingCacheDir = config.embeddingCacheDir ?? resolve(config.dataDir, 'models');
  // The model will not come up. The doctor says so on every report; this
  // says so once, to the operator's devices, because a deployment that
  // silently answers word matches is the failure this exists for.
  const notifyFallback = (id: string, reason: string): void =>
    onceBooted(() => {
      void push
        .notify({
          title: 'Retrieval is lexical-only',
          body: `The embedding model ${id} did not load: ${reason}. Memory and knowledge search match words until it does.`,
          url: '/settings',
          tag: 'embeddings-fallback',
        })
        .catch((error: unknown) => log.warn({ err: error }, 'could not notify the embeddings fallback'));
    });
  const bootEmbedder = await createEmbeddingProvider({
    provider: runtimeSettings.choice('embeddings') as 'hash' | 'local',
    model: config.embeddings.model,
    cacheDir: embeddingCacheDir,
    log: (level, message) => log[level](message),
    // The model came up: whatever was written pending, or under another
    // provider, can be rebuilt now.
    onReady: () => onceBooted(() => rebuildVectors()),
    onFallback: notifyFallback,
  });
  const embedder = new SwitchableEmbedder(bootEmbedder);
  log.info(`embeddings provider: ${embedder.id} (${embedder.ready ? `${embedder.dimension}d` : 'loading'})`);

  const memory = new MemoryStore(db, embedder);
  // A large document is written at once and vectorised by the rebuild, so
  // a save never waits on the model. `rebuildVectors` is declared below;
  // it is only ever called from a request, long after this line has run.
  const knowledge = new KnowledgeStore(db, embedder, undefined, { embedLater: () => rebuildVectors() });
  const classifier = new TaskClassifier(db, embedder);
  const policy = new PolicyLearner(db);

  // A vector is only comparable to one from the same provider, so a change of
  // embedder silently turns off dense retrieval *and* duplicate detection
  // until the stale rows are rebuilt. Not awaited: the rebuild must not hold
  // up the health endpoint the deploy gate waits on, and retrieval is already
  // degraded in exactly this way while it runs. Called again whenever the
  // model becomes ready or the setting changes; it does nothing while no
  // model is ready.
  const rebuild = createRebuildTrigger(() =>
    reindexStale({
      db,
      memory,
      knowledge,
      classifier,
      embedder,
      log: (level, message, data) => log[level](data ?? {}, message),
    }),
  );
  const rebuildVectors = (): void => rebuild.trigger();
  rebuildVectors();

  // The setting's hot half — see `embedder-switch.ts` for the rule that
  // keeps one model in memory across toggles and retries only a failed one.
  const embedderSwitch = createEmbedderSwitch({
    embedder,
    model: config.embeddings.model,
    cacheDir: embeddingCacheDir,
    rebuild: rebuildVectors,
    onFallback: notifyFallback,
    log: (level, message) => log[level](message),
    initial: bootEmbedder,
  });
  switchEmbedder = (provider) => embedderSwitch.apply(provider);

  /** What retrieval is right now — the doctor, the health endpoint and the steward all read this one. */
  const retrieval = (): RetrievalStatus => {
    const status = describeEmbedder(embedder);
    return {
      embedder: status.id,
      family: status.family,
      state: status.state,
      semantic: status.family === 'st' && status.ready,
      pending: countStale(db, status.id),
    };
  };

  const claudeEnv = buildClaudeEnv(config);

  // Owns the credential from here on. Constructing it rewrites `claudeEnv` in
  // place from the vault, so a token paired from the interface on a previous
  // boot is picked up before the supervisor ever reads the object.
  const claudeCredentials = new ClaudeCredentials({
    vault,
    env: claudeEnv,
    fromEnvironment: { oauthToken: config.claude.oauthToken, apiKey: config.claude.apiKey },
    // The CLI's own store, where `claude auth login` run in the container
    // leaves a sign-in the metaclaude-home volume persists. Same resolution
    // the CLI applies: an explicit config dir first, else ~/.claude.
    cliLogin: () => readCliLogin(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')),
    log: (level, message) => log[level](message),
  });

  // The guided pairing flow ends in `claudeCredentials.save`, so a token it
  // obtains takes effect on the very next run like a pasted one would.
  const claudePairing = new ClaudePairing({
    credentials: claudeCredentials,
    log: (level, message) => log[level](message),
  });

  // Web push: the VAPID identity lives in the vault, subscriptions in the
  // database, and the two event hooks below decide what deserves a buzz.
  const push = new PushService({
    db,
    vault,
    subject: config.pushSubject,
    log: (level, message, data) => log[level](data ?? {}, message),
  });
  const pushEvents = buildPushEventHandlers({
    push,
    sessions: sessionRepo,
    workspaces: workspaceRepo,
    // The scheduler is built after the kernel, which is built after this;
    // the reference is read when a run finishes, long after both exist.
    automations: { notifying: (sessionId) => schedulerRef?.notifying(sessionId) ?? null },
    log: (level, message, data) => log[level](data ?? {}, message),
  });
  // Approvals reach the bus, not onRunFinished — subscribe where they are
  // published. The kernel mirrors every approval onto the system topic.
  bus.subscribe(SYSTEM_TOPIC, (frame) => pushEvents.onSystemFrame(frame));
  const kernelLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => {
    log[level](data ?? {}, message);
  };

  /**
   * The language generated text should be in, for one workspace.
   *
   * Read at the point of use rather than captured: the deployment setting is
   * hot, so a change takes effect on the next run rather than the next restart
   * — the same contract every other runtime setting has.
   */
  const contentLanguage = (workspaceId: string | null) =>
    resolveContentLanguage(
      (workspaceId ? workspaceRepo.get(workspaceId)?.settings.language : undefined) ?? 'auto',
      runtimeSettings.choice('language') as 'auto' | 'fr' | 'en',
    );

  /**
   * Metaclaude's own workspace, prepared before anything can start a run in
   * it. A failure here is logged rather than fatal: the deployment is worth
   * more than its steward, and every route that asks then answers null.
   */
  const systemWorkspace: SystemWorkspace = new SystemWorkspace({
    db,
    workspaces: workspaceRepo,
    workspacesRoot: config.workspacesDir,
    docsDir: findDocsDir(),
    sourceRoot: findSourceRoot(),
    version: APP_VERSION,
    language: () => contentLanguage(systemWorkspace.id()),
    // The whole reversible surface, by exact name: its own tools, the board
    // and the proposals. Pre-approving less than the supervisor mounts left
    // the steward unable to file a card without a person watching, and
    // refused outright when its review ran on the schedule under `dontAsk`.
    preapproved: () => [...systemToolNames(), ...boardToolNames(), ...advisorToolNames()],
    tools: () => [
      ...SYSTEM_TOOLS.map((entry) => ({
        name: `mcp__${SYSTEM_SERVER_NAME}__${entry.name}`,
        ring: entry.ring,
        description: entry.description,
      })),
      ...BOARD_TOOL_CATALOGUE.map((entry) => ({
        ...entry,
        name: `mcp__${BOARD_SERVER_NAME}__${entry.name}`,
      })),
      ...ADVISOR_TOOL_CATALOGUE.map((entry) => ({
        ...entry,
        name: `mcp__${ADVISOR_SERVER_NAME}__${entry.name}`,
      })),
    ],
    log: (level, message, data) => log[level](data ?? {}, message),
  });
  try {
    await systemWorkspace.ensure();
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'could not prepare the system workspace',
    );
  }

  // The tools a run may call without changing anything durable. A run of the
  // system workspace made of nothing but these taught nothing a later run
  // cannot re-read, and its reflexion was the source of most of the state
  // notes measured in production — so such a run is not reflected on.
  const readOnlyTools = new Set<string>([
    ...SYSTEM_TOOLS.filter((entry) => entry.ring === 1).map((entry) => `mcp__${SYSTEM_SERVER_NAME}__${entry.name}`),
    ...BOARD_TOOL_CATALOGUE.filter((entry) => entry.ring === 1).map((entry) => `mcp__${BOARD_SERVER_NAME}__${entry.name}`),
    'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'ToolSearch', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task',
  ]);

  // What the gate is shown of a workspace's standing instructions: the system
  // workspace's generated CLAUDE.md, a project's own CLAUDE.md when it has one.
  const standingInstructions = async (workspaceId: string): Promise<string | null> => {
    const workspace = workspaceRepo.get(workspaceId);
    if (!workspace) return null;
    return readGenerated(workspace, 'CLAUDE.md');
  };

  // Every tool the steward has described to it, by short name: a note about
  // one of them repeats the instructions. Other workspaces get none — a
  // project's lessons legitimately name the tools it runs.
  const stewardToolNames = [
    ...SYSTEM_TOOLS.map((entry) => entry.name),
    ...BOARD_TOOL_CATALOGUE.map((entry) => entry.name),
    ...ADVISOR_TOOL_CATALOGUE.map((entry) => entry.name),
    // The built-ins its instructions name too: the ones it has, and the ones
    // it is told it does not — "no editor here" is a note about Write.
    ...SYSTEM_WORKSPACE_SAFETY.disallowedTools,
    'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  ];
  const gate = new Gatekeeper({
    memory,
    call: createGateCall({ env: claudeEnv, claudeBinPath: config.claude.binPath, cwd: config.dataDir }),
    describedTools: (workspaceId) => (systemWorkspace.isSystem(workspaceId) ? stewardToolNames : []),
    instructions: standingInstructions,
    language: (workspaceId) => contentLanguage(workspaceId),
    log: kernelLog,
  });

  const reflexion = new ReflexionEngine({
    db,
    memory,
    language: (workspaceId) => contentLanguage(workspaceId),
    env: claudeEnv,
    claudeBinPath: config.claude.binPath,
    // The reflector runs in a scratch directory, never a workspace: it has no
    // tools, and pointing it at project files would be a needless risk.
    cwd: config.dataDir,
    gate,
    readOnlyRun: (run, events) =>
      systemWorkspace.isSystem(run.workspaceId) &&
      events.every((event) => event.kind !== 'tool_call' || readOnlyTools.has(event.name)),
    log: kernelLog,
  });

  // The consolidation pass. Same tool-less, scratch-directory call as the
  // reflector, for the same reason: it reads memories and answers with JSON,
  // and giving it a workspace or a tool would be a risk it has no use for.
  const consolidator = new Consolidator({
    db,
    memory,
    embedder,
    language: (workspaceId) => contentLanguage(workspaceId),
    call: async (groups, language) => {
      const { prompt, numbering } = buildConsolidationPrompt(groups);
      const output = await structuredCall<ConsolidationOutput>(
        { env: claudeEnv, claudeBinPath: config.claude.binPath, cwd: config.dataDir },
        {
          prompt,
          systemPrompt: withLanguage(CONSOLIDATION_SYSTEM_PROMPT, language),
          schema: CONSOLIDATION_SCHEMA as unknown as Record<string, unknown>,
          accept: (parsed) => Array.isArray((parsed as ConsolidationOutput).groups),
        },
      );
      return readConsolidationOutput(output, groups, numbering);
    },
    log: kernelLog,
  });

  // Plugins are read from disk once at boot; `refresh()` re-reads them after
  // any change. `runtime()` is then synchronous, which matters because it is on
  // the path of every run.
  const plugins = new PluginRegistry({
    db,
    pluginsDir: config.pluginsDir,
    log: (level, message, data) => log[level](data ?? {}, message),
  });
  await plugins.refresh();

  const registry = new Registry(
    db,
    vault,
    (level, message, data) => log[level](data ?? {}, message),
    plugins,
  );

  /**
   * MCP OAuth, and the guard that decides where its requests may go.
   *
   * Loopback is allowed outside production for one reason: exercising this
   * flow locally means an authorization server on this machine, and refusing
   * it would make the feature untestable where it is written.
   */
  const outboundGuard = createOutboundGuard({
    allowLoopback: config.env !== 'production',
  });
  const mcpOAuth = new McpOAuth({
    db,
    vault,
    fetch: globalThis.fetch,
    isSafeEndpoint: outboundGuard,
    // Empty when the deployment never set its public origin. The routes refuse
    // with that setting named rather than building a redirect nobody can reach.
    callbackUrl: config.publicUrl ? `${config.publicUrl}/api/mcp/oauth/callback` : '',
    log: (level, message, data) => log[level](data ?? {}, message),
  });

  const library = new LibraryService(registry);

  // The board's one mutation surface — routes, the agent's board tools and the
  // kernel's run-outcome hook all write through it, so every change reaches
  // every open board as a frame.
  const board = new BoardGateway(new BoardService(db), bus);

  // Declared before the kernel and resolved lazily by the supervisor, since the
  // two reference each other.
  let kernelRef: Kernel | null = null;
  let advisorRef: AdvisorService | null = null;
  let stewardRef: Steward | null = null;

  const supervisor = new AgentSupervisor({
    broker: () => {
      if (!kernelRef) throw new Error('The kernel is not ready yet.');
      return kernelRef.broker;
    },
    allowBypassPermissions: config.allowBypassPermissions,
    claudeBinPath: config.claude.binPath,
    runTimeoutMs: () => runtimeSettings.number('runTimeoutMs'),
    idleTimeoutMs: () => runtimeSettings.number('idleTimeoutMs'),
    env: claudeEnv,
    directoryPolicy: { workspacesDir: config.workspacesDir, dataDir: config.dataDir },
    log: kernelLog,
    // Same lazy shape as the broker, for the same mutual-construction reason.
    delegate: (input) => {
      if (!kernelRef) throw new Error('The kernel is not ready yet.');
      return kernelRef.delegate(input);
    },
    board,
    // Same lazy shape as the broker: the advisor needs the kernel's submit,
    // so it is built after both — but its propose surface must be mountable
    // into every run from the start.
    advisor: {
      propose: (input) => {
        if (!advisorRef) throw new Error('The advisor is not ready yet.');
        return advisorRef.propose(input);
      },
      proposeAutomation: (input) => {
        if (!advisorRef) throw new Error('The advisor is not ready yet.');
        return advisorRef.proposeAutomation(input);
      },
    },
    // Same lazy shape again: the steward is built last, because it reaches
    // everything, and the supervisor only opens it once a run is starting.
    steward: {
      workspaceId: () => systemWorkspace.id(),
      facade: () => {
        if (!stewardRef) throw new Error('The steward is not ready yet.');
        return stewardRef;
      },
    },
  });

  // What the CLI itself offers, per workspace. Behind a short-lived cache
  // because each read spawns a subprocess and a dashboard's panels ask together.
  // The registry's servers and agents are mounted into the probe so the panel
  // reports live connection status for what runs actually use — a workspace is
  // found by path because that is the cache's key.
  const claudeCatalogue = new CatalogueCache({
    read: (workspacePath) => {
      const workspace = workspaceRepo.list(true).find((entry) => entry.path === workspacePath);
      return supervisor.catalogue(workspacePath, workspace ? registry.resolve(workspace) : undefined);
    },
  });

  // Same shape, same reason: reading the quota spawns a CLI subprocess.
  const claudeUsage = new TtlCache<ClaudeUsage>({
    read: (workspacePath) => supervisor.usage(workspacePath),
  });

  // The SDK reads the CLI's own transcript store in-process — no subprocess,
  // so no cache. Injected so tests never touch the real store.
  const claudeSessions = new ClaudeSessions({
    list: (options) => listSessions(options),
    workspaces: workspaceRepo,
    sessions: sessionRepo,
  });

  // The catalogue read is bounded in time and size: it is a convenience view
  // of a third-party file, and neither a slow host nor a huge body may hold a
  // request handler hostage. The install path never uses this fetch — the CLI
  // does its own.
  const marketplaces = new MarketplacesService({
    db,
    fetchText: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = await response.text();
      if (body.length > 2_000_000) throw new Error('marketplace.json larger than 2 MB');
      return body;
    },
  });

  // Declared before the kernel because the kernel's completion hook feeds it.
  let schedulerRef: Scheduler | null = null;
  let autopilotRef: BoardAutopilot | null = null;

  // Shared between the kernel (binding and loading a run's files) and the
  // HTTP routes (upload, serve, delete) — one ledger, one jail.
  const attachments = new AttachmentService(db);

  // The only sweep that destroys something the operator wrote, so both of its
  // conditions are configurable and both are generous by default.
  const runRetention = new RunRetention({
    db,
    attachments,
    retentionDays: () => runtimeSettings.number('runRetentionDays'),
    keepPerWorkspace: () => runtimeSettings.number('runKeepPerWorkspace'),
  });

  const kernel = new Kernel({
    db,
    bus,
    workspaces: workspaceRepo,
    sessions: sessionRepo,
    runs: runRepo,
    transcript: transcriptRepo,
    attachments,
    memory,
    knowledge,
    classifier,
    policy,
    reflexion,
    consolidator,
    // The registry resolves per-workspace context; the marketplace sources are
    // global and composed in here rather than taught to the registry.
    contextProvider: {
      resolve: (workspace) => ({
        ...registry.resolve(workspace),
        marketplaces: marketplaces.settingsPayload(),
      }),
      // Only the servers this workspace would mount, and only those whose
      // token is near its end. On a deployment with no OAuth server this
      // does nothing and costs one filtered list.
      prepare: async (workspace) => {
        const servers = registry
          .listMcpServers(workspace.id)
          .filter((server) => server.enabled && server.authType === 'oauth');
        for (const server of servers) {
          await mcpOAuth.refreshIfExpiring({
            ...server,
            oauthMetadata: registry.oauthMetadata(server.id),
          });
        }
      },
    },
    supervisor,
    maxConcurrentRuns: () => runtimeSettings.number('maxConcurrentRuns'),
    runTimeoutMs: () => runtimeSettings.number('runTimeoutMs'),
    // Every finished run is offered, not only automation-triggered ones: a human
    // pressing "Run now" produces a `user` run against the automation's session,
    // and its outcome still belongs in that automation's status.
    // `recordOutcome` no-ops for a session that has no automation.
    onRunFinished: (run) => {
      schedulerRef?.recordOutcome(run.sessionId, run.status, run.triggeredBy === 'user');
      // Close the loop on any board card this run was working; a board failure
      // must never disturb the kernel's own finish path.
      try {
        board.applyRunOutcome(run);
      } catch (error) {
        log.warn({ err: error, runId: run.id }, 'could not apply the run outcome to its board card');
      }
      // The phone hears about it — for human-started runs only, and
      // fire-and-forget inside the handler, so push can never slow a finish.
      pushEvents.onRunFinished(run);
      // The autopilot's chain: an opted-in board pulls its next card.
      void autopilotRef?.onRunFinished(run);
      // Event triggers: the automations watching this outcome in this workspace.
      void schedulerRef?.onRunFinished(run);
    },
    log: kernelLog,
  });
  kernelRef = kernel;

  const workspaces = new WorkspaceService({
    repo: workspaceRepo,
    workspacesRoot: config.workspacesDir,
    log: (level, message, data) => log[level](data ?? {}, message),
  });

  const scheduler = new Scheduler({
    db,
    bus,
    kernel,
    sessions: sessionRepo,
    workspaces: workspaceRepo,
    log: kernelLog,
  });

  schedulerRef = scheduler;

  // The board autopilot: composed from the exact pieces the card's own
  // "Send to the agent" route uses, so an automatic start is byte-identical
  // to a pressed one — skills materialised, session reused, outcome hooked.
  const autopilot = new BoardAutopilot({
    boardTasks: { board: (workspaceId) => board.list(workspaceId) },
    workspaces: workspaceRepo,
    runs: runRepo,
    start: async (taskId, username) => {
      const task = board.get(taskId);
      const workspace = task ? workspaceRepo.get(task.workspaceId) : null;
      if (workspace) {
        await registry.materialiseSkills(workspace).catch((error: Error) => {
          log.warn({ err: error.message }, 'could not materialise skills');
        });
      }
      return startTaskRun(
        {
          board,
          runs: runRepo,
          sessions: sessionRepo,
          workspaces: workspaceRepo,
          submit: (input) => kernel.submit(input),
        },
        taskId,
        username,
      );
    },
    quota: {
      utilization: async (workspacePath) => planUtilization(await claudeUsage.get(workspacePath)),
    },
    guardPct: () => runtimeSettings.number('quotaGuardPct'),
    log: (level, message, data) => log[level](data ?? {}, message),
  });
  autopilotRef = autopilot;
  // The review rule's second half: a card in review assigned to the agent is
  // worked by the agent. The gateway sees the delegation (it is the board's
  // one mutation surface); the autopilot answers it with the Work button's
  // authority — immediately when the workspace is idle, or picked up by the
  // run-finished chain and the sweep when it is not. Fire-and-forget: the
  // assignment already succeeded, and a kernel refusal here is a deferral.
  board.onReviewDelegated = (task, actor) => {
    const username = actor.startsWith('user:') ? actor.slice('user:'.length) : 'autopilot';
    void autopilot.workNext(task.workspaceId, { manual: false, username }).catch((error: Error) => {
      log.warn({ taskId: task.id, message: error.message }, 'delegated review could not start');
    });
  };
  // The safety net for stalls the chain cannot see: a quota deferral with
  // nothing left to finish, a kernel refusal, cards added while idle.
  const autopilotTimer = setInterval(() => void autopilot.sweep(), 5 * 60_000);
  autopilotTimer.unref();

  // The advisor: the dossier is composed from the same live services the
  // routes read, and its run goes through the ordinary kernel — session,
  // transcript, approvals and all.
  const advisor = new AdvisorService({
    db,
    workspaces: workspaceRepo,
    sessions: sessionRepo,
    runs: runRepo,
    registry,
    scheduler,
    library,
    board: { list: (workspaceId) => board.list(workspaceId) },
    submit: (input) => kernel.submit(input),
    log: (level, message, data) => log[level](data ?? {}, message),
  });
  advisorRef = advisor;
  // Hourly is the beat, not the cadence: the sweep itself holds each
  // workspace to at most one automatic analysis per day.
  const advisorTimer = setInterval(() => void advisor.sweep(), 60 * 60_000);
  advisorTimer.unref();

  // Read-only self-diagnosis. Probes are bound here so the doctor itself
  // stays testable against fakes; on demand only, so no caching.
  const doctor = new Doctor({
    db,
    audit,
    vault,
    dataDir: config.dataDir,
    workspacesDir: config.workspacesDir,
    diskFree: async (path) => {
      const stats = await statfs(path);
      return Number(stats.bavail) * Number(stats.bsize);
    },
    cliVersion: async () => {
      try {
        const { stdout } = await execFileAsync(config.claude.binPath ?? 'claude', ['--version'], {
          timeout: 10_000,
        });
        return stdout.trim().split('\n')[0] ?? null;
      } catch {
        return null;
      }
    },
    /**
     * One outbound request, to the host the CLI itself must reach.
     *
     * Any status code is a success: the question is whether a TLS connection
     * to a public host can be made at all, not what that host answers to a
     * bare GET. A five-second budget keeps a wedged network from holding the
     * diagnostics page open.
     */
    reachOut: async () => {
      const started = Date.now();
      try {
        const response = await fetch('https://api.anthropic.com/', {
          method: 'GET',
          signal: AbortSignal.timeout(5_000),
        });
        return { ok: true, detail: `HTTP ${response.status} in ${Date.now() - started} ms` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    credential: () => {
      const status = claudeCredentials.status();
      return { mode: status.mode, signInEndsAt: status.cliLogin?.signInEndsAt ?? null };
    },
    embeddings: () => {
      const status = describeEmbedder(embedder);
      return {
        requested: runtimeSettings.choice('embeddings'),
        active: status.id,
        dimension: status.dimension,
        state: status.state,
        lastError: status.lastError,
        pending: countStale(db, status.id),
      };
    },
    activeRuns: () => kernel.activeCount,
    queuedRuns: () => kernel.queuedCount,
    // Written by deploy/bin/metaclaude-backup on the host, into the volume
    // this process sees as its data directory. Absent is a real state — a
    // deployment whose nightly timer has not run yet — and the doctor judges
    // it; only "the file is not there" becomes null here.
    readBackupMarker: async () => {
      try {
        return await readFile(join(config.dataDir, 'backup-marker.json'), 'utf8');
      } catch {
        return null;
      }
    },
  });

  const analytics = new AnalyticsService(db);

  // The brief reads the same quota cache as the Analytics screen; a CLI that
  // cannot answer costs the section, never the page.
  const brief = new BriefService({
    db,
    analytics,
    doctor,
    usage: () => claudeUsage.get(config.dataDir),
    pendingApprovals: () => kernel.broker.listPending().length,
  });

  // Cross-run skill synthesis: same scratch-dir, tool-less call shape as the
  // reflector, and the same review queue for what it proposes.
  const synthesizer = new SkillSynthesizer({
    db,
    memory,
    call: (prompt, workspaceId) =>
      structuredCall<SynthesisOutput>(
        { env: claudeEnv, claudeBinPath: config.claude.binPath, cwd: config.dataDir },
        {
          prompt,
          systemPrompt: withLanguage(SYNTHESIS_SYSTEM_PROMPT, contentLanguage(workspaceId)),
          schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
          accept: (parsed) => typeof (parsed as SynthesisOutput).worthIt === 'boolean',
        },
      ),
    log: kernelLog,
  });

  const updateChecker = config.updateRepo
    ? new UpdateChecker({
        repo: config.updateRepo,
        fetchText: async (url) => {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(10_000),
            headers: { accept: 'application/vnd.github+json' },
          });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          return response.text();
        },
      })
    : null;
  const updateApplier = new UpdateApplier({ dir: config.updatesDir });

  /**
   * The steward — Metaclaude's own hands. Built last because it reaches
   * everything above; the supervisor receives it through the lazy getter
   * declared beside the advisor's. Approvals go through `decideApproval`
   * so a decision the steward makes is audited exactly like a person's,
   * under its own name.
   */
  const steward = new Steward({
    version: APP_VERSION,
    systemWorkspaceId: () => systemWorkspace.id(),
    workspaces: workspaceRepo,
    sessions: sessionRepo,
    runs: runRepo,
    transcript: transcriptRepo,
    memory,
    insights: {
      list: (options) => listInsights(db, options),
      setStatus: (id, status) => setInsightStatus(db, id, status),
    },
    automations: scheduler,
    proposals: advisor,
    approvals: {
      listPending: () => kernel.broker.listPending(),
      decide: (decision, actor) => decideApproval(context, decision, actor),
    },
    settings: runtimeSettings,
    doctor,
    analytics,
    audit,
    registry,
    updates: updateChecker
      ? { check: () => updateChecker.check(), status: () => updateApplier.status() }
      : null,
    retrieval,
    kernel,
  });
  stewardRef = steward;

  // The one automation that ships with the system workspace — disabled, so
  // it is an example of what scheduling the steward looks like rather than
  // a run nobody asked for. Seeded once; an operator who deletes it is not
  // contradicted at the next boot.
  const systemId = systemWorkspace.id();
  if (systemId) {
    try {
      seedSystemAutomation({ db, workspaceId: systemId, automations: scheduler });
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'could not seed the system automation');
    }
  }

  booted = true;
  for (const work of afterBoot.splice(0)) work();

  const context: AppContext = {
    config,
    log,
    db,
    bus,
    auth,
    apiTokens,
    webauthn: new WebAuthnService({ db, auth }),
    audit,
    vault,
    claudeCredentials,
    claudePairing,
    push,
    autopilot,
    plugins,
    claudeCatalogue,
    claudeUsage,
    claudeSessions,
    marketplaces,
    doctor,
    runtimeSettings,
    brief,
    synthesizer,
    updateChecker,
    updateApplier,
    workspaceRepo,
    systemWorkspace,
    sessionRepo,
    runRepo,
    transcriptRepo,
    embedder,
    retrieval,
    memory,
    knowledge,
    classifier,
    policy,
    reflexion,
    consolidator,
    registry,
    library,
    advisor,
    steward,
    workspaces,
    files: new FileService(),
    attachments,
    runRetention,
    mcpOAuth,
    board,
    git: new GitService(),
    analytics,
    scheduler,
    kernel,
    startedAt: Date.now(),
    shutdown: async () => {
      scheduler.stop();
      await kernel.shutdown();
      // A WAL checkpoint on the way out keeps the -wal file from growing across
      // restarts and makes the database file self-contained for backups.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Best effort.
      }
      db.close();
    },
  };

  return context;
}
