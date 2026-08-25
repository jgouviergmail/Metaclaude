import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  totpCode,
  totpUri,
  verifyTotp,
} from './totp.js';

/** RFC 4226 / 6238 reference secret "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('matches the RFC 4648 §10 test vectors (unpadded)', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
    }
  });

  it('decodes the RFC 4648 vectors back to the original bytes', () => {
    const vectors: Array<[string, string]> = [
      ['MY======', 'f'],
      ['MZXQ====', 'fo'],
      ['MZXW6===', 'foo'],
      ['MZXW6YQ=', 'foob'],
      ['MZXW6YTB', 'fooba'],
      ['MZXW6YTBOI======', 'foobar'],
    ];
    for (const [encoded, plain] of vectors) {
      expect(base32Decode(encoded).toString('ascii')).toBe(plain);
    }
  });

  it('round-trips arbitrary byte strings of every length modulo 5', () => {
    for (let length = 0; length <= 21; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('is case-insensitive and tolerates padding and whitespace', () => {
    expect(base32Decode('mzxw6ytboi').toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW6YTBOI======').toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW 6YTB OI').toString('ascii')).toBe('foobar');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrow(/Invalid base32 character/);
    expect(() => base32Decode('!!!!')).toThrow(/Invalid base32 character/);
  });

  it('generates a 160-bit secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe('totpCode', () => {
  it('reproduces the RFC 6238 SHA-1 reference codes', () => {
    // RFC 6238 Appendix B publishes 8-digit values; the low 6 digits are the
    // 6-digit code for the same counter.
    const cases: Array<[number, string]> = [
      [59_000, '94287082'],
      [1_111_111_109_000, '07081804'],
      [1_111_111_111_000, '14050471'],
      [1_234_567_890_000, '89005924'],
      [2_000_000_000_000, '69279037'],
    ];
    for (const [atMs, eightDigits] of cases) {
      expect(totpCode(RFC_SECRET, atMs, { digits: 8 })).toBe(eightDigits);
      expect(totpCode(RFC_SECRET, atMs)).toBe(eightDigits.slice(-6));
    }
  });

  it('is deterministic for a fixed secret and timestamp', () => {
    const at = 1_700_000_000_000;
    const first = totpCode(RFC_SECRET, at);
    expect(totpCode(RFC_SECRET, at)).toBe(first);
    expect(first).toMatch(/^\d{6}$/);
  });

  it('is constant across a 30-second step and changes at the boundary', () => {
    const stepStart = 1_700_000_010_000; // Exactly divisible by 30 000.
    expect(stepStart % 30_000).toBe(0);
    const code = totpCode(RFC_SECRET, stepStart);
    expect(totpCode(RFC_SECRET, stepStart + 29_999)).toBe(code);
    expect(totpCode(RFC_SECRET, stepStart + 30_000)).not.toBe(code);
  });

  it('depends on the secret', () => {
    const other = base32Encode(Buffer.from('09876543210987654321', 'ascii'));
    expect(totpCode(other, 59_000)).not.toBe(totpCode(RFC_SECRET, 59_000));
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_010_000;

  it('accepts the current code', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), { atMs: now })).toBe(true);
  });

  it('accepts codes one step either side of now (clock drift)', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), { atMs: now })).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), { atMs: now })).toBe(true);
  });

  it('rejects codes outside the ±1 step window', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 60_000), { atMs: now })).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 60_000), { atMs: now })).toBe(false);
  });

  it('honours a widened window', () => {
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 60_000), { atMs: now, window: 2 }),
    ).toBe(true);
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 90_000), { atMs: now, window: 2 }),
    ).toBe(false);
  });

  it('honours window: 0 (current step only)', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), { atMs: now, window: 0 })).toBe(true);
    expect(
      verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), { atMs: now, window: 0 }),
    ).toBe(false);
  });

  it('tolerates surrounding whitespace on the submitted code', () => {
    expect(verifyTotp(RFC_SECRET, `  ${totpCode(RFC_SECRET, now)} `, { atMs: now })).toBe(true);
  });

  it('rejects non-numeric, short, long and empty input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '12345a', '  ', '-12345']) {
      expect(verifyTotp(RFC_SECRET, bad, { atMs: now })).toBe(false);
    }
  });

  it('rejects a code of the wrong digit count for the configured digits', () => {
    const eight = totpCode(RFC_SECRET, now, { digits: 8 });
    expect(verifyTotp(RFC_SECRET, eight, { atMs: now })).toBe(false);
    expect(verifyTotp(RFC_SECRET, eight, { atMs: now, digits: 8 })).toBe(true);
  });

  it('returns false rather than throwing when the stored secret is unusable', () => {
    expect(verifyTotp('not-valid-base32!!', '123456', { atMs: now })).toBe(false);
  });

  it('rejects a code generated from a different secret', () => {
    const other = base32Encode(Buffer.from('09876543210987654321', 'ascii'));
    expect(verifyTotp(RFC_SECRET, totpCode(other, now), { atMs: now })).toBe(false);
  });
});

describe('totpUri', () => {
  it('builds an otpauth URI an authenticator app can consume', () => {
    const uri = totpUri({ secret: 'ABCDEFGH', account: 'jules@example.com' });
    expect(uri.startsWith('otpauth://totp/Metaclaude:jules%40example.com?')).toBe(true);

    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.searchParams.get('secret')).toBe('ABCDEFGH');
    expect(parsed.searchParams.get('issuer')).toBe('Metaclaude');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });

  it('percent-encodes a custom issuer in both the label and the query', () => {
    const uri = totpUri({
      secret: 'ABCDEFGH',
      account: 'a b',
      issuer: 'My Org/Team',
      digits: 8,
      periodSeconds: 60,
    });
    expect(uri).toContain('otpauth://totp/My%20Org%2FTeam:a%20b?');
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('issuer')).toBe('My Org/Team');
    expect(parsed.searchParams.get('digits')).toBe('8');
    expect(parsed.searchParams.get('period')).toBe('60');
  });
});

describe('generateRecoveryCodes', () => {
  it('produces the requested number of xxxxx-xxxxx codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
      expect(code).toHaveLength(11);
    }
    expect(generateRecoveryCodes(3)).toHaveLength(3);
    expect(generateRecoveryCodes(0)).toHaveLength(0);
  });

  it('excludes the visually ambiguous characters 0 O 1 I L', () => {
    const joined = generateRecoveryCodes(50).join('');
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(joined.includes(ambiguous)).toBe(false);
    }
  });

  it('produces unique codes', () => {
    const codes = generateRecoveryCodes(200);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
