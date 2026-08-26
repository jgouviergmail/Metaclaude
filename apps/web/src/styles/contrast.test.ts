/**
 * WCAG contrast, measured from the stylesheet rather than asserted about it.
 *
 * The filled buttons carried a hard-coded `text-white`, which fails AA on three
 * of the four theme/state combinations — 2.33:1 for white on the dark green.
 * Nothing caught it: the `rawPaletteClasses` ratchet exists because
 * a raw palette class such as `bg-gray-<n>` breaks the *light* theme, and three of these four failures are
 * in the dark one, so it was never the guard for this and could not have been.
 *
 * The tokens are OKLCH, so the conversion has to happen here. It is short, and
 * doing it in the test rather than trusting a table means a token edited to a
 * new lightness is re-measured rather than re-asserted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8');

/** OKLCH → linear sRGB. The standard matrices, clamped into gamut. */
function oklchToLinearSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

function parse(value: string): [number, number, number] {
  const match = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
  if (!match) throw new Error(`not an oklch() value: ${value}`);
  return oklchToLinearSrgb(Number(match[1]) / 100, Number(match[2]), Number(match[3]));
}

/**
 * Read a token from a specific block. The light values are on bare `:root` and
 * the dark ones override them under `.dark`, so a naive whole-file grep returns
 * whichever comes first and would silently measure the light theme twice.
 */
function token(name: string, theme: 'light' | 'dark'): string {
  // Anchored on the rule at the start of a line, not on the first `.dark`
  // anywhere: `@custom-variant dark (...)` appears sixty lines earlier, and
  // slicing there put the whole `:root` block on the dark side of the cut — so
  // both themes measured the same values and every assertion still passed.
  const darkAt = css.search(/^\.dark\s*\{/m);
  const rootAt = css.search(/^:root\s*\{/m);
  if (darkAt < 0 || rootAt < 0) throw new Error('cannot locate the :root / .dark blocks');

  const scope = theme === 'dark' ? css.slice(darkAt) : css.slice(rootAt, darkAt);
  const match = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(scope);
  if (!match) throw new Error(`token --${name} not found in the ${theme} block`);
  return match[1]!;
}

/** AA for normal text. The filled buttons render at 13px, so this is the bar. */
const AA = 4.5;

describe('button surfaces meet WCAG AA in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const state of ['success', 'danger', 'accent'] as const) {
      const surface = state === 'accent' ? 'mc-accent' : `mc-${state}`;
      const text = state === 'accent' ? 'mc-accent-text' : `mc-${state}-text`;

      it(`${theme}: ${state} text on ${state} surface`, () => {
        const ratio = contrast(token(text, theme), token(surface, theme));
        expect(ratio).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  it('reproduces the failure the tokens replaced', () => {
    // A control for the six cases above: without it, a bug in this file's
    // colour maths could pass everything and prove nothing. White on the dark
    // green is the worst of the four combinations `text-white` produced.
    const white = 'oklch(100% 0 0)';
    expect(contrast(white, token('mc-success', 'dark'))).toBeLessThan(3);
    expect(contrast(white, token('mc-success', 'light'))).toBeLessThan(AA);
    expect(contrast(white, token('mc-danger', 'dark'))).toBeLessThan(AA);
  });

  it('agrees with a value computed by hand', () => {
    // oklch(72% 0.15 155) is #43c07a; white on it is 2.33:1. If the conversion
    // above drifts, this catches it before a real pair is mis-measured.
    expect(contrast('oklch(100% 0 0)', 'oklch(72% 0.15 155)')).toBeCloseTo(2.33, 1);
  });
});
