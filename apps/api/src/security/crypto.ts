/**
 * Cryptographic primitives.
 *
 * Everything here is built on `node:crypto` — no native addons, no third-party
 * crypto. Fewer moving parts means fewer supply-chain and build-time risks, and
 * the primitives we need (scrypt, AES-256-GCM, HMAC-SHA1/256) are all built in.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt work factors.
 *
 * N=2^16, r=8, p=1 costs ~64 MiB and ~100 ms on modern hardware — comfortably
 * above the OWASP floor while staying responsive for interactive login on the
 * small VPS this typically runs on. `maxmem` must exceed 128 * N * r.
 */
export const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1, keylen: 64, maxmem: 192 * 1024 * 1024 };

/** Constant-time comparison that tolerates length mismatch without leaking it. */
export function timingSafeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  // Hash first so both operands are the same length; this keeps the comparison
  // constant-time even when the inputs differ in size.
  const hashA = createHash('sha256').update(bufA).digest();
  const hashB = createHash('sha256').update(bufB).digest();
  return nodeTimingSafeEqual(hashA, hashB);
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hash a password. The encoded form is self-describing:
 *   `scrypt$N$r$p$<salt-b64>$<hash-b64>`
 * so parameters can be raised later without invalidating existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const { N, r, p, keylen, maxmem } = SCRYPT_PARAMS;
  const derived = await scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a password against an encoded hash. Never throws on malformed input. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row — they would be a DoS vector.
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_PARAMS.maxmem, 256 * N * r),
    });
    return derived.length === expected.length && nodeTimingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was produced with weaker parameters than current. */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_PARAMS.N;
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/** 256 bits of CSPRNG entropy, base64url encoded. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash a bearer-style token for storage.
 *
 * Plain SHA-256 is correct here (unlike for passwords): the token already has
 * full entropy, so there is nothing to brute-force, and we need the lookup to
 * be fast enough to run on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/* -------------------------------------------------------------------------- */
/* Symmetric encryption (secret vault)                                         */
/* -------------------------------------------------------------------------- */

export interface SealedBox {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * AES-256-GCM with a random 96-bit IV.
 *
 * `aad` binds the ciphertext to its logical location (scope + key), so a row
 * cannot be moved to a different slot without detection.
 */
export function seal(key: Buffer, plaintext: string, aad?: string): SealedBox {
  if (key.length !== 32) throw new Error('seal: key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Returns `null` when authentication fails — a tampered or misplaced record. */
export function open(key: Buffer, box: SealedBox, aad?: string): string | null {
  if (key.length !== 32) throw new Error('open: key must be 32 bytes');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, box.iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(box.tag);
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Hashing helpers                                                             */
/* -------------------------------------------------------------------------- */

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(key: Buffer | string, message: string | Buffer): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

export { randomBytes };
