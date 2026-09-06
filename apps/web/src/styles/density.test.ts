/**
 * The density rules, read from the stylesheet they live in.
 *
 * `.help-comfortable` hides prose that the compact density does not show. It
 * was written as a bare class — one point of specificity, exactly like
 * `.block` — and Tailwind emits its utilities *after* this file, so any element
 * carrying both was visible in every density. Silently: the class is on the
 * element, a test asserting the class passes, and the prose is on screen
 * anyway. It shipped that way on the dashboard's checklist and only a
 * screenshot showed it.
 *
 * happy-dom has no cascade resolution to ask, so what a test can hold is the
 * *shape* of the selector — the same reasoning as the touch-target contracts.
 * The file is read with `readFileSync` relative to the package root, because
 * `import('…?raw')` returns empty under vitest.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Comments first: a docblock before a rule is otherwise read as part of its
// selector, which made the first version of this report three rules and a
// selector beginning with a slash.
const CSS = readFileSync('src/styles/index.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors of every rule mentioning a class, in source order. */
function selectorsFor(className: string): string[] {
  const found: string[] = [];
  for (const rule of CSS.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    // A capture is `string | undefined` to the compiler even where the pattern
    // makes it certain. The guard is for `tsc`, which vitest never runs.
    const selector = rule[1];
    if (!selector) continue;
    const text = selector.trim();
    if (text.includes(className)) found.push(text.replace(/\s+/g, ' '));
  }
  return found;
}

describe('the density-only help rule', () => {
  it('exists in both directions, so the class is not one-way', () => {
    const selectors = selectorsFor('.help-comfortable');
    expect(selectors.length).toBe(2);
  });

  it('is scoped to the root, which is what makes the pair symmetric', () => {
    // Not a defence against a utility: raising specificity cannot win against
    // one. Tailwind emits its utilities in a *later cascade layer*, and a later
    // layer beats any specificity — measured, after a first attempt that raised
    // the specificity and changed nothing on screen. What keeps the class
    // working is that nothing puts a display utility beside it, which
    // `deploy/ratchets.mjs` refuses. This only holds the two halves in the same
    // shape so one cannot drift.
    for (const selector of selectorsFor('.help-comfortable')) {
      expect(selector, selector).toMatch(/^:root/);
    }
  });

  it('hides by default rather than only under an explicit compact stamp', () => {
    // The pre-paint script stamps a density, but a browser that has never seen
    // it — a fresh profile, a blocked localStorage — stamps nothing, and the
    // default is compact. A rule keyed on `[data-density='compact']` would show
    // the prose to exactly those readers.
    const hiding = selectorsFor('.help-comfortable').find((selector) =>
      selector.includes(':not('),
    );
    expect(hiding).toBeDefined();
    expect(hiding).toContain("not([data-density='comfortable'])");
  });
});
