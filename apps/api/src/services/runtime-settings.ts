/**
 * Operational settings an owner may change without restarting the server.
 *
 * The line this draws is not "hot versus cold" — it is **operational versus
 * security**. Bypass mode, allowed origins, proxy trust, the master key and the
 * bootstrap credentials are absent on purpose: what protects them is being
 * unreachable from a session cookie, and `docs/SECURITY.md` calls the first of
 * those a deployment-level decision refused at three layers. Putting it behind
 * a form would collapse all three into one. The data directories and the
 * embedder are absent for a different reason — they cannot change while the
 * process runs, and switching the embedder would leave every stored vector a
 * different width, which `cosine` answers with a silent 0.
 *
 * Precedence is **stored > environment > schema default**, and it has to be
 * that way round: `compose.yml` names every one of these with a default of its
 * own, so in a real deployment the environment is always set and an
 * environment-wins design would leave the screen inert everywhere it matters.
 * The cost of that choice is a second source of truth, which is paid for by
 * reporting the provenance of every value — what is in force, and what it
 * would fall back to — rather than by pretending there is only one.
 *
 * Nothing here is pushed. Consumers read through a getter at the point of use,
 * which is what makes a change take effect on the next run rather than on the
 * next restart, with no notification graph to keep in step. The exception is a
 * setting whose effect lives outside this process's reach — the log level sits
 * on the logger object — and those declare `applies` and get a callback.
 */

import type { RuntimeSettingKey, RuntimeSettingRecord } from '@metaclaude/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

/** The floor a duration must clear when it is not 0. Mirrors `config.ts`. */
const DURATION_FLOOR_MS = 30_000;

export interface RuntimeSettingSpec {
  key: RuntimeSettingKey;
  kind: RuntimeSettingRecord['kind'];
  /** Bounds for a number. `null` means unbounded on that side. */
  min: number | null;
  max: number | null;
  /** Admissible values for a choice, in the order a form should offer them. */
  options: string[];
  /** The environment variable this mirrors, so provenance can be reported. */
  envVar: string | null;
  /** What this deployment booted with. */
  fromConfig: (config: Config) => number | string;
  /**
   * True when a change needs doing rather than merely reading — the log level
   * lives on the logger, not in anything that will look it up again.
   */
  applies?: boolean;
}

/**
 * The catalogue. Adding a row here is what exposes a setting, and the API
 * refuses everything else, so this list is the whole surface.
 *
 * The bounds mirror `config.ts` rather than restating it loosely, and
 * `runtime-settings.test.ts` drives `loadConfig` with each edge to prove they
 * agree — a form that accepted what boot refuses would store a value that
 * stops the server the next time it restarts.
 */
