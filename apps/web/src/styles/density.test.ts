/**
 * The density contract, tested at the only two levels that can carry it.
 *
 * happy-dom cannot parse what Tailwind v4 emits — `@layer`, CSS nesting and
 * `@custom-variant` each break the whole sheet — so no test here can load the
 * app's real stylesheet and read a computed value off a component. Measured,
 * not assumed. What remains is worth having, and is not a proxy:
 *
 *  1. The declaration itself, read out of `index.css`. Every density token must
 *     exist in the compact block AND in the comfortable one. A token declared
 *     in only one of them is the classic bug — the value silently falls back to
 *     the other density and nothing looks wrong until someone measures.
 *  2. The switch, driven through the real CSSOM. A custom property redefined
 *     under `[data-density]` does resolve in this engine (verified: 8px → 14px),
 *     so the mechanism the whole feature rests on is genuinely exercised rather
 *     than assumed to work.
 *
 * What neither level covers: whether a component actually consumes the token.
 * That is what the `literalTextSizes` ratchet measures, and while it stands
 * still the comfortable density is decorative on the screens not yet migrated.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

// Relative to the package root, which is where vitest runs from. `?raw`
// imports and `new URL(…, import.meta.url)` both come back empty here.
const css = readFileSync('src/styles/index.css', 'utf8');

/** The tokens density owns. Adding one here fails until it is declared twice. */
const DENSITY_TOKENS = ['--mc-text-body', '--mc-pad-x', '--mc-section-gap', '--mc-stack'];

/**
 * A token nothing reads is dead code that this test would pass on, so the list
 * above is held to what the app actually consumes. Row height and section
 * rhythm arrive with the primitives that need them.
 */

/** Everything between `selector {` and its closing brace, at nesting depth 0. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i);
    }
  }
  return '';
}

describe('the density tokens are declared for both densities', () => {
  const compact = block(':root');
  const comfortable = block(":root[data-density='comfortable']");

  it('declares the comfortable block at all', () => {
    expect(comfortable).not.toBe('');
  });

  for (const token of DENSITY_TOKENS) {
    it(`declares ${token} in the default block and overrides it when comfortable`, () => {
      expect(compact).toContain(`${token}:`);
      expect(comfortable).toContain(`${token}:`);
    });
  }

  it('gives comfortable a different value, or the setting does nothing', () => {
    for (const token of DENSITY_TOKENS) {
      const value = (text: string): string =>
        text.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
      expect(value(comfortable), token).not.toBe(value(compact));
      expect(value(comfortable), token).not.toBe('');
    }
  });
});

describe('the switch resolves in the CSSOM', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-density');
    document.head.querySelectorAll('style[data-test]').forEach((el) => el.remove());
  });

  it('changes what a component would read, without the component knowing', () => {
    const sheet = document.createElement('style');
    sheet.dataset.test = 'density';
    // The shape of the real declaration, not the real file: Tailwind's output
    // is unparseable here, so this exercises the mechanism the file relies on.
    sheet.textContent =
      ":root{--mc-row-h:32px}:root[data-density='comfortable']{--mc-row-h:40px}";
    document.head.append(sheet);

    const read = (): string =>
      getComputedStyle(document.documentElement).getPropertyValue('--mc-row-h').trim();

    expect(read()).toBe('32px');
    document.documentElement.setAttribute('data-density', 'comfortable');
    expect(read()).toBe('40px');
    document.documentElement.setAttribute('data-density', 'compact');
    expect(read()).toBe('32px');
  });
});

/**
 * The help that comfortable shows and compact hides.
 *
 * Until this existed the setting changed a font size and a padding, while its
 * own copy promised « l'aide toujours affichée ». A rule rather than a prop:
 * no component has to know the density, and a screen opts in by naming it.
 */
describe('the density-dependent help', () => {
  it('is declared for both densities, or it only ever hides', () => {
    expect(css).toContain('.help-comfortable {');
    expect(css).toMatch(/:root\[data-density='comfortable'\] \.help-comfortable/);
  });

  it('hides by default and shows when comfortable', () => {
    const sheet = document.createElement('style');
    sheet.dataset.test = 'help';
    sheet.textContent =
      ".help-comfortable{display:none}:root[data-density='comfortable'] .help-comfortable{display:block}";
    document.head.append(sheet);
    const help = document.createElement('p');
    help.className = 'help-comfortable';
    document.body.append(help);

    expect(getComputedStyle(help).display).toBe('none');
    document.documentElement.setAttribute('data-density', 'comfortable');
    help.setAttribute('data-nudge', '1'); // a mutation invalidates the style cache
    expect(getComputedStyle(help).display).toBe('block');
  });
});

