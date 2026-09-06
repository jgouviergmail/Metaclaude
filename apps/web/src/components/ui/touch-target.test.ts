/**
 * The hit areas, held to what a test here can actually see.
 *
 * happy-dom lays nothing out, so nothing in this file can prove a thumb
 * reaches a control — `apps/api/scripts/responsive.mjs` does that in a real
 * browser, at a coarse-pointer width, on every route and inside every dialog
 * and menu it opens. What a unit test can hold is the class contract: that the
 * shared spellings still carry a hit area at all.
 *
 * That is worth holding because the failure is silent. These constants exist
 * because sixteen controls across nine screens had no hit area — composer
 * pills, board filters, colour swatches, the quiet links out of every card —
 * and every one of them looked perfect on a desktop and measured 19 to 29
 * pixels under a thumb. Dropping the constant from one of them would look like
 * a tidy-up.
 */

import { describe, expect, it } from 'vitest';
import { CHIP, QUIET_LINK } from './primitives';
import { TOUCH_TARGET, TOUCH_TARGET_TEXT, TOUCH_TARGET_Y } from './touch-target';

describe('the hit areas', () => {
  it('apply only to a coarse pointer, so a mouse keeps the precise target', () => {
    for (const spelling of [TOUCH_TARGET, TOUCH_TARGET_Y, TOUCH_TARGET_TEXT]) {
      for (const token of spelling.split(/\s+/).filter((t) => t.includes('before:'))) {
        expect(token, spelling).toMatch(/^pointer-coarse:/);
      }
    }
  });

  it('positions the pseudo-element, which needs a positioned ancestor', () => {
    // `absolute` inside a static parent resolves against the page, and the hit
    // area lands somewhere else entirely — silently, since nothing paints.
    for (const spelling of [TOUCH_TARGET, TOUCH_TARGET_Y, TOUCH_TARGET_TEXT]) {
      expect(spelling).toContain('relative');
      expect(spelling).toContain('pointer-coarse:before:absolute');
    }
  });

  it('reaches outward on both axes, or only downward and upward', () => {
    expect(TOUCH_TARGET).toContain('-inset-2');
    // Vertical only, and pinned to zero sideways rather than left unset: an
    // unset inline axis leaves the pseudo-element with no width at all.
    expect(TOUCH_TARGET_Y).toContain('-inset-y-1.5');
    expect(TOUCH_TARGET_Y).toContain('inset-x-0');
    expect(TOUCH_TARGET_Y).not.toContain('-inset-x');
  });

  /*
   * Both shared spellings take the vertical form. Sideways would be wrong for
   * either: chips and pills sit in rows a few pixels apart, so opposing hit
   * areas would overlap and the later one in the DOM would take presses meant
   * for its neighbour — and on the board, a pseudo-element reaching sideways
   * widens the header row's scrollWidth, which hides the genuinely scrollable
   * container from the overflow probe and reports four clipped buttons.
   */
  it('gives the shared control spellings a vertical hit area', () => {
    expect(CHIP).toContain(TOUCH_TARGET_Y);
    // A quiet link is a line of text, not a box: 6px each side leaves a 16px
    // line at 28, under the floor. Measured on the dashboard's link out to
    // the settings screen, which failed the guard at exactly that.
    expect(QUIET_LINK).toContain(TOUCH_TARGET_TEXT);
  });

  it('grows a line of text further than a control with a box', () => {
    expect(TOUCH_TARGET_TEXT).toContain('-inset-y-2.5');
    expect(TOUCH_TARGET_Y).toContain('-inset-y-1.5');
  });

  it('gives the chip a scale role rather than a literal size', () => {
    expect(CHIP).toContain('text-caption');
    expect(CHIP).not.toMatch(/text-\[/);
  });
});
