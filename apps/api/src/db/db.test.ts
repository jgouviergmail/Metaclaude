import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from './schema.sql.js';
import {
  type Db,
  kvGet,
  kvSet,
  migrate,
  openDatabase,
  packEmbedding,
  parseJson,
  toBool,
  toInt,
  tx,
  unpackEmbedding,
} from './index.js';

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
});

afterEach(() => {
  db.close();
});

describe('openDatabase', () => {
  it('opens an in-memory database with the expected pragmas', () => {
    expect(db.open).toBe(true);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('temp_store', { simple: true })).toBe(2); // MEMORY
  });

  it('can be told to log the SQL it executes', () => {
    const seen: string[] = [];
    const logged = openDatabase({ path: ':memory:', verbose: (sql) => seen.push(sql) });
    try {
      logged.exec('CREATE TABLE probe (x INTEGER)');
      expect(seen.some((sql) => sql.includes('CREATE TABLE probe'))).toBe(true);
    } finally {
      logged.close();
    }
  });
});

describe('migrate', () => {
  it('applies every migration on a fresh database and is then idempotent', () => {
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(0);
    expect(migrate(db)).toBe(0);
  });

  it('records what it applied', () => {
    const messages: string[] = [];
    migrate(db, (msg) => messages.push(msg));
    expect(messages).toHaveLength(MIGRATIONS.length);

    const rows = db
      .prepare<[], { version: number; name: string; applied_at: number }>(
        'SELECT * FROM _migrations ORDER BY version',
      )
      .all();
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
    for (const row of rows) expect(row.applied_at).toBeGreaterThan(0);

    // A second run logs nothing because nothing was applied.
    const again: string[] = [];
    migrate(db, (msg) => again.push(msg));
    expect(again).toEqual([]);
  });

  it('creates the core tables the rest of the system depends on', () => {
    migrate(db);
    const names = new Set(
      db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all()
        .map((r) => r.name),
    );
    for (const table of [
      'users',
      'auth_sessions',
      'workspaces',
      'sessions',
      'runs',
      'transcript_events',
      'memories',
      'memories_fts',
      'memory_usages',
      'policy_arms',
      'task_exemplars',
      'insights',
      'audit_log',
      'kv',
    ]) {
      expect(names.has(table)).toBe(true);
    }
  });

  it('refuses a database migrated further than this build knows', () => {
    // The rollback path makes this reachable rather than theoretical:
    // `metaclaude-deploy` runs `bring_up "$PRIOR"` with no schema
    // consideration, so a failed deploy puts the *previous* image in front of a
    // forward-migrated database. Migration 4 is destructive to a pre-4 reader —
    // it drains `mcp_servers.headers` into the vault — so that image sends no
    // Authorization header and every HTTP MCP server silently loses its auth.
    //
    // Failing at boot is the fix: the container never reports healthy,
    // `bring_up` returns non-zero, and metaclaude-deploy already prints the
    // correct outcome — "the service is DOWN" — instead of quietly mis-serving.
    migrate(db);
    const ahead = MIGRATIONS[MIGRATIONS.length - 1]!.version + 1;
    db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      ahead,
      'from_a_future_build',
      Date.now(),
    );

    expect(() => migrate(db)).toThrow(/newer/i);
  });

  it('is still idempotent at the current version', () => {
    // The guard must not fire on the ordinary second boot.
    migrate(db);
    expect(migrate(db)).toBe(0);
    expect(() => migrate(db)).not.toThrow();
  });
});

