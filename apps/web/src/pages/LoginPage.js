import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Sign-in.
 *
 * Two-step when TOTP is enabled: the password form submits, the server replies
 * `totp_required`, and the same form swaps to a code field without losing what
 * was typed. The error copy never distinguishes "no such user" from "wrong
 * password", matching what the API does.
 */
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { APP_NAME } from '@metaclaude/shared';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { Button, Input, Label } from '@/components/ui/primitives';
export function LoginPage() {
    const navigate = useNavigate();
    const setUser = useAuthStore((state) => state.setUser);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [totp, setTotp] = useState('');
    const [needsTotp, setNeedsTotp] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const totpRef = useRef(null);
    const { data: bootstrap } = useQuery({
        queryKey: ['bootstrap-status'],
        queryFn: () => api.bootstrapStatus(),
        retry: false,
    });
    useEffect(() => {
        if (needsTotp)
            totpRef.current?.focus();
    }, [needsTotp]);
    const submit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const result = await api.login({
                username,
                password,
                ...(needsTotp ? { totp } : {}),
            });
            if (result.status === 'totp_required') {
                setNeedsTotp(true);
                return;
            }
            setUser(result.user);
            navigate('/', { replace: true });
        }
        catch (caught) {
            const message = caught instanceof ApiError
                ? caught.message
                : 'Could not reach the server. Check that it is running.';
            setError(message);
            // A rejected code is far more often a typo than a wrong password, so keep
            // the operator on the code step rather than sending them back.
            if (needsTotp)
                setTotp('');
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx("div", { className: "flex h-full items-center justify-center bg-bg px-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "mb-8 flex flex-col items-center gap-3 text-center", children: [_jsx(Logo, {}), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold tracking-tight text-ink", children: APP_NAME }), _jsx("p", { className: "mt-1 text-[13px] text-muted", children: "Your private agentic OS." })] })] }), bootstrap?.needsBootstrap ? (_jsxs("div", { className: "mb-4 rounded-xl border border-warning/30 bg-warning-soft/40 p-4 text-[13px] leading-relaxed text-ink", children: [_jsx("p", { className: "font-medium", children: "No account exists yet." }), _jsxs("p", { className: "mt-1 text-muted", children: ["Set ", _jsx("code", { className: "font-mono text-[12px]", children: "METACLAUDE_BOOTSTRAP_USER" }), " and", ' ', _jsx("code", { className: "font-mono text-[12px]", children: "METACLAUDE_BOOTSTRAP_PASSWORD" }), " in your", ' ', _jsx("code", { className: "font-mono text-[12px]", children: ".env" }), ", then restart the container."] })] })) : null, _jsxs("form", { onSubmit: (event) => void submit(event), className: "space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-[var(--mc-shadow)]", children: [!needsTotp ? (_jsxs(_Fragment, { children: [_jsxs(Label, { htmlFor: "username", children: ["Username", _jsx(Input, { id: "username", value: username, onChange: (event) => setUsername(event.target.value), autoComplete: "username", autoFocus: true, required: true, className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "password", children: ["Password", _jsx(Input, { id: "password", type: "password", value: password, onChange: (event) => setPassword(event.target.value), autoComplete: "current-password", required: true, className: "mt-1.5" })] })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent", children: [_jsx(ShieldCheck, { className: "size-4 shrink-0", "aria-hidden": true }), "Enter the code from your authenticator app."] }), _jsxs(Label, { htmlFor: "totp", hint: "A recovery code also works here.", children: ["Verification code", _jsx(Input, { id: "totp", ref: totpRef, value: totp, onChange: (event) => setTotp(event.target.value.trim()), inputMode: "numeric", autoComplete: "one-time-code", placeholder: "123456", required: true, className: "mt-1.5 text-center font-mono text-lg tracking-[0.35em]" })] })] })), error ? (_jsx("p", { role: "alert", className: "text-[13px] leading-relaxed text-danger", children: error })) : null, _jsxs(Button, { type: "submit", variant: "primary", size: "lg", className: "w-full", loading: busy, children: [busy ? _jsx(Loader2, { className: "size-4 animate-spin" }) : _jsx(KeyRound, { className: "size-4" }), needsTotp ? 'Verify' : 'Sign in'] }), needsTotp ? (_jsx("button", { type: "button", onClick: () => {
                                setNeedsTotp(false);
                                setTotp('');
                                setError(null);
                            }, className: "w-full text-center text-[12.5px] text-muted hover:text-ink", children: "Use a different account" })) : null] }), _jsx("p", { className: "mt-6 text-center text-[11.5px] leading-relaxed text-subtle", children: "This instance is private. Every action is recorded in a tamper-evident audit log." })] }) }));
}
function Logo() {
    return (_jsxs("svg", { viewBox: "0 0 32 32", className: "size-12", "aria-hidden": true, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "mc-login-logo", x1: "0", y1: "0", x2: "1", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: "var(--mc-accent)" }), _jsx("stop", { offset: "100%", stopColor: "var(--mc-thinking)" })] }) }), _jsx("circle", { cx: "16", cy: "16", r: "11", fill: "none", stroke: "url(#mc-login-logo)", strokeWidth: "3", strokeLinecap: "round", strokeDasharray: "52 17", transform: "rotate(-45 16 16)" }), _jsx("circle", { cx: "16", cy: "16", r: "3.5", fill: "url(#mc-login-logo)" })] }));
}
//# sourceMappingURL=LoginPage.js.map