/**
 * The loop, made visible — one strip between the question and the answer.
 *
 * Every run already lives the cycle the README draws (classify → choose a
 * policy → recall memory → run), but until now nothing showed it happening.
 * This strip narrates it exactly where it happened: a compact line built
 * from the run row alone (no request), and a detail panel — fetched only
 * when opened — with the memories actually injected, the Beta posterior of
 * the arm the choice stood on, and the learner's own sentence.
 *
 * On the run that is currently working, the segments cascade in one after
 * another — a few hundred milliseconds that SHOW the decision being made,
 * once, and never on historic exchanges. `prefers-reduced-motion` disables
 * the cascade entirely (see index.css).
 */

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Workflow } from 'lucide-react';
import { useState } from 'react';
import type { Run, RunPolicy } from '@metaclaude/shared';
import { BetaCurve } from '@/components/analytics/BetaCurve';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { TOUCH_TARGET_Y } from '@/components/ui/touch-target';
import { cn, formatPercent } from '@/lib/utils';

const SOURCE_PHRASE: Record<RunPolicy['source'], string> = {
  learned: 'chosen from experience',
  workspace: 'workspace default',
  explicit: 'your choice',
};

/**
 * Who asked for this run, when it was not the person reading.
 *
 * `user` is absent on purpose: it is the ordinary case, and a strip that
 * labels every run "started by you" stops being read. What matters is the
 * opposite — a run nobody in this browser typed must not read as one somebody
 * did. `api` is the sharpest case: an outside program holding a token asked
 * for it, possibly while nobody was watching, and the run history is the only
 * place that fact surfaces.
 */
const TRIGGER_PHRASE: Partial<Record<Run['triggeredBy'], string>> = {
  automation: 'started by an automation',
  loop: 'started by a loop',
  system: 'started by the system',
  delegation: 'asked by another workspace',
  api: 'asked through the API',
};

const ACTIVE_STATUSES = new Set<Run['status']>(['queued', 'running', 'waiting_approval']);

export function RunGenesis({ run }: { run: Run }) {
  const t = useT();
  const active = ACTIVE_STATUSES.has(run.status);
  const [open, setOpen] = useState(false);

  const genesis = useQuery({
    queryKey: ['run-genesis', run.id],
    queryFn: () => api.runGenesis(run.id),
    enabled: open,
    // Immutable once started — except recall lands just before execution, so
    // while the run is live an empty recall list may still fill in.
    staleTime: active ? 0 : Infinity,
    refetchInterval: (query) =>
      active && (query.state.data?.memories.length ?? 0) === 0 ? 2500 : false,
  });

  const model = String(run.policy.model);
  const trigger = TRIGGER_PHRASE[run.triggeredBy];
  const segments: string[] = [
    ...(trigger ? [t(trigger)] : []),
    ...(run.category ? [run.category] : []),
    `${model === 'default' ? 'auto' : model}${run.policy.effort ? ` @ ${run.policy.effort}` : ''}`,
    t(SOURCE_PHRASE[run.policy.source]),
  ];

  return (
    <div className="pl-0 sm:pl-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={cn(
          'group flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-1.5 py-1 text-[11.5px]',
          'text-subtle transition-colors hover:bg-raised hover:text-muted',
          TOUCH_TARGET_Y,
        )}
      >
        <Workflow
          className={cn('size-3.5 shrink-0 text-accent/70', active && 'animate-pulse')}
          aria-hidden
        />
        {segments.map((segment, index) => (
          <span
            key={`${segment}-${index}`}
            className={cn('flex items-center gap-2', active && 'genesis-step')}
            style={active ? ({ '--step': index } as React.CSSProperties) : undefined}
          >
            {index > 0 ? (
              <span aria-hidden className="text-line">
                →
              </span>
            ) : null}
            <span className={index === 0 && run.category ? 'font-medium text-muted' : undefined}>
              {segment}
            </span>
          </span>
        ))}
        <ChevronDown
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
        <span className="sr-only">{t('Why this run was shaped this way')}</span>
      </button>

      {open ? (
        <div className="mc-card mt-1 space-y-3 rounded-xl border border-line bg-surface p-3 text-[12.5px] leading-relaxed">
          {genesis.isLoading ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : genesis.data ? (
            <>
              {genesis.data.arm ? (
                <div className="flex flex-wrap items-center gap-3">
                  <BetaCurve
                    alpha={genesis.data.arm.alpha}
                    beta={genesis.data.arm.beta}
                    width={120}
                    height={36}
                    tone={run.policy.source === 'learned' ? 'accent' : 'success'}
                    label={t('Posterior for this arm — {pct} expected over {n} trials', {
                      pct: formatPercent(
                        genesis.data.arm.alpha / (genesis.data.arm.alpha + genesis.data.arm.beta),
                      ),
                      n: genesis.data.arm.trials,
                    })}
                  />
                  <p className="min-w-0 flex-1 text-muted">
                    {t('The learner expects {pct} from this arm, over {n} trials here.', {
                      pct: formatPercent(
                        genesis.data.arm.alpha / (genesis.data.arm.alpha + genesis.data.arm.beta),
                      ),
                      n: genesis.data.arm.trials,
                    })}{' '}
                    {genesis.data.explanation ? (
                      <span className="text-subtle">{genesis.data.explanation}</span>
                    ) : null}
                  </p>
                </div>
              ) : (
                <p className="text-muted">
                  {run.policy.source === 'explicit'
                    ? t(
                      'You chose this configuration yourself; the learner watches and records the outcome.',
                    )
                    : t(
                      'No learned arm matches this run yet — its outcome is what teaches the first one.',
                    )}
                </p>
              )}

              {genesis.data.memories.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                    {t('Recalled into this run')}
                  </p>
                <ul className="space-y-1.5">
                  {genesis.data.memories.slice(0, 5).map((memory) => (
                    <li key={memory.id} className="flex items-center gap-2">
                      <Badge tone="thinking">{t(memory.kind)}</Badge>
                      <span className="min-w-0 flex-1 truncate text-ink">{memory.title}</span>
                      <span
                        className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-sunken"
                        role="img"
                        aria-label={t('Retrieval strength {pct}', {
                          pct: formatPercent(memory.score),
                        })}
                      >
                        <span
                          className="block h-full rounded-full bg-accent/70"
                          style={{ width: `${Math.round(memory.score * 100)}%` }}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
                </div>
              ) : (
                <p className="text-subtle">
                  {active
                    ? t('Recalling memory…')
                    : t('Nothing recalled — this run started from the prompt alone.')}
                </p>
              )}

              {(genesis.data.documents?.length ?? 0) > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                    {t('Passages consulted')}
                  </p>
                  <ul className="space-y-1">
                    {genesis.data.documents.slice(0, 5).map((doc) => (
                      <li key={doc.chunkId} className="flex items-center gap-2">
                        <Badge tone="info">{t('doc')}</Badge>
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {[doc.title, doc.heading].filter(Boolean).join(' › ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-subtle">{t('The story of this run could not be read.')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
