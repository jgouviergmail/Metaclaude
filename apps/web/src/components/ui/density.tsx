/**
 * Explanatory prose that follows the density — and stays reachable either way.
 *
 * The comfortable density shows a description outright; the compact one offers
 * it behind a control. That distinction is the whole point of the setting,
 * whose own copy promises "plus d'air, et l'aide toujours affichée" — but
 * hiding it outright in compact would take from the *default* reader something
 * they had before, which is a regression dressed as a preference. Disclosed,
 * not dropped.
 *
 * A hook rather than a component, because the two halves do not sit together:
 * the control belongs beside the heading and the prose belongs under it. Both
 * `Section` and `CardHeader` already own a description, so they carry this and
 * no caller has to think about the density at all.
 *
 * The purely ornamental hints — a word under a count — keep the CSS-only
 * `.help-comfortable` class instead: an `i` button beside each of four numbers
 * would be worse than the noise it removes.
 */

import { Info } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { useUiStore } from '@/lib/store';
import { TOUCH_TARGET } from '@/components/ui/touch-target';
import { cn } from '@/lib/utils';

export interface DisclosedDescription {
  /** Sits beside the heading. `null` when the density shows the prose anyway. */
  trigger: ReactNode;
  /** Sits under the heading. `null` while a compact reader has not asked. */
  body: ReactNode;
}

export function useDisclosedDescription(
  description: ReactNode,
  /**
   * What the prose is about, when the caller knows it as plain text.
   *
   * Two of these sit side by side on the Memory page, and named `Explain`
   * alike they are one entry twice in any list of a screen's controls — the
   * enclosing heading disambiguates them visually and by arrow navigation, and
   * not at all by that list. A title that is not a string keeps the bare
   * label; there is nothing honest to build a name from.
   */
  subject?: string,
  /**
   * The id of an element that says what is being explained.
   *
   * The third answer to naming, and the right one where a label sits beside the
   * control: eight settings named `Explain` make a poor list of buttons, and
   * naming each by its subject made every row answer twice to a search for its
   * own words. A *description* does neither.
   */
  describedBy?: string,
): DisclosedDescription {
  const t = useT();
  const density = useUiStore((state) => state.density);
  const [open, setOpen] = useState(false);

  if (!description) return { trigger: null, body: null };

  const comfortable = density === 'comfortable';
  const shown = comfortable || open;

  return {
    trigger: comfortable ? null : (
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        /*
         * `aria-expanded` without `aria-controls` is deliberate: the prose is
         * unmounted while folded, and an IDREF that resolves to nothing is
         * worse than an absent one.
         */
        aria-label={subject ? t('Explain {subject}', { subject }) : t('Explain')}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className={cn(
          // 20px painted, 36px under a thumb. It was 16px with no hit area at
          // all, which `scripts/browser.mjs` caught on /settings — four of
          // these at 16x16 on a phone. 16 plus the 8px inset would have cleared
          // the floor by a single pixel; 20 is an affordance rather than a
          // near miss.
          'grid size-5 shrink-0 place-items-center rounded-full border border-line-strong',
          'text-subtle transition-colors hover:border-accent hover:text-accent',
          'focus-visible:outline-2 focus-visible:outline-accent',
          TOUCH_TARGET,
        )}
      >
        <Info className="size-3" aria-hidden />
      </button>
    ),
    body: shown ? (
      <p className="mt-0.5 text-caption leading-relaxed text-muted">{description}</p>
    ) : null,
  };
}
