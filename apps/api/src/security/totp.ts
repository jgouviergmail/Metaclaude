/**
 * TOTP (RFC 6238) and base32 (RFC 4648), implemented directly on `node:crypto`.
 *
 * Two-factor authentication is the difference between "a leaked password loses
 * my agent OS" and "a leaked password is an inconvenience", so it ships in the
 * box rather than as an optional dependency.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generate a 160-bit secret — the size recommended by RFC 4226 for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

/** Compute the TOTP code for a given time. Exported for testing determinism. */
export function totpCode(secret: string, atMs: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const period = options.periodSeconds ?? 30;
  const algorithm = options.algorithm ?? 'sha1';

  const counter = Math.floor(atMs / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, base32Decode(secret)).update(counterBuffer).digest();

  // Dynamic truncation (RFC 4226 §5.4).
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Verify a code, accepting `window` steps either side of now to tolerate clock
 * drift. The comparison is constant-time to avoid leaking digits.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: TotpOptions & { window?: number; atMs?: number } = {},
): boolean {
  const digits = options.digits ?? 6;
  const trimmed = code.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(trimmed)) return false;

  const window = options.window ?? 1;
  const now = options.atMs ?? Date.now();
  const period = options.periodSeconds ?? 30;
  const provided = Buffer.from(trimmed, 'utf8');

  let matched = false;
  for (let step = -window; step <= window; step += 1) {
    let expected: Buffer;
    try {
      expected = Buffer.from(totpCode(secret, now + step * period * 1000, options), 'utf8');
    } catch {
      return false;
    }
    // Deliberately no early exit: checking every step keeps the timing flat.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      matched = true;
    }
  }
  return matched;
}

/** Build the `otpauth://` URI that authenticator apps consume as a QR code. */
export function totpUri(params: {
  secret: string;
  account: string;
  issuer?: string;
  digits?: number;
  periodSeconds?: number;
}): string {
  const issuer = params.issuer ?? 'Metaclaude';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(params.digits ?? 6),
    period: String(params.periodSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Recovery codes for the case where the authenticator device is lost.
 * Format `xxxxx-xxxxx` from an unambiguous alphabet (no 0/O/1/I/L).
 */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j += 1) {
      if (j === 5) code += '-';
      code += alphabet[(bytes[j] as number) % alphabet.length];
    }
    codes.push(code);
  }
  return codes;
}
