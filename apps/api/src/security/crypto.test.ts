import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SCRYPT_PARAMS,
  generateToken,
  hashPassword,
  hashToken,
  hmacSha256,
  needsRehash,
  open,
  seal,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from './crypto.js';

/**
 * scrypt with N=2^16 costs ~100 ms per derivation, so this file deliberately
 * shares a single hash across the password tests and keeps the number of full
 * cost derivations in the single digits.
 */
const PASSWORD = 'correct horse battery staple';
let encoded: string;

beforeAll(async () => {
  encoded = await hashPassword(PASSWORD);
}, 30_000);

describe('hashPassword / verifyPassword', () => {
  it('produces a self-describing encoded hash carrying the current parameters', () => {
    const parts = encoded.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBe(SCRYPT_PARAMS.N);
    expect(Number(parts[2])).toBe(SCRYPT_PARAMS.r);
    expect(Number(parts[3])).toBe(SCRYPT_PARAMS.p);
    // 32-byte salt and 64-byte derived key, base64 encoded.
    expect(Buffer.from(parts[4] as string, 'base64')).toHaveLength(32);
    expect(Buffer.from(parts[5] as string, 'base64')).toHaveLength(SCRYPT_PARAMS.keylen);
  });

  it('round-trips the correct password and rejects a wrong one', async () => {
    await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(true);
    await expect(verifyPassword(`${PASSWORD}!`, encoded)).resolves.toBe(false);
  }, 30_000);

  it('normalises unicode so equivalent NFC/NFD spellings verify identically', async () => {
    // "\u00e9" as a single code point vs "e" + combining acute (U+0301).
    // hashPassword/verifyPassword both apply NFKC, so the two must agree.
    const composed = 'caf\u00e9-passphrase-x';
    const decomposed = 'cafe\u0301-passphrase-x';
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFKC')).toBe(decomposed.normalize('NFKC'));
    const hash = await hashPassword(composed);
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
  }, 30_000);

  it('returns false rather than throwing on malformed encoded hashes', async () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$65536$8$1$onlyfiveparts',
      'bcrypt$65536$8$1$c2FsdA==$aGFzaA==',
      'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',
      'scrypt$65536$8$1$$aGFzaA==',
      'scrypt$65536$8$1$c2FsdA==$',
      'scrypt$65536$8$1$c2FsdA==$aGFzaA==$extra',
    ];
    for (const candidate of malformed) {
      await expect(verifyPassword(PASSWORD, candidate)).resolves.toBe(false);
    }
  });

  it('refuses absurd work factors from a tampered row without running scrypt', async () => {
    const parts = encoded.split('$');
    const withParams = (n: string, r: string, p: string): string =>
      [parts[0], n, r, p, parts[4], parts[5]].join('$');

    // Below the floor, above the ceiling, and non-integers are all rejected.
    await expect(verifyPassword(PASSWORD, withParams('512', '8', '1'))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withParams(String(1 << 21), '8', '1'))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withParams('65536', '0', '1'))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withParams('65536', '64', '1'))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withParams('65536', '8', '0'))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withParams('65536', '8', '99'))).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, withParams('65536.5', '8', '1'))).resolves.toBe(false);
  });

  it('fails verification when the parameters are changed to a legal-but-different value', async () => {
    // N is inside the accepted range, so scrypt runs — but with a different work
    // factor it derives a different key and must not authenticate.
    const parts = encoded.split('$');
    const retuned = [parts[0], '2048', parts[2], parts[3], parts[4], parts[5]].join('$');
    await expect(verifyPassword(PASSWORD, retuned)).resolves.toBe(false);
  }, 30_000);

  it('fails verification when the stored digest is tampered with', async () => {
    const parts = encoded.split('$');
    const digest = Buffer.from(parts[5] as string, 'base64');
    digest[0] = (digest[0] as number) ^ 0xff;
    const tampered = [...parts.slice(0, 5), digest.toString('base64')].join('$');
    await expect(verifyPassword(PASSWORD, tampered)).resolves.toBe(false);
  }, 30_000);
});

