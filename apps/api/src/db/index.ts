/**
 * SQLite access layer.
 *
 * We use one connection in WAL mode. `better-sqlite3` is synchronous, which for
 * a single-user OS is a feature rather than a limitation: no connection pool, no
 * interleaving, and transactions are trivially correct. Every write path that
 * spans more than one statement goes through `tx()`.
 */

import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './schema.sql.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** `:memory:` is supported and used throughout the test suite. */
  path: string;
  readonly?: boolean;
  verbose?: (sql: string) => void;
}

export function openDatabase(options: OpenOptions): Db {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const verbose = options.verbose;
  const db = new Database(options.path, {
    readonly: options.readonly ?? false,
    ...(verbose ? { verbose: (message?: unknown) => verbose(String(message)) } : {}),
  });

  // WAL gives us concurrent readers alongside the writer and survives crashes.
  db.pragma('journal_mode = WAL');
  // NORMAL is the right durability/throughput trade-off under WAL: a power loss
  // can lose the last transaction but never corrupts the database.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // 64 MiB page cache — plenty for a personal deployment, still modest in RAM.
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');

  return db;
}

/** Apply every pending migration. Idempotent; safe to call on each boot. */
export function migrate(db: Db, log?: (msg: string) => void): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM _migrations')
      .all()
      .map((r) => r.version),
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    // `better-sqlite3` cannot run multi-statement SQL inside a prepared
    // transaction wrapper, so we drive BEGIN/COMMIT explicitly around exec().
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    log?.(`applied migration ${migration.version}: ${migration.name}`);
    count += 1;
  }
  return count;
}

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction via
 * SAVEPOINT, so services can compose without knowing their caller's context.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.inTransaction) {
    const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Small conversion helpers                                                    */
/* -------------------------------------------------------------------------- */

/** SQLite has no boolean type; we store 0/1 INTEGER. */
export const toInt = (value: boolean): number => (value ? 1 : 0);
export const toBool = (value: number | null | undefined): boolean => value === 1;

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Pack a unit-normalised embedding into a compact little-endian Float32 blob. */
export function packEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Unpack an embedding blob. The buffer is copied because `better-sqlite3` may
 * reuse the underlying memory between rows, and because a Float32Array view
 * requires 4-byte alignment that a slice of a pooled Buffer does not guarantee.
 */
export function unpackEmbedding(blob: Buffer | Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const copy = new ArrayBuffer(blob.byteLength);
  new Uint8Array(copy).set(blob);
  return new Float32Array(copy);
}

/* -------------------------------------------------------------------------- */
/* Key/value store                                                             */
/* -------------------------------------------------------------------------- */

export function kvGet<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM kv WHERE key = ?').get(key);
  return parseJson<T>(row?.value, fallback);
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}
