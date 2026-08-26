/**
 * The two boolean controls, in one place.
 *
 * Both existed three times across the pages: a switch and a labelled checkbox,
 * two of them called `Toggle` for different components and the third called
 * `CheckboxRow` for the same component as the second `Toggle`. Same name for
 * different things and different names for the same thing, which is how a
 * component ends up fixed in one copy and not the others.
 *
 * They live beside `primitives.tsx` rather than in it because they are
 * stateful-looking controls with accessibility contracts worth testing on their
 * own, and `controls.test.tsx` is those contracts written down.
 */

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip } from './primitives';

/**
 * On a coarse pointer the control gets a hit area larger than its box.
 *
 * A switch is 20×36 by design: one that filled 44px would loosen every dense
 * row it appears in. An invisible inset pseudo-element takes the press instead,
 * so the thumb gets its target and the layout keeps its density. Shared with
 * `primitives.tsx`, which applies the same idea to small buttons.
 */
const TOUCH_TARGET =
  "pointer-coarse:before:absolute pointer-coarse:before:-inset-3 pointer-coarse:before:content-['']";

export interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  /** The accessible name. Required: an unlabelled switch is unusable by voice or screen reader. */
  label: string;
  /** Shown on hover; defaults to the label. */
  tooltip?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, tooltip, disabled, className }: SwitchProps) {
  return (
    <Tooltip content={tooltip ?? label}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-line-strong',
          TOUCH_TARGET,
          className,
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full transition-[left]',
            checked ? 'left-[1.125rem] bg-accent-ink' : 'left-0.5 bg-surface',
          )}
          aria-hidden
        />
      </button>
    </Tooltip>
  );
}

export interface CheckboxFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** One line saying what turning it on actually does. */
  hint: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A checkbox with a label and an explanatory line.
 *
 * The hint sits *outside* the `<label>` and is wired in with `aria-describedby`.
 * All three copies nested it, which folds the sentence into the accessible
 * *name*: the reader announces "Enable memory Retrieved notes are added to the
 * prompt, checkbox, not checked" every time focus lands, and voice control has
 * no short phrase to target. `aria-describedby` alone does not fix that — the
 * name comes from the label's text content, so the hint has to leave the label.
 */
export function CheckboxField({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: CheckboxFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className={cn('min-w-0', disabled && 'opacity-60')}>
        <label
          htmlFor={id}
          className={cn(
            'block text-[13px] font-medium text-ink',
            !disabled && 'cursor-pointer',
          )}
        >
          {label}
        </label>
        <span id={hintId} className="block text-[12px] leading-relaxed text-muted">
          {hint}
        </span>
      </div>
    </div>
  );
}
