/**
 * Machine identities for the MCP gateway.
 *
 * The tests below are written against the properties that make a token safe to
 * hand to another program, because every one of them is a property somebody
 * would otherwise discover was missing in production: a secret that cannot be
 * read back, an expiry that always exists, a scope that never says "every
 * workspace", and a verification that fails closed on every wrong shape rather
 * than on some of them.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { ApiTokenService } from './api-tokens.js';

let db: Db;
let tokens: ApiTokenService;

/** The part of a value that is actually secret — everything after the id. */
const randomTail = (secret: string, id: string): string =>
  secret.slice('mck_'.length + id.length + 1);

const MINT = {
  name: 'n8n production',
  scopes: ['run', 'read'] as const,
  workspaceIds: ['ws_one'],
  ceiling: 'dontAsk' as const,
  expiresInDays: 30,
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  tokens = new ApiTokenService(db);
});

describe('minting', () => {
  it('returns the secret exactly once and never stores it', () => {
    const { token, secret } = tokens.create({ ...MINT, scopes: [...MINT.scopes] }, 'jules');

    expect(secret.startsWith('mck_')).toBe(true);
    // Long enough that guessing is not a strategy: an id plus 256 bits.
    expect(secret.length).toBeGreaterThan(60);

    const stored = db
      .prepare<[string], { token_hash: string }>('SELECT token_hash FROM api_tokens WHERE id = ?')
      .get(token.id);
    expect(stored?.token_hash).toBeDefined();
    expect(stored?.token_hash).not.toContain(secret);

    // And the record the interface reads carries no way back to the value.
    // The random tail, not the whole value: the id is inside the value on
    // purpose, and it is public — it is what makes a leak revocable.
    expect(JSON.stringify(token)).not.toContain(randomTail(secret, token.id));
  });

  it('records who minted it, and a hint that identifies without authenticating', () => {
    const { token, secret } = tokens.create({ ...MINT, scopes: [...MINT.scopes] }, 'jules');

    expect(token.createdBy).toBe('jules');
    expect(secret.startsWith(token.hint)).toBe(true);
    // A hint that carried the secret would be the leak it exists to avoid.
    expect(secret.length - token.hint.length).toBeGreaterThan(40);
  });

  it('always sets an expiry', () => {
    const { token } = tokens.create({ ...MINT, scopes: [...MINT.scopes] }, 'jules', 1_000);

    expect(token.expiresAt).toBe(1_000 + 30 * 24 * 60 * 60 * 1000);
  });

  it('refuses a token that reaches no workspace', () => {
    // "Nothing" is a mistake; "everything" is not on offer at all, so an empty
    // list can only be a caller that meant to name one and did not.
    expect(() => tokens.create({ ...MINT, scopes: [...MINT.scopes], workspaceIds: [] }, 'jules')).toThrow(
      /workspace/i,
    );
  });

  it('refuses a token that can do nothing', () => {
    expect(() => tokens.create({ ...MINT, scopes: [], workspaceIds: ['ws_one'] }, 'jules')).toThrow(
      /capabilit/i,
    );
  });
});

