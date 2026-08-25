import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { forwardRef, } from 'react';
import { cn } from '@/lib/utils';
const BUTTON_VARIANTS = {
    primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-[var(--mc-shadow-sm)] active:scale-[0.98]',
    secondary: 'bg-raised text-ink hover:bg-line border border-line active:scale-[0.98]',
    outline: 'border border-line-strong text-ink hover:bg-raised active:scale-[0.98]',
    ghost: 'text-muted hover:text-ink hover:bg-raised',
    danger: 'bg-danger text-white hover:brightness-110 active:scale-[0.98]',
    success: 'bg-success text-white hover:brightness-110 active:scale-[0.98]',
};
const BUTTON_SIZES = {
    xs: 'h-6 px-2 text-[11px] gap-1 rounded-md',
    sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
    md: 'h-9 px-4 text-sm gap-2 rounded-lg',
    lg: 'h-11 px-6 text-[15px] gap-2 rounded-xl',
    icon: 'h-9 w-9 rounded-lg',
    'icon-sm': 'h-7 w-7 rounded-md',
};
export const Button = forwardRef(function Button({ className, variant = 'secondary', size = 'md', loading, disabled, children, ...props }, ref) {
    return (_jsxs("button", { ref: ref, 
        // A loading button must not be clickable, or a double submit gets through.
        disabled: disabled || loading, className: cn('inline-flex select-none items-center justify-center font-medium whitespace-nowrap', 'transition-[background-color,color,transform,opacity] duration-150', 'disabled:pointer-events-none disabled:opacity-50', BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className), ...props, children: [loading ? _jsx(Loader2, { className: "size-4 shrink-0 animate-spin", "aria-hidden": true }) : null, children] }));
});
/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */
export const Input = forwardRef(function Input({ className, ...props }, ref) {
    return (_jsx("input", { ref: ref, className: cn('h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink', 'placeholder:text-subtle', 'transition-colors focus:border-accent focus:outline-none', 'disabled:cursor-not-allowed disabled:opacity-60', className), ...props }));
});
export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
    return (_jsx("textarea", { ref: ref, className: cn('w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink', 'placeholder:text-subtle resize-y', 'transition-colors focus:border-accent focus:outline-none', 'disabled:cursor-not-allowed disabled:opacity-60', className), ...props }));
});
export function Label({ className, children, hint, ...props }) {
    return (_jsxs("label", { className: cn('block space-y-1.5', className), ...props, children: [_jsx("span", { className: "block text-[13px] font-medium text-ink", children: children }), hint ? _jsx("span", { className: "block text-xs leading-relaxed text-muted", children: hint }) : null] }));
}
const BADGE_TONES = {
    neutral: 'bg-raised text-muted border-line',
    accent: 'bg-accent-soft text-accent border-accent/25',
    success: 'bg-success-soft text-success border-success/25',
    warning: 'bg-warning-soft text-warning border-warning/25',
    danger: 'bg-danger-soft text-danger border-danger/25',
    info: 'bg-info-soft text-info border-info/25',
    thinking: 'bg-thinking-soft text-thinking border-thinking/25',
};
export function Badge({ tone = 'neutral', className, children, ...props }) {
    return (_jsx("span", { className: cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5', 'text-[11px] font-medium leading-none whitespace-nowrap', BADGE_TONES[tone], className), ...props, children: children }));
}
/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */
export function Card({ className, children, ...props }) {
    return (_jsx("div", { className: cn('rounded-xl border border-line bg-surface', className), ...props, children: children }));
}
export function CardHeader({ title, description, actions, className, }) {
    return (_jsxs("div", { className: cn('flex items-start justify-between gap-4 border-b border-line p-4', className), children: [_jsxs("div", { className: "min-w-0 space-y-1", children: [_jsx("h3", { className: "truncate text-sm font-semibold text-ink", children: title }), description ? _jsx("p", { className: "text-xs leading-relaxed text-muted", children: description }) : null] }), actions ? _jsx("div", { className: "flex shrink-0 items-center gap-2", children: actions }) : null] }));
}
/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */
export function Spinner({ className }) {
    return (_jsx(Loader2, { className: cn('size-4 animate-spin text-muted', className), "aria-label": "Loading" }));
}
export function EmptyState({ icon, title, description, action, className, }) {
    return (_jsxs("div", { className: cn('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className), children: [icon ? _jsx("div", { className: "text-subtle [&>svg]:size-8", "aria-hidden": true, children: icon }) : null, _jsxs("div", { className: "space-y-1", children: [_jsx("p", { className: "text-sm font-medium text-ink", children: title }), description ? (_jsx("p", { className: "mx-auto max-w-sm text-[13px] leading-relaxed text-muted", children: description })) : null] }), action] }));
}
/** Skeleton block for loading states, sized by the caller. */
export function Skeleton({ className }) {
    return _jsx("div", { className: cn('animate-pulse rounded-md bg-raised', className) });
}
/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */
export function TooltipProvider({ children }) {
    return (_jsx(TooltipPrimitive.Provider, { delayDuration: 350, skipDelayDuration: 200, children: children }));
}
export function Tooltip({ content, children, side = 'top', }) {
    if (!content)
        return _jsx(_Fragment, { children: children });
    return (_jsxs(TooltipPrimitive.Root, { children: [_jsx(TooltipPrimitive.Trigger, { asChild: true, children: children }), _jsx(TooltipPrimitive.Portal, { children: _jsx(TooltipPrimitive.Content, { side: side, sideOffset: 6, collisionPadding: 8, className: cn('z-50 max-w-xs rounded-lg border border-line bg-raised px-2.5 py-1.5', 'text-xs leading-relaxed text-ink shadow-[var(--mc-shadow)]', 'animate-in-up'), children: content }) })] }));
}
/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */
export function PageHeader({ title, description, actions, }) {
    return (_jsxs("header", { className: "flex flex-wrap items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-6", children: [_jsxs("div", { className: "min-w-0 space-y-1", children: [_jsx("h1", { className: "truncate text-lg font-semibold tracking-tight text-ink", children: title }), description ? (_jsx("p", { className: "text-[13px] leading-relaxed text-muted", children: description })) : null] }), actions ? _jsx("div", { className: "flex shrink-0 flex-wrap items-center gap-2", children: actions }) : null] }));
}
/** A labelled statistic, used across the dashboard and analytics. */
export function Stat({ label, value, hint, tone, icon, }) {
    return (_jsxs("div", { className: "rounded-xl border border-line bg-surface p-4", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("p", { className: "text-xs font-medium uppercase tracking-wide text-subtle", children: label }), icon ? _jsx("span", { className: "text-subtle [&>svg]:size-4", children: icon }) : null] }), _jsx("p", { className: cn('mt-2 text-2xl font-semibold tabular-nums tracking-tight', tone === 'success' && 'text-success', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger', !tone && 'text-ink'), children: value }), hint ? _jsx("p", { className: "mt-1 text-xs text-muted", children: hint }) : null] }));
}
//# sourceMappingURL=primitives.js.map