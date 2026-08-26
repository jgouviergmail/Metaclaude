/**
 * The subscription's quota, as the CLI reports it.
 *
 * Answers the question a plan with ceilings actually raises — "how close am I
 * to the wall, and when does it move" — window by window: the five-hour
 * session window, the weekly ones, the per-model buckets. The tone escalates
 * with utilization because the bar that matters is the one about to be hit.
 *
 * Truthfulness rules: a plan without windows says so in words ("does not
 * apply") rather than rendering nothing, and the attribution block carries
 * the CLI's own caveat — it is read from this machine's transcripts, so other
 * devices and claude.ai are invisible to it.
 */

import type { ClaudeUsage } from '@metaclaude/shared';
import { cn } from '@/lib/utils';

function untilLabel(resetsAt: number, now: number): string {
  const delta = resetsAt - now;
  if (delta <= 60_000) return 'resets now';
  if (delta < 3_600_000) return `resets in ${Math.round(delta / 60_000)}m`;
  if (delta < 86_400_000) return `resets in ${Math.round(delta / 3_600_000)}h`;
  return `resets in ${Math.round(delta / 86_400_000)}d`;
}

function tone(utilization: number | null): string {
  if (utilization === null) return 'bg-line-strong';
  if (utilization >= 90) return 'bg-danger';
  if (utilization >= 75) return 'bg-warning';
  return 'bg-accent';
}

export function QuotaPanel({ usage, now = Date.now() }: { usage: ClaudeUsage; now?: number }) {
  if (usage.unavailable.includes('rate_limits')) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-subtle">
        Plan quota windows do not apply here — this credential is an API key or a third-party
        provider, billed per token instead.
      </p>
    );
  }
  if (usage.unavailable.includes('usage') || usage.unavailable.includes('session')) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-subtle">
        The CLI could not report quota here — its usage endpoint is unavailable in this version.
      </p>
    );
  }

  const day = usage.behaviors?.day;
  const attributions = day
    ? [
        ...day.behaviors.map((behavior) => ({ name: behavior.key, pct: behavior.pct })),
        ...day.agents,
        ...day.skills,
        ...day.plugins,
        ...day.mcpServers,
      ].filter((share) => share.pct >= 1)
    : [];

  return (
    <div className="space-y-4">
      <ul className="space-y-2.5">
        {usage.windows.map((window) => (
          <li key={window.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[13px] font-medium text-ink">{window.label}</span>
              <span className="flex shrink-0 items-baseline gap-2 text-[11.5px] tabular-nums text-muted">
                {window.resetsAt !== null ? <span>{untilLabel(window.resetsAt, now)}</span> : null}
                <span className="w-9 text-right text-ink">
                  {window.utilization !== null ? `${Math.round(window.utilization)}%` : '—'}
                </span>
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-raised"
              aria-label={`${window.label}: ${
                window.utilization !== null ? `${Math.round(window.utilization)}% used` : 'usage unknown'
              }${window.resetsAt !== null ? `, ${untilLabel(window.resetsAt, now)}` : ''}`}
            >
              <div
                data-testid={`quota-bar-${window.key}`}
                className={cn('h-full rounded-full transition-[width] duration-500', tone(window.utilization))}
                style={{ width: `${Math.min(100, window.utilization ?? 0)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>

      {usage.extraUsage?.isEnabled ? (
        <p className="text-[12px] tabular-nums text-muted">
          Extra usage credits: {usage.extraUsage.usedCredits ?? 0}
          {usage.extraUsage.monthlyLimit !== null ? ` of ${usage.extraUsage.monthlyLimit}` : ''}
          {usage.extraUsage.utilization !== null ? ` (${Math.round(usage.extraUsage.utilization)}%)` : ''}
        </p>
      ) : null}

      {day && attributions.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[12px] font-medium text-ink">
            What consumed it today
            <span className="ml-2 font-normal text-subtle">
              {day.requestCount} requests · {day.sessionCount} sessions
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {attributions.map((share) => (
              <span
                key={share.name}
                className="rounded-full bg-raised px-2 py-0.5 font-mono text-[11.5px] text-muted"
              >
                {share.name} {Math.round(share.pct)}%
              </span>
            ))}
          </div>
          <p className="text-[11.5px] text-subtle">
            Approximate — read from this machine's transcripts, so other devices and claude.ai are
            not counted. Categories overlap.
          </p>
        </div>
      ) : null}
    </div>
  );
}
