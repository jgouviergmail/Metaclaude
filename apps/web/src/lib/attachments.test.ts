/**
 * The upload plumbing the composer trusts.
 *
 * bufferToBase64 exists because `btoa(String.fromCharCode(...bytes))` throws
 * past a few hundred kilobytes of arguments — precisely the size of every
 * interesting screenshot — so the encoding must chunk, and chunking must not
 * change the answer.
 */

import { describe, expect, it } from 'vitest';
import { bufferToBase64, formatBytes } from './attachments';

describe('bufferToBase64', () => {
  it('matches btoa on something small', () => {
    const bytes = new TextEncoder().encode('hello attachments');
    expect(bufferToBase64(bytes.buffer as ArrayBuffer)).toBe(btoa('hello attachments'));
  });

  it('round-trips a buffer far larger than one chunk', () => {
    // 200 KB of a repeating non-ASCII-safe byte pattern spans many 32 KB
    // chunks; a chunking bug (overlap, gap, argument overflow) breaks the
    // round-trip or throws.
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    const decoded = atob(bufferToBase64(bytes.buffer as ArrayBuffer));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(199_999)).toBe(199_999 % 251);
    expect(decoded.charCodeAt(65_536)).toBe(65_536 % 251);
  });
});

describe('formatBytes', () => {
  it('speaks the unit a human expects', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
