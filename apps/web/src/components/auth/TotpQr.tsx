/**
 * The enrolment QR code, drawn in the page.
 *
 * Encoded locally with `uqr` (pure, dependency-free) and rendered as our own
 * SVG rather than an injected string: the modules become one `<path>`, which
 * compresses far better than hundreds of rect nodes.
 *
 * Deliberately exempt from the theme tokens, and the exemption is the correct
 * behaviour rather than a shortcut: a camera needs dark modules on a light
 * ground whatever the page looks like, and `text-ink` inverts in dark mode —
 * near-white modules on the white quiet zone would not scan at all. So this
 * one element paints both of its colours explicitly, like a printed label held
 * up to the screen.
 *
 * Never an external image service: CSP forbids the request, and the otpauth
 * URI embeds the shared secret — it must not leave the page.
 */

import { useMemo } from 'react';
import { encode } from 'uqr';

export function TotpQr({ uri }: { uri: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(uri, { ecc: 'M', border: 2 });
    // One subpath per dark module. Crude but tiny, and a path compresses far
    // better than hundreds of <rect> nodes.
    let d = '';
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { path: d, size: qr.size };
  }, [uri]);

  return (
    <div
      role="img"
      aria-label="QR code — scan it with your authenticator app"
      className="inline-block rounded-lg border border-line bg-white p-2"
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="block size-44"
        shapeRendering="crispEdges"
        aria-hidden
      >
        <path d={path} fill="#111111" />
      </svg>
    </div>
  );
}
