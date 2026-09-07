/**
 * Show every extension, only the ones a run will see, or only the ones it will not.
 *
 * One component for skills, subagents and MCP servers, for the same reason
 * `BulkActions` is one component: the three tabs render different rows and ask
 * the identical question, and three copies of a segmented row is how one of
 * them ends up missing `[&>*]:shrink-0` and squeezing its chips on a phone.
 *
 * The counts are part of the answer, not decoration. "Inactive 0" tells an
 * operator that nothing is switched off without their having to click and read
 * an empty state, which is the question this filter is usually opened with.
 */

import { FILTER_ROW } from '@/components/ui/layout';
import { CHIP } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type Availability = 'all' | 'enabled' | 'disabled';

/**
 * The options, in the order they read: the widest first, then the two halves.
 * Every label is a catalogue key — see `locales/fr.ts`.
 */
const OPTIONS = [
  { value: 'all' as const, label: 'All statuses' },
  { value: 'enabled' as const, label: 'Active' },
  { value: 'disabled' as const, label: 'Inactive' },
];

/** Narrow a listing to what the filter names. Exported for the tabs and tests. */
export function filterByAvailability<T extends { enabled: boolean }>(
  items: readonly T[],
  value: Availability,
): T[] {
  if (value === 'all') return [...items];
  return items.filter((item) => item.enabled === (value === 'enabled'));
}

export function AvailabilityFilter({
  value,
  onChange,
  items,
  label,
}: {
  value: Availability;
  onChange: (next: Availability) => void;
  /** The unfiltered listing, so each chip can carry its own count. */
  items: readonly { enabled: boolean }[];
  /** Names the group for a screen reader: "Skill availability", say. */
  label: string;
}) {
  const t = useT();
  const counts: Record<Availability, number> = {
    all: items.length,
    enabled: items.filter((item) => item.enabled).length,
    disabled: items.filter((item) => !item.enabled).length,
  };

  return (
    <div className={cn(FILTER_ROW, 'gap-1.5')} role="group" aria-label={label}>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            CHIP,
            value === option.value
              ? 'bg-accent-soft font-medium text-accent'
              : 'border border-line text-muted hover:text-ink',
          )}
        >
          {t(option.label)}{' '}
          <span className="tabular-nums text-subtle">{counts[option.value]}</span>
        </button>
      ))}
    </div>
  );
}
