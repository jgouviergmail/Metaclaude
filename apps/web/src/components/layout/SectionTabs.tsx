/**
 * A section's own navigation: the screens inside it, as chips.
 *
 * One component, two sections. `SystemTabs` and `SettingsTabs` were the same
 * forty lines twice — same chips, same current-chip scrolling, same hit area —
 * and they had already begun to drift: one carried `[&>*]:shrink-0` and the
 * other did not. A row of chips that shrinks instead of scrolling is the board
 * filter-bar defect, and it would have arrived in whichever copy was forgotten.
 *
 * Links rather than tabs, and the distinction is not pedantic: `role="tab"`
 * promises a panel switching in place under the same URL. These change the
 * route, so a screen reader is told what is true — a navigation landmark whose
 * current entry carries `aria-current="page"`.
 *
 * Chips rather than an underlined strip, and that is not decoration either.
 * Some of these screens carry a tab strip of their own; drawn in the same
 * register the two stacked into ninety pixels of identical scrolling rows,
 * with nothing saying which one moved between screens and which moved within
 * one. Two levels of navigation exist, so they read as two.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { TOUCH_TARGET_Y } from '@/components/ui/touch-target';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface SectionPath {
  to: string;
  label: string;
  icon: ReactNode;
}

export function SectionTabs({
  label,
  entries,
  className,
}: {
  /** Names the landmark. Distinct per section, so both can be found. */
  label: string;
  entries: readonly SectionPath[];
  className?: string;
}) {
  const t = useT();
  const { pathname } = useLocation();
  const currentRef = useRef<HTMLAnchorElement | null>(null);

  /*
   * Bring the current chip into view.
   *
   * Six French labels are wider than a phone, so the strip scrolls — and it
   * scrolls from the left, which put the current chip off-screen on every
   * screen of the section at 390px: the one thing a strip exists to show was
   * the one thing it did not. `nearest` on the block axis so the page itself
   * never jumps, and no smooth behaviour, which would be motion nobody asked
   * for on a load.
   */
  useEffect(() => {
    currentRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);

  return (
    <nav
      aria-label={label}
      // Scrolls rather than wraps: a strip that wraps to two rows pushes the
      // content down on every phone. `[&>*]:shrink-0` is what makes it scroll
      // rather than squeeze — a flex child shrinks before it overflows, and a
      // squeezed chip breaks its own label over three lines and ends up
      // *taller* than the wrapping version. `scripts/responsive.mjs` tolerates
      // a control outside the frame precisely when an ancestor scrolls.
      className={cn('flex gap-1.5 overflow-x-auto py-2 [&>*]:shrink-0', className)}
    >
      {entries.map((entry) => {
        const current = pathname === entry.to || pathname.startsWith(`${entry.to}/`);
        return (
          <Link
            key={entry.to}
            to={entry.to}
            ref={current ? currentRef : undefined}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5',
              'text-label font-medium transition-colors [&>svg]:size-3.5',
              // 36px painted, 48px of screen under a thumb. The same
              // pseudo-element the small buttons use, and vertical only for the
              // same reason: the chips sit 6px apart, so a sideways hit area
              // would let one steal presses meant for its neighbour.
              TOUCH_TARGET_Y,
              current ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-raised hover:text-ink',
            )}
          >
            {entry.icon}
            {t(entry.label)}
          </Link>
        );
      })}
    </nav>
  );
}
