import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { type AuditInput, AuditLog } from './audit.js';

const BASE = 1_700_000_000_000;
const DAY = 86_400_000;
const GENESIS = '0'.repeat(64);

let db: Db;
let audit: AuditLog;
let clock: number;

/**
 * Record an entry at a distinct, controlled millisecond.
 *
 * The clock is driven explicitly because `AuditLog.record` chains onto whichever
 * row sorts last by `(at, id)`, and ids carry a random suffix — see the skipped
 * test at the bottom of this file.
 */
function rec(input: AuditInput, at?: number): void {
  clock = at ?? clock + 1;
  vi.setSystemTime(new Date(clock));
  audit.record(input);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = BASE;
  vi.setSystemTime(new Date(clock));
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  audit = new AuditLog(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('record / list', () => {
  it('stores an entry and reads it back through the domain mapping', () => {
    rec({
      actor: 'usr_1',
      action: 'auth.login',
      target: 'ses_9',
      ipAddress: '10.0.0.1',
      outcome: 'success',
      detail: 'via cookie',
    });

    const entries = audit.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.actor).toBe('usr_1');
    expect(entry.action).toBe('auth.login');
    expect(entry.target).toBe('ses_9');
    expect(entry.ipAddress).toBe('10.0.0.1');
    expect(entry.outcome).toBe('success');
    expect(entry.detail).toBe('via cookie');
    expect(entry.id.startsWith('aud_')).toBe(true);
    expect(entry.at).toBe(clock);
  });

  it('defaults the optional fields', () => {
    rec({ actor: 'system', action: 'boot' });
    const entry = audit.list()[0]!;
    expect(entry.target).toBeNull();
    expect(entry.ipAddress).toBeNull();
    expect(entry.detail).toBeNull();
    expect(entry.outcome).toBe('success');
  });

  it('records a failure outcome as given', () => {
    rec({ actor: 'usr_1', action: 'auth.login', outcome: 'failure', detail: 'bad password' });
    expect(audit.list()[0]!.outcome).toBe('failure');
  });

  it('caps a runaway detail at 4000 characters', () => {
    rec({ actor: 'system', action: 'boom', detail: 'x'.repeat(10_000) });
    expect(audit.list()[0]!.detail).toHaveLength(4000);
  });

  it('returns entries newest first and honours limit, before and action filters', () => {
    for (let i = 0; i < 5; i += 1) {
      rec({ actor: 'usr_1', action: i % 2 === 0 ? 'even' : 'odd' }, BASE + i * 1000);
    }

    const all = audit.list();
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.at)).toEqual([
      BASE + 4000,
      BASE + 3000,
      BASE + 2000,
      BASE + 1000,
      BASE,
    ]);

    expect(audit.list({ limit: 2 }).map((e) => e.at)).toEqual([BASE + 4000, BASE + 3000]);
    expect(audit.list({ action: 'even' })).toHaveLength(3);
    expect(audit.list({ action: 'odd' })).toHaveLength(2);
    expect(audit.list({ action: 'nothing-matches' })).toHaveLength(0);
    expect(audit.list({ before: BASE + 2000 }).map((e) => e.at)).toEqual([BASE + 1000, BASE]);
    expect(audit.list({ before: BASE + 2000, action: 'even' }).map((e) => e.at)).toEqual([BASE]);
  });

  it('clamps an absurd limit into range', () => {
    rec({ actor: 'a', action: 'b' });
    expect(audit.list({ limit: 0 })).toHaveLength(1);
    expect(audit.list({ limit: -5 })).toHaveLength(1);
    expect(audit.list({ limit: 10_000 })).toHaveLength(1);
  });
});

