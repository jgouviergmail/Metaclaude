/**
 * The tab strip.
 *
 * A thin wrapper over Radix, and the thinness is the point: three screens had
 * their own copy of the trigger's appearance — `TAB_CLASS` declared
 * byte-for-byte identically in SettingsPage and HelpPage, plus a third variant
 * inline in AgentsPage. Three places to change when the active underline moves.
 *
 * The strip scrolls rather than wrapping. Six sections in French do not fit a
 * 390px screen, and a strip that wraps to two rows pushes the content down on
 * every phone; `scripts/responsive.mjs` tolerates a control outside the frame
 * only when an ancestor genuinely scrolls, which is what makes this deliberate
 * rather than an overflow nobody noticed.
 */

import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = RadixTabs.Root;

export function TabStrip({
  label,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.List> & { label: string; children: ReactNode }) {
  return (
    <RadixTabs.List
      aria-label={label}
      // The gap below the rule belongs to the strip, not to each caller: the
      // three copies carried `mb-5`, `mb-4` and nothing, and factoring the
      // class out without it left the first panel touching the rule.
      className={cn('mb-4 flex gap-1 overflow-x-auto border-b border-line', className)}
      {...props}
    >
      {children}
    </RadixTabs.List>
  );
}

export function TabTrigger({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-body font-medium text-muted',
        'transition-colors hover:text-ink',
        'data-[state=active]:border-accent data-[state=active]:text-ink',
        className,
      )}
      {...props}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabPanel({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content className={cn('focus-visible:outline-none', className)} {...props}>
      {children}
    </RadixTabs.Content>
  );
}