describe('verification', () => {
  const mint = (overrides: Partial<Parameters<ApiTokenService['create']>[0]> = {}, now?: number) =>
    tokens.create({ ...MINT, scopes: [...MINT.scopes], ...overrides }, 'jules', now);

  it('accepts the secret it minted, and carries the reach back', () => {
    const { token, secret } = mint();

    const verified = tokens.verify(secret);
    expect(verified?.id).toBe(token.id);
    expect(verified?.workspaceIds).toEqual(['ws_one']);
    expect(verified?.ceiling).toBe('dontAsk');
  });

  it('refuses every wrong shape rather than only the obvious one', () => {
    const { token, secret } = mint();

    for (const wrong of [
      '',
      'mck_',
      'mck_nope',
      // An id and nothing after it.
      `mck_${token.id}_`,
      // The right id, a wrong secret — the case a lookup by id alone lets in.
      `mck_${token.id}_wrongwrongwrongwrongwrongwrongwrongwrongwro`,
      // The right secret under another id: the hash must be bound to the row.
      `mck_tok_0000000000000000000000_${randomTail(secret, token.id)}`,
      // A session cookie value, in case the two verifiers are ever confused.
      'as_01J8ZQabcdefghijklmnop',
      `${secret} `,
      secret.toUpperCase(),
    ]) {
      expect(tokens.verify(wrong)).toBeNull();
    }
  });

  it('refuses a revoked token, and says nothing different about it', () => {
    const { token, secret } = mint();
    tokens.revoke(token.id);

    expect(tokens.verify(secret)).toBeNull();
  });

  it('refuses an expired token', () => {
    const { secret } = mint({ expiresInDays: 1 }, 1_000);

    expect(tokens.verify(secret, 1_000 + 23 * 60 * 60 * 1000)).not.toBeNull();
    expect(tokens.verify(secret, 1_000 + 25 * 60 * 60 * 1000)).toBeNull();
  });

  /**
   * The listing is where an operator notices a token still being used by
   * something they forgot about — which only works if using it writes.
   */
  it('records the moment of use, so an idle token is visible as idle', () => {
    const { token, secret } = mint();
    expect(tokens.list().find((one) => one.id === token.id)?.lastUsedAt).toBeNull();

    tokens.verify(secret, 5_000);

    expect(tokens.list().find((one) => one.id === token.id)?.lastUsedAt).toBe(5_000);
  });
});

describe('reach', () => {
  it('answers for the workspaces it was given and no others', () => {
    const { secret } = tokens.create(
      { ...MINT, scopes: ['run'], workspaceIds: ['ws_one', 'ws_two'] },
      'jules',
    );
    const verified = tokens.verify(secret)!;

    expect(tokens.reaches(verified, 'ws_two')).toBe(true);
    expect(tokens.reaches(verified, 'ws_three')).toBe(false);
    expect(tokens.can(verified, 'run')).toBe(true);
    expect(tokens.can(verified, 'read')).toBe(false);
  });

  it('narrows when edited, without minting a new secret', () => {
    const { token, secret } = tokens.create({ ...MINT, scopes: [...MINT.scopes] }, 'jules');

    tokens.update(token.id, { workspaceIds: ['ws_two'], scopes: ['read'], ceiling: 'plan' });

    const verified = tokens.verify(secret)!;
    expect(verified.workspaceIds).toEqual(['ws_two']);
    expect(tokens.can(verified, 'run')).toBe(false);
    expect(verified.ceiling).toBe('plan');
  });
});

/**
 * A grant that outlives its workspace.
 *
 * Measured in production: the deployment's one token named a workspace that
 * had since been deleted and recreated with a new id. Nothing cascades into a
 * JSON list, so the grant stood, the gateway filtered the workspace list by it
 * and answered *nothing at all* — and the program on the other side reported
 * that Metaclaude had no workspaces.
 */
describe('a deleted workspace', () => {
  it('is pruned from every token that named it, and only from those', () => {
    const { token: both } = tokens.create(
      { ...MINT, scopes: [...MINT.scopes], workspaceIds: ['ws_one', 'ws_two'] },
      'jules',
    );
    const { token: other } = tokens.create(
      { ...MINT, name: 'elsewhere', scopes: [...MINT.scopes], workspaceIds: ['ws_two'] },
      'jules',
    );

    expect(tokens.forgetWorkspace('ws_one')).toBe(1);
    expect(tokens.get(both.id)?.workspaceIds).toEqual(['ws_two']);
    expect(tokens.get(other.id)?.workspaceIds).toEqual(['ws_two']);

    // Pruning may leave a token reaching nothing. That state has to exist:
    // only the operator knows which workspace it should reach now, and a
    // token silently re-granted somewhere else would be a privilege invented.
    expect(tokens.forgetWorkspace('ws_two')).toBe(2);
    expect(tokens.get(both.id)?.workspaceIds).toEqual([]);
    expect(tokens.get(other.id)?.workspaceIds).toEqual([]);

    // An operator's own edit still cannot empty one.
    expect(() => tokens.update(both.id, { workspaceIds: [] })).toThrow(/at least one workspace/i);
    expect(tokens.update(both.id, { workspaceIds: ['ws_three'] })?.workspaceIds).toEqual(['ws_three']);

    // And a workspace nobody named changes nothing.
    expect(tokens.forgetWorkspace('ws_ghost')).toBe(0);
  });
});