describe('verifyChain', () => {
  it('is ok on an empty log', () => {
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 0 });
  });

  it('is ok on a clean chain', () => {
    for (let i = 0; i < 20; i += 1) {
      rec({ actor: `usr_${i}`, action: 'test.action', detail: `entry ${i}` });
    }
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 20 });
  });

  it('links each entry to its predecessor and anchors the first at genesis', () => {
    rec({ actor: 'a', action: 'one' });
    rec({ actor: 'b', action: 'two' });
    rec({ actor: 'c', action: 'three' });

    const rows = db
      .prepare<[], { id: string; prev_hash: string; hash: string }>(
        'SELECT id, prev_hash, hash FROM audit_log ORDER BY at ASC, id ASC',
      )
      .all();
    expect(rows[0]!.prev_hash).toBe(GENESIS);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(3);
  });

  it('detects a silently edited detail and names the first broken row', () => {
    rec({ actor: 'a', action: 'one', detail: 'harmless' });
    rec({ actor: 'b', action: 'two' });
    rec({ actor: 'c', action: 'three' });
    expect(audit.verifyChain().ok).toBe(true);

    const victim = db
      .prepare<[], { id: string }>('SELECT id FROM audit_log ORDER BY at ASC, id ASC LIMIT 1')
      .get()!;
    db.prepare('UPDATE audit_log SET detail = ? WHERE id = ?').run('rewritten', victim.id);

    const result = audit.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.brokenAt).toBe(victim.id);
    expect(result.entries).toBe(3);
  });

  it('detects tampering in every hashed field', () => {
    rec({ actor: 'a', action: 'auth.login', target: 't', ipAddress: '1.1.1.1', outcome: 'failure' });
    const id = db.prepare<[], { id: string }>('SELECT id FROM audit_log').get()!.id;

    const fields: Array<[string, unknown, unknown]> = [
      ['actor', 'someone-else', 'a'],
      ['action', 'auth.logout', 'auth.login'],
      ['target', 'other', 't'],
      ['ip_address', '9.9.9.9', '1.1.1.1'],
      ['outcome', 'success', 'failure'],
      ['at', BASE + 999_999, clock],
    ];

    for (const [column, tampered, original] of fields) {
      db.prepare(`UPDATE audit_log SET ${column} = ? WHERE id = ?`).run(tampered, id);
      expect(audit.verifyChain().ok, `tampering with ${column} must be detected`).toBe(false);
      db.prepare(`UPDATE audit_log SET ${column} = ? WHERE id = ?`).run(original, id);
      expect(audit.verifyChain().ok).toBe(true);
    }
  });

  it('detects a forged hash that does not match the row contents', () => {
    rec({ actor: 'a', action: 'one' });
    rec({ actor: 'b', action: 'two' });
    const last = db
      .prepare<[], { id: string }>('SELECT id FROM audit_log ORDER BY at DESC LIMIT 1')
      .get()!;
    db.prepare('UPDATE audit_log SET hash = ? WHERE id = ?').run('f'.repeat(64), last.id);
    expect(audit.verifyChain().ok).toBe(false);
  });

  it('detects a deleted row in the middle of the chain', () => {
    rec({ actor: 'a', action: 'one' });
    rec({ actor: 'b', action: 'two' });
    rec({ actor: 'c', action: 'three' });

    const middle = db
      .prepare<[], { id: string }>('SELECT id FROM audit_log ORDER BY at ASC, id ASC LIMIT 1 OFFSET 1')
      .get()!;
    db.prepare('DELETE FROM audit_log WHERE id = ?').run(middle.id);

    const result = audit.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.entries).toBe(2);
  });

  /**
   * BUG (apps/api/src/security/audit.ts:61, `AuditLog.lastHash`):
   * the previous hash is looked up with `ORDER BY at DESC, id DESC`, but ids
   * generated inside the same millisecond share a timestamp prefix and differ
   * only by a random suffix. Two entries recorded in the same millisecond
   * therefore chain onto whichever id happens to sort higher rather than onto
   * the row actually inserted last, which permanently breaks `verifyChain()`
   * on a log nobody has tampered with. Recording several events in one
   * millisecond is routine (a login writes more than one entry).
   */
  it('keeps a valid chain when several entries share a millisecond', () => {
    vi.setSystemTime(new Date(BASE));
    for (let i = 0; i < 20; i += 1) {
      audit.record({ actor: `usr_${i}`, action: 'test.action' });
    }
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 20 });
  });
});

