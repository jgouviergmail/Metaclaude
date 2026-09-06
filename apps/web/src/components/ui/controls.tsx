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
import { TOUCH_TARGET_Y } from '@/components/ui/touch-target';
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
  /**
   * Usually a sentence. A node where the label *is* an identifier — the exact
   * name of a Claude Code tool — so it can be rendered as code and read as the
   * literal string it is, rather than as a word somebody forgot to translate.
   */
  label: ReactNode;
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
            'block text-body font-medium text-ink',
            !disabled && 'cursor-pointer',
            // The box is 16px and a pseudo-element does not render on a
            // replaced element, so the input cannot carry a hit area at all.
            // The label can, and pressing it toggles the box — which makes the
            // row the target it already looked like. One line of `text-body` is
            // 20px, which is under the floor a thumb needs.
            TOUCH_TARGET_Y,
          )}
        >
          {label}
        </label>
        <span id={hintId} className="block text-caption leading-relaxed text-muted">
          {hint}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented control                                                           */
/* -------------------------------------------------------------------------- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** One line under the label. Described, never folded into the name. */
  hint?: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  /**
   * Rendered above the options *and* used as the group's accessible name.
   *
   * The component owns it rather than leaving each caller to write its own
   * paragraph: three call sites did, which meant the visible label and the
   * group's name were two separate strings free to drift, and the visible one
   * was associated with nothing.
   */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<SegmentedOption<T>>;
  className?: string;
}

/**
 * One choice among a few, laid out as a grid.
 *
 * The grid is the whole point and it is not a style preference. A row of
 * `flex-1` buttons cannot shrink below its own text, so the row overflows
 * instead of wrapping: four trigger buttons went off a 390px screen here and an
 * event trigger could not be chosen *or seen* on a phone. French is where it
 * shows — `Planifié · Intervalle · Manuel · Événement` is half again the
 * English. Two columns below the breakpoint, the natural count above it.
 *
 * This replaces three hand-rolled copies that sat in a single card: language,
 * theme and density.
 *
 * The hint stays *inside* the button, because a hint you cannot click is a
 * smaller target for no reason — but the button then carries an explicit
 * `aria-label` of the short label alone. Text inside a control becomes part of
 * its accessible *name*, and `aria-describedby` does not take it back out:
 * without the label the reader announces "Compacte Plus de lignes d'un coup
 * d'œil, pressed" on every focus, and voice control has no short phrase to
 * target. The name still contains the visible label, which is what WCAG's
 * label-in-name rule asks for.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: SegmentedControlProps<T>) {
  const id = useId();
  const columns =
    options.length <= 2
      ? 'grid-cols-2'
      : options.length === 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : 'grid-cols-2 sm:grid-cols-4';
  // An odd count leaves the last option alone in a half-width box on the phone,
  // which reads as a mistake rather than as a choice. It takes the whole row
  // instead, and goes back to one column once there is room for the real count.
  const orphan =
    options.length > 2 && options.length % 2 === 1
      ? '[&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1'
      : '';

  return (
    <div className={className}>
      <p id={`${id}-label`} className="mb-2 text-body font-medium text-ink">
        {label}
      </p>
      <div role="group" aria-labelledby={`${id}-label`} className={cn('grid gap-2', columns, orphan)}>
        {options.map((option) => {
          const hintId = option.hint ? `${id}-${option.value}` : undefined;
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={selected}
              aria-label={option.label}
              aria-describedby={hintId}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-left transition-colors',
                option.icon && 'flex flex-col items-center gap-1.5 text-center [&>svg]:size-5',
                selected
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-muted hover:bg-raised',
              )}
            >
              {option.icon}
              <span className="block text-body font-medium">{option.label}</span>
              {option.hint ? (
                <span id={hintId} className="mt-0.5 block text-caption opacity-80">
                  {option.hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
