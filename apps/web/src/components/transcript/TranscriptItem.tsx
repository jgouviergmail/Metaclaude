/**
 * Renderers for every transcript event kind.
 *
 * Each kind gets a visual treatment that matches how much attention it deserves:
 * the assistant's answer is the loudest thing on screen, reasoning is quiet and
 * collapsible, tool calls are compact, and the run footer is almost invisible
 * until something goes wrong.
 */

import {
  AlertCircle,
  Brain,
  ChevronRight,
  CircleDot,
  Coins,
  Info,
  ListChecks,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  User as UserIcon,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { TranscriptEvent } from '@metaclaude/shared';
import { Badge, Button, Tooltip } from '@/components/ui/primitives';
import { renderMarkdown } from '@/lib/markdown';
import { useUiStore } from '@/lib/store';
import { cn, formatCost, formatDuration, formatTokens } from '@/lib/utils';
import { ToolCallCard } from './ToolCallCard';
import { DiffView } from './DiffView';

/* -------------------------------------------------------------------------- */
/* User message                                                                */
/* -------------------------------------------------------------------------- */

export const UserMessage = memo(function UserMessage({
  event,
}: {
  event: Extract<TranscriptEvent, { kind: 'user_message' }>;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[min(46rem,88%)] items-start gap-2.5">
        <div className="min-w-0 rounded-2xl rounded-tr-md border border-accent/20 bg-accent-soft px-4 py-2.5">
          {/* User text is plain, not markdown: they typed it, we show it verbatim. */}
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.65] text-ink">
            {event.text}
          </p>
        </div>
        <div
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-muted"
          aria-hidden
        >
          <UserIcon className="size-3.5" />
        </div>
      </div>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Assistant text                                                              */
/* -------------------------------------------------------------------------- */

export const AssistantText = memo(function AssistantText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  // Re-rendering markdown on every streamed token would dominate the frame
  // budget, so the parse is memoised on the text itself.
  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    <div
      className={cn('prose-mc max-w-none text-ink', streaming && 'caret')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* Thinking                                                                    */
/* -------------------------------------------------------------------------- */

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const showThinking = useUiStore((state) => state.showThinking);
  // While streaming, reasoning is the only sign of life — open it by default.
  const [expanded, setExpanded] = useState(streaming);

  if (!showThinking) return null;

  const preview = text.replace(/\s+/g, ' ').trim();

  return (
    <div className="overflow-hidden rounded-lg border border-thinking/25 bg-thinking-soft/40">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-thinking transition-transform duration-150',
            expanded && 'rotate-90',
          )}
          aria-hidden
        />
        <Brain className="size-3.5 shrink-0 text-thinking" aria-hidden />
        <span className="shrink-0 text-[12px] font-medium text-thinking">
          {streaming ? 'Thinking…' : 'Reasoning'}
        </span>
        {!expanded ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{preview}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="border-t border-thinking/20 px-3 py-2.5">
          <p
            className={cn(
              'whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.65] text-muted',
              streaming && 'caret',
            )}
          >
            {text}
          </p>
        </div>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Todo list                                                                   */
/* -------------------------------------------------------------------------- */

export const TodoList = memo(function TodoList({
  event,
}: {
  event: Extract<TranscriptEvent, { kind: 'todo' }>;
}) {
  const done = event.items.filter((item) => item.status === 'completed').length;
  const total = event.items.length;

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ListChecks className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="text-[13px] font-medium text-ink">Plan</span>
        <span className="ml-auto text-[11px] tabular-nums text-subtle">
          {done}/{total}
        </span>
      </div>

      <ol className="space-y-1.5 px-3 py-2.5">
        {event.items.map((item, index) => (
          <li key={`${index}-${item.content}`} className="flex items-start gap-2 text-[13px]">
            <span className="mt-[3px] shrink-0" aria-hidden>
              {item.status === 'completed' ? (
                <span className="flex size-3.5 items-center justify-center rounded-full bg-success/20 text-success">
                  ✓
                </span>
              ) : item.status === 'in_progress' ? (
                <CircleDot className="size-3.5 animate-pulse text-accent" />
              ) : (
                <span className="block size-3.5 rounded-full border border-line-strong" />
              )}
            </span>
            <span
              className={cn(
                'leading-snug',
                item.status === 'completed' && 'text-subtle line-through',
                item.status === 'in_progress' && 'font-medium text-ink',
                item.status === 'pending' && 'text-muted',
              )}
            >
              {item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */

export const DiffEvent = memo(function DiffEvent({
  event,
}: {
  event: Extract<TranscriptEvent, { kind: 'diff' }>;
}) {
  return (
    <DiffView
      patch={event.patch}
      path={event.path}
      additions={event.additions}
      deletions={event.deletions}
      collapsible
    />
  );
});

/* -------------------------------------------------------------------------- */
/* Subagent                                                                    */
/* -------------------------------------------------------------------------- */

export const SubagentEvent = memo(function SubagentEvent({
  event,
}: {
  event: Extract<TranscriptEvent, { kind: 'subagent' }>;
}) {
  return (
    <div className="rounded-lg border border-info/25 bg-info-soft/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge tone="info">subagent</Badge>
        <span className="text-[13px] font-medium text-ink">{event.agentName}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
          {event.description}
        </span>
      </div>
      {event.summary ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{event.summary}</p>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* System notes                                                                */
/* -------------------------------------------------------------------------- */

export const SystemNote = memo(function SystemNote({
  event,
}: {
  event: Extract<TranscriptEvent, { kind: 'system' }>;
}) {
  const Icon = event.level === 'error' ? AlertCircle : event.level === 'warn' ? TriangleAlert : Info;

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed',
        event.level === 'error' && 'border-danger/25 bg-danger-soft/40 text-ink',
        event.level === 'warn' && 'border-warning/25 bg-warning-soft/40 text-ink',
        event.level === 'info' && 'border-line bg-raised text-muted',
      )}
    >
      <Icon
        className={cn(
          'mt-px size-3.5 shrink-0',
          event.level === 'error' && 'text-danger',
          event.level === 'warn' && 'text-warning',
          event.level === 'info' && 'text-subtle',
        )}
        aria-hidden
      />
      <span className="min-w-0 break-words">{event.message}</span>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Run result footer                                                           */
/* -------------------------------------------------------------------------- */

export const ResultFooter = memo(function ResultFooter({
  event,
  rating,
  onRate,
}: {
  event: Extract<TranscriptEvent, { kind: 'result' }>;
  rating: number | null;
  onRate: (value: number) => void;
}) {
  const failed = event.status === 'failed';
  const interrupted = event.status === 'interrupted';

  return (
    <div className="space-y-2">
      {event.error ? (
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-relaxed',
            failed ? 'border-danger/30 bg-danger-soft/50' : 'border-warning/30 bg-warning-soft/50',
          )}
        >
          <AlertCircle
            className={cn('mt-px size-4 shrink-0', failed ? 'text-danger' : 'text-warning')}
            aria-hidden
          />
          <span className="min-w-0 break-words text-ink">{event.error}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-subtle">
        <Badge tone={failed ? 'danger' : interrupted ? 'warning' : 'success'}>
          {event.status}
        </Badge>

        {event.usage.durationMs > 0 ? (
          <span className="tabular-nums">{formatDuration(event.usage.durationMs)}</span>
        ) : null}

        {event.usage.turns > 0 ? (
          <span className="tabular-nums">
            {event.usage.turns} turn{event.usage.turns === 1 ? '' : 's'}
          </span>
        ) : null}

        {event.usage.inputTokens + event.usage.outputTokens > 0 ? (
          <Tooltip
            content={
              <span className="tabular-nums">
                {formatTokens(event.usage.inputTokens)} in ·{' '}
                {formatTokens(event.usage.outputTokens)} out ·{' '}
                {formatTokens(event.usage.cacheReadTokens)} cached
              </span>
            }
          >
            <span className="cursor-help tabular-nums underline decoration-dotted underline-offset-2">
              {formatTokens(event.usage.inputTokens + event.usage.outputTokens)} tokens
            </span>
          </Tooltip>
        ) : null}

        {event.usage.costUsd > 0 ? (
          <span className="flex items-center gap-1 tabular-nums">
            <Coins className="size-3" aria-hidden />
            {formatCost(event.usage.costUsd)}
          </span>
        ) : null}

        {/* Rating is the strongest signal the learner receives, so it sits
            directly under every result rather than behind a menu. */}
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 hidden sm:inline">Was this useful?</span>
          <Tooltip content="Good — reinforce this approach">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Rate this run as good"
              aria-pressed={rating === 1}
              onClick={() => onRate(rating === 1 ? 0 : 1)}
              className={cn(rating === 1 && 'bg-success-soft text-success')}
            >
              <ThumbsUp className="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content="Poor — try something else next time">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Rate this run as poor"
              aria-pressed={rating === -1}
              onClick={() => onRate(rating === -1 ? 0 : -1)}
              className={cn(rating === -1 && 'bg-danger-soft text-danger')}
            >
              <ThumbsDown className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                  */
/* -------------------------------------------------------------------------- */

export function TranscriptItem({
  event,
  rating,
  onRate,
}: {
  event: TranscriptEvent;
  rating: number | null;
  onRate: (runId: string, value: number) => void;
}) {
  const expandTools = useUiStore((state) => state.expandTools);

  switch (event.kind) {
    case 'user_message':
      return <UserMessage event={event} />;
    case 'assistant_text':
      return <AssistantText text={event.text} />;
    case 'thinking':
      return <ThinkingBlock text={event.text} />;
    case 'tool_call':
      return <ToolCallCard call={event} defaultExpanded={expandTools} />;
    case 'todo':
      return <TodoList event={event} />;
    case 'diff':
      return <DiffEvent event={event} />;
    case 'subagent':
      return <SubagentEvent event={event} />;
    case 'system':
      return <SystemNote event={event} />;
    case 'result':
      return (
        <ResultFooter
          event={event}
          rating={rating}
          onRate={(value) => onRate(event.runId, value)}
        />
      );
    default:
      return null;
  }
}
