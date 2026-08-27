import { describe, expect, it } from 'vitest';
import { isCeremonyCancelled, isIpHost } from './passkeys';

describe('isIpHost', () => {
  it('recognises the addresses a passkey cannot be scoped to', () => {
    expect(isIpHost('203.0.113.7')).toBe(true);
    expect(isIpHost('[2001:db8::1]')).toBe(true); // location.hostname keeps the brackets
    expect(isIpHost('::1')).toBe(true);
  });

  it('leaves domains alone, including ones that merely start with digits', () => {
    expect(isIpHost('claude.home.arpa')).toBe(false);
    expect(isIpHost('localhost')).toBe(false);
    // Every label must be numeric for IPv4 — a domain suffix makes it a name.
    expect(isIpHost('10.0.0.7.example')).toBe(false);
  });
});

describe('isCeremonyCancelled', () => {
  it('treats the browser dismissal errors as a choice, everything else as a failure', () => {
    const cancelled = new Error('The operation either timed out or was not allowed.');
    cancelled.name = 'NotAllowedError';
    expect(isCeremonyCancelled(cancelled)).toBe(true);
    expect(isCeremonyCancelled(new Error('network down'))).toBe(false);
    expect(isCeremonyCancelled('not even an error')).toBe(false);
  });
});
