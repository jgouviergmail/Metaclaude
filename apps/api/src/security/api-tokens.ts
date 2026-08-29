/**
 * Machine identities — the credentials the MCP gateway authenticates.
 *
 * A token is deliberately not a second kind of user. A user is somebody who
 * can be asked what they meant; a token is a capability handed to a program
 * that will use it unattended, possibly for a year, possibly after whoever
 * created it has forgotten it exists. Everything unusual about this table
 * follows from that: the expiry is never null, the workspace list is never a
 * wildcard, and the token carries a ceiling on what a run it starts may do
 * without a human in the room.
 *
 * The secret's shape is `mck_<id>_<secret>`. The id is not decoration: it
 * makes verification an indexed read of one row rather than a scan, and it
 * makes a leaked value greppable and revocable by the operator who spots it.
 * Only the SHA-256 of the whole value is stored, as for auth sessions — the
 * value already carries full entropy, so there is nothing to brute-force and a
 * stolen database yields nothing usable.
 */

import type { ApiTokenCeiling, ApiTokenRecord, ApiTokenScope } from '@metaclaude/shared';
import { isId, newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { generateToken, hashToken, timingSafeEqual } from './crypto.js';

/** Prefix of every token value. Distinct enough to grep a leak for. */
const PREFIX = 'mck';

/** How much of the value the interface may show to tell two tokens apart. */
const HINT_LENGTH = 12;

/** `tok_` plus the 22 characters `newId` always produces. */
const ID_LENGTH = 26;

const DAY_MS = 24 * 60 * 60 * 1000;

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  workspace_ids: string;
  ceiling: string;
  hint: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface MintInput {
  name: string;
  scopes: ApiTokenScope[];
  workspaceIds: string[];
  ceiling: ApiTokenCeiling;
  expiresInDays: number;
}

export interface UpdateInput {
  name?: string;
  scopes?: ApiTokenScope[];
  workspaceIds?: string[];
  ceiling?: ApiTokenCeiling;
}

/**
 * Pull the row id out of a presented value.
 *
 * Splitting on `_` is wrong twice over and both ways fail open-ish: the id
 * contains one, and the base64url secret may contain several. The id is
 * fixed-width, so read it by width and require the separator to be where it
 * must be — anything else is not a token this service minted.
 */
function idWithin(presented: string): string | null {
  const opening = `${PREFIX}_`;
  if (!presented.startsWith(opening)) return null;

  const rest = presented.slice(opening.length);
  const id = rest.slice(0, ID_LENGTH);
  if (!isId('apiToken', id) || rest[ID_LENGTH] !== '_') return null;
  // A secret has to be there. An id with an empty tail is not a credential.
  if (rest.length <= ID_LENGTH + 1) return null;
  return id;
}

const parseList = <T>(raw: string): T[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const toRecord = (row: TokenRow): ApiTokenRecord => ({
  id: row.id,
  name: row.name,
  scopes: parseList<ApiTokenScope>(row.scopes),
  workspaceIds: parseList<string>(row.workspace_ids),
  ceiling: row.ceiling as ApiTokenCeiling,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
  hint: row.hint,
});

export class ApiTokenService {
  constructor(private readonly db: Db) {}

  /**
   * Mint a token, returning the only copy of its secret there will ever be.
   *
   * Both refusals below are refusals of a *useless* token rather than of a
   * dangerous one, and that is on purpose: a token reaching nothing, or able
   * to do nothing, is a caller who meant to say something and did not — and
   * the failure it produces later reads as a broken gateway.
   */
  create(input: MintInput, createdBy: string, now: number = Date.now()): {
    token: ApiTokenRecord;
    secret: string;
  } {
    if (input.workspaceIds.length === 0) {
      throw new Error('A token must name at least one workspace it can reach.');
    }
    if (input.scopes.length === 0) {
      throw new Error('A token must carry at least one capability.');
    }

    const id = newId('apiToken', now);
    const secret = `${PREFIX}_${id}_${generateToken(32)}`;
    const row: TokenRow = {
      id,
      name: input.name.trim(),
      token_hash: hashToken(secret),
      scopes: JSON.stringify([...new Set(input.scopes)]),
      workspace_ids: JSON.stringify([...new Set(input.workspaceIds)]),
      ceiling: input.ceiling,
      hint: secret.slice(0, HINT_LENGTH),
      created_by: createdBy,
      created_at: now,
      expires_at: now + input.expiresInDays * DAY_MS,
      last_used_at: null,
      revoked_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO api_tokens
           (id, name, token_hash, scopes, workspace_ids, ceiling, hint, created_by,
            created_at, expires_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.token_hash,
        row.scopes,
        row.workspace_ids,
        row.ceiling,
        row.hint,
        row.created_by,
        row.created_at,
        row.expires_at,
        row.last_used_at,
        row.revoked_at,
      );

    return { token: toRecord(row), secret };
  }

  /**
   * Resolve a presented value into the identity it names, or null.
   *
   * One `null` for every failure — malformed, unknown, wrong secret, revoked,
   * expired. A caller that learned *which* of those it was would learn whether
   * an id exists, which is the first half of guessing one.
   *
   * The lookup is by id and the comparison is timing-safe against the stored
   * hash, so presenting a valid secret under another row's id fails: the hash
   * covers the whole value, id included.
   */
  verify(presented: string, now: number = Date.now()): ApiTokenRecord | null {
    const id = idWithin(presented);
    if (!id) return null;

    const row = this.db
      .prepare<[string], TokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(id);
    if (!row) return null;

    if (!timingSafeEqual(row.token_hash, hashToken(presented))) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at <= now) return null;

    // Written on every accepted call. It is what makes an abandoned
    // integration visible in the listing as one nobody is using.
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);

    return toRecord({ ...row, last_used_at: now });
  }

  list(): ApiTokenRecord[] {
    return this.db
      .prepare<[], TokenRow>('SELECT * FROM api_tokens ORDER BY created_at DESC')
      .all()
      .map(toRecord);
  }

  get(id: string): ApiTokenRecord | null {
    const row = this.db
      .prepare<[string], TokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(id);
    return row ? toRecord(row) : null;
  }

  /**
   * Narrow or rename a token in place. The secret is never touched: rotating
   * it here would leave every holder of the old value authenticated as the
   * new one. Rotation is a new token and a revocation.
   */
  update(id: string, patch: UpdateInput): ApiTokenRecord | null {
    const current = this.get(id);
    if (!current) return null;
    if (patch.workspaceIds?.length === 0) {
      throw new Error('A token must name at least one workspace it can reach.');
    }
    if (patch.scopes?.length === 0) {
      throw new Error('A token must carry at least one capability.');
    }

    this.db
      .prepare(
        'UPDATE api_tokens SET name = ?, scopes = ?, workspace_ids = ?, ceiling = ? WHERE id = ?',
      )
      .run(
        patch.name?.trim() ?? current.name,
        JSON.stringify([...new Set(patch.scopes ?? current.scopes)]),
        JSON.stringify([...new Set(patch.workspaceIds ?? current.workspaceIds)]),
        patch.ceiling ?? current.ceiling,
        id,
      );

    return this.get(id);
  }

  /** Irreversible, and immediate: the next call with this value is refused. */
  revoke(id: string, now: number = Date.now()): boolean {
    const changed = this.db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, id).changes;
    return changed > 0;
  }

  /** Whether this identity may reach that workspace at all. */
  reaches(token: ApiTokenRecord, workspaceId: string): boolean {
    return token.workspaceIds.includes(workspaceId);
  }

  /** Whether this identity carries a capability. */
  can(token: ApiTokenRecord, scope: ApiTokenScope): boolean {
    return token.scopes.includes(scope);
  }
}
