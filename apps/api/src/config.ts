/**
 * Runtime configuration.
 *
 * Everything is read once at boot and validated. A misconfigured deployment
 * fails fast with an actionable message instead of misbehaving at request time.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const Booleanish = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  METACLAUDE_HOST: z.string().default('0.0.0.0'),
  METACLAUDE_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),

  /** Root for all mutable state: database, artifacts, uploads, model cache. */
  METACLAUDE_DATA_DIR: z.string().default('/var/lib/metaclaude'),
  /** Root containing one directory per workspace. Every FS op is jailed here. */
  METACLAUDE_WORKSPACES_DIR: z.string().default('/var/lib/metaclaude/workspaces'),
  /** Directory holding the built web assets, served by the API in production. */
  METACLAUDE_WEB_DIR: z.string().default('/opt/metaclaude/web'),

  /**
   * 32-byte hex/base64 master key for the secret vault. Generated and persisted
   * on first boot when absent, so a fresh `docker compose up` just works.
   */
  METACLAUDE_MASTER_KEY: z.string().optional(),

  /**
   * Comma-separated origins allowed to call the API. Empty means same-origin
   * only, which is the correct setting behind the bundled reverse proxy.
   */
  METACLAUDE_ALLOWED_ORIGINS: z.string().default(''),

  /** Set when TLS terminates upstream so cookies keep the `Secure` attribute. */
  METACLAUDE_TRUST_PROXY: Booleanish,
  /** Allow cookies over plain HTTP. Only for local development. */
  METACLAUDE_INSECURE_COOKIES: Booleanish,
  /** Unlock the `bypassPermissions` mode. Off unless deliberately enabled. */
  METACLAUDE_ALLOW_BYPASS_PERMISSIONS: Booleanish,

  /** Bootstrap credentials, consumed once to create the owner account. */
  METACLAUDE_BOOTSTRAP_USER: z.string().optional(),
  METACLAUDE_BOOTSTRAP_PASSWORD: z.string().optional(),

  /** Maximum concurrent agent runs across the whole OS. */
  METACLAUDE_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(64).default(4),
  /** Hard ceiling on a single run's wall-clock time. */
  METACLAUDE_RUN_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(45 * 60 * 1000),

  /** `hash` needs no model download; `local` loads a sentence-transformer. */
  METACLAUDE_EMBEDDINGS: z.enum(['hash', 'local']).default('hash'),
  METACLAUDE_EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),

  /** Claude subscription token produced by `claude setup-token`. */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  /** Fallback pay-as-you-go credential. Subscription takes precedence. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Override the CLI binary path (the SDK resolves it automatically by default). */
  METACLAUDE_CLAUDE_BIN: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  dataDir: string;
  workspacesDir: string;
  webDir: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  trustProxy: boolean;
  secureCookies: boolean;
  allowBypassPermissions: boolean;
  bootstrap: { username: string; password: string } | null;
  maxConcurrentRuns: number;
  runTimeoutMs: number;
  embeddings: { provider: 'hash' | 'local'; model: string };
  claude: {
    oauthToken: string | null;
    apiKey: string | null;
    binPath: string | null;
    authMode: 'subscription' | 'api_key' | 'none';
  };
  logLevel: Env['LOG_LEVEL'];
  databasePath: string;
  artifactsDir: string;
  uploadsDir: string;
}

/**
 * Load or create the 32-byte master key.
 *
 * Persisting a generated key under the data directory keeps first-run friction
 * at zero while still allowing an operator to supply their own via env (which
 * is what you want when the data volume is backed up off-box).
 */
function resolveMasterKey(dataDir: string, provided: string | undefined): Buffer {
  if (provided && provided.trim().length > 0) {
    const raw = provided.trim();
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        'METACLAUDE_MASTER_KEY must decode to exactly 32 bytes (64 hex chars or 44 base64 chars).',
      );
    }
    return key;
  }

  const keyPath = resolve(dataDir, 'master.key');
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (key.length !== 32) {
      throw new Error(`Corrupt master key at ${keyPath}: expected 32 bytes.`);
    }
    return key;
  }

  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

function requireAbsolute(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, received "${value}".`);
  }
  return resolve(value);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  const dataDir = requireAbsolute('METACLAUDE_DATA_DIR', env.METACLAUDE_DATA_DIR);
  const workspacesDir = requireAbsolute(
    'METACLAUDE_WORKSPACES_DIR',
    env.METACLAUDE_WORKSPACES_DIR,
  );

  for (const dir of [dataDir, workspacesDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const artifactsDir = resolve(dataDir, 'artifacts');
  const uploadsDir = resolve(dataDir, 'uploads');
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });

  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null;
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;

  const bootstrapUser = env.METACLAUDE_BOOTSTRAP_USER?.trim();
  const bootstrapPassword = env.METACLAUDE_BOOTSTRAP_PASSWORD;

  // Empty means "not set", and must not be an error.
  //
  // `compose.yml` passes `${METACLAUDE_BOOTSTRAP_PASSWORD:-}`, which sets the
  // variable to the empty string rather than leaving it absent. Testing against
  // `undefined` therefore rejected the empty value and threw at startup, so the
  // container crash-looped on the very first `docker compose up` with an
  // unedited `.env` — and again later, when the operator follows .env.example's
  // own advice to blank the password once the account exists.
  if (bootstrapPassword && bootstrapPassword.length < 12) {
    throw new Error('METACLAUDE_BOOTSTRAP_PASSWORD must be at least 12 characters.');
  }

  return {
    env: env.NODE_ENV,
    host: env.METACLAUDE_HOST,
    port: env.METACLAUDE_PORT,
    dataDir,
    workspacesDir,
    webDir: resolve(env.METACLAUDE_WEB_DIR),
    masterKey: resolveMasterKey(dataDir, env.METACLAUDE_MASTER_KEY),
    allowedOrigins: env.METACLAUDE_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: env.METACLAUDE_TRUST_PROXY,
    secureCookies: !env.METACLAUDE_INSECURE_COOKIES,
    allowBypassPermissions: env.METACLAUDE_ALLOW_BYPASS_PERMISSIONS,
    bootstrap:
      bootstrapUser && bootstrapPassword
        ? { username: bootstrapUser, password: bootstrapPassword }
        : null,
    maxConcurrentRuns: env.METACLAUDE_MAX_CONCURRENT_RUNS,
    runTimeoutMs: env.METACLAUDE_RUN_TIMEOUT_MS,
    embeddings: { provider: env.METACLAUDE_EMBEDDINGS, model: env.METACLAUDE_EMBEDDING_MODEL },
    claude: {
      oauthToken,
      apiKey,
      binPath: env.METACLAUDE_CLAUDE_BIN?.trim() || null,
      authMode: oauthToken ? 'subscription' : apiKey ? 'api_key' : 'none',
    },
    logLevel: env.LOG_LEVEL,
    databasePath: resolve(dataDir, 'metaclaude.db'),
    artifactsDir,
    uploadsDir,
  };
}