describe('tx', () => {
  beforeEach(() => {
    migrate(db);
  });

  it('commits the work and returns the callback value', () => {
    const result = tx(db, () => {
      kvSet(db, 'alpha', 1);
      kvSet(db, 'beta', 2);
      return 'done';
    });
    expect(result).toBe('done');
    expect(kvGet(db, 'alpha', 0)).toBe(1);
    expect(kvGet(db, 'beta', 0)).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls everything back when the callback throws, and rethrows', () => {
    kvSet(db, 'kept', 'before');

    expect(() =>
      tx(db, () => {
        kvSet(db, 'kept', 'during');
        kvSet(db, 'doomed', true);
        throw new Error('nope');
      }),
    ).toThrow('nope');

    expect(kvGet(db, 'kept', null)).toBe('before');
    expect(kvGet(db, 'doomed', null)).toBeNull();
    expect(db.inTransaction).toBe(false);
  });

  it('uses savepoints for nesting: a caught inner failure only rolls back the inner work', () => {
    tx(db, () => {
      kvSet(db, 'outer', 'kept');

      expect(() =>
        tx(db, () => {
          kvSet(db, 'inner', 'discarded');
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');

      kvSet(db, 'after-inner', 'kept');
    });

    expect(kvGet(db, 'outer', null)).toBe('kept');
    expect(kvGet(db, 'after-inner', null)).toBe('kept');
    expect(kvGet(db, 'inner', null)).toBeNull();
    expect(db.inTransaction).toBe(false);
  });

  it('propagates an uncaught inner failure and rolls back the outer transaction too', () => {
    kvSet(db, 'survivor', 'yes');

    expect(() =>
      tx(db, () => {
        kvSet(db, 'outer-2', 'x');
        tx(db, () => {
          kvSet(db, 'inner-2', 'y');
          throw new Error('boom');
        });
      }),
    ).toThrow('boom');

    expect(kvGet(db, 'outer-2', null)).toBeNull();
    expect(kvGet(db, 'inner-2', null)).toBeNull();
    expect(kvGet(db, 'survivor', null)).toBe('yes');
    expect(db.inTransaction).toBe(false);
  });

  it('commits a successful savepoint into the outer transaction', () => {
    tx(db, () => {
      tx(db, () => kvSet(db, 'nested-ok', 42));
    });
    expect(kvGet(db, 'nested-ok', 0)).toBe(42);
  });

  it('supports three levels of nesting', () => {
    tx(db, () => {
      tx(db, () => {
        tx(db, () => kvSet(db, 'deep', 'yes'));
      });
    });
    expect(kvGet(db, 'deep', null)).toBe('yes');
  });
});

describe('embedding blobs', () => {
  it('round-trips a Float32Array exactly', () => {
    const vector = Float32Array.from([0, 1, -1, 0.5, -0.25, 0.125, 3.5]);
    const packed = packEmbedding(vector);
    expect(packed).toBeInstanceOf(Buffer);
    expect(packed.byteLength).toBe(vector.length * 4);

    const unpacked = unpackEmbedding(packed);
    expect(unpacked).not.toBeNull();
    expect(Array.from(unpacked!)).toEqual(Array.from(vector));
  });

  it('round-trips through SQLite storage', () => {
    migrate(db);
    const vector = Float32Array.from(Array.from({ length: 64 }, (_, i) => (i - 32) / 64));
    db.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, v BLOB)');
    db.prepare('INSERT INTO blobs (id, v) VALUES (1, ?)').run(packEmbedding(vector));

    const row = db.prepare<[], { v: Buffer }>('SELECT v FROM blobs WHERE id = 1').get()!;
    const unpacked = unpackEmbedding(row.v)!;
    expect(Array.from(unpacked)).toEqual(Array.from(vector));
  });

  it('returns a copy, not a view onto the source buffer', () => {
    const vector = Float32Array.from([1, 2, 3, 4]);
    const packed = packEmbedding(vector);
    const unpacked = unpackEmbedding(packed)!;
    packed[0] = 0xff;
    expect(unpacked[0]).toBe(1);
  });

  it('unpacks correctly from a non-aligned slice of a pooled buffer', () => {
    const vector = Float32Array.from([1.5, -2.5, 3.5, -4.5]);
    const pool = Buffer.alloc(vector.byteLength + 3);
    packEmbedding(vector).copy(pool, 3);
    const misaligned = pool.subarray(3);
    expect(misaligned.byteOffset % 4).not.toBe(0);
    expect(Array.from(unpackEmbedding(misaligned)!)).toEqual(Array.from(vector));
  });

  it('returns null for missing, empty or truncated blobs', () => {
    expect(unpackEmbedding(null)).toBeNull();
    expect(unpackEmbedding(Buffer.alloc(0))).toBeNull();
    expect(unpackEmbedding(Buffer.alloc(1))).toBeNull();
    expect(unpackEmbedding(Buffer.alloc(2))).toBeNull();
    expect(unpackEmbedding(Buffer.alloc(3))).toBeNull();
    expect(unpackEmbedding(Buffer.alloc(7))).toBeNull();
    expect(unpackEmbedding(Buffer.alloc(4))).not.toBeNull();
  });
});

describe('kv store', () => {
  beforeEach(() => {
    migrate(db);
  });

  it('returns the fallback for a key that was never written', () => {
    expect(kvGet(db, 'absent', 'fallback')).toBe('fallback');
    expect(kvGet(db, 'absent', null)).toBeNull();
    expect(kvGet<number[]>(db, 'absent', [])).toEqual([]);
  });

  it('round-trips JSON-serialisable values', () => {
    kvSet(db, 'string', 'hello');
    kvSet(db, 'number', 42.5);
    kvSet(db, 'bool', false);
    kvSet(db, 'object', { a: 1, b: ['x', 'y'], c: null });
    kvSet(db, 'array', [1, 2, 3]);

    expect(kvGet(db, 'string', '')).toBe('hello');
    expect(kvGet(db, 'number', 0)).toBe(42.5);
    expect(kvGet(db, 'bool', true)).toBe(false);
    expect(kvGet(db, 'object', {})).toEqual({ a: 1, b: ['x', 'y'], c: null });
    expect(kvGet(db, 'array', [])).toEqual([1, 2, 3]);
  });

  it('upserts rather than duplicating, and bumps updated_at', () => {
    kvSet(db, 'counter', 1);
    const first = db
      .prepare<[string], { updated_at: number }>('SELECT updated_at FROM kv WHERE key = ?')
      .get('counter')!;

    kvSet(db, 'counter', 2);
    expect(kvGet(db, 'counter', 0)).toBe(2);

    const rows = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM kv').get()!;
    expect(rows.n).toBe(1);

    const second = db
      .prepare<[string], { updated_at: number }>('SELECT updated_at FROM kv WHERE key = ?')
      .get('counter')!;
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
  });

  it('falls back when the stored value is not valid JSON', () => {
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'corrupt',
      '{not json',
      Date.now(),
    );
    expect(kvGet(db, 'corrupt', 'safe')).toBe('safe');
  });
});

describe('small conversion helpers', () => {
  it('maps booleans onto SQLite integers and back', () => {
    expect(toInt(true)).toBe(1);
    expect(toInt(false)).toBe(0);
    expect(toBool(1)).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool(null)).toBe(false);
    expect(toBool(undefined)).toBe(false);
    // Anything that is not exactly 1 is false — no truthiness surprises.
    expect(toBool(2)).toBe(false);
  });

  it('parseJson returns the fallback for empty and malformed input', () => {
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJson('[1,2]', [])).toEqual([1, 2]);
    expect(parseJson(null, 'fb')).toBe('fb');
    expect(parseJson(undefined, 'fb')).toBe('fb');
    expect(parseJson('', 'fb')).toBe('fb');
    expect(parseJson('not json', 'fb')).toBe('fb');
    expect(parseJson('{unterminated', 'fb')).toBe('fb');
  });
});
