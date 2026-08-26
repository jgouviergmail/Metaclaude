/**
 * The morning brief — what happened, what needs a human.
 *
 * The headline leads; everything under it is evidence. Failures link
 * straight into their sessions because the next action is always "go look",
 * and the automations the failure guard switched off are named here — the
 * dashboard being where a silently stopped loop finally gets seen.
 */

import { AlertTriangle, ArrowRight, Lightbulb, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Brief } from '@metaclaude/shared';
import { Badge } from '@/components/ui/primitives';
import { formatRelative, formatTokens } from '@/lib/utils';

export function BriefView({ brief }: { brief: Brief }) {
  const quotaWorst = brief.quota
    ? [...brief.quota.windows].sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0]
    : null;

  return (
    <div className="space-y-4">
      <p className="text-[14px] font-medium leading-relaxed text-ink">{brief.headline}</p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>
          {formatTokens(brief.activity.totalInputTokens + brief.activity.totalOutputTokens)} tokens
        </span>
        {brief.newInsights > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Lightbulb className="size-3" aria-hidden />
            {brief.newInsights} new insight{brief.newInsights === 1 ? '' : 's'}
          </span>
        ) : null}
        {quotaWorst && quotaWorst.utilization !== null ? (
          <span>
            {quotaWorst.label}: {Math.round(quotaWorst.utilization)}% used
          </span>
        ) : null}
        {brief.automations.nextRun ? (
          <span className="inline-flex items-center gap-1">
            <Timer className="size-3" aria-hidden />
            next automation: {brief.automations.nextRun.name}
          </span>
        ) : null}
      </div>

      {brief.failures.length > 0 ? (
        <ul className="divide-y divide-[var(--mc-border)]">
          {brief.failures.map((failure) => (
            <li key={failure.runId}>
              <Link
                to={`/w/${failure.workspaceId}/s/${failure.sessionId}`}
                className="group flex items-center gap-3 py-2"
              >
                <Badge tone="danger" className="shrink-0">
                  failed
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{failure.prompt}</span>
                  <span className="block truncate text-[11.5px] text-muted">
                    <span className="text-ink">{failure.workspaceName}</span>
                    {failure.error ? ` — ${failure.error}` : ''} · {formatRelative(failure.at)}
                  </span>
                </span>
                <ArrowRight
                  className="size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {brief.automations.disabledByGuard.length > 0 ? (
        <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            Switched off by the failure guard:{' '}
            <code className="font-mono">{brief.automations.disabledByGuard.join(', ')}</code> —
            re-enable under Automations once the cause is fixed.
          </span>
        </p>
      ) : null}
    </div>
  );
}
