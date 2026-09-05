/**
 * A consolidation proposal, as something to decide rather than something to read.
 *
 * The pass that produces these never merges anything: it notices that several
 * memories say one thing, or that two of them disagree, and files what it
 * found. This card is where that becomes an action, so it has to show the
 * evidence before the buttons — every member, by title, and the survivor named
 * among them. An operator who cannot see what would be deleted has not been
 * asked anything.
 *
 * Two verdicts arrive here and they are not symmetrical:
 *
 *  - **duplicate** — several rows saying one thing. There is a merged text to
 *    apply, and one button to apply it. Where the fact holds beyond this
 *    project, promoting is offered *beside* merging rather than folded into
 *    it: they are two decisions, and one of them changes what every other
 *    workspace recalls.
 *  - **contradictory** — two rows that cannot both be true. There is nothing
 *    to press, deliberately. Which one is right is a judgement the operator
 *    makes by editing or deleting, and a button here would be the system
 *    guessing at it.
 */

import { AlertTriangle, Globe, Layers } from 'lucide-react';
import type { ConsolidationProposal, Workspace } from '@metaclaude/shared';

import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { Badge, Button, Card } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';
import { usePlural } from '@/lib/i18n';

/**
 * Read a proposal out of an insight's payload.
 *
 * Hand-guarded rather than schema-parsed: the schema lives in the API-only
 * half of the contracts package, which nothing the web runs at runtime may
 * import, and the fields this card actually reads are few enough to check
 * outright. A payload from an older shape returns null and the card is not
 * rendered, which is the same outcome as a parse failure and a great deal
 * cheaper than shipping a validator to every visitor.
 */
export function readProposal(payload: string | null): ConsolidationProposal | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<ConsolidationProposal>;
    if (!Array.isArray(parsed.members) || parsed.members.length < 2) return null;
    if (parsed.verdict !== 'duplicate' && parsed.verdict !== 'contradictory') return null;
    if (typeof parsed.winnerId !== 'string') return null;
    // Every member is rendered by title and matched by id; one of the wrong
    // shape would draw an empty row rather than an obviously broken card.
    const shaped = parsed.members.every(
      (member) => typeof member?.id === 'string' && typeof member?.title === 'string',
    );
    if (!shaped) return null;
    return parsed as ConsolidationProposal;
  } catch {
    return null;
  }
}

export function ConsolidationCard({
  proposal,
  workspaces,
  busy = false,
  onApply,
  onDismiss,
}: {
  proposal: ConsolidationProposal;
  workspaces: readonly Workspace[];
  busy?: boolean;
  /** Fold the members together; `promote` also moves the survivor to global. */
  onApply: (promote: boolean) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const plural = usePlural();
  const duplicate = proposal.verdict === 'duplicate' && proposal.merged !== undefined;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={duplicate ? 'accent' : 'danger'}>
          {duplicate ? (
            <Layers className="size-3" aria-hidden />
          ) : (
            <AlertTriangle className="size-3" aria-hidden />
          )}
          {duplicate ? t('Repetition') : t('Contradiction')}
        </Badge>
        {/* The project whose memories these are, which is not necessarily the
            survivor's tier: a group of one workspace's rows can be won by a
            global memory. Same rule as the one the proposal is filed under. */}
        <ScopeBadge
          workspaceId={proposal.members.map((m) => m.workspaceId).find(Boolean) ?? null}
          workspaces={workspaces}
        />
        <h3 className="min-w-0 text-[13.5px] font-medium text-ink">
          {duplicate
            ? plural(
                proposal.members.length,
                '{n} memory says this',
                '{n} memories say the same thing',
              )
            : plural(
                proposal.members.length,
                '{n} memory disagrees',
                '{n} memories disagree with each other',
              )}
        </h3>
      </div>

      <p className="break-words text-[13px] leading-relaxed text-muted">{proposal.reason}</p>

      {/* The evidence, before the buttons. A row marked as the survivor is the
          one that keeps its history — its use count, its reinforcement and its
          place in every past run's genesis. */}
      <ul className="space-y-1">
        {proposal.members.map((member) => (
          <li
            key={member.id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-line bg-sunken px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 break-words text-[12.5px] text-ink">{member.title}</span>
            {member.id === proposal.winnerId && duplicate ? (
              <Badge tone="success">{t('kept')}</Badge>
            ) : duplicate ? (
              <Badge tone="neutral">{t('folded in')}</Badge>
            ) : null}
          </li>
        ))}
      </ul>

      {duplicate && proposal.merged ? (
        <div className="space-y-1 rounded-lg border border-accent/30 bg-accent-soft/30 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
            {t('What would be kept')}
          </p>
          <p className="break-words text-[13px] font-medium text-ink">{proposal.merged.title}</p>
          {/* Bounded but complete: the arbiter may return up to four thousand
              characters, and neither burying the buttons under all of it nor
              clamping away the half an operator is being asked to approve is
              acceptable. It scrolls. */}
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted">
            {proposal.merged.content}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {duplicate ? (
          <>
            <Button variant="primary" size="sm" loading={busy} onClick={() => onApply(false)}>
              {t('Merge')}
            </Button>
            {proposal.promotable ? (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onApply(true)}>
                <Globe className="size-4" aria-hidden />
                {t('Merge and make global')}
              </Button>
            ) : null}
          </>
        ) : null}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss}>
          {duplicate ? t('Keep them separate') : t('Dismiss')}
        </Button>
      </div>

      {proposal.promotable && duplicate ? (
        <p className="text-[11.5px] leading-relaxed text-subtle">
          {t(
            'This does not name anything specific to one project, so it can be made global — every workspace would then recall it.',
          )}
        </p>
      ) : null}
    </Card>
  );
}