export const RUNTIME_SETTING_SPECS: readonly RuntimeSettingSpec[] = [
  {
    key: 'idleTimeoutMs',
    kind: 'duration',
    min: 0,
    max: null,
    options: [],
    envVar: 'METACLAUDE_RUN_IDLE_TIMEOUT_MS',
    fromConfig: (config) => config.idleTimeoutMs,
  },
  {
    key: 'runTimeoutMs',
    kind: 'duration',
    min: 0,
    max: null,
    options: [],
    envVar: 'METACLAUDE_RUN_TIMEOUT_MS',
    fromConfig: (config) => config.runTimeoutMs,
  },
  {
    key: 'maxConcurrentRuns',
    kind: 'count',
    min: 1,
    max: 64,
    options: [],
    envVar: 'METACLAUDE_MAX_CONCURRENT_RUNS',
    fromConfig: (config) => config.maxConcurrentRuns,
  },
  {
    key: 'quotaGuardPct',
    kind: 'percent',
    min: 0,
    max: 100,
    options: [],
    envVar: 'METACLAUDE_QUOTA_GUARD_PCT',
    fromConfig: (config) => config.quotaGuardPct,
  },
  {
    key: 'runRetentionDays',
    kind: 'count',
    min: 0,
    max: null,
    options: [],
    envVar: 'METACLAUDE_RUN_RETENTION_DAYS',
    fromConfig: (config) => config.runRetention.days,
  },
  {
    key: 'runKeepPerWorkspace',
    kind: 'count',
    min: 1,
    max: null,
    options: [],
    envVar: 'METACLAUDE_RUN_KEEP_PER_WORKSPACE',
    fromConfig: (config) => config.runRetention.keepPerWorkspace,
  },
  {
    key: 'logLevel',
    kind: 'choice',
    min: null,
    max: null,
    options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    envVar: 'LOG_LEVEL',
    fromConfig: (config) => config.logLevel,
    applies: true,
  },
  {
    // The language generated text is written in — read at the point of use by
    // every pass that writes prose, so a change takes effect on the next run
    // rather than on the next restart. `auto` leaves it to whatever each
    // workspace says, and to the model where a workspace says nothing either.
    key: 'language',
    kind: 'choice',
    min: null,
    max: null,
    options: ['auto', 'fr', 'en'],
    envVar: 'METACLAUDE_LANGUAGE',
    fromConfig: (config) => config.language,
  },
  {
    // The embedding provider, hot. `local` switches every store to the
    // shipped model at once — they answer lexically until it is ready, then
    // every stale vector is rebuilt — and `hash` switches back immediately.
    // Read at boot through `choice()`, so a stored override outlives a
    // restart without a replay; applied live by `switchEmbedder` in
    // context.ts.
    key: 'embeddings',
    kind: 'choice',
    min: null,
    max: null,
    options: ['hash', 'local'],
    envVar: 'METACLAUDE_EMBEDDINGS',
    fromConfig: (config) => config.embeddings.provider,
    applies: true,
  },
];

const BY_KEY = new Map(RUNTIME_SETTING_SPECS.map((spec) => [spec.key as string, spec]));

export interface RuntimeSettingsDeps {
  db: Db;
  config: Config;
  /**
   * Names of the environment variables this deployment actually declared.
   *
   * Passed in rather than read from `process.env` here so the distinction
   * between "the environment said 4" and "the schema defaults to 4" is a fact
   * the caller establishes once, and a test can state.
   */
  declared: ReadonlySet<string>;
  /** Called for a setting whose effect has to be done rather than read. */
  apply?: (key: RuntimeSettingKey, value: number | string) => void;
  now?: () => number;
}

interface StoredRow {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string;
}

export class RuntimeSettingsError extends Error {}

