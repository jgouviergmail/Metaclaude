/**
 * Every custom `@theme` family is known to `cn`, derived from the stylesheet.
 *
 * One of them was not, and it cost the whole type scale: tailwind-merge knew
 * nothing of `--text-caption`, classified the utility it generates as a text
 * *colour*, and deleted it as conflicting with the `text-muted` beside it. The
 * size never reached the DOM anywhere prose was muted — which is nearly
 * everywhere — while the ratchet counted roles in the source and reported a
 * steadily improving number.
 *
 * `lib/utils.test.ts` pins the six roles by name. This pins the *rule*: it
 * reads `styles/index.css`, enumerates the namespaces declared there, and
 * fails on any it has no assertion for. A namespace added tomorrow is a red
 * test today, rather than a silent deletion discovered by accident six lots
 * later. Same shape as the SDK narrator's test reading the installed union.
 *
 * The stylesheet is read with `readFileSync` relative to the package root:
 * `import('…?raw')` returns empty under vitest and `new URL(…, import.meta.url)`
 * is an http URL there.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cn } from './utils';

const CSS = readFileSync('src/styles/index.css', 'utf8');

/** The custom properties of every `@theme` block, by namespace. */
function themeNamespaces(): Map<string, string[]> {
  const namespaces = new Map<string, string[]>();
  for (const [, body] of CSS.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)) {
    for (const [, property] of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) {
      // `--text-display--line-height` describes `--text-display`; it generates
      // no utility of its own.
      if (property.includes('--', 2)) continue;
      const rest = property.slice(2);
      const namespace = rest.slice(0, rest.indexOf('-'));
      const name = rest.slice(rest.indexOf('-') + 1);
      namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), name]);
    }
  }
  return namespaces;
}

/**
 * The utility prefix each namespace generates, for the merge assertion.
 *
 * `bg-` for colours rather than `text-`, because `text-` is the one prefix two
 * namespaces share — which is the whole reason the scale was being eaten.
 */
const PREFIX: Record<string, string> = {
  color: 'bg-',
  text: 'text-',
  spacing: 'p-',
  font: 'font-',
  ease: 'ease-',
};

describe('every custom theme namespace is known to cn', () => {
  it('has an assertion for each namespace the stylesheet declares', () => {
    // A namespace with no entry here is not skipped: it fails. That is the
    // property that makes this test worth having — the failure mode it guards
    // against is precisely one nobody thought to look for.
    expect([...themeNamespaces().keys()].filter((ns) => !(ns in PREFIX))).toEqual([]);
  });

  it('merges two members of the same namespace, so the last one wins', () => {
    for (const [namespace, members] of themeNamespaces()) {
      if (members.length < 2) continue;
      const prefix = PREFIX[namespace]!;
      const [first, second] = members;
      const merged = cn(`${prefix}${first}`, `${prefix}${second}`);
      expect(merged, `${namespace}: ${prefix}${first} then ${prefix}${second}`).toBe(
        `${prefix}${second}`,
      );
    }
  });

  it('keeps a size beside a colour, the pair that started this', () => {
    // The two namespaces that share the `text-` prefix must NOT merge into one
    // another: a role and a colour are different properties of one element.
    const sizes = themeNamespaces().get('text') ?? [];
    const colours = themeNamespaces().get('color') ?? [];
    expect(sizes.length).toBeGreaterThan(0);
    expect(colours.length).toBeGreaterThan(0);
    for (const size of sizes) {
      for (const colour of ['ink', 'muted', 'subtle', 'accent', 'danger']) {
        expect(cn(`text-${size} text-${colour}`), `${size} + ${colour}`).toBe(
          `text-${size} text-${colour}`,
        );
      }
    }
  });
});
