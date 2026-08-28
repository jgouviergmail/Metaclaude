/**
 * Modal dialog and confirmation prompt.
 *
 * On phones the dialog becomes a bottom sheet, which is where a thumb can reach
 * it; on wider screens it centres. Both share one component so behaviour cannot
 * drift between the two.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from './primitives';
import { cn } from '@/lib/utils';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = {
    sm: 'sm:max-w-sm',
    md: 'sm:max-w-lg',
    lg: 'sm:max-w-2xl',
    xl: 'sm:max-w-4xl',
  } as const;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cn(
            'fixed z-50 flex flex-col border border-line bg-surface shadow-[var(--mc-shadow-lg)]',
            // Phone: a bottom sheet pinned to the bottom edge.
            'inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl',
            // Tablet and up: a centred dialog.
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl',
            'animate-in-up',
            widths[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0 space-y-1">
              <Dialog.Title className="text-base font-semibold tracking-tight text-ink">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="text-[13px] leading-relaxed text-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Confirmation dialog for destructive actions.
 * The confirm button is never focused first — the same principle as the
 * permission prompt.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Two separate duties on failure, and only the first was being kept.
      //
      // Stay open, so whatever the caller raised is still readable and the
      // action can be retried — closing would leave the user believing a
      // destructive thing succeeded.
      //
      // And absorb the rejection here: the click handler discards this
      // promise, so without a catch a failing confirmation escapes as an
      // unhandled rejection — a console error in the browser, and a red run
      // in a suite where every test passed. Reporting stays the caller's
      // job; every one of them already raises its own toast.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} autoFocus>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            loading={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-muted">{description}</div>
    </Modal>
  );
}