export class RuntimeSettings {
  constructor(private readonly deps: RuntimeSettingsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stored(key: string): StoredRow | undefined {
    return this.deps.db
      .prepare<[string], StoredRow>('SELECT * FROM runtime_settings WHERE key = ?')
      .get(key);
  }

  /**
   * Read a stored string back as the setting's own type, or `null` when it
   * cannot be.
   *
   * Fails *open* on purpose: an override nobody can parse — written by an
   * older version, or by hand — is ignored in favour of the environment.
   * Refusing to answer would stop every run over a bad row in a table whose
   * whole point is that it is optional.
   */
  private parse(spec: RuntimeSettingSpec, raw: string): number | string | null {
    if (spec.kind === 'choice') return spec.options.includes(raw) ? raw : null;
    const value = Number(raw);
    return Number.isFinite(value) && this.admissible(spec, value) === null ? value : null;
  }

  /** Why `value` is not admissible for `spec`, or null when it is. */
  private admissible(spec: RuntimeSettingSpec, value: number | string): string | null {
    if (spec.kind === 'choice') {
      if (typeof value !== 'string') return 'expects one of its listed values';
      return spec.options.includes(value) ? null : `must be one of ${spec.options.join(', ')}`;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'expects a whole number';
    // A duration is either off or comfortably above the floor. The middle is
    // refused because a ceiling of a few seconds stops runs rather than
    // bounding them — and 0 is not "a ceiling of nothing", it is no ceiling.
    if (spec.kind === 'duration' && value !== 0 && value < DURATION_FLOOR_MS) {
      return `must be 0 (no ceiling) or at least ${DURATION_FLOOR_MS}`;
    }
    if (spec.min !== null && value < spec.min) return `must be at least ${spec.min}`;
    if (spec.max !== null && value > spec.max) return `must be at most ${spec.max}`;
    return null;
  }

  /** The value in force, with where it came from. */
  private resolve(spec: RuntimeSettingSpec): {
    value: number | string;
    source: RuntimeSettingRecord['source'];
    row: StoredRow | undefined;
  } {
    const row = this.stored(spec.key);
    if (row) {
      const parsed = this.parse(spec, row.value);
      if (parsed !== null) return { value: parsed, source: 'stored', row };
    }
    const booted = spec.fromConfig(this.deps.config);
    const declared = spec.envVar !== null && this.deps.declared.has(spec.envVar);
    return { value: booted, source: declared ? 'environment' : 'default', row: undefined };
  }

  /** Every setting, in the order a form should show them. */
  all(): RuntimeSettingRecord[] {
    return RUNTIME_SETTING_SPECS.map((spec) => {
      const { value, source, row } = this.resolve(spec);
      return {
        key: spec.key,
        value,
        source,
        // Only meaningful while something is being shadowed; otherwise it
        // would repeat `value` and read as a second, different answer.
        fallback: source === 'stored' ? spec.fromConfig(this.deps.config) : null,
        kind: spec.kind,
        min: spec.min,
        max: spec.max,
        options: [...spec.options],
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by ?? null,
      };
    });
  }

  /** The value in force for a numeric setting. */
  number(key: RuntimeSettingKey): number {
    const spec = BY_KEY.get(key);
    if (!spec) throw new RuntimeSettingsError(`Unknown setting: ${key}`);
    const { value } = this.resolve(spec);
    return typeof value === 'number' ? value : Number(value);
  }

  /** The value in force for a choice. */
  choice(key: RuntimeSettingKey): string {
    const spec = BY_KEY.get(key);
    if (!spec) throw new RuntimeSettingsError(`Unknown setting: ${key}`);
    return String(this.resolve(spec).value);
  }

  /**
   * Store an override. Throws `RuntimeSettingsError` for an unknown key or an
   * inadmissible value — the routes turn that into a 400 naming the reason.
   */
  set(key: RuntimeSettingKey, value: number | string, actor: string): void {
    const spec = BY_KEY.get(key);
    if (!spec) throw new RuntimeSettingsError(`"${key}" is not a setting this server exposes.`);
    const reason = this.admissible(spec, value);
    if (reason) throw new RuntimeSettingsError(`"${key}" ${reason}.`);

    this.deps.db
      .prepare(
        `INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(spec.key, String(value), this.now(), actor);

    if (spec.applies) this.deps.apply?.(spec.key, value);
  }

  /** Remove an override, and apply whatever now takes its place. */
  clear(key: RuntimeSettingKey): void {
    const spec = BY_KEY.get(key);
    if (!spec) throw new RuntimeSettingsError(`"${key}" is not a setting this server exposes.`);
    this.deps.db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(spec.key);
    if (spec.applies) this.deps.apply?.(spec.key, this.resolve(spec).value);
  }

  /**
   * Apply every stored override that needs doing, once, at boot.
   *
   * Without this a log level chosen through the screen would be forgotten by
   * the next restart while the screen went on reporting it — the exact
   * disagreement the provenance exists to prevent.
   */
  applyStored(): void {
    for (const spec of RUNTIME_SETTING_SPECS) {
      if (!spec.applies) continue;
      const { value, source } = this.resolve(spec);
      if (source === 'stored') this.deps.apply?.(spec.key, value);
    }
  }
}
