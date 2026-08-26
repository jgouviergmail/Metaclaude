/**
 * Application container.
 *
 * Constructs every subsystem once, wires them together, and hands routes a
 * single typed object. Explicit construction (rather than a DI framework) keeps
 * the dependency graph readable and makes it trivial to build a fully in-memory
 * instance for tests.
 */

import { resolve } from 'node:path';
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
import { PolicyLearner } from './learning/bandit.js';
import { TaskClassifier } from './learning/classifier.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './learning/embeddings.js';
import { MemoryStore } from './learning/memory.js';
import { ReflexionEngine } from './learning/reflexion.js';
import { AuditLog } from './security/audit.js';
import { AuthService } from './security/auth.js';
import { Vault } from './security/vault.js';
import { ClaudeCredentials } from './services/claude-credentials.js';
import { CatalogueCache } from './services/claude-catalogue.js';
import { PluginRegistry } from './services/plugin-registry.js';
import { AnalyticsService } from './services/analytics.js';
import { FileService } from './services/files.js';
import { GitService } from './services/git.js';
import { Registry } from './services/registry.js';
import { Scheduler } from './services/scheduler.js';
import { WorkspaceService } from './services/workspaces.js';

export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  bus: EventBus;

  auth: AuthService;
  audit: AuditLog;
  vault: Vault;
  claudeCredentials: ClaudeCredentials;
  plugins: PluginRegistry;
  claudeCatalogue: CatalogueCache;

  workspaceRepo: WorkspaceRepo;
  sessionRepo: SessionRepo;
  runRepo: RunRepo;
  transcriptRepo: TranscriptRepo;

  embedder: EmbeddingProvider;
  memory: MemoryStore;
  classifier: TaskClassifier;
  policy: PolicyLearner;
  reflexion: ReflexionEngine;

  registry: Registry;
  workspaces: WorkspaceService;
  files: FileService;
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

  const auth = new AuthService(db);
  const audit = new AuditLog(db);

  const workspaceRepo = new WorkspaceRepo(db);
  const sessionRepo = new SessionRepo(db);
  const runRepo = new RunRepo(db);
  const transcriptRepo = new TranscriptRepo(db);

  // Anything left `running` belongs to a process that no longer exists.
  const orphanedRuns = runRepo.recoverOrphaned();
  const orphanedSessions = sessionRepo.recoverOrphaned();
  if (orphanedRuns > 0 || orphanedSessions > 0) {
    log.warn(
      { runs: orphanedRuns, sessions: orphanedSessions },
      'recovered state left behind by an unclean shutdown',
    );
  }

  const embedder = await createEmbeddingProvider({
    provider: config.embeddings.provider,
    model: config.embeddings.model,
    cacheDir: resolve(config.dataDir, 'models'),
    log: (level, message) => log[level](message),
  });
  log.info(`embeddings provider: ${embedder.id} (${embedder.dimension}d)`);

  const memory = new MemoryStore(db, embedder);
  const classifier = new TaskClassifier(db, embedder);
  const policy = new PolicyLearner(db);

  const claudeEnv = buildClaudeEnv(config);

  // Owns the credential from here on. Constructing it rewrites `claudeEnv` in
  // place from the vault, so a token paired from the interface on a previous
  // boot is picked up before the supervisor ever reads the object.
  const claudeCredentials = new ClaudeCredentials({
    vault,
    env: claudeEnv,
    fromEnvironment: { oauthToken: config.claude.oauthToken, apiKey: config.claude.apiKey },
    log: (level, message) => log[level](message),
  });
  const kernelLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => {
    log[level](data ?? {}, message);
  };

  const reflexion = new ReflexionEngine({
    db,
    memory,
    env: claudeEnv,
    claudeBinPath: config.claude.binPath,
    // The reflector runs in a scratch directory, never a workspace: it has no
    // tools, and pointing it at project files would be a needless risk.
    cwd: config.dataDir,
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

  // Declared before the kernel and resolved lazily by the supervisor, since the
  // two reference each other.
  let kernelRef: Kernel | null = null;

  const supervisor = new AgentSupervisor({
    broker: () => {
      if (!kernelRef) throw new Error('The kernel is not ready yet.');
      return kernelRef.broker;
    },
    allowBypassPermissions: config.allowBypassPermissions,
    claudeBinPath: config.claude.binPath,
    runTimeoutMs: config.runTimeoutMs,
    env: claudeEnv,
    directoryPolicy: { workspacesDir: config.workspacesDir, dataDir: config.dataDir },
    log: kernelLog,
  });

  // What the CLI itself offers, per workspace. Behind a short-lived cache
  // because each read spawns a subprocess and a dashboard's panels ask together.
  const claudeCatalogue = new CatalogueCache({
    read: (workspacePath) => supervisor.catalogue(workspacePath),
  });

  // Declared before the kernel because the kernel's completion hook feeds it.
  let schedulerRef: Scheduler | null = null;

  const kernel = new Kernel({
    db,
    bus,
    workspaces: workspaceRepo,
    sessions: sessionRepo,
    runs: runRepo,
    transcript: transcriptRepo,
    memory,
    classifier,
    policy,
    reflexion,
    contextProvider: registry,
    supervisor,
    maxConcurrentRuns: config.maxConcurrentRuns,
    // Every finished run is offered, not only automation-triggered ones: a human
    // pressing "Run now" produces a `user` run against the automation's session,
    // and its outcome still belongs in that automation's status.
    // `recordOutcome` no-ops for a session that has no automation.
    onRunFinished: (run) =>
      schedulerRef?.recordOutcome(run.sessionId, run.status, run.triggeredBy === 'user'),
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

  const context: AppContext = {
    config,
    log,
    db,
    bus,
    auth,
    audit,
    vault,
    claudeCredentials,
    plugins,
    claudeCatalogue,
    workspaceRepo,
    sessionRepo,
    runRepo,
    transcriptRepo,
    embedder,
    memory,
    classifier,
    policy,
    reflexion,
    registry,
    workspaces,
    files: new FileService(),
    git: new GitService(),
    analytics: new AnalyticsService(db),
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
