/**
 * The morning brief — what happened, what needs a human.
 *
 * The headline leads; everything under it is evidence. Failures link
 * straight into their sessions because the next action is always "go look",
 * and the automations the failure guard switched off are named here — the
 * dashboard being where a silently stopped loop finally gets seen.
 */

import { AlertTriangle, ArrowRight, Lightbulb, SquareKanban, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Brief } from '@metaclaude/shared';
import { Badge } from '@/components/ui/primitives';
import { formatRelative, formatTokens } from '@/lib/utils';
import { usePlural, useT, type PluralFn, type TranslateFn } from '@/lib/i18n';

/**
 * The board line's fragments, in the order the operator triages them.
 *
 * Takes the formatter rather than reaching for a hook: it is a plain function,
 * and its four fragments were the last English on this card after the headline
 * — "3 in review · 2 blocked" under a French heading.
 */
function boardParts(board: Brief['board'], t: TranslateFn, plural: PluralFn): string[] {
  const parts: string[] = [];
  // Three of the four are invariant in both languages — "en relecture", "en
  // cours", "à échéance proche" — and only an adjective has to agree, so only
  // "blocked" is worth two keys.
  if (board.inReview > 0) parts.push(t('{n} in review', { n: board.inReview }));
  if (board.blocked > 0) {
    parts.push(plural(board.blocked, '{n} card blocked', '{n} cards blocked'));
  }
  if (board.inFlight > 0) parts.push(t('{n} being worked', { n: board.inFlight }));
  if (board.dueSoon > 0) parts.push(t('{n} due soon', { n: board.dueSoon }));
  return parts;
}

/**
 * The headline, composed here rather than read from `brief.headline`.
 *
 * The server writes that sentence too, and it is English prose assembled from
 * counts — there is no way to translate a finished sentence, and the API has no
 * catalogue of its own. It was the one line of English left on an otherwise
 * French dashboard, and it is the line the whole card exists to deliver: "the
 * one sentence to read when nothing else gets read".
 *
 * Every input it needs is already in the payload — `activity.totalRuns`,
 * `failures`, `pendingApprovals`, `doctor.status`, `board.inReview` — so this
 * is the same sentence built from the same numbers, in the reader's language.
 * `brief.headline` stays on the contract: it is what a caller that is not a
 * browser would read, and removing it would be a breaking change to solve a
 * problem that is entirely the web app's.
 */
function useHeadline(brief: Brief): string {
  const t = useT();
  const plural = usePlural();

  const runs = brief.activity.totalRuns;
  const failures = brief.failures.length;
  const approvals = brief.pendingApprovals;
  const inReview = brief.board?.inReview ?? 0;
  const doctor = brief.doctor.status;

  if (runs === 0 && approvals === 0 && doctor === 'ok' && inReview === 0) {
    return t('A quiet day — no runs in the last 24 hours, and every self-check passes.');
  }

  const parts = [
    runs === 0
      ? t('No runs in the last 24 hours')
      : plural(runs, '{n} run in the last 24 hours', '{n} runs in the last 24 hours'),
  ];
  if (failures > 0) {
    parts.push(plural(failures, '{n} failure worth a look', '{n} failures worth a look'));
  }
  if (approvals > 0) {
    parts.push(
      plural(approvals, '{n} approval waiting on you', '{n} approvals waiting on you'),
    );
  }
  if (inReview > 0) {
    parts.push(
      plural(inReview, '{n} card waiting for review', '{n} cards waiting for review'),
    );
  }
  // The doctor's own three words are catalogue keys; see DoctorReportView.
  if (doctor !== 'ok') parts.push(t('the doctor reports {status}', { status: t(doctor) }));

  return `${parts.join(', ')}.`;
}

export function BriefView({ brief }: { brief: Brief }) {
  const plural = usePlural();
  const t = useT();
  const headline = useHeadline(brief);
  const quotaWorst = brief.quota
    ? [...brief.quota.windows].sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0]
    : null;

  return (
    <div className="space-y-4">
      <p className="text-[14px] font-medium leading-relaxed text-ink">{headline}</p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>
          {formatTokens(brief.activity.totalInputTokens + brief.activity.totalOutputTokens)} {t('tokens')}
        </span>
        {brief.newInsights > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Lightbulb className="size-3" aria-hidden />
            {plural(brief.newInsights, '{n} new insight', '{n} new insights')}
          </span>
        ) : null}
        {quotaWorst && quotaWorst.utilization !== null ? (
          <span>
            {quotaWorst.label}: {Math.round(quotaWorst.utilization)}{t('% used')}
          </span>
        ) : null}
        {brief.automations.nextRun ? (
          <span className="inline-flex items-center gap-1">
            <Timer className="size-3" aria-hidden />
            {t('next automation: {name}', { name: brief.automations.nextRun.name })}
          </span>
        ) : null}
      </div>

      {brief.board && boardParts(brief.board, t, plural).length > 0 ? (
        <Link
          to="/board"
          className="group flex items-center gap-2 text-[12.5px] text-muted hover:text-ink"
        >
          <SquareKanban className="size-3.5 shrink-0 text-accent" aria-hidden />
          <span>{t('Board:')} {boardParts(brief.board, t, plural).join(' · ')}</span>
          <ArrowRight
            className="size-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>
      ) : null}

      {brief.failures.length > 0 ? (
        <ul className="divide-y divide-line">
          {brief.failures.map((failure) => (
            <li key={failure.runId}>
              <Link
                to={`/w/${failure.workspaceId}/s/${failure.sessionId}`}
                className="group flex items-center gap-3 py-2"
              >
                <Badge tone="danger" className="shrink-0">
                  {t('failed')}
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
            {t('Switched off by the failure guard:')}{' '}
            <code className="font-mono">{brief.automations.disabledByGuard.join(', ')}</code>{' '}
            {t('Re-enable them under Automations once the cause is fixed.')}
          </span>
        </p>
      ) : null}
    </div>
  );
}
