import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Modal dialog and confirmation prompt.
 *
 * On phones the dialog becomes a bottom sheet, which is where a thumb can reach
 * it; on wider screens it centres. Both share one component so behaviour cannot
 * drift between the two.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from './primitives';
import { cn } from '@/lib/utils';
export function Modal({ open, onOpenChange, title, description, children, footer, size = 'md', }) {
    const widths = {
        sm: 'sm:max-w-sm',
        md: 'sm:max-w-lg',
        lg: 'sm:max-w-2xl',
        xl: 'sm:max-w-4xl',
    };
    return (_jsx(Dialog.Root, { open: open, onOpenChange: onOpenChange, children: _jsxs(Dialog.Portal, { children: [_jsx(Dialog.Overlay, { className: "fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" }), _jsxs(Dialog.Content, { className: cn('fixed z-50 flex flex-col border border-line bg-surface shadow-[var(--mc-shadow-lg)]', 
                    // Phone: a bottom sheet pinned to the bottom edge.
                    'inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl', 
                    // Tablet and up: a centred dialog.
                    'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full', 'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl', 'animate-in-up', widths[size]), children: [_jsxs("div", { className: "flex items-start justify-between gap-4 border-b border-line px-5 py-4", children: [_jsxs("div", { className: "min-w-0 space-y-1", children: [_jsx(Dialog.Title, { className: "text-base font-semibold tracking-tight text-ink", children: title }), description ? (_jsx(Dialog.Description, { className: "text-[13px] leading-relaxed text-muted", children: description })) : null] }), _jsx(Dialog.Close, { asChild: true, children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Close", children: _jsx(X, { className: "size-4" }) }) })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-y-auto px-5 py-4", children: children }), footer ? (_jsx("div", { className: "flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3", children: footer })) : null] })] }) }));
}
/**
 * Confirmation dialog for destructive actions.
 * The confirm button is never focused first — the same principle as the
 * permission prompt.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', danger = false, onConfirm, }) {
    const [busy, setBusy] = useState(false);
    const confirm = async () => {
        setBusy(true);
        try {
            await onConfirm();
            onOpenChange(false);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Modal, { open: open, onOpenChange: onOpenChange, title: title, size: "sm", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => onOpenChange(false), autoFocus: true, children: "Cancel" }), _jsx(Button, { variant: danger ? 'danger' : 'primary', size: "sm", loading: busy, onClick: () => void confirm(), children: confirmLabel })] }), children: _jsx("div", { className: "text-[13px] leading-relaxed text-muted", children: description }) }));
}
//# sourceMappingURL=Modal.js.map