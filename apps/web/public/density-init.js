/**
 * Apply the stored density before first paint.
 *
 * Same reasoning as theme-init.js, and the same constraint: the app's
 * Content-Security-Policy is `script-src 'self'`, so this cannot be inline in
 * index.html. Without it the rows resize under the reader a frame after load,
 * which is more distracting than the theme flash it sits beside.
 */
(function applyStoredDensity() {
  try {
    var stored = localStorage.getItem('metaclaude.density');
    document.documentElement.setAttribute(
      'data-density',
      stored === 'comfortable' ? 'comfortable' : 'compact',
    );
  } catch (error) {
    // Private mode or blocked storage: the stylesheet's default is compact.
  }
})();
