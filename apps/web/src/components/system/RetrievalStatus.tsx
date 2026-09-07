/**
 * The retrieval regime, as a badge with its model — and, when asked, the
 * sentence that explains it and the count of vectors still waiting.
 *
 * Shown wherever a person might otherwise assume "semantic": the Settings
 * row, the Memory page, the Dashboard stat. One component, so the four states
 * are spelled once.
 */

import type { RetrievalStatus as RetrievalStatusValue } from '@metaclaude/shared';
import { Badge } from '@/components/ui/primitives';
import { usePlural, useT } from '@/lib/i18n';
import { describeRetrieval } from '@/lib/retrieval';

export function RetrievalStatus({
  status,
  compact = false,
}: {
  status: RetrievalStatusValue | null | undefined;
  /** Badge and model only — for a header or a table row. */
  compact?: boolean;
}) {
  const t = useT();
  const plural = usePlural();
  const view = describeRetrieval(status);

  return (
    <div className="min-w-0" data-testid="retrieval-status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={view.tone}>{t(view.label)}</Badge>
        {view.model ? <code className="font-mono text-caption text-muted">{view.model}</code> : null}
      </div>
      {compact ? null : (
        <p className="mt-1 text-caption leading-relaxed text-muted">
          {t(view.detail)}
          {view.pending > 0 ? (
            <span className="text-subtle">
              {' '}
              {plural(view.pending, '{n} vector is waiting for a rebuild.', '{n} vectors are waiting for a rebuild.')}
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}
