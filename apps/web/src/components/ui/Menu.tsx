/**
 * Dropdown menu built on Radix, so keyboard navigation, focus trapping and
 * dismissal behaviour are correct without reimplementing them.
 */

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Menu({
  trigger,
  children,
  align = 'start',
  side = 'top',
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            // The maximum width is bounded by the viewport, not only by a
            // comfortable reading measure. Radix sizes the content to its
            // widest child, and several items carry an explanatory sentence
            // under the label: a memory's action menu came out 430px wide on a
            // 390px phone, with every sentence running off the right edge.
            // Capped, the items' `min-w-0 flex-1` lets those sentences wrap.
            'animate-in-up z-50 max-h-[min(24rem,60vh)] min-w-52 overflow-y-auto',
            'max-w-[min(22rem,calc(100vw-1.5rem))]',
            'rounded-xl border border-line bg-raised p-1 shadow-[var(--mc-shadow-lg)]',
          )}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface MenuItemProps
  extends Omit<ComponentPropsWithoutRef<typeof DropdownMenu.Item>, 'onSelect' | 'children'> {
  children: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  onSelect: () => void;
  tone?: 'danger';
  icon?: ReactNode;
  /**
   * Keep the menu open after selecting — for multi-select lists (the Tools
   * picker), where closing on every toggle would cost a reopen per choice.
   */
  keepOpen?: boolean;
}

/**
 * Forwards its ref and spreads the rest of its props, so a Radix `Tooltip` (or
 * anything else that needs a real element handle) can wrap a menu item.
 */
export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { children, description, selected, onSelect, tone, icon, disabled, className, keepOpen, ...rest },
  ref,
) {
  return (
    <DropdownMenu.Item
      ref={ref}
      disabled={disabled}
      // The tick below is `aria-hidden`, so without these two attributes the
      // selected theme, model or tool was visible and nothing more — a
      // screen-reader user heard a list of identical items. Applied only when
      // `selected` is passed: announcing "Delete" as an unchecked checkbox
      // would be worse than saying nothing.
      {...(selected === undefined
        ? {}
        : { role: 'menuitemcheckbox', 'aria-checked': selected })}
      onSelect={(event) => {
        if (keepOpen) event.preventDefault();
        onSelect();
      }}
      {...rest}
      className={cn(
        'flex cursor-pointer select-none items-start gap-2.5 rounded-lg px-2.5 py-2',
        'text-[13px] outline-none transition-colors',
        'data-[highlighted]:bg-surface data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        tone === 'danger' ? 'text-danger' : 'text-ink',
        className,
      )}
    >
      {icon ? <span className="mt-px shrink-0 [&>svg]:size-4">{icon}</span> : null}

      <span className="min-w-0 flex-1">
        <span className="block font-medium">{children}</span>
        {description ? (
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{description}</span>
        ) : null}
      </span>

      {selected ? <Check className="mt-px size-3.5 shrink-0 text-accent" aria-hidden /> : null}
    </DropdownMenu.Item>
  );
});

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
      {children}
    </DropdownMenu.Label>
  );
}
