/**
 * Transcript container.
 *
 * Two behaviours matter here and both are about not fighting the reader:
 *
 *  - Auto-scroll follows the newest output *only while the reader is already at
 *    the bottom*. The moment they scroll up to read something, streaming text
 *    must stop yanking the viewport, and a "jump to latest" affordance appears.
 *  - Events are grouped by run, so a long session reads as a sequence of
 *    exchanges rather than one undifferentiated column.
 */

import { ArrowDown, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalRequest, Run, TranscriptEvent } from '@metaclaude/shared';
import { Button, EmptyState } from '@/components/ui/primitives';
import type { StreamingBlock } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ApprovalCard } from './ApprovalCard';
import { DelegationStrip } from './Delegation';
import { AssistantText, ThinkingBlock, TranscriptItem } from './TranscriptItem';

/** Distance from the bottom still treated as "at the bottom". */
const STICKY_THRESHOLD_PX = 120;

interface RunGroup {
  runId: string;
  run: Run | undefined;
  events: TranscriptEvent[];
}

export function MessageStream({
  events,
  runs,
  streaming,
  approvals,
  isRunning,
  onRate,
  onRewind,
  onDecideApproval,
  emptyHint,
}: {
  events: TranscriptEvent[];
  runs: Run[];
  streaming: Map<string, StreamingBlock>;
  approvals: ApprovalRequest[];
  isRunning: boolean;
  onRate: (runId: string, rating: number) => void;
  onRewind: (runId: string) => void;
  onDecideApproval: (approvalId: string, approved: boolean, remember: boolean) => void;
  emptyHint?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  /* ---------------------------- Scroll tracking ---------------------------- */

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setStuckToBottom(distance <= STICKY_THRESHOLD_PX);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
    setStuckToBottom(true);
  }, []);

  // `useLayoutEffect` so the scroll happens in the same frame the new content
  // paints — with `useEffect` the viewport visibly jumps.
  useLayoutEffect(() => {
    if (stuckToBottom) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length, streaming, approvals.length, stuckToBottom]);

  // Jump straight to the end when a different session is opened.
  const firstEventId = events[0]?.id;
  useEffect(() => {
    scrollToBottom('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstEventId]);

  /* ------------------------------- Grouping -------------------------------- */

  const groups = useMemo<RunGroup[]>(() => {
    const runById = new Map(runs.map((run) => [run.id, run]));
    const result: RunGroup[] = [];

    for (const event of events) {
      const last = result[result.length - 1];
      if (last && last.runId === event.runId) {
        last.events.push(event);
      } else {
        result.push({ runId: event.runId, run: runById.get(event.runId), events: [event] });
      }
    }
    return result;
  }, [events, runs]);

  const streamingBlocks = useMemo(() => [...streaming.values()], [streaming]);

  /* -------------------------------- Render --------------------------------- */

  if (events.length === 0 && streamingBlocks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto">
        <EmptyState
          icon={<Sparkles />}
          title="Nothing here yet"
          description="Describe what you want done. Metaclaude picks the model, recalls what it learned from earlier sessions, and asks before it does anything irreversible."
          action={emptyHint}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6"
      >
        <div className="mx-auto max-w-4xl space-y-6">
          {groups.map((group) => (
            <section key={group.runId} className="space-y-3" aria-label="Exchange">
              {/* What this run farmed out, in one line. The individual events
                  are scattered through the transcript wherever the delegation
                  happened, which answers "what happened next" and never "what
                  did this run delegate". Renders nothing when it delegated
                  nothing, which is most runs. */}
              <DelegationStrip events={group.events} />

              {group.events.map((event) => (
                <TranscriptItem
                  key={event.id}
                  event={event}
                  rating={group.run?.rating ?? null}
                  onRate={onRate}
                  // Only a run that recorded an anchor can be undone. Offering
                  // the action on one that cannot is a button that exists to
                  // fail.
                  canRewind={Boolean(group.run?.rewindPoint)}
                  onRewind={onRewind}
                />
              ))}
            </section>
          ))}

          {/* Live text not yet committed to the transcript. */}
          {streamingBlocks.map((block) =>
            block.channel === 'thinking' ? (
              <ThinkingBlock key={block.eventId} text={block.text} streaming />
            ) : (
              <AssistantText key={block.eventId} text={block.text} streaming />
            ),
          )}

          {/* Pending prompts sit at the very bottom: they are what blocks progress. */}
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              request={approval}
              onDecide={(approved, remember) => onDecideApproval(approval.id, approved, remember)}
            />
          ))}

          {isRunning && streamingBlocks.length === 0 && approvals.length === 0 ? (
            <WorkingIndicator />
          ) : null}

          <div ref={bottomRef} className="h-px" />
        </div>
      </div>

      {!stuckToBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => scrollToBottom()}
            className="pointer-events-auto shadow-[var(--mc-shadow)]"
          >
            <ArrowDown className="size-3.5" aria-hidden />
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Shown between a submitted prompt and the first token, so nothing feels stuck. */
function WorkingIndicator() {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-muted" role="status">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-70" />
        <span className="relative inline-flex size-2 rounded-full bg-accent" />
      </span>
      <span className={cn('animate-pulse')}>Working…</span>
    </div>
  );
}
