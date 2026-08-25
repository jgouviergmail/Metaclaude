import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Unified diff viewer.
 *
 * Renders a patch with line numbers and add/remove colouring. Long diffs are
 * collapsed to a summary until asked for, because an agent that touched forty
 * files should not push the conversation off screen.
 */
import { ChevronRight, FileDiff, Minus, Plus } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { parseDiff } from '@/lib/markdown';
import { cn } from '@/lib/utils';
/** Diffs longer than this start collapsed. */
const COLLAPSE_THRESHOLD = 40;
export const DiffView = memo(function DiffView({ patch, path, additions, deletions, collapsible = false, }) {
    const lines = useMemo(() => parseDiff(patch), [patch]);
    const long = lines.length > COLLAPSE_THRESHOLD;
    const [expanded, setExpanded] = useState(!collapsible || !long);
    // Derive the counts when the caller did not supply them.
    const stats = useMemo(() => {
        if (additions !== undefined && deletions !== undefined)
            return { additions, deletions };
        let added = 0;
        let removed = 0;
        for (const line of lines) {
            if (line.type === 'add')
                added += 1;
            else if (line.type === 'remove')
                removed += 1;
        }
        return { additions: added, deletions: removed };
    }, [lines, additions, deletions]);
    const visible = expanded ? lines : lines.slice(0, 12);
    return (_jsxs("div", { className: "overflow-hidden rounded-lg border border-line bg-surface", children: [_jsxs("button", { type: "button", onClick: () => setExpanded((value) => !value), disabled: !collapsible && !long, className: cn('flex w-full items-center gap-2 px-3 py-2 text-left', (collapsible || long) && 'hover:bg-raised'), "aria-expanded": expanded, children: [collapsible || long ? (_jsx(ChevronRight, { className: cn('size-3.5 shrink-0 text-subtle transition-transform duration-150', expanded && 'rotate-90'), "aria-hidden": true })) : (_jsx(FileDiff, { className: "size-3.5 shrink-0 text-subtle", "aria-hidden": true })), _jsx("code", { className: "min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink", children: path ?? 'changes' }), _jsxs("span", { className: "flex shrink-0 items-center gap-2 text-[11px] tabular-nums", children: [stats.additions > 0 ? (_jsxs("span", { className: "flex items-center gap-0.5 text-success", children: [_jsx(Plus, { className: "size-3", "aria-hidden": true }), stats.additions] })) : null, stats.deletions > 0 ? (_jsxs("span", { className: "flex items-center gap-0.5 text-danger", children: [_jsx(Minus, { className: "size-3", "aria-hidden": true }), stats.deletions] })) : null] })] }), visible.length > 0 ? (_jsxs("div", { className: "overflow-x-auto border-t border-line", children: [_jsx("table", { className: "w-full border-collapse font-mono text-[12px] leading-[1.55]", children: _jsx("tbody", { children: visible.map((line, index) => (_jsx(DiffRow, { line: line }, index))) }) }), !expanded && lines.length > visible.length ? (_jsxs("button", { type: "button", onClick: () => setExpanded(true), className: "w-full bg-sunken py-1.5 text-[11px] text-muted hover:bg-raised hover:text-ink", children: ["Show ", lines.length - visible.length, " more lines"] })) : null] })) : null] }));
});
const DiffRow = memo(function DiffRow({ line }) {
    if (line.type === 'meta') {
        return (_jsx("tr", { className: "bg-sunken", children: _jsx("td", { colSpan: 3, className: "px-3 py-0.5 text-subtle", children: line.text }) }));
    }
    if (line.type === 'hunk') {
        return (_jsx("tr", { className: "bg-info-soft/40", children: _jsx("td", { colSpan: 3, className: "px-3 py-0.5 text-info", children: line.text }) }));
    }
    return (_jsxs("tr", { className: cn(line.type === 'add' && 'diff-line-add', line.type === 'remove' && 'diff-line-remove'), children: [_jsx("td", { className: "w-10 select-none border-r border-line px-2 text-right align-top text-subtle tabular-nums", children: line.oldLine ?? '' }), _jsx("td", { className: "w-10 select-none border-r border-line px-2 text-right align-top text-subtle tabular-nums", children: line.newLine ?? '' }), _jsxs("td", { className: "whitespace-pre px-3 align-top text-ink", children: [_jsx("span", { className: "select-none text-subtle", "aria-hidden": true, children: line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ' }), line.text] })] }));
});
//# sourceMappingURL=DiffView.js.map