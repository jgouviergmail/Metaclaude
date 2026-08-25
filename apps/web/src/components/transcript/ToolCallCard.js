import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Tool call card.
 *
 * A run is mostly tool calls, so this component decides how readable the whole
 * transcript feels. The rule it follows: show what the tool *did* in one line,
 * and keep the payload one click away. A wall of JSON is not observability.
 */
import { AlertTriangle, Check, ChevronRight, Circle, Copy, FileCode, FilePen, FilePlus, Globe, Loader2, Search, Sparkles, Terminal, X, } from 'lucide-react';
import { memo, useState } from 'react';
import { Badge, Tooltip } from '@/components/ui/primitives';
import { cn, copyToClipboard, formatDuration, truncate } from '@/lib/utils';
/** Icon per tool. Unknown tools fall back to the generic MCP sparkle. */
function iconFor(name) {
    switch (name.replace(/^mcp__[^_]+__/, '')) {
        case 'Bash':
            return _jsx(Terminal, {});
        case 'Read':
            return _jsx(FileCode, {});
        case 'Write':
            return _jsx(FilePlus, {});
        case 'Edit':
        case 'NotebookEdit':
            return _jsx(FilePen, {});
        case 'Glob':
        case 'Grep':
            return _jsx(Search, {});
        case 'WebFetch':
        case 'WebSearch':
            return _jsx(Globe, {});
        default:
            return _jsx(Sparkles, {});
    }
}
/**
 * One-line summary of what a tool call is doing.
 * Mirrors the server's `summarise`, but tuned for a narrow column.
 */
function summarise(call) {
    const input = (call.input ?? {});
    const str = (key) => typeof input[key] === 'string' ? input[key] : null;
    const base = call.name.replace(/^mcp__([^_]+)__/, '$1: ');
    switch (call.name.replace(/^mcp__[^_]+__/, '')) {
        case 'Bash':
            return { label: 'Terminal', detail: str('command') };
        case 'Read':
            return { label: 'Read', detail: shortPath(str('file_path')) };
        case 'Write':
            return { label: 'Write', detail: shortPath(str('file_path')) };
        case 'Edit':
            return { label: 'Edit', detail: shortPath(str('file_path')) };
        case 'Glob':
            return { label: 'Find files', detail: str('pattern') };
        case 'Grep':
            return { label: 'Search', detail: str('pattern') };
        case 'WebFetch':
            return { label: 'Fetch', detail: str('url') };
        case 'WebSearch':
            return { label: 'Web search', detail: str('query') };
        case 'Task':
            return { label: 'Subagent', detail: str('description') };
        case 'TodoWrite':
            return { label: 'Plan', detail: null };
        default:
            return { label: base, detail: null };
    }
}
/** Keep the last two path segments, which is what identifies a file at a glance. */
function shortPath(path) {
    if (!path)
        return null;
    const parts = path.split('/').filter(Boolean);
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}
function StatusIcon({ status }) {
    switch (status) {
        case 'running':
            return _jsx(Loader2, { className: "size-3.5 shrink-0 animate-spin text-accent" });
        case 'ok':
            return _jsx(Check, { className: "size-3.5 shrink-0 text-success" });
        case 'error':
            return _jsx(AlertTriangle, { className: "size-3.5 shrink-0 text-danger" });
        case 'denied':
            return _jsx(X, { className: "size-3.5 shrink-0 text-warning" });
        default:
            return _jsx(Circle, { className: "size-3.5 shrink-0 text-subtle" });
    }
}
export const ToolCallCard = memo(function ToolCallCard({ call, defaultExpanded = false, }) {
    // Errors open by default: a failure the user has to click to see is a failure
    // they will miss.
    const [expanded, setExpanded] = useState(defaultExpanded || call.resultIsError);
    const [copied, setCopied] = useState(false);
    const { label, detail } = summarise(call);
    const isCommand = call.name.replace(/^mcp__[^_]+__/, '') === 'Bash';
    const copyPayload = async () => {
        const text = JSON.stringify(call.input, null, 2);
        if (await copyToClipboard(text)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        }
    };
    return (_jsxs("div", { className: cn('overflow-hidden rounded-lg border bg-surface transition-colors', call.resultIsError ? 'border-danger/35' : 'border-line'), children: [_jsxs("button", { type: "button", onClick: () => setExpanded((value) => !value), className: "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raised", "aria-expanded": expanded, children: [_jsx(ChevronRight, { className: cn('size-3.5 shrink-0 text-subtle transition-transform duration-150', expanded && 'rotate-90'), "aria-hidden": true }), _jsx("span", { className: "shrink-0 text-subtle [&>svg]:size-3.5", "aria-hidden": true, children: iconFor(call.name) }), _jsx("span", { className: "shrink-0 text-[13px] font-medium text-ink", children: label }), detail ? (_jsx("code", { className: cn('min-w-0 flex-1 truncate text-[12.5px] text-muted', isCommand && 'font-mono'), children: detail })) : (_jsx("span", { className: "flex-1" })), call.durationMs !== null && call.durationMs > 1500 ? (_jsx("span", { className: "shrink-0 text-[11px] tabular-nums text-subtle", children: formatDuration(call.durationMs) })) : null, _jsx(StatusIcon, { status: call.status })] }), expanded ? (_jsxs("div", { className: "space-y-3 border-t border-line bg-sunken px-3 py-3", children: [_jsxs("section", { children: [_jsxs("div", { className: "mb-1.5 flex items-center justify-between", children: [_jsx("h4", { className: "text-[11px] font-semibold uppercase tracking-wide text-subtle", children: "Input" }), _jsx(Tooltip, { content: copied ? 'Copied' : 'Copy input', children: _jsx("button", { type: "button", onClick: (event) => {
                                                event.stopPropagation();
                                                void copyPayload();
                                            }, className: "rounded p-1 text-subtle hover:bg-raised hover:text-ink", "aria-label": "Copy tool input", children: copied ? _jsx(Check, { className: "size-3.5" }) : _jsx(Copy, { className: "size-3.5" }) }) })] }), _jsx("pre", { className: "max-h-64 overflow-auto rounded-md bg-surface p-2.5 font-mono text-[12px] leading-relaxed text-ink", children: formatInput(call.input, isCommand) })] }), call.result ? (_jsxs("section", { children: [_jsxs("h4", { className: "mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-subtle", children: ["Result", call.resultIsError ? _jsx(Badge, { tone: "danger", children: "error" }) : null] }), _jsx("pre", { className: cn('max-h-80 overflow-auto rounded-md p-2.5 font-mono text-[12px] leading-relaxed', call.resultIsError
                                    ? 'bg-danger-soft text-ink'
                                    : 'bg-surface text-ink'), children: call.result })] })) : null] })) : null] }));
});
/**
 * Render a tool's input for display.
 * A Bash command is shown as the raw command, not as JSON with escaped quotes —
 * that is the form the operator can actually read and verify.
 */
function formatInput(input, isCommand) {
    if (isCommand && input && typeof input === 'object') {
        const record = input;
        if (typeof record.command === 'string') {
            const extras = Object.entries(record)
                .filter(([key]) => key !== 'command')
                .map(([key, value]) => `# ${key}: ${truncate(String(value), 120)}`);
            return [record.command, ...extras].join('\n');
        }
    }
    try {
        return JSON.stringify(input, null, 2) ?? String(input);
    }
    catch {
        return String(input);
    }
}
//# sourceMappingURL=ToolCallCard.js.map