import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Permission prompt.
 *
 * This is the moment where the operator either understands what is about to
 * happen or rubber-stamps it. Three design decisions follow from that:
 *
 *  1. The action is shown verbatim — the actual command, the actual path — not a
 *     paraphrase. A summary you cannot verify is worse than no summary.
 *  2. High-risk calls get a visually distinct treatment and no "always allow"
 *     shortcut, so the dangerous path is never the fast path.
 *  3. Approve is never the default focus. Deny is the safe key.
 */
import { AlertTriangle, Check, Clock, ShieldQuestion, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
const RISK_COPY = {
    low: { label: 'Low risk', blurb: 'Reads data without changing anything.' },
    medium: {
        label: 'Medium risk',
        blurb: 'Writes files, runs a command, or reaches an external service.',
    },
    high: {
        label: 'High risk',
        blurb: 'This command matches a destructive pattern. Read it carefully.',
    },
};
export function ApprovalCard({ request, onDecide, }) {
    const [remember, setRemember] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [remaining, setRemaining] = useState(() => Math.max(0, request.expiresAt - Date.now()));
    // A live countdown, because a prompt that silently expires and denies the tool
    // is confusing without one.
    useEffect(() => {
        const tick = setInterval(() => {
            setRemaining(Math.max(0, request.expiresAt - Date.now()));
        }, 1000);
        return () => clearInterval(tick);
    }, [request.expiresAt]);
    const decide = (approved) => {
        setSubmitting(true);
        onDecide(approved, remember && request.risk !== 'high');
    };
    // Enter/Escape as accelerators, but only Escape maps to the destructive-safe
    // side; approving always needs a deliberate click or ⌘Enter.
    useEffect(() => {
        const onKey = (event) => {
            if (submitting)
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                decide(false);
            }
            else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                decide(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [submitting, remember]);
    const risk = RISK_COPY[request.risk];
    const command = extractCommand(request.input);
    return (_jsxs("div", { className: cn('animate-in-up overflow-hidden rounded-xl border-2 shadow-[var(--mc-shadow)]', request.risk === 'high'
            ? 'border-danger bg-danger-soft/30'
            : request.risk === 'medium'
                ? 'border-warning/60 bg-warning-soft/25'
                : 'border-accent/50 bg-accent-soft/25'), role: "alertdialog", "aria-labelledby": `approval-${request.id}-title`, children: [_jsxs("div", { className: "flex items-start gap-3 px-4 pt-3.5", children: [_jsx("span", { className: cn('mt-0.5 shrink-0 [&>svg]:size-5', request.risk === 'high' ? 'text-danger' : 'text-accent'), "aria-hidden": true, children: request.risk === 'high' ? _jsx(AlertTriangle, {}) : _jsx(ShieldQuestion, {}) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("h3", { id: `approval-${request.id}-title`, className: "text-sm font-semibold text-ink", children: "Permission needed" }), _jsx(Badge, { tone: request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warning' : 'accent', children: risk.label }), _jsx("code", { className: "rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted", children: request.toolName }), remaining > 0 ? (_jsx(Tooltip, { content: "Unanswered prompts are declined automatically.", children: _jsxs("span", { className: "ml-auto flex cursor-help items-center gap-1 text-[11px] tabular-nums text-subtle", children: [_jsx(Clock, { className: "size-3", "aria-hidden": true }), formatCountdown(remaining)] }) })) : null] }), _jsx("p", { className: "mt-1 text-[13px] leading-relaxed text-muted", children: risk.blurb })] })] }), _jsx("div", { className: "mx-4 mt-3 overflow-hidden rounded-lg border border-line bg-surface", children: command ? (_jsx("pre", { className: "max-h-52 overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink", children: command })) : (_jsxs("div", { className: "space-y-1 px-3 py-2.5", children: [_jsx("p", { className: "text-[13px] text-ink", children: request.summary }), _jsx("pre", { className: "max-h-40 overflow-auto font-mono text-[11.5px] text-muted", children: safeJson(request.input) })] })) }), request.reason ? (_jsxs("p", { className: "mx-4 mt-2 text-[12px] leading-relaxed text-muted", children: [_jsx("span", { className: "font-medium text-ink", children: "Why you are being asked: " }), request.reason] })) : null, _jsxs("div", { className: "mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 bg-surface/40 px-4 py-3", children: [_jsxs(Button, { variant: "danger", size: "sm", onClick: () => decide(false), disabled: submitting, 
                        // Deny holds initial focus: the safe choice should be the one a
                        // reflexive Enter press lands on.
                        autoFocus: true, children: [_jsx(X, { className: "size-4", "aria-hidden": true }), "Deny", _jsx("kbd", { className: "ml-1 hidden rounded bg-black/20 px-1 text-[10px] sm:inline", children: "Esc" })] }), _jsxs(Button, { variant: "success", size: "sm", onClick: () => decide(true), disabled: submitting, children: [_jsx(Check, { className: "size-4", "aria-hidden": true }), "Allow"] }), request.risk !== 'high' ? (_jsxs("label", { className: "ml-auto flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted", children: [_jsx("input", { type: "checkbox", checked: remember, onChange: (event) => setRemember(event.target.checked), className: "size-3.5 accent-[var(--mc-accent)]" }), "Remember for this session"] })) : (_jsx("span", { className: "ml-auto text-[11px] text-danger", children: "High-risk actions are always asked individually." }))] })] }));
}
/* -------------------------------------------------------------------------- */
/** Pull the human-verifiable command out of a tool input, when there is one. */
function extractCommand(input) {
    if (!input || typeof input !== 'object')
        return null;
    const record = input;
    if (typeof record.command === 'string')
        return record.command;
    if (typeof record.file_path === 'string' && typeof record.content === 'string') {
        const preview = record.content.slice(0, 800);
        return `${record.file_path}\n\n${preview}${record.content.length > 800 ? '\n…' : ''}`;
    }
    if (typeof record.file_path === 'string')
        return record.file_path;
    if (typeof record.url === 'string')
        return record.url;
    return null;
}
function safeJson(value) {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    }
    catch {
        return String(value);
    }
}
function formatCountdown(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
//# sourceMappingURL=ApprovalCard.js.map