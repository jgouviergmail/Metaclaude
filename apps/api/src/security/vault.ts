/**
 * Encrypted secret vault.
 *
 * MCP servers frequently need API keys. Storing those in plaintext next to the
 * transcript database would make a stolen volume catastrophic, so every value
 * is sealed with AES-256-GCM under the master key and bound to its slot.
 */

import type { Db } from '../db/index.js';
import { newId } from '@metaclaude/shared';
import { open, seal } from './crypto.js';

export type SecretScope = `workspace:${string}` | `mcp:${string}` | 'global';

interface SecretRow {
  id: string;
  scope: string;
  key: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export class Vault {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) throw new Error('Vault: master key must be 32 bytes');
  }

  /** Additional authenticated data binds a ciphertext to its (scope, key) slot. */
  private aad(scope: string, key: string): string {
    return `metaclaude:v1:${scope}:${key}`;
  }

  set(scope: SecretScope, key: string, value: string): void {
    const box = seal(this.masterKey, value, this.aad(scope, key));
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO secrets (id, scope, key, ciphertext, iv, tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           iv         = excluded.iv,
           tag        = excluded.tag,
           updated_at = excluded.updated_at`,
      )
      .run(newId('secret'), scope, key, box.ciphertext, box.iv, box.tag, now, now);
  }

  /** Returns `null` when absent, and also when the ciphertext fails to verify. */
  get(scope: SecretScope, key: string): string | null {
    const row = this.db
      .prepare<[string, string], SecretRow>('SELECT * FROM secrets WHERE scope = ? AND key = ?')
      .get(scope, key);
    if (!row) return null;
    return open(
      this.masterKey,
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      this.aad(scope, key),
    );
  }

  /** Key names only — values never leave the vault except through `get`. */
  listKeys(scope: SecretScope): string[] {
    return this.db
      .prepare<[string], { key: string }>('SELECT key FROM secrets WHERE scope = ? ORDER BY key')
      .all(scope)
      .map((r) => r.key);
  }

  delete(scope: SecretScope, key: string): boolean {
    const info = this.db.prepare('DELETE FROM secrets WHERE scope = ? AND key = ?').run(scope, key);
    return info.changes > 0;
  }

  deleteScope(scope: SecretScope): number {
    return this.db.prepare('DELETE FROM secrets WHERE scope = ?').run(scope).changes;
  }

  /** Resolve a whole scope into an env map for handing to a child process. */
  resolveEnv(scope: SecretScope, keys: readonly string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of keys) {
      const value = this.get(scope, key);
      if (value !== null) env[key] = value;
    }
    return env;
  }

  /**
   * Verify that every stored secret still decrypts. Run at boot: it turns a
   * silently wrong master key into an immediate, actionable startup error
   * instead of a confusing MCP failure hours later.
   */
  selfTest(): { total: number; failed: string[] } {
    const rows = this.db
      .prepare<[], SecretRow>('SELECT * FROM secrets')
      .all();
    const failed: string[] = [];
    for (const row of rows) {
      const value = open(
        this.masterKey,
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
        this.aad(row.scope, row.key),
      );
      if (value === null) failed.push(`${row.scope}/${row.key}`);
    }
    return { total: rows.length, failed };
  }
}
