/**
 * Whether this deployment may make an HTTP request to a URL it was given.
 *
 * The MCP OAuth flow takes URLs from a third party — an authorization server's
 * metadata names its own token and registration endpoints — and then sends an
 * authorization code and a PKCE verifier to them. A server that names
 * `http://127.0.0.1:8787/api/...` or `http://169.254.169.254/latest/meta-data/`
 * would have this process attack itself, and its answer would be relayed back
 * to whoever asked. That is the whole of SSRF, and a URL allowlist is not the
 * defence: the name is not the address.
 *
 * So this resolves the name and judges the *addresses*, and it is called
 * immediately before each request rather than once when a server was
 * registered. The gap between the two is a TOCTOU window: DNS can move, and a
 * name that resolved publicly at registration can resolve to loopback at the
 * moment the code is redeemed. Re-resolving costs one lookup.
 *
 * Two limits, stated rather than papered over. A resolver that answers
 * differently for this check than for the request that follows can still slip
 * through — closing that needs the socket to be pinned to the address that was
 * judged, which Node's fetch does not expose. And a public address that
 * *proxies* to a private one is invisible from here. Both are beyond what a
 * pre-flight check can promise; what it does promise is that the obvious
 * shapes — loopback, link-local, the RFC 1918 ranges, unique-local IPv6 — are
 * refused, including when they arrive through a name.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Only these two reach the network at all. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Ranges no outbound request from this process may reach.
 *
 * Link-local is here for 169.254.169.254 specifically — the cloud metadata
 * address, which is the single most valuable target an SSRF has.
 */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable is not provably public
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 carrier NAT
  if (a === 192 && b === 0) return true; // RFC 6890 special-purpose
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? '';
  if (value === '::' || value === '::1') return true; // unspecified, loopback
  if (value.startsWith('fe80')) return true; // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique-local
  if (value.startsWith('ff')) return true; // multicast
  // IPv4-mapped is an IPv4 address wearing a hat, and it arrives in two
  // spellings: as written (`::ffff:127.0.0.1`) and as `new URL()` normalises
  // it (`::ffff:7f00:1`). Only checking the dotted form is how
  // `http://[::ffff:127.0.0.1]/` reaches loopback through a guard that refuses
  // `http://127.0.0.1/` — the URL parser rewrites it on the way past.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) return isPrivateIPv4(dotted[1]!);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return isPrivateIPv4(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
    );
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // not an address at all
}

export interface OutboundGuardDeps {
  /** Injected so the tests never touch a resolver. */
  resolve?: (hostname: string) => Promise<{ address: string }[]>;
  /**
   * Loopback is refused in production and allowed in development, because the
   * only way to exercise this flow locally is against a server on this
   * machine. It is a deliberate, single, named exception rather than a
   * general relaxation: everything else stays refused in both.
   */
  allowLoopback?: boolean;
}

/**
 * A guard bound to its dependencies.
 *
 * Returns a predicate rather than exporting a bare function so the resolver
 * and the loopback exception are injected once, at composition, and every
 * caller then asks the same question the same way.
 */
export function createOutboundGuard(deps: OutboundGuardDeps = {}) {
  const resolve =
    deps.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));

  return async function isSafeEndpoint(raw: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.length === 0) return false;

    // A literal address needs no resolver, and must not get one: `lookup` on
    // an IP happily echoes it back, which would make the two paths differ for
    // no reason.
    if (isIP(hostname) !== 0) {
      if (deps.allowLoopback && isLoopback(hostname)) return true;
      return !isPrivateAddress(hostname);
    }

    let addresses: { address: string }[];
    try {
      addresses = await resolve(hostname);
    } catch {
      // A name that does not resolve is not a name we send secrets to.
      return false;
    }
    if (addresses.length === 0) return false;

    // *Every* address, not the first: a name that answers with one public and
    // one private address is a name being used to smuggle the private one.
    return addresses.every(({ address }) =>
      deps.allowLoopback && isLoopback(address) ? true : !isPrivateAddress(address),
    );
  };
}

function isLoopback(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith('127.');
  if (family === 6) return address === '::1';
  return false;
}
