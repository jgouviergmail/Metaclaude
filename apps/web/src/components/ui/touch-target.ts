/**
 * Hit areas larger than the box that paints them.
 *
 * These lived in `primitives.tsx`, which is where they are mostly used — until
 * `density.tsx` needed one too, and `primitives.tsx` imports `density.tsx`.
 * A module with no imports of its own ends that: both sides take the constant
 * from here, and neither depends on the other.
 *
 * `controls.tsx` keeps its own, wider variant. It is not a stray copy: a switch
 * is 20×36 and needs a 12px inset where a 28px button needs 8, and merging the
 * two would silently shrink one of them.
 */

/**
 * On a coarse pointer the smallest sizes get a hit area larger than their box.
 *
 * A 16–28px icon button is right for a dense desktop row and too small for a
 * thumb, and growing the box would loosen every row it appears in. An invisible
 * inset pseudo-element takes the press instead: the button still measures
 * 28×28, but 44×44 of screen responds to it. Applied only under
 * `pointer-coarse`, so a mouse keeps the precise target.
 *
 * 8px each side, so the box it is put on has to be at least 16px for the result
 * to clear the 32px floor `scripts/browser.mjs` probes — and that check probes
 * 15px from the centre, so 16px painted leaves exactly one pixel. Anything that
 * small should be 20px painted rather than rely on the margin.
 */
export const TOUCH_TARGET =
  "relative pointer-coarse:before:absolute pointer-coarse:before:-inset-2 pointer-coarse:before:content-['']";

/**
 * The same idea on one axis only.
 *
 * A labelled button is already wide enough for a thumb; it is the 32px height
 * that falls short of 44. Growing it sideways as well would be worse than
 * useless here: rows in this app go down to `gap-0.5`, so opposing hit areas
 * would overlap and the button later in the DOM would quietly take presses
 * meant for its neighbour. Vertical only reaches exactly 44px and cannot
 * collide with anything beside it.
 */
export const TOUCH_TARGET_Y =
  "relative pointer-coarse:before:absolute pointer-coarse:before:-inset-y-1.5 " +
  "pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']";
