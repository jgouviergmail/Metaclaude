/**
 * A card whose body folds away, leaving a line that still says something.
 *
 * Built on `<details>` rather than on conditional rendering, and that is the
 * whole design. A folded card keeps its children **mounted**: the Google
 * connection card reads the OAuth outcome out of the query string in an effect
 * and raises the toast that reports it, so a fold that unmounted the body would
 * swallow the result of a consent the operator just gave. Same reasoning as the
 * comment in `SettingsPage` about Radix unmounting inactive tabs — that trap
 * cost a release once already.
 *
 * Two more properties come free with the native element: the summary is
 * focusable and operable from the keyboard without a single handler, and the
 * browser's own find-in-page can open the section it matched.
 *
 * The summary carries a `status` slot on purpose. A fold that hides *whether
 * something is connected* has replaced a big card with a useless one; the
 * folded line has to answer the question the card exists for.
 */

import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Card } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export function CollapsibleCard({
  title,
  status,
  description,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className,
}: {
  title: ReactNode;
  /** The one thing worth knowing while it is folded — a badge, a count. */
  status?: ReactNode;
  /** Shown inside the fold: it is usually the bulk of what takes the room. */
  description?: ReactNode;
  defaultOpen?: boolean;
  /**
   * Drive the fold from outside, for a card that must open in response to
   * something that happens *later* than mount.
   *
   * The Google card needs exactly that: it learns it is being shown after an
   * OAuth consent from an effect, not from its first render — and reading that
   * at mount instead was wrong twice over. It races the same effect's cleanup
   * of the query string, and under `StrictMode` the deliberate remount reads a
   * query that has already been cleared, folding the card shut on the one
   * visit where it must be open.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const isOpen = open ?? selfOpen;

  return (
    <Card className={className}>
      <details
        className="group"
        open={isOpen}
        onToggle={(event) => {
          // The native element has already toggled itself; this only tells the
          // two states about it, so a controlled parent and a plain click
          // agree.
          const next = event.currentTarget.open;
          setSelfOpen(next);
          onOpenChange?.(next);
        }}
      >
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center gap-2.5 rounded-xl p-4',
            'text-body font-semibold text-ink transition-colors hover:bg-raised',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            'group-open:rounded-b-none group-open:border-b group-open:border-line',
          )}
        >
          <ChevronRight
            className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {status ? (
            <span className="flex shrink-0 items-center gap-2 font-normal">{status}</span>
          ) : null}
        </summary>

        {description ? (
          <p className="px-4 pt-3 text-caption leading-relaxed text-muted">{description}</p>
        ) : null}
        {children}
      </details>
    </Card>
  );
}
