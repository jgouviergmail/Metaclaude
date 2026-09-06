/**
 * The tab strip.
 *
 * A thin wrapper over Radix, and the thinness is the point: three screens had
 * their own copy of the trigger's appearance — `TAB_CLASS` declared
 * byte-for-byte identically in SettingsPage and HelpPage, plus a third variant
 * inline in AgentsPage. Three places to change when the active underline moves.
 *
 * The strip scrolls rather than wrapping. Six sections in French do not fit a
 * 390px screen, and a strip that wraps to two rows pushes the content down on
 * every phone; `scripts/responsive.mjs` tolerates a control outside the frame
 * only when an ancestor genuinely scrolls, which is what makes this deliberate
 * rather than an overflow nobody noticed.
 */

import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { PAGE_WIDTHS, type PageWidth } from '@/components/ui/layout';
import { cn } from '@/lib/utils';

export const Tabs = RadixTabs.Root;

export function TabStrip({
  label,
  width,
  sticky = false,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.List> & {
  label: string;
  /**
   * Align the triggers with a page body of this width.
   *
   * Only a strip that sits *outside* the body needs it — a sticky one, which
   * cannot live inside the scrolling element. Without it that strip is
   * full-bleed while its panel is centred, so the triggers start at the screen
   * edge and their content a hundred and eighty pixels further in, and the row
   * reads as chrome rather than as a label for what follows. A strip already
   * inside a `Page` is bounded by the body around it and must not be bounded
   * twice.
   */
  width?: PageWidth;
  /** Keep the strip visible while its panel scrolls under it. */
  sticky?: boolean;
  children: ReactNode;
}) {
  return (
    /*
     * A band around the list, not a wrapper inside it.
     *
     * The rule belongs to the full width even when the triggers are centred,
     * and `position: sticky` belongs to the element the scroller sees. Neither
     * can go on the list itself — and nothing may go *between* the list and its
     * triggers, because `role="tablist"` owns its `role="tab"` children.
     */
    <div
      className={cn(
        'border-b border-line',
        // The gap below the rule belongs to the strip, not to each caller: the
        // three copies carried `mb-5`, `mb-4` and nothing, and factoring the
        // class out without it left the first panel touching the rule. A
        // sticky strip is the exception — its panel's own gutter is the gap.
        sticky ? 'sticky top-0 z-10 bg-bg' : 'mb-4',
      )}
    >
      <RadixTabs.List
        aria-label={label}
        className={cn(
          'flex gap-1 overflow-x-auto',
          width && ['mx-auto w-full px-gutter sm:px-6', PAGE_WIDTHS[width]],
          className,
        )}
        {...props}
      >
        {children}
      </RadixTabs.List>
    </div>
  );
}

export function TabTrigger({
  icon,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.Trigger> & {
  /**
   * A glyph before the label, hidden from assistive tech.
   *
   * It sits inside an `aria-hidden` span for the same reason a `Section`'s
   * icon does: text inside the trigger becomes part of the name the tab is
   * announced by, and an icon has nothing to contribute to it. Owning the slot
   * here is what removes the two spellings it replaced — a full appearance
   * override on one screen to get a flex row, and `mr-1.5 inline` on the icon
   * itself on another.
   */
  icon?: ReactNode;
}) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2',
        'text-body font-medium text-muted transition-colors hover:text-ink',
        'data-[state=active]:border-accent data-[state=active]:text-ink',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span className="shrink-0 [&>svg]:size-4" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabPanel({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content className={cn('focus-visible:outline-none', className)} {...props}>
      {children}
    </RadixTabs.Content>
  );
}
