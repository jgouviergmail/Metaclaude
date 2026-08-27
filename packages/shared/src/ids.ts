/**
 * Identifier helpers.
 *
 * Metaclaude uses prefixed, sortable, URL-safe identifiers so that an id is
 * self-describing in logs, URLs and the audit trail. The random component uses
 * the platform CSPRNG (`crypto.getRandomValues`), available in both Node 22 and
 * every browser we target.
 */

/** Crockford base32 alphabet — no I, L, O, U (avoids visual/typing ambiguity). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIXES = {
  user: 'usr',
  authSession: 'as',
  workspace: 'ws',
  session: 'ses',
  run: 'run',
  event: 'ev',
  memory: 'mem',
  skill: 'skl',
  agent: 'agt',
  mcpServer: 'mcp',
  automation: 'aut',
  approval: 'apr',
  task: 'tsk',
  taskComment: 'tsc',
  taskEvent: 'tse',
  artifact: 'art',
  attachment: 'att',
  secret: 'sec',
  audit: 'aud',
  insight: 'ins',
  policyArm: 'pol',
  plugin: 'plg',
  exemplar: 'exm',
  marketplace: 'mkt',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // `bytes[i]` is always defined for i < length; the mask keeps it in range.
    out += ALPHABET[(bytes[i] as number) & 31];
  }
  return out;
}

/**
 * Encode a millisecond timestamp as 10 base32 characters (ULID-compatible
 * layout). Lexicographic ordering of the encoded string matches chronological
 * ordering, which makes ids sortable in SQL without a separate index.
 */
function encodeTime(ms: number): string {
  let remaining = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** Create a new prefixed, time-sortable id, e.g. `run_01J8ZQ...`. */
export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${encodeTime(now)}${randomChars(12)}`;
}

/** True when `id` is a well-formed identifier of the given kind. */
export function isId(kind: IdKind, id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!id.startsWith(prefix)) return false;
  const body = id.slice(prefix.length);
  if (body.length !== 22) return false;
  for (const ch of body) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Extract the creation timestamp encoded in an id, or `null` if malformed. */
export function idTimestamp(id: string): number | null {
  const body = id.slice(id.indexOf('_') + 1);
  if (body.length < 10) return null;
  let ms = 0;
  for (let i = 0; i < 10; i += 1) {
    const index = ALPHABET.indexOf(body[i] as string);
    if (index < 0) return null;
    ms = ms * 32 + index;
  }
  return ms;
}
