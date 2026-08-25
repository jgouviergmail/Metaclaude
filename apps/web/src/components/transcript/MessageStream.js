import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { Button, EmptyState } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { ApprovalCard } from './ApprovalCard';
import { AssistantText, ThinkingBlock, TranscriptItem } from './TranscriptItem';
/** Distance from the bottom still treated as "at the bottom". */
const STICKY_THRESHOLD_PX = 120;
export function MessageStream({ events, runs, streaming, approvals, isRunning, onRate, onDecideApproval, emptyHint, }) {
    const scrollRef = useRef(null);
    const bottomRef = useRef(null);
    const [stuckToBottom, setStuckToBottom] = useState(true);
    /* ---------------------------- Scroll tracking ---------------------------- */
    const handleScroll = useCallback(() => {
        const element = scrollRef.current;
        if (!element)
            return;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setStuckToBottom(distance <= STICKY_THRESHOLD_PX);
    }, []);
    const scrollToBottom = useCallback((behavior = 'smooth') => {
        bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
        setStuckToBottom(true);
    }, []);
    // `useLayoutEffect` so the scroll happens in the same frame the new content
    // paints — with `useEffect` the viewport visibly jumps.
    useLayoutEffect(() => {
        if (stuckToBottom)
            bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [events.length, streaming, approvals.length, stuckToBottom]);
    // Jump straight to the end when a different session is opened.
    const firstEventId = events[0]?.id;
    useEffect(() => {
        scrollToBottom('auto');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [firstEventId]);
    /* ------------------------------- Grouping -------------------------------- */
    const groups = useMemo(() => {
        const runById = new Map(runs.map((run) => [run.id, run]));
        const result = [];
        for (const event of events) {
            const last = result[result.length - 1];
            if (last && last.runId === event.runId) {
                last.events.push(event);
            }
            else {
                result.push({ runId: event.runId, run: runById.get(event.runId), events: [event] });
            }
        }
        return result;
    }, [events, runs]);
    const streamingBlocks = useMemo(() => [...streaming.values()], [streaming]);
    /* -------------------------------- Render --------------------------------- */
    if (events.length === 0 && streamingBlocks.length === 0) {
        return (_jsx("div", { className: "flex flex-1 items-center justify-center overflow-y-auto", children: _jsx(EmptyState, { icon: _jsx(Sparkles, {}), title: "Nothing here yet", description: "Describe what you want done. Metaclaude picks the model, recalls what it learned from earlier sessions, and asks before it does anything irreversible.", action: emptyHint }) }));
    }
    return (_jsxs("div", { className: "relative flex min-h-0 flex-1 flex-col", children: [_jsx("div", { ref: scrollRef, onScroll: handleScroll, className: "flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6", children: _jsxs("div", { className: "mx-auto max-w-4xl space-y-6", children: [groups.map((group) => (_jsx("section", { className: "space-y-3", "aria-label": "Exchange", children: group.events.map((event) => (_jsx(TranscriptItem, { event: event, rating: group.run?.rating ?? null, onRate: onRate }, event.id))) }, group.runId))), streamingBlocks.map((block) => block.channel === 'thinking' ? (_jsx(ThinkingBlock, { text: block.text, streaming: true }, block.eventId)) : (_jsx(AssistantText, { text: block.text, streaming: true }, block.eventId))), approvals.map((approval) => (_jsx(ApprovalCard, { request: approval, onDecide: (approved, remember) => onDecideApproval(approval.id, approved, remember) }, approval.id))), isRunning && streamingBlocks.length === 0 && approvals.length === 0 ? (_jsx(WorkingIndicator, {})) : null, _jsx("div", { ref: bottomRef, className: "h-px" })] }) }), !stuckToBottom ? (_jsx("div", { className: "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center", children: _jsxs(Button, { variant: "secondary", size: "sm", onClick: () => scrollToBottom(), className: "pointer-events-auto shadow-[var(--mc-shadow)]", children: [_jsx(ArrowDown, { className: "size-3.5", "aria-hidden": true }), "Jump to latest"] }) })) : null] }));
}
/** Shown between a submitted prompt and the first token, so nothing feels stuck. */
function WorkingIndicator() {
    return (_jsxs("div", { className: "flex items-center gap-2.5 text-[13px] text-muted", role: "status", children: [_jsxs("span", { className: "relative flex size-2", children: [_jsx("span", { className: "absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-70" }), _jsx("span", { className: "relative inline-flex size-2 rounded-full bg-accent" })] }), _jsx("span", { className: cn('animate-pulse'), children: "Working\u2026" })] }));
}
//# sourceMappingURL=MessageStream.js.map