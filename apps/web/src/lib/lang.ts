/**
 * The active language, readable from a plain function.
 *
 * `formatRelative` and `formatDateTime` are called from about thirty places,
 * most of them deep inside a `.map()` where a hook cannot go, and they were the
 * last English left on a French dashboard: every session row said "2h ago"
 * under a French heading. Threading a language through thirty call sites would
 * have been thirty chances to miss one; a hook is not available where they are
 * called at all.
 *
 * So the provider publishes the choice here and the formatters read it. Two
 * properties make that safe rather than sloppy:
 *
 *  - It is *set before* `setLangState`, synchronously, so the render the switch
 *    triggers already sees the new value. Stamping `<html lang>` happens in an
 *    effect, after render, which is why reading that instead would leave every
 *    timestamp one frame behind.
 *  - Nothing writes it but `I18nProvider`. It is a published value, not shared
 *    mutable state: a second writer would make the two disagree with no way to
 *    tell which was right.
 *
 * This module deliberately imports nothing. It is the seam between the React
 * world and the plain functions, and giving it a dependency would drag React
 * into every consumer of `lib/utils`.
 */

export type Lang = 'en' | 'fr';

let active: Lang = 'en';

/** Called by `I18nProvider`, and by nothing else. */
export function publishLang(lang: Lang): void {
  active = lang;
}

/** The language to format in, for code that cannot reach the hook. */
export function currentLang(): Lang {
  return active;
}
