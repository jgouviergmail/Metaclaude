/**
 * Delegated work — what a run farmed out to subagents, and how it went.
 *
 * Two problems, one place.
 *
 * The transcript recorded a subagent's `status` and never rendered it, so a
 * subagent that failed looked exactly like one that succeeded. That matters
 * more here than almost anywhere else, because a subagent's own work is
 * summarised rather than streamed: if the summary does not say it failed,
 * nothing does, and the run's own result is still a success.
 *
 * And the events are scattered through the transcript wherever the delegation
 * happened, which answers "what happened next" and never "what did this run
 * farm out". The strip answers the second question in one line, above the run.
 */

import { AlertTriangle, Check, CornerDownRight, Loader2 } from 'lucide-react';
import { memo } from 'react';
import type { TranscriptEvent } from '@metaclaude/shared';
import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

type SubagentEventType = Extract<TranscriptEvent, { kind: 'subagent' }>;
type Status = SubagentEventType['status'];

const STATUS = {
  running: { label: 'running', tone: 'info', icon: <Loader2 className="size-3 animate-spin" /> },
  ok: { label: 'done', tone: 'success', icon: <Check className="size-3" /> },
  error: { label: 'failed', tone: 'danger', icon: <AlertTriangle className="size-3" /> },
} as const satisfies Record<Status, { label: string; tone: 'info' | 'success' | 'danger'; icon: unknown }>;

/**
 * How urgent each status is.
 *
 * Used to collapse repeats: seven of eight subagents succeeding is not a
 * success, and taking the last one would report whichever happened to finish
 * last, which is arbitrary.
 */
const SEVERITY: Record<Status, number> = { ok: 0, running: 1, error: 2 };

/* -------------------------------------------------------------------------- */

export const SubagentEvent = memo(function SubagentEvent({
  event,
}: {
  event: SubagentEventType;
}) {
  const status = STATUS[event.status];
  const failed = event.status === 'error';

  return (
    <div
      // A failed delegation is the reason a run's answer is incomplete, and it
      // is otherwise silent. Announcing it is what makes it noticeable.
      role={failed ? 'alert' : undefined}
      className={cn(
        'rounded-lg border px-3 py-2',
        failed ? 'border-danger/30 bg-danger-soft/40' : 'border-info/25 bg-info-soft/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CornerDownRight className="size-3.5 shrink-0 text-info" aria-hidden />
        <span className="text-[13px] font-medium text-ink">{event.agentName}</span>
        <Badge tone={status.tone}>
          {status.icon}
          {status.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{event.description}</span>
      </div>
      {event.summary ? (
        <p className="mt-1.5 border-l-2 border-line pl-2.5 text-[12.5px] leading-relaxed text-muted">
          {event.summary}
        </p>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */

interface Delegate {
  agentName: string;
  count: number;
  status: Status;
}

/** Collapse a run's subagent events into one entry per agent name. */
export function summariseDelegation(events: TranscriptEvent[]): Delegate[] {
  const byName = new Map<string, Delegate>();

  for (const event of events) {
    if (event.kind !== 'subagent') continue;
    const existing = byName.get(event.agentName);
    if (!existing) {
      byName.set(event.agentName, { agentName: event.agentName, count: 1, status: event.status });
      continue;
    }
    existing.count += 1;
    // Worst wins, not last: a fan-out where one of eight failed is a fan-out
    // that failed.
    if (SEVERITY[event.status] > SEVERITY[existing.status]) existing.status = event.status;
  }

  return [...byName.values()];
}

export function DelegationStrip({ events }: { events: TranscriptEvent[] }) {
  const t = useT();
  const delegates = summariseDelegation(events);
  // Most runs delegate nothing. An empty strip on every one of them is a line
  // of chrome to scan past on the way to the answer.
  if (delegates.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-subtle">{t('Delegated to')}</span>
      {delegates.map((delegate) => {
        const status = STATUS[delegate.status];
        return (
          <span
            key={delegate.agentName}
            data-testid={`delegation-${delegate.agentName}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11.5px]',
              delegate.status === 'error'
                ? 'border-danger/30 bg-danger-soft/50 text-ink'
                : 'border-line bg-raised text-muted',
            )}
          >
            <span
              className={cn(
                delegate.status === 'error' && 'text-danger',
                delegate.status === 'running' && 'text-info',
                delegate.status === 'ok' && 'text-success',
              )}
              aria-hidden
            >
              {status.icon}
            </span>
            <span className="font-medium text-ink">{delegate.agentName}</span>
            {delegate.count > 1 ? (
              <span className="tabular-nums text-subtle">×{delegate.count}</span>
            ) : null}
            {/* Visible *and* announced — one copy does both. An `sr-only`
                duplicate beside it would be read twice and, less obviously,
                would make every query for the status ambiguous. */}
            <span className="text-subtle">{status.label}</span>
          </span>
        );
      })}
    </div>
  );
}