describe('prune', () => {
  it('removes only entries older than the retention window', () => {
    rec({ actor: 'usr_1', action: 'ancient' }, BASE - 40 * DAY);
    rec({ actor: 'usr_1', action: 'old' }, BASE - 31 * DAY);
    rec({ actor: 'usr_1', action: 'recent' }, BASE - 3 * DAY);
    rec({ actor: 'usr_1', action: 'fresh' }, BASE - 1 * DAY);
    vi.setSystemTime(new Date(BASE));

    expect(audit.verifyChain()).toEqual({ ok: true, entries: 4 });

    expect(audit.prune(30)).toBe(2);
    expect(audit.list().map((e) => e.action)).toEqual(['fresh', 'recent']);
  });

  it('re-anchors the surviving chain so verifyChain stays ok', () => {
    for (let i = 10; i >= 1; i -= 1) {
      rec({ actor: 'usr_1', action: `entry-${i}`, detail: `detail ${i}` }, BASE - i * 10 * DAY);
    }
    vi.setSystemTime(new Date(BASE));
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 10 });

    const removed = audit.prune(45);
    expect(removed).toBe(6);

    const after = audit.verifyChain();
    expect(after).toEqual({ ok: true, entries: 4 });

    // The oldest survivor is re-anchored at genesis rather than at the hash of
    // a row that no longer exists.
    const rows = db
      .prepare<[], { prev_hash: string; hash: string }>(
        'SELECT prev_hash, hash FROM audit_log ORDER BY at ASC, id ASC',
      )
      .all();
    expect(rows[0]!.prev_hash).toBe(GENESIS);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    }

    // The re-anchored chain is still tamper-evident.
    const victim = db
      .prepare<[], { id: string }>('SELECT id FROM audit_log ORDER BY at ASC, id ASC LIMIT 1')
      .get()!;
    db.prepare('UPDATE audit_log SET detail = ? WHERE id = ?').run('tampered', victim.id);
    expect(audit.verifyChain().ok).toBe(false);
  });

  it('is a no-op when nothing is old enough, leaving hashes untouched', () => {
    rec({ actor: 'a', action: 'one' });
    rec({ actor: 'b', action: 'two' });
    const before = db
      .prepare<[], { id: string; prev_hash: string; hash: string }>(
        'SELECT id, prev_hash, hash FROM audit_log ORDER BY id',
      )
      .all();

    expect(audit.prune(30)).toBe(0);

    const after = db
      .prepare<[], { id: string; prev_hash: string; hash: string }>(
        'SELECT id, prev_hash, hash FROM audit_log ORDER BY id',
      )
      .all();
    expect(after).toEqual(before);
    expect(audit.verifyChain().ok).toBe(true);
  });

  it('leaves an empty, still-valid log when everything is pruned', () => {
    rec({ actor: 'a', action: 'ancient-a' }, BASE - 100 * DAY);
    rec({ actor: 'b', action: 'ancient-b' }, BASE - 99 * DAY);
    vi.setSystemTime(new Date(BASE));

    expect(audit.prune(30)).toBe(2);
    expect(audit.list()).toHaveLength(0);
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 0 });
  });

  it('keeps appending correctly after a prune', () => {
    rec({ actor: 'a', action: 'ancient' }, BASE - 60 * DAY);
    rec({ actor: 'b', action: 'recent' }, BASE - 2 * DAY);
    vi.setSystemTime(new Date(BASE));
    expect(audit.prune(30)).toBe(1);

    rec({ actor: 'z', action: 'after-prune' }, BASE + 1);
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 2 });

    rec({ actor: 'z', action: 'and-another' }, BASE + 2);
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 3 });
  });
});
