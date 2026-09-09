/**
 * One insight, with the verbs that decide it.
 *
 * Extracted when the Dashboard grew its own review queue: the card had been
 * two hundred lines of JSX inside the Memory page, and a second copy on
 * another screen is the duplication this repository has watched diverge before
 * — the two tab strips that differed by the one class that makes a chip row
 * scroll. One component, two callers, and whatever is added to it lands on
 * both screens at once.
 *
 * A consolidation is deliberately *not* rendered here. It is a decision about
 * rows that already exist rather than an observation to accept or reject, and
 * the generic Accept / Reject pair would be the wrong question entirely —
 * `ConsolidationCard` carries its own verbs. Both callers branch on that before
 * reaching this.
 */

import type { GateOutcome, Insight, ReflexionInsightPayload, Workspace } from '@metaclaude/shared';
import { Check, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { routes } from '@metaclaude/shared';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { Badge, Button, Card, QUIET_LINK } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';
import { INSIGHT_TONE } from '@/lib/insights';
import { cn, formatPercent, formatRelative } from '@/lib/utils';

const OUTCOME_TONE: Record<GateOutcome, 'success' | 'info' | 'neutral' | 'warning'> = {
  kept: 'success',
  superseded: 'info',
  skipped: 'neutral',
  'over-budget': 'warning',
  unjudged: 'warning',
  forgotten: 'neutral',
};

/**
 * A note the operator may still keep — because it is not in the corpus.
 *
 * `forgotten` belongs here and is the reason the set exists in both
 * directions: a kept note whose memory was deleted or reaped is no longer a
 * memory, so the row has to offer `Keep` again. Without it the row showed
 * `Forget` on a memory that was already gone, and pressing it did nothing an
 * operator could see.
 */
const REFUSED: ReadonlySet<GateOutcome> = new Set([
  'skipped',
  'over-budget',
  'unjudged',
  'forgotten',
]);

/**
 * What is in flight, so exactly one control spins.
 *
 * A single `busy` boolean would spin every button on the card at once, which
 * tells an operator that something is happening and not which thing — and this
 * card can have four different requests running from it.
 */
export interface InsightCardBusy {
  deciding?: 'accepted' | 'rejected' | null;
  installing?: boolean;
  /** The index of the gate decision whose `Keep` is in flight. */
  keepingNote?: number | null;
  /** The id of the memory whose `Forget` is in flight. */
  forgetting?: string | null;
}

export function InsightCard({
  insight,
  workspaces,
  gate,
  busy = {},
  onDecide,
  onInstallSkill,
  onKeepNote,
  onForgetMemory,
}: {
  insight: Insight;
  workspaces: readonly Workspace[];
  /**
   * The gate's decisions, already parsed by the caller.
   *
   * Passed rather than parsed here so the parse lives with the page that knows
   * which payloads it is looking at, and so a caller that has no use for the
   * detail — a digest — can simply pass null and get the body instead.
   */
  gate: ReflexionInsightPayload | null;
  busy?: InsightCardBusy;
  onDecide: (status: 'accepted' | 'rejected') => void;
  onInstallSkill?: () => void;
  onKeepNote?: (index: number) => void;
  onForgetMemory?: (memoryId: string) => void;
}) {
  const t = useT();

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={INSIGHT_TONE[insight.kind]}>{insight.kind.replace('_', ' ')}</Badge>
        {/* Which project it was learned in. The list unions the tiers exactly
            as the memory list does — and a lesson is a proposal about
            somewhere, so deciding on one without knowing where it came from is
            guesswork. */}
        <ScopeBadge workspaceId={insight.workspaceId} workspaces={workspaces} />
        <span className="text-caption text-muted">
          {t('confidence')} {formatPercent(insight.confidence)}
        </span>
        <span className="text-caption text-subtle">{formatRelative(insight.createdAt)}</span>
      </div>

      <div className="space-y-1">
        <h3 className="break-words text-heading font-medium text-ink">{insight.title}</h3>
        {gate === null ? (
          <p className="whitespace-pre-wrap text-body leading-relaxed text-muted">{insight.body}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-caption text-subtle">
              {t(
                'What the memory gate made of each note this run proposed. A refused note can still be kept, and a kept one forgotten.',
              )}
            </p>
            <ul className="space-y-2">
              {gate.decisions.map((decision, index) => (
                <li key={index} className="flex flex-wrap items-start gap-2 text-body">
                  <Badge tone={OUTCOME_TONE[decision.outcome]}>{t(decision.outcome)}</Badge>
                  <span className="text-caption text-subtle">{t(decision.level)}</span>
                  <span className="min-w-0 flex-1 text-muted">
                    <span className="font-medium text-ink">{decision.title}</span>
                    {decision.reason ? <span className="text-subtle"> — {decision.reason}</span> : null}
                  </span>
                  {/*
                   * Both directions, because the gate is a judgement and not a
                   * verdict.
                   *
                   * A refused note could be kept and a kept one could not be
                   * undone — so disagreeing with the gate was possible in
                   * exactly one direction, and the note that mattered most (a
                   * wrong keep, which is now in the corpus and will be
                   * recalled) was the one with no way back. `Forget` deletes
                   * the memory the keep created; the row then offers `Keep`
                   * again, so the decision stays reversible either way.
                   */}
                  {REFUSED.has(decision.outcome) && !decision.memoryId ? (
                    onKeepNote ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onKeepNote(index)}
                        loading={busy.keepingNote === index}
                        aria-label={t('Keep {title}', { title: decision.title })}
                      >
                        {t('Keep')}
                      </Button>
                    ) : null
                  ) : decision.memoryId ? (
                    onForgetMemory ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onForgetMemory(decision.memoryId as string)}
                        loading={busy.forgetting === decision.memoryId}
                        aria-label={t('Forget {title}', { title: decision.title })}
                      >
                        {t('Forget')}
                      </Button>
                    ) : null
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* An applied proposal has nothing left to decide, and offering
            `Install skill` again would only hit the registry's unique-name
            conflict. What it owes the operator is the way to what it produced
            — which lives on another screen, and is the whole reason installing
            one felt like losing it. */}
        {insight.status === 'applied' ? (
          insight.kind === 'skill_proposal' ? (
            <Link
              to={routes.agents()}
              className={cn('inline-flex items-center gap-1.5 text-caption font-medium', QUIET_LINK)}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {t('Installed — open it in Skills')}
            </Link>
          ) : (
            <p className="text-caption text-subtle">
              {t('Applied — its effect is in the memory list above.')}
            </p>
          )
        ) : (
          <>
            <Button
              size="sm"
              variant="success"
              onClick={() => onDecide('accepted')}
              loading={busy.deciding === 'accepted'}
            >
              <Check className="size-4" />
              {t('Accept')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDecide('rejected')}>
              <X className="size-4" />
              {t('Reject')}
            </Button>
            {insight.kind === 'skill_proposal' && onInstallSkill ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onInstallSkill}
                loading={busy.installing === true}
              >
                <Sparkles className="size-4" />
                {t('Install skill')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
