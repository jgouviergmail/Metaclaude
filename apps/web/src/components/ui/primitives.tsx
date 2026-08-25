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
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink hover:bg-accent-hover shadow-[var(--mc-shadow-sm)] active:scale-[0.98]',
  secondary:
    'bg-raised text-ink hover:bg-line border border-line active:scale-[0.98]',
  outline: 'border border-line-strong text-ink hover:bg-raised active:scale-[0.98]',
  ghost: 'text-muted hover:text-ink hover:bg-raised',
  danger: 'bg-danger text-white hover:brightness-110 active:scale-[0.98]',
  success: 'bg-success text-white hover:brightness-110 active:scale-[0.98]',
};

/**
 * On a coarse pointer the smallest sizes get a hit area larger than their box.
 *
 * A 24–28px icon button is right for a dense desktop row and too small for a
 * thumb, and growing the box would loosen every row it appears in. An invisible
 * inset pseudo-element takes the press instead: the button still measures
 * 28×28, but 44×44 of screen responds to it. Applied only under
 * `pointer-coarse`, so a mouse keeps the precise target.
 */
const TOUCH_TARGET =
  "relative pointer-coarse:before:absolute pointer-coarse:before:-inset-2 pointer-coarse:before:content-['']";

const BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: `h-6 px-2 text-[11px] gap-1 rounded-md ${TOUCH_TARGET}`,
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-6 text-[15px] gap-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg',
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
          'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink',
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
          'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink',
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

export function Label({
  className,
  children,
  hint,
  ...props
}: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string; hint?: ReactNode }) {
  return (
    <label className={cn('block space-y-1.5', className)} {...props}>
      <span className="block text-[13px] font-medium text-ink">{children}</span>
      {hint ? <span className="block text-xs leading-relaxed text-muted">{hint}</span> : null}
    </label>
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
        'text-[11px] font-medium leading-none whitespace-nowrap',
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

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-line bg-surface', className)}
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
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line p-4', className)}>
      <div className="min-w-0 space-y-1">
        <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
        {description ? <p className="text-xs leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2 className={cn('size-4 animate-spin text-muted', className)} aria-label="Loading" />
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
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>
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
            'text-xs leading-relaxed text-ink shadow-[var(--mc-shadow)]',
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
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-6">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {description ? (
          <p className="text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A labelled statistic, used across the dashboard and analytics. */
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
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</p>
        {icon ? <span className="text-subtle [&>svg]:size-4">{icon}</span> : null}
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums tracking-tight',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          !tone && 'text-ink',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
