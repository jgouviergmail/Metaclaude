/**
 * The outbound guard, which is the only thing standing between a third party's
 * metadata document and this process making a request wherever it says.
 *
 * The cases that matter are not "does it refuse 127.0.0.1" — they are the ones
 * where the address arrives *through* something: a name, an IPv4-mapped IPv6
 * literal, a second answer in a multi-address DNS reply. Each of those is a way
 * to be told a public thing and reach a private one.
 */

import { describe, expect, it } from 'vitest';
import { createOutboundGuard, isPrivateAddress } from './outbound.js';

const publicOnly = createOutboundGuard({
  resolve: async (hostname) => {
    if (hostname === 'public.test') return [{ address: '93.184.216.34' }];
    if (hostname === 'private.test') return [{ address: '10.0.0.5' }];
    if (hostname === 'metadata.test') return [{ address: '169.254.169.254' }];
    if (hostname === 'mixed.test') {
      return [{ address: '93.184.216.34' }, { address: '127.0.0.1' }];
    }
    if (hostname === 'empty.test') return [];
    throw new Error('NXDOMAIN');
  },
});

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['93.184.216.34', false],
    ['172.32.0.1', false],
    ['8.8.8.8', false],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    // An IPv4 address wearing a hat is still an IPv4 address.
    ['::ffff:127.0.0.1', true],
    ['::ffff:93.184.216.34', false],
    // The spelling `new URL()` produces for the two above. Checking only the
    // dotted form is how `http://[::ffff:127.0.0.1]/` reaches loopback past a
    // guard that refuses `http://127.0.0.1/`: the parser rewrites it in transit.
    ['::ffff:7f00:1', true],
    ['::ffff:5db8:d822', false],
    ['2606:2800:220:1:248:1893:25c8:1946', false],
    ['not-an-address', true],
  ])('judges %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it('refuses 172.16–172.31 without refusing the rest of 172', () => {
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.0.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });
});

describe('the outbound guard', () => {
  it('allows a public https endpoint', async () => {
    expect(await publicOnly('https://public.test/token')).toBe(true);
  });

  it.each([
    ['a private address behind a name', 'https://private.test/token'],
    ['the cloud metadata address behind a name', 'https://metadata.test/latest/meta-data/'],
    ['a bare loopback literal', 'http://127.0.0.1:8787/api/system'],
    ['an IPv4-mapped loopback literal', 'http://[::ffff:127.0.0.1]/x'],
    ['a name that does not resolve', 'https://nowhere.test/token'],
    ['a name that resolves to nothing', 'https://empty.test/token'],
    ['a protocol that is not http', 'file:///etc/passwd'],
    ['a URL that is not a URL', 'not a url'],
  ])('refuses %s', async (_name, url) => {
    expect(await publicOnly(url)).toBe(false);
  });

  /**
   * The one that a first-address check would let through. A resolver is free
   * to answer with several addresses, and "the first one is public" is not the
   * question — the request can go to any of them.
   */
  it('refuses a name that answers with one public and one private address', async () => {
    expect(await publicOnly('https://mixed.test/token')).toBe(false);
  });

  it('allows loopback only where the deployment asked for it', async () => {
    const dev = createOutboundGuard({ allowLoopback: true, resolve: async () => [] });
    expect(await dev('http://127.0.0.1:9000/authorize')).toBe(true);
    // And the exception is loopback alone: the rest stays refused.
    expect(await dev('http://10.0.0.5/authorize')).toBe(false);
    expect(await dev('http://169.254.169.254/latest/')).toBe(false);
  });
});
