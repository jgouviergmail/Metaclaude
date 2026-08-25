/**
 * Apply the stored theme before first paint.
 *
 * This must run before React mounts, or a dark-preference user sees a flash of
 * the light theme on every load. It lives in its own file rather than inline in
 * index.html because the app's Content-Security-Policy is `script-src 'self'`,
 * which blocks inline scripts — and relaxing the CSP for a cosmetic detail
 * would be the wrong trade.
 */
(function applyStoredTheme() {
  try {
    var stored = localStorage.getItem('metaclaude.theme');
    var dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (error) {
    // Private mode or blocked storage. index.html ships with `class="dark"`,
    // so the default survives.
  }
})();
