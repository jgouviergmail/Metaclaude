/**
 * The system's pulse — the dashboard's opening line.
 *
 * One sentence that answers "what is my agent OS doing right now?", and a
 * 24-hour heartbeat beside it: one bar per hour, height = runs, the green
 * part what succeeded and the red cap what failed, empty hours drawn as
 * gaps because a quiet hour is information too. The current hour breathes
 * while runs are in flight — the same pulse the constellation uses, stilled
 * by the same motion preference.
 *
 * Built entirely from queries the dashboard already makes plus one hourly
 * analytics read; no new API surface, no polling beyond the minute.
 */

import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import type { UsagePoint } from '@metaclaude/shared';
import { api } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { cn, formatRelative } from '@/lib/utils';

const HOUR_MS = 60 * 60_000;
const BARS = 24;

export interface PulseBar {
  /** Bucket start, ms. */
  hour: number;
  runs: number;
  ok: number;
  failed: number;
}

/**
 * The last 24 hourly bars, oldest first, holes filled with zero — the
 * series already emits empty buckets, but only inside the range it saw
 * runs in, and a pulse with missing hours would lie about the quiet ones.
 */
export function pulseBars(series: UsagePoint[], now: number): PulseBar[] {
  const byBucket = new Map(series.map((point) => [point.bucket, point]));
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;

  return Array.from({ length: BARS }, (_, i) => {
    const hour = currentHour - (BARS - 1 - i) * HOUR_MS;
    const point = byBucket.get(hour);
    const runs = point?.runs ?? 0;
    const ok = point ? Math.round(point.runs * point.successRate) : 0;
    return { hour, runs, ok, failed: runs - ok };
  });
}

export function SystemPulse({
  activeRuns,
  queuedRuns,
  approvals,
  lastFinishedAt,
  now = Date.now(),
}: {
  activeRuns: number;
  queuedRuns: number;
  approvals: number;
  lastFinishedAt: number | null;
  now?: number;
}) {
  const plural = usePlural();
  const t = useT();
  const uid = useId();

  const pulseQuery = useQuery({
    queryKey: ['analytics', 'pulse'],
    queryFn: () => api.analytics({ days: 1, granularity: 'hour' }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const bars = pulseBars(pulseQuery.data?.series ?? [], now);
  const maxRuns = Math.max(1, ...bars.map((bar) => bar.runs));
  const total = bars.reduce((sum, bar) => sum + bar.runs, 0);

  const sentence =
    activeRuns > 0
      ? [
          plural(activeRuns, '{n} run working right now', '{n} runs working right now'),
          queuedRuns > 0 ? t('{n} queued', { n: queuedRuns }) : null,
          approvals > 0
            ? plural(approvals, '{n} decision waiting on you', '{n} decisions waiting on you')
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : approvals > 0
        ? plural(approvals, '{n} decision waiting on you', '{n} decisions waiting on you')
        : lastFinishedAt
          ? t(
            'All quiet — the last run finished {when}.',
            { when: formatRelative(lastFinishedAt) },
          )
          : t('All quiet. Send a message, or fill the board and let it work.');

  const W = BARS * 9;
  const H = 36;

  return (
    <div className="mc-card flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3.5">
      <p
        className={cn(
          'min-w-0 text-[15px] font-medium leading-relaxed',
          activeRuns > 0 ? 'text-ink' : 'text-muted',
        )}
        role="status"
      >
        {activeRuns > 0 ? (
          <span className="mr-2 inline-flex size-2 align-middle" aria-hidden>
            <span className="absolute inline-flex size-2 animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
        ) : null}
        {sentence}
      </p>

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t('{n} runs over the last 24 hours', { n: total })}
        className="shrink-0"
      >
        <defs>
          <linearGradient id={`${uid}-ok`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--mc-success)" stopOpacity={0.95} />
            <stop offset="100%" stopColor="var(--mc-success)" stopOpacity={0.45} />
          </linearGradient>
          <linearGradient id={`${uid}-fail`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--mc-danger)" stopOpacity={0.95} />
            <stop offset="100%" stopColor="var(--mc-danger)" stopOpacity={0.5} />
          </linearGradient>
        </defs>
        {bars.map((bar, i) => {
          const x = i * 9 + 1;
          if (bar.runs === 0) {
            // A quiet hour is a tick, not a bar — and not an absence.
            return (
              <rect key={bar.hour} x={x} y={H - 2.5} width={7} height={1.5} rx={0.75} fill="var(--mc-border)" />
            );
          }
          const height = 4 + (bar.runs / maxRuns) * (H - 8);
          const okHeight = bar.runs > 0 ? (bar.ok / bar.runs) * height : 0;
          const isNow = i === BARS - 1;
          return (
            <g key={bar.hour} className={cn(isNow && activeRuns > 0 && 'constellation-live')}>
              <rect
                x={x}
                y={H - okHeight}
                width={7}
                height={okHeight}
                rx={1}
                fill={`url(#${uid}-ok)`}
              />
              {bar.failed > 0 ? (
                <rect
                  x={x}
                  y={H - height}
                  width={7}
                  height={height - okHeight}
                  rx={1}
                  fill={`url(#${uid}-fail)`}
                />
              ) : null}
              <title>
                {new Date(bar.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} —{' '}
                {t('{n} runs', { n: bar.runs })}
                {bar.failed > 0 ? ` · ${t('{n} failed', { n: bar.failed })}` : ''}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
