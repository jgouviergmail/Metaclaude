import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Renderers for every transcript event kind.
 *
 * Each kind gets a visual treatment that matches how much attention it deserves:
 * the assistant's answer is the loudest thing on screen, reasoning is quiet and
 * collapsible, tool calls are compact, and the run footer is almost invisible
 * until something goes wrong.
 */
import { AlertCircle, Brain, ChevronRight, CircleDot, Coins, Info, ListChecks, ThumbsDown, ThumbsUp, TriangleAlert, User as UserIcon, } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Badge, Button, Tooltip } from '@/components/ui/primitives';
import { renderMarkdown } from '@/lib/markdown';
import { useUiStore } from '@/lib/store';
import { cn, formatCost, formatDuration, formatTokens } from '@/lib/utils';
import { ToolCallCard } from './ToolCallCard';
import { DiffView } from './DiffView';
/* -------------------------------------------------------------------------- */
/* User message                                                                */
/* -------------------------------------------------------------------------- */
export const UserMessage = memo(function UserMessage({ event, }) {
    return (_jsx("div", { className: "flex justify-end", children: _jsxs("div", { className: "flex max-w-[min(46rem,88%)] items-start gap-2.5", children: [_jsx("div", { className: "min-w-0 rounded-2xl rounded-tr-md border border-accent/20 bg-accent-soft px-4 py-2.5", children: _jsx("p", { className: "whitespace-pre-wrap break-words text-[15px] leading-[1.65] text-ink", children: event.text }) }), _jsx("div", { className: "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-muted", "aria-hidden": true, children: _jsx(UserIcon, { className: "size-3.5" }) })] }) }));
});
/* -------------------------------------------------------------------------- */
/* Assistant text                                                              */
/* -------------------------------------------------------------------------- */
export const AssistantText = memo(function AssistantText({ text, streaming = false, }) {
    // Re-rendering markdown on every streamed token would dominate the frame
    // budget, so the parse is memoised on the text itself.
    const html = useMemo(() => renderMarkdown(text), [text]);
    return (_jsx("div", { className: cn('prose-mc max-w-none text-ink', streaming && 'caret'), dangerouslySetInnerHTML: { __html: html } }));
});
/* -------------------------------------------------------------------------- */
/* Thinking                                                                    */
/* -------------------------------------------------------------------------- */
export const ThinkingBlock = memo(function ThinkingBlock({ text, streaming = false, }) {
    const showThinking = useUiStore((state) => state.showThinking);
    // While streaming, reasoning is the only sign of life — open it by default.
    const [expanded, setExpanded] = useState(streaming);
    if (!showThinking)
        return null;
    const preview = text.replace(/\s+/g, ' ').trim();
    return (_jsxs("div", { className: "overflow-hidden rounded-lg border border-thinking/25 bg-thinking-soft/40", children: [_jsxs("button", { type: "button", onClick: () => setExpanded((value) => !value), className: "flex w-full items-center gap-2 px-3 py-1.5 text-left", "aria-expanded": expanded, children: [_jsx(ChevronRight, { className: cn('size-3.5 shrink-0 text-thinking transition-transform duration-150', expanded && 'rotate-90'), "aria-hidden": true }), _jsx(Brain, { className: "size-3.5 shrink-0 text-thinking", "aria-hidden": true }), _jsx("span", { className: "shrink-0 text-[12px] font-medium text-thinking", children: streaming ? 'Thinking…' : 'Reasoning' }), !expanded ? (_jsx("span", { className: "min-w-0 flex-1 truncate text-[12px] text-muted", children: preview })) : null] }), expanded ? (_jsx("div", { className: "border-t border-thinking/20 px-3 py-2.5", children: _jsx("p", { className: cn('whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.65] text-muted', streaming && 'caret'), children: text }) })) : null] }));
});
/* -------------------------------------------------------------------------- */
/* Todo list                                                                   */
/* -------------------------------------------------------------------------- */
export const TodoList = memo(function TodoList({ event, }) {
    const done = event.items.filter((item) => item.status === 'completed').length;
    const total = event.items.length;
    return (_jsxs("div", { className: "rounded-lg border border-line bg-surface", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-line px-3 py-2", children: [_jsx(ListChecks, { className: "size-3.5 shrink-0 text-accent", "aria-hidden": true }), _jsx("span", { className: "text-[13px] font-medium text-ink", children: "Plan" }), _jsxs("span", { className: "ml-auto text-[11px] tabular-nums text-subtle", children: [done, "/", total] })] }), _jsx("ol", { className: "space-y-1.5 px-3 py-2.5", children: event.items.map((item, index) => (_jsxs("li", { className: "flex items-start gap-2 text-[13px]", children: [_jsx("span", { className: "mt-[3px] shrink-0", "aria-hidden": true, children: item.status === 'completed' ? (_jsx("span", { className: "flex size-3.5 items-center justify-center rounded-full bg-success/20 text-success", children: "\u2713" })) : item.status === 'in_progress' ? (_jsx(CircleDot, { className: "size-3.5 animate-pulse text-accent" })) : (_jsx("span", { className: "block size-3.5 rounded-full border border-line-strong" })) }), _jsx("span", { className: cn('leading-snug', item.status === 'completed' && 'text-subtle line-through', item.status === 'in_progress' && 'font-medium text-ink', item.status === 'pending' && 'text-muted'), children: item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content })] }, `${index}-${item.content}`))) })] }));
});
/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */
export const DiffEvent = memo(function DiffEvent({ event, }) {
    return (_jsx(DiffView, { patch: event.patch, path: event.path, additions: event.additions, deletions: event.deletions, collapsible: true }));
});
/* -------------------------------------------------------------------------- */
/* Subagent                                                                    */
/* -------------------------------------------------------------------------- */
export const SubagentEvent = memo(function SubagentEvent({ event, }) {
    return (_jsxs("div", { className: "rounded-lg border border-info/25 bg-info-soft/40 px-3 py-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Badge, { tone: "info", children: "subagent" }), _jsx("span", { className: "text-[13px] font-medium text-ink", children: event.agentName }), _jsx("span", { className: "min-w-0 flex-1 truncate text-[12.5px] text-muted", children: event.description })] }), event.summary ? (_jsx("p", { className: "mt-1.5 text-[12.5px] leading-relaxed text-muted", children: event.summary })) : null] }));
});
/* -------------------------------------------------------------------------- */
/* System notes                                                                */
/* -------------------------------------------------------------------------- */
export const SystemNote = memo(function SystemNote({ event, }) {
    const Icon = event.level === 'error' ? AlertCircle : event.level === 'warn' ? TriangleAlert : Info;
    return (_jsxs("div", { className: cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed', event.level === 'error' && 'border-danger/25 bg-danger-soft/40 text-ink', event.level === 'warn' && 'border-warning/25 bg-warning-soft/40 text-ink', event.level === 'info' && 'border-line bg-raised text-muted'), children: [_jsx(Icon, { className: cn('mt-px size-3.5 shrink-0', event.level === 'error' && 'text-danger', event.level === 'warn' && 'text-warning', event.level === 'info' && 'text-subtle'), "aria-hidden": true }), _jsx("span", { className: "min-w-0 break-words", children: event.message })] }));
});
/* -------------------------------------------------------------------------- */
/* Run result footer                                                           */
/* -------------------------------------------------------------------------- */
export const ResultFooter = memo(function ResultFooter({ event, rating, onRate, }) {
    const failed = event.status === 'failed';
    const interrupted = event.status === 'interrupted';
    return (_jsxs("div", { className: "space-y-2", children: [event.error ? (_jsxs("div", { className: cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-relaxed', failed ? 'border-danger/30 bg-danger-soft/50' : 'border-warning/30 bg-warning-soft/50'), children: [_jsx(AlertCircle, { className: cn('mt-px size-4 shrink-0', failed ? 'text-danger' : 'text-warning'), "aria-hidden": true }), _jsx("span", { className: "min-w-0 break-words text-ink", children: event.error })] })) : null, _jsxs("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-subtle", children: [_jsx(Badge, { tone: failed ? 'danger' : interrupted ? 'warning' : 'success', children: event.status }), event.usage.durationMs > 0 ? (_jsx("span", { className: "tabular-nums", children: formatDuration(event.usage.durationMs) })) : null, event.usage.turns > 0 ? (_jsxs("span", { className: "tabular-nums", children: [event.usage.turns, " turn", event.usage.turns === 1 ? '' : 's'] })) : null, event.usage.inputTokens + event.usage.outputTokens > 0 ? (_jsx(Tooltip, { content: _jsxs("span", { className: "tabular-nums", children: [formatTokens(event.usage.inputTokens), " in \u00B7", ' ', formatTokens(event.usage.outputTokens), " out \u00B7", ' ', formatTokens(event.usage.cacheReadTokens), " cached"] }), children: _jsxs("span", { className: "cursor-help tabular-nums underline decoration-dotted underline-offset-2", children: [formatTokens(event.usage.inputTokens + event.usage.outputTokens), " tokens"] }) })) : null, event.usage.costUsd > 0 ? (_jsxs("span", { className: "flex items-center gap-1 tabular-nums", children: [_jsx(Coins, { className: "size-3", "aria-hidden": true }), formatCost(event.usage.costUsd)] })) : null, _jsxs("div", { className: "ml-auto flex items-center gap-1", children: [_jsx("span", { className: "mr-1 hidden sm:inline", children: "Was this useful?" }), _jsx(Tooltip, { content: "Good \u2014 reinforce this approach", children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Rate this run as good", "aria-pressed": rating === 1, onClick: () => onRate(rating === 1 ? 0 : 1), className: cn(rating === 1 && 'bg-success-soft text-success'), children: _jsx(ThumbsUp, { className: "size-3.5" }) }) }), _jsx(Tooltip, { content: "Poor \u2014 try something else next time", children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Rate this run as poor", "aria-pressed": rating === -1, onClick: () => onRate(rating === -1 ? 0 : -1), className: cn(rating === -1 && 'bg-danger-soft text-danger'), children: _jsx(ThumbsDown, { className: "size-3.5" }) }) })] })] })] }));
});
/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                  */
/* -------------------------------------------------------------------------- */
export function TranscriptItem({ event, rating, onRate, }) {
    const expandTools = useUiStore((state) => state.expandTools);
    switch (event.kind) {
        case 'user_message':
            return _jsx(UserMessage, { event: event });
        case 'assistant_text':
            return _jsx(AssistantText, { text: event.text });
        case 'thinking':
            return _jsx(ThinkingBlock, { text: event.text });
        case 'tool_call':
            return _jsx(ToolCallCard, { call: event, defaultExpanded: expandTools });
        case 'todo':
            return _jsx(TodoList, { event: event });
        case 'diff':
            return _jsx(DiffEvent, { event: event });
        case 'subagent':
            return _jsx(SubagentEvent, { event: event });
        case 'system':
            return _jsx(SystemNote, { event: event });
        case 'result':
            return (_jsx(ResultFooter, { event: event, rating: rating, onRate: (value) => onRate(event.runId, value) }));
        default:
            return null;
    }
}
//# sourceMappingURL=TranscriptItem.js.map