/**
 * The encrypted secret vault.
 *
 * The last module in kernel/security/learning with no test beside it, which for
 * the one thing holding every MCP credential on the box was the wrong place to
 * be. What is worth pinning is not that a round trip works — that is the easy
 * half — but the properties that make a stolen volume survivable: that the
 * ciphertext is bound to the slot it was written to, that tampering reads as
 * absence rather than as data, and that values never leave except through the
 * one accessor that is meant to return them.
 */

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Vault } from './vault.js';

let db: Db;
let vault: Vault;
const masterKey = Buffer.alloc(32, 7);

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  vault = new Vault(db, masterKey);
});

describe('construction', () => {
  it('refuses a master key that is not 32 bytes', () => {
    // A short key is a configuration mistake that would otherwise surface as a
    // cipher error hours later, on the first MCP server that needed a secret.
    expect(() => new Vault(db, Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('storing and reading', () => {
  it('returns what was stored', () => {
    vault.set('mcp:srv_1', 'API_KEY', 'sk-secret-value');
    expect(vault.get('mcp:srv_1', 'API_KEY')).toBe('sk-secret-value');
  });

  it('never writes the value in the clear', () => {
    // The whole point. If the plaintext is recoverable from the file, the
    // encryption is decoration.
    vault.set('mcp:srv_1', 'API_KEY', 'sk-secret-value');

    const row = db
      .prepare<[], { ciphertext: Buffer }>('SELECT ciphertext FROM secrets')
      .get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('binary')).not.toContain('sk-secret-value');
  });

  it('replaces rather than duplicating on a second write', () => {
    vault.set('mcp:srv_1', 'API_KEY', 'first');
    vault.set('mcp:srv_1', 'API_KEY', 'second');

    expect(vault.get('mcp:srv_1', 'API_KEY')).toBe('second');
    expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM secrets').get()?.n).toBe(1);
  });

  it('keeps the same key name separate per scope', () => {
    // Two MCP servers both wanting `API_KEY` is the normal case, not an edge
    // one; collapsing them would hand one server the other's credential.
    vault.set('mcp:srv_1', 'API_KEY', 'one');
    vault.set('mcp:srv_2', 'API_KEY', 'two');

    expect(vault.get('mcp:srv_1', 'API_KEY')).toBe('one');
    expect(vault.get('mcp:srv_2', 'API_KEY')).toBe('two');
  });

  it('answers null for something never stored', () => {
    expect(vault.get('mcp:srv_1', 'MISSING')).toBeNull();
  });

  it('round-trips values that are not ASCII', () => {
    vault.set('global', 'NOTE', 'clé privée — ne pas partager 🔐');
    expect(vault.get('global', 'NOTE')).toBe('clé privée — ne pas partager 🔐');
  });
});

describe('the ciphertext is bound to its slot', () => {
  it('will not decrypt under a different key name', () => {
    // Without the AAD binding, moving a row from one slot to another would
    // silently re-point a credential — a privilege escalation done with an
    // UPDATE statement rather than an exploit.
    vault.set('mcp:srv_1', 'API_KEY', 'one');
    db.prepare("UPDATE secrets SET key = 'OTHER_KEY'").run();

    expect(vault.get('mcp:srv_1', 'OTHER_KEY')).toBeNull();
  });

  it('will not decrypt under a different scope', () => {
    vault.set('mcp:srv_1', 'API_KEY', 'one');
    db.prepare("UPDATE secrets SET scope = 'mcp:srv_2'").run();

    expect(vault.get('mcp:srv_2', 'API_KEY')).toBeNull();
  });

  it('reads a tampered ciphertext as absent, not as data', () => {
    vault.set('mcp:srv_1', 'API_KEY', 'one');
    db.prepare('UPDATE secrets SET ciphertext = ?').run(randomBytes(16));

    expect(vault.get('mcp:srv_1', 'API_KEY')).toBeNull();
  });

  it('does not open under the wrong master key', () => {
    vault.set('mcp:srv_1', 'API_KEY', 'one');
    expect(new Vault(db, Buffer.alloc(32, 9)).get('mcp:srv_1', 'API_KEY')).toBeNull();
  });
});

describe('listing and deleting', () => {
  it('lists key names, never values', () => {
    vault.set('mcp:srv_1', 'B_KEY', 'b');
    vault.set('mcp:srv_1', 'A_KEY', 'a');

    const keys = vault.listKeys('mcp:srv_1');
    expect(keys).toEqual(['A_KEY', 'B_KEY']);
    expect(JSON.stringify(keys)).not.toContain('a');
  });

  it('lists only the scope asked for', () => {
    vault.set('mcp:srv_1', 'A', 'a');
    vault.set('mcp:srv_2', 'B', 'b');

    expect(vault.listKeys('mcp:srv_1')).toEqual(['A']);
  });

  it('reports whether a delete removed anything', () => {
    vault.set('mcp:srv_1', 'A', 'a');

    expect(vault.delete('mcp:srv_1', 'A')).toBe(true);
    expect(vault.delete('mcp:srv_1', 'A')).toBe(false);
    expect(vault.get('mcp:srv_1', 'A')).toBeNull();
  });

  it('drops a whole scope and leaves the others alone', () => {
    // Deleting an MCP server must take its credentials with it; taking anyone
    // else's would be the same bug in the opposite direction.
    vault.set('mcp:srv_1', 'A', 'a');
    vault.set('mcp:srv_1', 'B', 'b');
    vault.set('mcp:srv_2', 'C', 'c');

    expect(vault.deleteScope('mcp:srv_1')).toBe(2);
    expect(vault.listKeys('mcp:srv_1')).toEqual([]);
    expect(vault.get('mcp:srv_2', 'C')).toBe('c');
  });
});

describe('resolveEnv', () => {
  it('builds the env a child process is handed', () => {
    vault.set('mcp:srv_1', 'API_KEY', 'k');
    vault.set('mcp:srv_1', 'TOKEN', 't');

    expect(vault.resolveEnv('mcp:srv_1', ['API_KEY', 'TOKEN'])).toEqual({
      API_KEY: 'k',
      TOKEN: 't',
    });
  });

  it('omits a missing key rather than passing undefined through', () => {
    // `{ API_KEY: undefined }` reaches a subprocess as the string "undefined",
    // which a server then sends to its upstream as a credential.
    vault.set('mcp:srv_1', 'API_KEY', 'k');

    const env = vault.resolveEnv('mcp:srv_1', ['API_KEY', 'ABSENT']);
    expect(env).toEqual({ API_KEY: 'k' });
    expect('ABSENT' in env).toBe(false);
  });

  it('returns nothing when nothing was asked for', () => {
    expect(vault.resolveEnv('mcp:srv_1', [])).toEqual({});
  });
});

describe('selfTest', () => {
  it('passes on an intact vault', () => {
    vault.set('mcp:srv_1', 'A', 'a');
    vault.set('mcp:srv_2', 'B', 'b');

    expect(vault.selfTest()).toEqual({ total: 2, failed: [] });
  });

  it('names what failed, which is the point of running it at boot', () => {
    // A wrong master key otherwise surfaces as a confusing MCP failure hours
    // later; naming the slots turns it into an actionable startup error.
    vault.set('mcp:srv_1', 'A', 'a');
    vault.set('mcp:srv_2', 'B', 'b');

    const result = new Vault(db, Buffer.alloc(32, 9)).selfTest();
    expect(result.total).toBe(2);
    expect(result.failed.sort()).toEqual(['mcp:srv_1/A', 'mcp:srv_2/B']);
  });

  it('is content with an empty vault', () => {
    expect(vault.selfTest()).toEqual({ total: 0, failed: [] });
  });
});
