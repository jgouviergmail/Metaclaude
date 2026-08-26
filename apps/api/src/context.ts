/**
 * Application container.
 *
 * Constructs every subsystem once, wires them together, and hands routes a
 * single typed object. Explicit construction (rather than a DI framework) keeps
 * the dependency graph readable and makes it trivial to build a fully in-memory
 * instance for tests.
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
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
import { PolicyLearner } from './learning/bandit.js';
import { TaskClassifier } from './learning/classifier.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './learning/embeddings.js';
import { MemoryStore } from './learning/memory.js';
import { ReflexionEngine } from './learning/reflexion.js';
import { AuditLog } from './security/audit.js';
import { AuthService } from './security/auth.js';
import { Vault } from './security/vault.js';
import { ClaudeCredentials } from './services/claude-credentials.js';
import { CatalogueCache, TtlCache } from './services/claude-catalogue.js';
import { ClaudeSessions } from './services/claude-sessions.js';
import { Doctor } from './services/doctor.js';
import { MarketplacesService } from './services/marketplaces.js';
import { UpdateChecker } from './services/update-check.js';
import { BriefService } from './services/brief.js';
import { SkillSynthesizer, SYNTHESIS_SCHEMA, SYNTHESIS_SYSTEM_PROMPT, type SynthesisOutput } from './learning/synthesis.js';
import { structuredCall } from './learning/structured-call.js';
import { PluginRegistry } from './services/plugin-registry.js';
import { AnalyticsService } from './services/analytics.js';
import { FileService } from './services/files.js';
import { GitService } from './services/git.js';
import { Registry } from './services/registry.js';
import { Scheduler } from './services/scheduler.js';
import { relocateWorkspaces, WorkspaceService } from './services/workspaces.js';

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
  claudeUsage: TtlCache<ClaudeUsage>;
  claudeSessions: ClaudeSessions;
  marketplaces: MarketplacesService;
  doctor: Doctor;
  brief: BriefService;
  synthesizer: SkillSynthesizer;
  /** Null when METACLAUDE_UPDATE_REPO is set empty. */
  updateChecker: UpdateChecker | null;

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

const execFileAsync = promisify(execFile);

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
    // The registry resolves per-workspace context; the marketplace sources are
    // global and composed in here rather than taught to the registry.
    contextProvider: {
      resolve: (workspace) => ({
        ...registry.resolve(workspace),
        marketplaces: marketplaces.settingsPayload(),
      }),
    },
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
    credentialMode: () => claudeCredentials.status().mode,
    activeRuns: () => kernel.activeCount,
    queuedRuns: () => kernel.queuedCount,
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
    call: (prompt) =>
      structuredCall<SynthesisOutput>(
        { env: claudeEnv, claudeBinPath: config.claude.binPath, cwd: config.dataDir },
        {
          prompt,
          systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
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
    claudeUsage,
    claudeSessions,
    marketplaces,
    doctor,
    brief,
    synthesizer,
    updateChecker,
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
