/**
 * Service worker.
 *
 * Deliberately minimal, and deliberately network-first for anything dynamic.
 *
 * The failure mode of an over-eager service worker on a tool like this is
 * severe: a cached transcript or a cached API response would show the operator
 * stale state about what their agent is doing, which is worse than showing
 * nothing. So the rules are:
 *
 *   - API requests: never cached, never intercepted. Always the network.
 *   - Hashed build assets: cache-first, since their name changes on every build.
 *   - The app shell: network-first with a cache fallback, so a cold start with
 *     no connection still renders something rather than a browser error page.
 */

const VERSION = 'v1';
const SHELL_CACHE = `metaclaude-shell-${VERSION}`;
const ASSET_CACHE = `metaclaude-assets-${VERSION}`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `addAll` rejects wholesale if any single URL fails, which would leave
      // the worker uninstalled; adding individually degrades gracefully.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept the API or the WebSocket. Live state must be live.
  if (url.pathname.startsWith('/api/')) return;

  // Build assets carry a content hash, so a cache hit is always correct.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else is the shell: prefer the network so a deploy is picked up
  // immediately, and fall back to the cache only when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A client-side route has no cache entry of its own; serve the shell
        // and let the router resolve the path.
        const shell = await caches.match('/index.html');
        if (shell) return shell;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }),
  );
});
