/**
 * UI primitives.
 *
 * A deliberately small set: button, input, badge, card, spinner, tooltip and a
 * couple of layout helpers. Everything else in the app composes from these, so
 * spacing, radii and focus behaviour stay consistent without a component
 * library's weight or its opinions.
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Loader2 } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { useDisclosedDescription } from '@/components/ui/density';
import {
  TOUCH_TARGET,
  TOUCH_TARGET_TEXT,
  TOUCH_TARGET_Y,
} from '@/components/ui/touch-target';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'btn-primary text-accent-ink active:scale-[0.98]',
  secondary:
    'bg-raised text-ink hover:bg-line border border-line active:scale-[0.98]',
  outline: 'border border-line-strong text-ink hover:bg-raised active:scale-[0.98]',
  ghost: 'text-muted hover:text-ink hover:bg-raised',
  danger: 'bg-danger text-danger-ink hover:brightness-110 active:scale-[0.98]',
  success: 'bg-success text-success-ink hover:brightness-110 active:scale-[0.98]',
};


const BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: `h-6 px-2 text-caption gap-1 rounded-md ${TOUCH_TARGET}`,
  // `sm` carries most of this interface — 77 call sites against one for `md` —
  // so it is the size that decides whether the app is usable with a thumb.
  sm: `h-8 px-3 text-body gap-1.5 rounded-lg ${TOUCH_TARGET_Y}`,
  md: `h-9 px-4 text-body gap-2 rounded-lg ${TOUCH_TARGET_Y}`,
  lg: 'h-11 px-6 text-title gap-2 rounded-xl',
  icon: `h-9 w-9 rounded-lg ${TOUCH_TARGET}`,
  'icon-sm': `h-7 w-7 rounded-md ${TOUCH_TARGET}`,
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // A loading button must not be clickable, or a double submit gets through.
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,color,transform,opacity] duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-lg border border-line bg-surface px-3 text-body text-ink',
          'placeholder:text-subtle',
          'transition-colors focus:border-accent focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink',
          'placeholder:text-subtle resize-y',
          'transition-colors focus:border-accent focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
      />
    );
  },
);

/**
 * The native select, in the same box as an Input.
 *
 * Three files carried this class string by hand, eight times over, beside an
 * `Input` that already said exactly it. The appearance stays native — no
 * `appearance-none` and no drawn chevron — because that is what those eight
 * copies did and a select the platform draws is a select the platform's own
 * assistive tech and its mobile picker already understand.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-9 w-full rounded-lg border border-line bg-surface px-3 text-body text-ink',
          'transition-colors focus:border-accent focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

/**
 * A field label with an optional explanatory line.
 *
 * The hint is rendered *outside* the `<label>`, and that placement is the whole
 * point. A labelled control's accessible name is the text content of its
 * labelling element — the embedded control excluded, but nothing else — so a
 * hint nested inside the label is announced as part of the name of the field:
 * "Name Lowercase and dashes; this is the directory name., edit text" every
 * time focus lands, with no short phrase for voice control to target.
 * `aria-describedby` does not rescue that; being described does not take text
 * out of the name. The hint has to leave the label, which is what
 * `controls.tsx`'s `CheckboxField` already does.
 *
 * The container carries the spacing the label used to, so the rendered result
 * is unchanged.
 *
 * When `htmlFor` is given the hint gets the id `<htmlFor>-hint`, so a caller
 * can wire `aria-describedby` on its control and have the hint announced as a
 * description rather than dropped. That is opt-in: the name is fixed either
 * way, and this only decides whether the hint is also read out.
 */
