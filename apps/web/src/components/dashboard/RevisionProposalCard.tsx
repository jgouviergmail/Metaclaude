/**
 * A proposed rewrite of an instruction that is already in force.
 *
 * The one proposal in this inbox that creates nothing. Every other kind lands
 * *disabled* — an accepted skill exists and does nothing until somebody
 * enables it — while a revision shapes the very next run of its workspace,
 * including runs nobody is watching. So this card owes the operator three
 * things the generic row cannot give: the diff, so what they are approving is
 * visible rather than described; the runs behind it, as links, so the claim
 * can be checked rather than trusted; and, once applied, a way back.
 *
 * Rendered from the payload rather than from a fresh read. The diff travelled
 * with the proposal precisely so that what is approved is what was shown — the
 * consolidation fingerprint's discipline, one layer up.
 */

import type { AdvisorProposal, RevisionPayload as RevisionPayloadType } from '@metaclaude/shared';
import { routes } from '@metaclaude/shared';
import { FIELD_LABELS, TARGET_LABELS } from './revision-payload';
import { Check, FileDiff, RotateCcw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DiffView } from '@/components/transcript/DiffView';
import { Badge, Button, Card, QUIET_LINK } from '@/components/ui/primitives';
import { interpolate, useT } from '@/lib/i18n';
import { cn, formatRelative } from '@/lib/utils';

export function RevisionProposalCard({
  proposal,
  payload,
  workspaceName,
  busy = false,
  onAccept,
  onDismiss,
  onRevert,
}: {
  proposal: AdvisorProposal;
  payload: RevisionPayloadType;
  workspaceName?: string;
  busy?: boolean;
  onAccept?: () => void;
  onDismiss?: () => void;
  onRevert?: () => void;
}) {
  const t = useT();
  const applied = proposal.status === 'accepted';
  const reverted = payload.revertedAt !== null;
  /**
   * A revision of something every workspace reaches is a different decision
   * from one confined to this project — the same consequence that makes
   * promoting a memory ask first, and just as invisible from the row it is
   * pressed on.
   */
  const global = payload.target.workspaceId === null && payload.target.kind !== 'workspace';

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="thinking">{t('revision')}</Badge>
        <Badge tone="neutral">{t(TARGET_LABELS[payload.target.kind])}</Badge>
        <code className="font-mono text-body font-medium text-ink">{payload.target.name}</code>
        <span className="text-caption text-subtle">{t(FIELD_LABELS[payload.field])}</span>
        {workspaceName ? <Badge tone="neutral">{workspaceName}</Badge> : null}
        {global ? (
          <Badge tone="warning">{t('reaches every workspace')}</Badge>
        ) : null}
        <span className="text-caption text-subtle">{formatRelative(proposal.createdAt)}</span>
      </div>

      <p className="whitespace-pre-wrap text-body leading-relaxed text-muted">{payload.rationale}</p>

      {/*
        The diff is the card. A revision described in prose and applied
        unseen is the one thing this whole loop must never be, so it is
        rendered rather than summarised — collapsed when long, because a
        forty-line patch should not push the rest of the inbox off screen.
      */}
      {payload.diff ? (
        <DiffView patch={payload.diff} path={`${payload.target.name} · ${payload.field}`} collapsible />
      ) : (
        <p className="flex items-center gap-1.5 text-caption text-subtle">
          <FileDiff className="size-3.5" aria-hidden />
          {t('No diff was recorded for this proposal.')}
        </p>
      )}

      {payload.evidence.length > 0 ? (
        <div className="space-y-1">
          <p className="text-caption font-medium text-muted">
            {t('What it is based on')}
          </p>
          <ul className="space-y-1">
            {payload.evidence.slice(0, 6).map((entry) => (
              <li key={entry.runId} className="text-caption leading-relaxed text-subtle">
                {/*
                  A run id alone is not a destination — the Memory page learned
                  that. A run whose session is gone (retention pruned it) is
                  still worth naming, so it degrades to plain text rather than
                  to a link that resolves nowhere.
                */}
                {entry.sessionId && entry.workspaceId ? (
                  <Link
                    to={routes.session(entry.workspaceId, entry.sessionId)}
                    className={cn('font-mono', QUIET_LINK)}
                  >
                    {entry.runId}
                  </Link>
                ) : (
                  <code className="font-mono">{entry.runId}</code>
                )}
                {entry.note ? <span> — {entry.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {payload.followUp ? (
        <p
          className={cn(
            'text-caption leading-relaxed',
            payload.followUp.recurred ? 'text-warning' : 'text-success',
          )}
        >
          {payload.followUp.recurred
            ? t('Since this was applied, the problem it was meant to fix happened again.')
            : t('Since this was applied, the problem it was meant to fix has not happened again.')}
        </p>
      ) : null}

      <div className={cn('grid grid-cols-2 gap-2 sm:flex sm:flex-wrap', '[&>*]:min-w-0')}>
        {applied ? (
          reverted ? (
            <p className="col-span-2 text-caption text-subtle">
              {interpolate(t('Applied, then taken back {when}.'), {
                when: formatRelative(payload.revertedAt as number),
              })}
            </p>
          ) : onRevert ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRevert}
              loading={busy}
              // Several of these sit on one dashboard, so a name of "Take it
              // back" alone is a button a screen reader cannot tell from its
              // neighbours. The visible label is inside the accessible name,
              // never replaced by it.
              aria-label={interpolate(t('Take it back: “{name}”'), { name: payload.target.name })}
            >
              <RotateCcw className="size-4" aria-hidden />
              {t('Take it back')}
            </Button>
          ) : null
        ) : proposal.status === 'pending' ? (
          <>
            {onAccept ? (
              <Button
                size="sm"
                variant="success"
                onClick={onAccept}
                loading={busy}
                aria-label={interpolate(t('Apply “{name}”'), { name: payload.target.name })}
              >
                <Check className="size-4" aria-hidden />
                {t('Apply')}
              </Button>
            ) : null}
            {onDismiss ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
                disabled={busy}
                aria-label={interpolate(t('Dismiss “{name}”'), { name: payload.target.name })}
              >
                <X className="size-4" aria-hidden />
                {t('Dismiss')}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="col-span-2 text-caption text-subtle">{t('Dismissed.')}</p>
        )}
      </div>
    </Card>
  );
}