describe('needsRehash', () => {
  it('is false for a freshly produced hash', () => {
    expect(needsRehash(encoded)).toBe(false);
  });

  it('is true for a hash produced with a weaker N', () => {
    const parts = encoded.split('$');
    const weaker = [parts[0], String(SCRYPT_PARAMS.N >> 2), ...parts.slice(2)].join('$');
    expect(needsRehash(weaker)).toBe(true);
  });

  it('is true for anything it cannot parse or that is not scrypt', () => {
    expect(needsRehash('')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
    expect(needsRehash('argon2$65536$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });
});

describe('timingSafeEqual', () => {
  it('compares equal values as equal regardless of representation', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true);
    expect(timingSafeEqual(Buffer.from('hello'), 'hello')).toBe(true);
    expect(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('rejects different values, including ones of different lengths', () => {
    expect(timingSafeEqual('hello', 'hellp')).toBe(false);
    expect(timingSafeEqual('hello', 'hello ')).toBe(false);
    expect(timingSafeEqual('short', 'a much longer string entirely')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
  });
});

describe('generateToken / hashToken', () => {
  it('generates URL-safe tokens of the requested entropy', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url characters, unpadded.
    expect(token).toHaveLength(43);
    expect(generateToken(16)).toHaveLength(22);
  });

  it('generates a different token every time', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateToken()));
    expect(tokens.size).toBe(64);
  });

  it('hashes deterministically, url-safely, and differently per input', () => {
    const a = hashToken('token-a');
    expect(hashToken('token-a')).toBe(a);
    expect(hashToken('token-b')).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 → 32 bytes → 43 base64url characters.
    expect(a).toHaveLength(43);
  });
});

describe('seal / open', () => {
  const key = randomBytes(32);

  it('round-trips a plaintext', () => {
    const box = seal(key, 'hunter2');
    expect(box.iv).toHaveLength(12);
    expect(box.tag).toHaveLength(16);
    expect(box.ciphertext.toString('utf8')).not.toBe('hunter2');
    expect(open(key, box)).toBe('hunter2');
  });

  it('round-trips with additional authenticated data', () => {
    const box = seal(key, 'hunter2', 'mcp:GITHUB_TOKEN');
    expect(open(key, box, 'mcp:GITHUB_TOKEN')).toBe('hunter2');
  });

  it('uses a fresh IV per call, so identical plaintexts differ on the wire', () => {
    const a = seal(key, 'same');
    const b = seal(key, 'same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('returns null when the ciphertext is tampered with', () => {
    const box = seal(key, 'hunter2');
    const ciphertext = Buffer.from(box.ciphertext);
    ciphertext[0] = (ciphertext[0] as number) ^ 0x01;
    expect(open(key, { ...box, ciphertext })).toBeNull();
  });

  it('returns null when the auth tag is tampered with', () => {
    const box = seal(key, 'hunter2');
    const tag = Buffer.from(box.tag);
    tag[0] = (tag[0] as number) ^ 0x01;
    expect(open(key, { ...box, tag })).toBeNull();
  });

  it('returns null when the AAD does not match (a record moved to another slot)', () => {
    const box = seal(key, 'hunter2', 'mcp:GITHUB_TOKEN');
    expect(open(key, box, 'mcp:OTHER_TOKEN')).toBeNull();
    expect(open(key, box)).toBeNull();
  });

  it('returns null when sealed without AAD but opened with one', () => {
    const box = seal(key, 'hunter2');
    expect(open(key, box, 'mcp:GITHUB_TOKEN')).toBeNull();
  });

  it('returns null under the wrong key', () => {
    const box = seal(key, 'hunter2');
    expect(open(randomBytes(32), box)).toBeNull();
  });

  it('throws on a key of the wrong size rather than silently weakening', () => {
    expect(() => seal(randomBytes(16), 'x')).toThrow(/32 bytes/);
    const box = seal(key, 'x');
    expect(() => open(randomBytes(16), box)).toThrow(/32 bytes/);
  });
});

describe('hashing helpers', () => {
  it('sha256Hex matches the well-known digest of the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });

  it('hmacSha256 matches RFC 4231 test case 1', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(hmacSha256(key, 'Hi There').toString('hex')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});