export function Label({
  className,
  children,
  hint,
  explanation,
  htmlFor,
  ...props
}: HTMLAttributes<HTMLLabelElement> & {
  htmlFor?: string;
  /**
   * The constraint you need *while* filling the control — "lowercase and
   * dashes; this is the directory name". Always shown, in both densities:
   * folding it away would hide the rule at the moment it is needed, which is
   * not the trade the density setting offers.
   */
  hint?: ReactNode;
  /**
   * The essay. The configuration screen carries three lines per setting, eight
   * settings deep, and reading them is something you do once — so it follows
   * the density exactly as a `Section`'s description does.
   */
  explanation?: ReactNode;
}) {
  /*
   * Not named by its subject, unlike a `Section`'s.
   *
   * There the heading may be far from its control and the title is two words;
   * here the label is the immediately preceding sibling, and the title is a
   * whole sentence. Naming the trigger `Explain Stop a run that goes quiet
   * after` makes every setting answer to a search for its own words twice —
   * measured, not supposed: `findByLabelText(/goes quiet/i)` began matching the
   * input *and* the button, and twelve tests went from passing to timing out.
   * Two controls with the same words is a worse answer than one short name
   * beside the label that already says what it is.
   */
  const help = useDisclosedDescription(explanation);
  return (
    <div className={cn('block space-y-1.5', className)}>
      <div className="flex items-center gap-2">
        <label className="block text-body font-medium text-ink" htmlFor={htmlFor} {...props}>
          {children}
        </label>
        {help.trigger}
      </div>
      {hint ? (
        <span
          {...(htmlFor ? { id: `${htmlFor}-hint` } : {})}
          className="block text-caption leading-relaxed text-muted"
        >
          {hint}
        </span>
      ) : null}
      {help.body}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'thinking';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-raised text-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent/25',
  success: 'bg-success-soft text-success border-success/25',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/25',
  thinking: 'bg-thinking-soft text-thinking border-thinking/25',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5',
        'text-caption font-medium leading-none whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A quiet link out of a block — "View all", "Review", the source of a memory.
 *
 * Nine of these existed in five spellings and three type sizes, two of them
 * arbitrary values. None had a hit area, so every one of them was a 19px target
 * on a phone; `scripts/responsive.mjs` names them one by one. Colour, hover and
 * the vertical hit area live here; the size stays with the caller, because two
 * of the nine sit inside a sentence and have to match the text around them.
 */
export const QUIET_LINK = `text-accent hover:underline ${TOUCH_TARGET_TEXT}`;

/**
 * A toggle chip: a board filter, a task kind, a cron preset.
 *
 * Five hand-rolled copies of one shape, each 27–29px tall with no hit area.
 * Not `Button size="xs"`, which is 24px and differently drawn — this is the
 * chip the app already uses, spelled once. `aria-pressed` and the selected
 * colours stay with the caller, which is the only part that differs.
 */
export const CHIP = `rounded-lg px-2.5 py-1 text-caption ${TOUCH_TARGET_Y}`;

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mc-card rounded-xl border border-line bg-surface', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  level = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /**
   * The heading level, `h2` by default.
   *
   * `PageHeader` renders the page's `h1`, so a card sitting directly under it
   * is a first-rank section. Rendering an `h3` skipped a level on every screen
   * at once — 24 skips measured across both languages and all three widths —
   * and a skipped level makes the heading outline wrong for anyone navigating
   * by it. Step down to 3 only where the card is genuinely nested under a
   * section that already carries an `h2`.
   */
  level?: 2 | 3 | 4;
}) {
  const Heading = `h${level}` as const;
  // Same behaviour as `Section`, from the same place: the description is shown
  // outright in the comfortable density and offered behind a control in the
  // compact one. `space-y-1` is gone from the wrapper because the disclosed
  // prose carries its own top margin, and two rules setting `margin-top` on
  // one element is a cascade collision waiting for a refactor to resolve it
  // the wrong way.
  const help = useDisclosedDescription(description, typeof title === 'string' ? title : undefined);
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line p-gutter', className)}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <Heading className="truncate text-body font-semibold text-ink">{title}</Heading>
          {help.trigger}
        </div>
        {help.body}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }) {
  const t = useT();
  return (
    <Loader2 className={cn('size-4 animate-spin text-muted', className)} aria-label={t(
      'Loading',
    )} />
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? <div className="text-subtle [&>svg]:size-8" aria-hidden>{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-body font-medium text-ink">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-body leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Skeleton block for loading states, sized by the caller. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-raised', className)} />;
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  if (!content) return <>{children}</>;

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-xs rounded-lg border border-line bg-raised px-2.5 py-1.5',
            'text-caption leading-relaxed text-ink shadow-[var(--mc-shadow)]',
            'animate-in-up',
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-gutter sm:px-6">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {description ? (
          <p className="text-body leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A labelled statistic, used across the dashboard and analytics. */
/**
 * A proportion, drawn.
 *
 * `value` is 0–1, or null for "not measured" — which is a state the resource
 * meters genuinely have on a machine without cgroups, and which must not be
 * drawn as an empty bar: an empty bar reads as "nothing is happening", and
 * that is the opposite of unknown.
 *
 * The tone is passed in rather than derived, because the direction differs by
 * caller: a memory that is 90% full is bad, a confidence that is 90% is good.
 */
export function Meter({
  value,
  tone = 'accent',
  label,
  className,
}: {
  value: number | null;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  label: string;
  className?: string;
}) {
  const fill = {
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }[tone];

  return (
    <div
      className={cn(
        'h-1.5 overflow-hidden rounded-full bg-sunken',
        // Faded, not hidden: the track holds the card's height so a row of
        // meters stays aligned whether or not each one has a reading — but at
        // full strength an empty track reads as a gauge sitting at zero,
        // which is a measurement, and the opposite of what it means here.
        value === null && 'opacity-50',
        className,
      )}
      role="img"
      aria-label={label}
    >
      {value === null ? null : (
        <div
          className={cn('h-full rounded-full transition-[width]', fill)}
          style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
        />
      )}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'success' | 'warning' | 'danger';
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-gutter">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption font-medium uppercase tracking-wide text-subtle">{label}</p>
        {icon ? <span className="text-subtle [&>svg]:size-4">{icon}</span> : null}
      </div>
      <p
        className={cn(
          'mt-2 text-display font-semibold tabular-nums tracking-tight',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          !tone && 'text-ink',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-caption text-muted">{hint}</p> : null}
    </div>
  );
}
