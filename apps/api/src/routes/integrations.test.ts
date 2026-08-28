import { describe, expect, it } from 'vitest';

import { deployedOrigin } from './integrations.js';

/**
 * The one derivation the whole Google flow leans on, and the two facts that
 * shaped it — both measured against a live Fastify instance, not assumed:
 *
 *  - a same-origin GET carries **no Origin header** (browsers only send it on
 *    POSTs and CORS), so the status route that shows the redirect URI cannot
 *    rely on it — as first shipped it did, and the setup screen could never
 *    display the URI it exists to display;
 *  - Fastify 5 splits `hostname` from `port`, so building an origin from
 *    `request.hostname` silently drops `:8443` and the callback would send
 *    the browser back to an address the deployment does not answer on.
 */
describe('deriving this deployment’s own origin', () => {
  it('prefers the Origin header when the browser sent one', () => {
    expect(
      deployedOrigin({ origin: 'https://metaclaude.example', host: 'internal:8787', protocol: 'http' }),
    ).toBe('https://metaclaude.example');
  });

  it('falls back to protocol + Host for the requests that carry no Origin', () => {
    // The GET status route lives here: no Origin, ever.
    expect(deployedOrigin({ host: 'metaclaude.example', protocol: 'https' })).toBe(
      'https://metaclaude.example',
    );
  });

  it('keeps a non-standard port, which Origin-less reconstruction is exactly for', () => {
    expect(deployedOrigin({ host: 'metaclaude.example:8443', protocol: 'https' })).toBe(
      'https://metaclaude.example:8443',
    );
  });

  it('returns null rather than inventing an address', () => {
    expect(deployedOrigin({ protocol: 'https' })).toBeNull();
    expect(deployedOrigin({ host: '', protocol: 'https' })).toBeNull();
  });

  it('refuses an Origin that is not one', () => {
    // "null" is what browsers literally send from sandboxed contexts.
    expect(deployedOrigin({ origin: 'null', host: 'metaclaude.example', protocol: 'https' })).toBe(
      'https://metaclaude.example',
    );
  });
});
