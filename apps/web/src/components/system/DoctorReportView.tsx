/**
 * The doctor's report — every self-check with its verdict and evidence.
 *
 * Prop-driven; the settings page owns the query. The overall verdict is
 * stated in words above the list, because "is anything wrong" should not
 * require scanning eight rows.
 */

import type { DoctorReport } from '@metaclaude/shared';
import { Badge } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';

const TONE = { ok: 'success', warn: 'warning', fail: 'danger' } as const;

/** English as data — translated at render; see the note in `lib/i18n.tsx`. */
const VERDICT: Record<DoctorReport['status'], string> = {
  ok: 'Everything checks out.',
  warn: 'Working, with something worth a look.',
  fail: 'Something needs attention.',
};

export function DoctorReportView({ report }: { report: DoctorReport }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-[13px] text-ink">
        <Badge tone={TONE[report.status]}>{t(report.status)}</Badge>
        {t(VERDICT[report.status])}
      </p>

      <ul className="divide-y divide-line">
        {report.checks.map((check) => (
          <li key={check.name} className="flex items-start gap-3 py-2">
            <Badge tone={TONE[check.status]} className="mt-0.5 shrink-0">
              {check.status}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <code className="font-mono text-[12.5px] font-medium text-ink">{check.name}</code>
                <span className="text-[12.5px] text-muted">{check.summary}</span>
              </p>
              {check.detail && check.status !== 'ok' ? (
                <p className="mt-0.5 break-words font-mono text-[11.5px] text-subtle">
                  {check.detail}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
