/**
 * Where the subscription actually went.
 *
 * Analytics could already scope to one workspace at a time, which answers "how
 * much did this one cost" and never "which one is eating the quota". On a plan
 * with a weekly ceiling that second question is the one that matters, and it is
 * the only one that needs every workspace on screen together — so it cannot be
 * a filter, it has to be a comparison.
 *
 * Two decisions about how a proportional chart tells the truth.
 *
 * The bars are scaled against the *heaviest* workspace, not against the total.
 * Against the total, four similar workspaces are four short stubs and the chart
 * says nothing; against the leader the comparison is legible at a glance. The
 * share of the whole is then stated as a number beside it, because "twice as
 * long as the other one" is otherwise easily read as "half the quota".
 *
 * And a single workspace gets no percentage at all. One bar at 100% looks like
 * a finding, and it is not one — it is the absence of anything to compare.
 */

import type { WorkspaceUsage } from '@metaclaude/shared';
import { formatCost, formatTokens } from '@/lib/utils';

export function WorkspaceUsageBars({ rows }: { rows: WorkspaceUsage[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-subtle">
        No usage in this period.
      </p>
    );
  }

  const totals = rows.map((row) => row.inputTokens + row.outputTokens);
  // Both directions are billed, so a chart that plotted only input would rank
  // a long-context reader above a workspace that wrote ten times as much.
  const heaviest = Math.max(...totals);
  const overall = totals.reduce((sum, value) => sum + value, 0);
  const comparable = rows.length > 1;

  return (
    <ul className="space-y-2.5">
      {rows.map((row, index) => {
        const tokens = totals[index] as number;
        // Guarded: a fresh install has every figure at zero, and the naive
        // version renders `NaN%` widths that collapse the whole chart.
        const relative = heaviest > 0 ? (tokens / heaviest) * 100 : 0;
        const share = overall > 0 ? Math.round((tokens / overall) * 100) : 0;

        return (
          <li key={row.workspaceId} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  className="size-2.5 shrink-0 translate-y-px rounded-[3px]"
                  style={{ background: row.color }}
                  aria-hidden
                />
                <span className="truncate text-[13px] font-medium text-ink">{row.name}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2 text-[11.5px] tabular-nums text-muted">
                <span>{formatTokens(tokens)}</span>
                {/* Only where a cost was actually reported. A subscription
                    reports none, and "$0.00" on every row reads as "this was
                    free", which is exactly backwards. */}
                {row.costUsd > 0 ? <span>{formatCost(row.costUsd)}</span> : null}
                <span>
                  {row.runs} run{row.runs === 1 ? '' : 's'}
                </span>
                {comparable ? <span className="w-8 text-right text-ink">{share}%</span> : null}
              </span>
            </div>

            <div
              className="h-2 w-full overflow-hidden rounded-full bg-raised"
              // The bar itself is invisible to a screen reader, so the row says
              // what it depicts rather than leaving a decorative div.
              aria-label={`${row.name}: ${formatTokens(tokens)} tokens across ${row.runs} run${
                row.runs === 1 ? '' : 's'
              }${comparable ? `, ${share}% of the period` : ''}`}
            >
              <div
                data-testid="usage-bar"
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${relative}%`, background: row.color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
