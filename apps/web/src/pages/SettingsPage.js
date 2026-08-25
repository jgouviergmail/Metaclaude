import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Settings — account security, system health and the audit trail.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Cpu, HardDrive, KeyRound, Monitor, Moon, ScrollText, ShieldCheck, Smartphone, Sun, Trash2, } from 'lucide-react';
import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Label, Spinner, Stat, } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useAuthStore, useUiStore } from '@/lib/store';
import { cn, copyToClipboard, formatBytes, formatDateTime, formatDuration, formatRelative, } from '@/lib/utils';
const TAB_CLASS = 'px-3 py-2 text-[13px] font-medium text-muted border-b-2 border-transparent transition-colors data-[state=active]:border-accent data-[state=active]:text-ink hover:text-ink';
export function SettingsPage() {
    const user = useAuthStore((state) => state.user);
    return (_jsxs(AppShell, { children: [_jsx(ContentHeader, { title: "Settings", subtitle: user ? `Signed in as ${user.username} (${user.role})` : undefined, showSidebarToggle: false }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsx("div", { className: "mx-auto max-w-3xl p-4 sm:p-6", children: _jsxs(Tabs.Root, { defaultValue: "security", children: [_jsxs(Tabs.List, { className: "mb-5 flex gap-1 overflow-x-auto border-b border-line", "aria-label": "Settings sections", children: [_jsx(Tabs.Trigger, { value: "security", className: TAB_CLASS, children: "Security" }), _jsx(Tabs.Trigger, { value: "appearance", className: TAB_CLASS, children: "Appearance" }), _jsx(Tabs.Trigger, { value: "system", className: TAB_CLASS, children: "System" }), user?.role === 'owner' ? (_jsx(Tabs.Trigger, { value: "audit", className: TAB_CLASS, children: "Audit log" })) : null] }), _jsxs(Tabs.Content, { value: "security", className: "space-y-4", children: [_jsx(PasswordCard, {}), _jsx(TotpCard, {}), _jsx(SessionsCard, {})] }), _jsx(Tabs.Content, { value: "appearance", children: _jsx(AppearanceCard, {}) }), _jsx(Tabs.Content, { value: "system", children: _jsx(SystemCard, {}) }), user?.role === 'owner' ? (_jsx(Tabs.Content, { value: "audit", children: _jsx(AuditCard, {}) })) : null] }) }) })] }));
}
/* -------------------------------------------------------------------------- */
/* Security                                                                    */
/* -------------------------------------------------------------------------- */
function PasswordCard() {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const change = useMutation({
        mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
        onSuccess: () => {
            toast.success('Password changed. Sign in again with the new one.');
            // Every session was revoked server-side, including this one.
            setTimeout(() => window.location.assign('/login'), 1200);
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not change the password.'),
    });
    const mismatch = confirm.length > 0 && next !== confirm;
    const tooShort = next.length > 0 && next.length < 12;
    return (_jsxs(Card, { children: [_jsx(CardHeader, { title: "Password", description: "Changing it signs out every device, including this one." }), _jsxs("div", { className: "space-y-4 p-4", children: [_jsxs(Label, { htmlFor: "pw-current", children: ["Current password", _jsx(Input, { id: "pw-current", type: "password", autoComplete: "current-password", value: current, onChange: (event) => setCurrent(event.target.value), className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "pw-new", hint: "At least 12 characters. Length matters more than symbols.", children: ["New password", _jsx(Input, { id: "pw-new", type: "password", autoComplete: "new-password", value: next, onChange: (event) => setNext(event.target.value), className: "mt-1.5" })] }), _jsxs(Label, { htmlFor: "pw-confirm", children: ["Confirm new password", _jsx(Input, { id: "pw-confirm", type: "password", autoComplete: "new-password", value: confirm, onChange: (event) => setConfirm(event.target.value), className: cn('mt-1.5', mismatch && 'border-danger') })] }), mismatch ? _jsx("p", { className: "text-[12.5px] text-danger", children: "The passwords do not match." }) : null, tooShort ? (_jsx("p", { className: "text-[12.5px] text-warning", children: "Use at least 12 characters." })) : null, _jsxs(Button, { variant: "primary", size: "sm", loading: change.isPending, disabled: !current || !next || mismatch || tooShort, onClick: () => change.mutate(), children: [_jsx(KeyRound, { className: "size-4", "aria-hidden": true }), "Change password"] })] })] }));
}
function TotpCard() {
    const { user, recoveryCodesRemaining, setUser } = useAuthStore();
    const [enrolling, setEnrolling] = useState(null);
    const [code, setCode] = useState('');
    const [recoveryCodes, setRecoveryCodes] = useState(null);
    const [disabling, setDisabling] = useState(false);
    const [password, setPassword] = useState('');
    const begin = useMutation({
        mutationFn: () => api.totpBegin(),
        onSuccess: (data) => setEnrolling(data),
        onError: () => toast.error('Could not start enrolment.'),
    });
    const confirm = useMutation({
        mutationFn: () => api.totpConfirm(code),
        onSuccess: (data) => {
            setRecoveryCodes(data.recoveryCodes);
            setEnrolling(null);
            setCode('');
            if (user)
                setUser({ ...user, totpEnabled: true }, data.recoveryCodes.length);
            toast.success('Two-factor authentication is on.');
        },
        onError: () => toast.error('That code was not accepted. Check your device clock.'),
    });
    const disable = useMutation({
        mutationFn: () => api.totpDisable(password),
        onSuccess: () => {
            if (user)
                setUser({ ...user, totpEnabled: false }, 0);
            setDisabling(false);
            setPassword('');
            toast.success('Two-factor authentication is off.');
        },
        onError: () => toast.error('That password is incorrect.'),
    });
    return (_jsxs(Card, { children: [_jsx(CardHeader, { title: "Two-factor authentication", description: "A second factor is what keeps a leaked password from becoming a compromised agent OS.", actions: user?.totpEnabled ? (_jsxs(Badge, { tone: "success", children: [_jsx(ShieldCheck, { className: "size-3", "aria-hidden": true }), "on"] })) : (_jsx(Badge, { tone: "warning", children: "off" })) }), _jsx("div", { className: "space-y-3 p-4", children: user?.totpEnabled ? (_jsxs(_Fragment, { children: [_jsxs("p", { className: "text-[13px] text-muted", children: [recoveryCodesRemaining, " recovery code", recoveryCodesRemaining === 1 ? '' : 's', ' ', "remaining.", recoveryCodesRemaining <= 2 ? (_jsx("span", { className: "text-warning", children: " Consider re-enrolling to get a fresh set." })) : null] }), _jsx(Button, { variant: "outline", size: "sm", onClick: () => setDisabling(true), children: "Turn off" })] })) : (_jsxs(Button, { variant: "primary", size: "sm", loading: begin.isPending, onClick: () => begin.mutate(), children: [_jsx(Smartphone, { className: "size-4", "aria-hidden": true }), "Set up"] })) }), _jsx(Modal, { open: Boolean(enrolling), onOpenChange: (open) => !open && setEnrolling(null), title: "Set up two-factor authentication", description: "Add this secret to your authenticator app, then confirm with the code it shows.", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setEnrolling(null), children: "Cancel" }), _jsx(Button, { variant: "primary", size: "sm", loading: confirm.isPending, disabled: !/^\d{6}$/.test(code), onClick: () => confirm.mutate(), children: "Confirm" })] }), children: enrolling ? (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("p", { className: "mb-1.5 text-[13px] font-medium text-ink", children: "Setup key" }), _jsx(CopyableCode, { value: enrolling.secret })] }), _jsxs("div", { children: [_jsx("p", { className: "mb-1.5 text-[13px] font-medium text-ink", children: "Or paste this URI into your app" }), _jsx(CopyableCode, { value: enrolling.uri })] }), _jsxs(Label, { htmlFor: "totp-code", children: ["Code from your app", _jsx(Input, { id: "totp-code", value: code, onChange: (event) => setCode(event.target.value.trim()), inputMode: "numeric", placeholder: "123456", autoFocus: true, className: "mt-1.5 text-center font-mono text-lg tracking-[0.35em]" })] })] })) : null }), _jsx(Modal, { open: Boolean(recoveryCodes), onOpenChange: (open) => !open && setRecoveryCodes(null), title: "Save your recovery codes", description: "Each works once, in place of a code from your app. This is the only time they are shown.", footer: _jsx(Button, { variant: "primary", size: "sm", onClick: () => setRecoveryCodes(null), children: "I have saved them" }), children: _jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "grid grid-cols-2 gap-2 rounded-lg border border-line bg-sunken p-3", children: recoveryCodes?.map((recoveryCode) => (_jsx("code", { className: "font-mono text-[13px] text-ink", children: recoveryCode }, recoveryCode))) }), _jsxs(Button, { variant: "secondary", size: "sm", onClick: () => {
                                void copyToClipboard((recoveryCodes ?? []).join('\n')).then((ok) => ok ? toast.success('Copied') : toast.error('Could not copy'));
                            }, children: [_jsx(Copy, { className: "size-4", "aria-hidden": true }), "Copy all"] })] }) }), _jsx(Modal, { open: disabling, onOpenChange: setDisabling, title: "Turn off two-factor authentication?", description: "Confirm with your password. This weakens your account's security.", size: "sm", footer: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setDisabling(false), children: "Cancel" }), _jsx(Button, { variant: "danger", size: "sm", loading: disable.isPending, disabled: !password, onClick: () => disable.mutate(), children: "Turn off" })] }), children: _jsxs(Label, { htmlFor: "totp-disable-pw", children: ["Password", _jsx(Input, { id: "totp-disable-pw", type: "password", value: password, onChange: (event) => setPassword(event.target.value), className: "mt-1.5" })] }) })] }));
}
function SessionsCard() {
    const queryClient = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['auth-sessions'],
        queryFn: () => api.authSessions(),
    });
    const revoke = useMutation({
        mutationFn: (id) => api.revokeAuthSession(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
            toast.success('Signed out that device');
        },
    });
    const revokeOthers = useMutation({
        mutationFn: () => api.revokeOtherSessions(),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
            toast.success(`Signed out ${result.revoked} other device(s)`);
        },
    });
    const sessions = data?.sessions ?? [];
    return (_jsxs(Card, { children: [_jsx(CardHeader, { title: "Signed-in devices", description: "Anything you do not recognise should be signed out immediately.", actions: sessions.length > 1 ? (_jsx(Button, { variant: "outline", size: "sm", loading: revokeOthers.isPending, onClick: () => revokeOthers.mutate(), children: "Sign out others" })) : null }), isLoading ? (_jsx("div", { className: "flex justify-center py-8", children: _jsx(Spinner, {}) })) : (_jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: sessions.map((session) => (_jsxs("li", { className: "flex items-center gap-3 px-4 py-3", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("p", { className: "flex items-center gap-2 text-[13px] text-ink", children: [_jsx("span", { className: "truncate", children: describeUserAgent(session.userAgent) }), session.current ? _jsx(Badge, { tone: "accent", children: "this device" }) : null] }), _jsxs("p", { className: "text-[11.5px] text-subtle", children: [session.ipAddress ?? 'unknown address', " \u00B7 active", ' ', formatRelative(session.lastSeenAt)] })] }), !session.current ? (_jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Sign out this device", onClick: () => revoke.mutate(session.id), children: _jsx(Trash2, { className: "size-4" }) })) : null] }, session.id))) }))] }));
}
/* -------------------------------------------------------------------------- */
/* Appearance                                                                  */
/* -------------------------------------------------------------------------- */
function AppearanceCard() {
    const { theme, setTheme, showThinking, setShowThinking, expandTools, setExpandTools } = useUiStore();
    const options = [
        { value: 'light', label: 'Light', icon: _jsx(Sun, {}) },
        { value: 'dark', label: 'Dark', icon: _jsx(Moon, {}) },
        { value: 'system', label: 'System', icon: _jsx(Monitor, {}) },
    ];
    return (_jsxs(Card, { children: [_jsx(CardHeader, { title: "Appearance", description: "These preferences live in this browser only." }), _jsxs("div", { className: "space-y-5 p-4", children: [_jsxs("div", { children: [_jsx("p", { className: "mb-2 text-[13px] font-medium text-ink", children: "Theme" }), _jsx("div", { className: "flex gap-2", children: options.map((option) => (_jsxs("button", { type: "button", onClick: () => setTheme(option.value), "aria-pressed": theme === option.value, className: cn('flex flex-1 flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-colors', '[&>svg]:size-5', theme === option.value
                                        ? 'border-accent bg-accent-soft text-accent'
                                        : 'border-line text-muted hover:bg-raised'), children: [option.icon, _jsx("span", { className: "text-[12px] font-medium", children: option.label })] }, option.value))) })] }), _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-[13px] font-medium text-ink", children: "Transcript" }), _jsx(PreferenceToggle, { checked: showThinking, onChange: setShowThinking, label: "Show the model's reasoning", hint: "Collapsible blocks showing how the agent worked through the problem." }), _jsx(PreferenceToggle, { checked: expandTools, onChange: setExpandTools, label: "Expand tool calls by default", hint: "Show each tool's full input and result instead of a one-line summary." })] })] })] }));
}
function PreferenceToggle({ checked, onChange, label, hint, }) {
    return (_jsxs("label", { className: "flex cursor-pointer items-start gap-3", children: [_jsx("input", { type: "checkbox", checked: checked, onChange: (event) => onChange(event.target.checked), className: "mt-0.5 size-4 shrink-0 accent-[var(--mc-accent)]" }), _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block text-[13px] text-ink", children: label }), _jsx("span", { className: "block text-[12px] leading-relaxed text-muted", children: hint })] })] }));
}
/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */
function SystemCard() {
    const { data, isLoading } = useQuery({
        queryKey: ['system'],
        queryFn: () => api.system(),
        refetchInterval: 30_000,
    });
    if (isLoading || !data) {
        return (_jsx("div", { className: "flex justify-center py-10", children: _jsx(Spinner, {}) }));
    }
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(Stat, { label: "Version", value: data.version }), _jsx(Stat, { label: "Uptime", value: formatDuration(data.uptimeMs) }), _jsx(Stat, { label: "Memory (RSS)", value: formatBytes(data.rssBytes), icon: _jsx(Cpu, {}) }), _jsx(Stat, { label: "Disk free", value: formatBytes(data.diskFreeBytes), icon: _jsx(HardDrive, {}) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { title: "Claude CLI", description: "Every agent run goes through this binary." }), _jsxs("dl", { className: "divide-y divide-[var(--mc-border)]", children: [_jsx(Row, { label: "Available", children: data.claudeCli.available ? (_jsx(Badge, { tone: "success", children: "yes" })) : (_jsx(Badge, { tone: "danger", children: "not found" })) }), _jsx(Row, { label: "Version", children: data.claudeCli.version ?? '—' }), _jsx(Row, { label: "Authentication", children: data.claudeCli.authMode === 'subscription' ? (_jsx(Badge, { tone: "success", children: "subscription (Pro / Max)" })) : data.claudeCli.authMode === 'api_key' ? (_jsx(Badge, { tone: "warning", children: "API key (pay as you go)" })) : (_jsx(Badge, { tone: "danger", children: "none configured" })) })] })] }), _jsxs(Card, { children: [_jsx(CardHeader, { title: "Kernel" }), _jsxs("dl", { className: "divide-y divide-[var(--mc-border)]", children: [_jsx(Row, { label: "Active runs", children: data.activeRuns }), _jsx(Row, { label: "Queued runs", children: data.queuedRuns }), _jsx(Row, { label: "Stored memories", children: data.memoryCount }), _jsx(Row, { label: "Embedding provider", children: _jsx("code", { className: "font-mono text-[12px]", children: data.embeddingProvider }) })] })] })] }));
}
function Row({ label, children }) {
    return (_jsxs("div", { className: "flex items-center justify-between gap-4 px-4 py-2.5", children: [_jsx("dt", { className: "text-[13px] text-muted", children: label }), _jsx("dd", { className: "text-[13px] font-medium text-ink", children: children })] }));
}
/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */
function AuditCard() {
    const [verifying, setVerifying] = useState(false);
    const { data, isLoading } = useQuery({
        queryKey: ['audit'],
        queryFn: () => api.audit({ limit: 200 }),
    });
    const verify = useMutation({
        mutationFn: () => api.verifyAudit(),
        onSuccess: (result) => {
            if (result.ok) {
                toast.success(`Chain intact across ${result.entries} entries.`);
            }
            else {
                toast.error(`Chain broken at entry ${result.brokenAt}. The log may have been altered.`);
            }
            setVerifying(false);
        },
        onError: () => {
            toast.error('Could not verify the chain.');
            setVerifying(false);
        },
    });
    const entries = data?.entries ?? [];
    return (_jsxs(Card, { children: [_jsx(CardHeader, { title: "Audit log", description: "Every entry commits to the hash of the one before it, so an edit anywhere invalidates everything after.", actions: _jsxs(Button, { variant: "outline", size: "sm", loading: verifying, onClick: () => {
                        setVerifying(true);
                        verify.mutate();
                    }, children: [_jsx(ScrollText, { className: "size-4", "aria-hidden": true }), "Verify chain"] }) }), isLoading ? (_jsx("div", { className: "flex justify-center py-8", children: _jsx(Spinner, {}) })) : entries.length === 0 ? (_jsx(EmptyState, { title: "No entries" })) : (_jsx("div", { className: "max-h-[28rem] overflow-y-auto", children: _jsx("ul", { className: "divide-y divide-[var(--mc-border)]", children: entries.map((entry) => (_jsxs("li", { className: "flex items-start gap-3 px-4 py-2.5", children: [_jsx(Badge, { tone: entry.outcome === 'success' ? 'neutral' : 'danger', children: entry.outcome === 'success' ? (_jsx(Check, { className: "size-2.5", "aria-hidden": true })) : ('!') }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("p", { className: "flex flex-wrap items-baseline gap-x-2 text-[12.5px]", children: [_jsx("code", { className: "font-mono font-medium text-ink", children: entry.action }), _jsx("span", { className: "text-muted", children: entry.actor })] }), entry.detail ? (_jsx("p", { className: "truncate text-[11.5px] text-subtle", children: entry.detail })) : null] }), _jsx("span", { className: "shrink-0 text-[11px] text-subtle", title: formatDateTime(entry.at), children: formatRelative(entry.at) })] }, entry.id))) }) }))] }));
}
/* -------------------------------------------------------------------------- */
function CopyableCode({ value }) {
    const [copied, setCopied] = useState(false);
    return (_jsxs("div", { className: "flex items-stretch gap-2", children: [_jsx("code", { className: "min-w-0 flex-1 truncate rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] text-ink", children: value }), _jsx(Button, { variant: "secondary", size: "icon", "aria-label": "Copy", onClick: () => {
                    void copyToClipboard(value).then((ok) => {
                        if (!ok)
                            return;
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                    });
                }, children: copied ? _jsx(Check, { className: "size-4" }) : _jsx(Copy, { className: "size-4" }) })] }));
}
/** Turn a user-agent string into something a human can recognise. */
function describeUserAgent(userAgent) {
    if (!userAgent)
        return 'Unknown device';
    const browser = /Firefox\/[\d.]+/.test(userAgent)
        ? 'Firefox'
        : /Edg\//.test(userAgent)
            ? 'Edge'
            : /Chrome\//.test(userAgent)
                ? 'Chrome'
                : /Safari\//.test(userAgent)
                    ? 'Safari'
                    : 'Browser';
    const platform = /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Android/.test(userAgent)
            ? 'Android'
            : /Macintosh/.test(userAgent)
                ? 'macOS'
                : /Windows/.test(userAgent)
                    ? 'Windows'
                    : /Linux/.test(userAgent)
                        ? 'Linux'
                        : 'Unknown';
    return `${browser} on ${platform}`;
}
//# sourceMappingURL=SettingsPage.js.map