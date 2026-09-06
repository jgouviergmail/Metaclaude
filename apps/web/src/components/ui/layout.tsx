/**
 * Layout primitives.
 *
 * The app had a vocabulary of controls — button, input, badge, card, meter —
 * and none of structure, so every screen invented its own. Measured on the tree
 * these replace: ten pages, four different maximum widths, three paddings and
 * four vertical rhythms for one repeated shape, fifty distinct padding values
 * and seventeen text sizes across the app. That is the mechanical cause of an
 * interface that reads as dense and unorganised, and of a page file reaching
 * 2584 lines.
 *
 * These carry no knowledge of any screen. A new screen picks a shape here
 * rather than starting from a blank page, which is what "evolutive" has to mean
 * in practice.
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import { useDisclosedDescription } from '@/components/ui/density';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The four widths, named by intent rather than by a Tailwind step.
 *
 * Ten screens carried ten independent choices — `max-w-3xl` through `6xl` with
 * no rule behind any of them. Naming the intent is what makes a new screen's
 * choice reviewable: "is this a reading column or a dashboard" is a question
 * with an answer, "is this 4xl or 5xl" is not.
 */
const WIDTHS = {
  /** One column of text and settings. */
  prose: 'max-w-3xl',
  /** A list of things, each a row. */
  list: 'max-w-4xl',
  /** The default working width. */
  standard: 'max-w-5xl',
  /** Dashboards and tables, where the extra columns earn their place. */
  wide: 'max-w-6xl',
} as const;

export type PageWidth = keyof typeof WIDTHS;

export interface PageProps extends HTMLAttributes<HTMLDivElement> {
  width?: PageWidth;
  /**
   * Vertical rhythm between the page's own children.
   *
   * `section` follows the density token; `none` is for a screen whose single
   * child manages its own spacing, which is most of the tabbed ones.
   */
  gap?: 'section' | 'none';
}

/**
 * The bounded body of a page, without the scrolling element around it.
 *
 * Exported because a screen with a sticky tab strip cannot use `Page`: Radix
 * requires `Tabs.Root` to wrap both the list and the panels, so nothing can
 * sit between the scroller and the strip. A first attempt gave `Page` a
 * `subnav` slot for exactly that case and it does not fit — the structure
 * refuted it. This composes instead: such a screen keeps its own scroller and
 * wraps its panels in a `PageBody`, and the width still lives in one place.
 */
export function PageBody({ width = 'standard', gap = 'section', className, children }: PageProps) {
  return (
    <div
      className={cn(
        'mx-auto w-full p-gutter sm:p-6',
        WIDTHS[width],
        gap === 'section' && 'space-y-section',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A scrolling page body with one width and one rhythm.
 *
 * The scroll lives here rather than on the document because `body` is
 * `overflow: hidden` in this app: the shell owns the viewport and each pane
 * scrolls on its own. That is also why a clipped control never produces a
 * document-level overflow, and why `scripts/responsive.mjs` measures the first
 * overflowing *ancestor* instead.
 */
export function Page({ width, gap, className, children, ...props }: PageProps) {
  return (
    <div className="flex-1 overflow-y-auto" {...props}>
      <PageBody width={width} gap={gap} className={className}>
        {children}
      </PageBody>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Section                                                                     */
/* -------------------------------------------------------------------------- */

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * An icon beside the title, hidden from assistive tech.
   *
   * It sits outside the heading deliberately: text inside a heading becomes
   * part of the name a screen reader announces and part of what a document
   * outline shows, and an icon has nothing to contribute to either.
   */
  icon?: ReactNode;
  /**
   * The heading level, `h2` by default.
   *
   * A page's `h1` comes from its header, so a section sitting under it is a
   * first-rank section. Rendering an `h3` skipped a level on every screen at
   * once — 24 skips measured across both languages and all three widths — which
   * makes the heading outline wrong for anyone navigating by it.
   */
  level?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}

/**
 * A titled band, separated by a rule rather than enclosed in a box.
 *
 * This is the piece that changes how the app reads. There were 138 bordered
 * boxes — 67 `<Card>` and 71 hand-written borders — so every block carried the
 * same visual weight and nothing led the eye. Border, fill and shadow each say
 * "separate object"; spending them on everything spends them on nothing.
 *
 * A card is still right where a block genuinely is a separate object one can
 * act on. A group of settings is not that; it is a section.
 */
export function Section({
  title,
  description,
  actions,
  icon,
  level = 2,
  className,
  children,
}: SectionProps) {
  const id = useId();
  const Heading = `h${level}` as const;
  // The prose follows the density, and stays reachable in both — see
  // `useDisclosedDescription`. The two halves cannot be one element: the
  // control belongs on the title's baseline, the prose under it.
  const help = useDisclosedDescription(description, typeof title === 'string' ? title : undefined);
  return (
    <section aria-labelledby={`${id}-title`} className={className}>
      <header className="flex items-start justify-between gap-4 border-b border-line pb-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            {icon ? (
              <span className="shrink-0 translate-y-0.5 [&>svg]:size-4" aria-hidden>
                {icon}
              </span>
            ) : null}
            <Heading id={`${id}-title`} className="text-heading text-ink">
              {title}
            </Heading>
            {help.trigger}
          </div>
          {help.body}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className="mt-stack">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where the columns appear, per breakpoint.
 *
 * The first version fixed the breakpoint per column count, and not one of the
 * ten hand-written grids in the app matched it: two charts side by side need
 * `xl`, two cards need `sm`, the dashboard needs `lg`. The number of columns is
 * a property of the layout; the width at which they are worth having is a
 * property of the *content*, and only the caller knows it.
 */
const AT = {
  sm: { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' },
  md: { 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' },
  lg: { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' },
  xl: { 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4' },
} as const;

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  cols?: 2 | 3 | 4;
  /** The width at which the columns are worth having. */
  from?: keyof typeof AT;
}

/**
 * A responsive grid whose children may shrink.
 *
 * `[&>*]:min-w-0` is the whole reason this exists rather than a bare
 * `className="grid"`. A grid item's `min-width` is `auto`, so it refuses to go
 * below its content's minimum width: on the dashboard a card blew out to 542px
 * — 697 in French — inside a 358px column, and because the grid is
 * `overflow-x: visible` nothing scrolled. The links were simply out of reach,
 * below the fold, where the screenshot bench never looked.
 */
export function Grid({ cols = 3, from = 'lg', className, children, ...props }: GridProps) {
  return (
    <div
      className={cn('grid grid-cols-1 gap-4 [&>*]:min-w-0', AT[from][cols], className)}
      {...props}
    >
      {children}
    </div>
  );
}
