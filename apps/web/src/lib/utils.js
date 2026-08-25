/** Small presentation helpers shared across the app. */
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
/** Merge Tailwind classes, letting later conditional classes win. */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}
/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Cost, rendered at a precision that stays informative across three orders of
 * magnitude — a fraction of a cent up to tens of dollars.
 */
export function formatCost(usd) {
    if (usd === 0)
        return '$0';
    if (usd < 0.01)
        return `$${usd.toFixed(4)}`;
    if (usd < 1)
        return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
}
export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    if (count < 1_000_000)
        return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
    return `${(count / 1_000_000).toFixed(1)}M`;
}
export function formatDuration(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    if (minutes < 60)
        return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}
export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
/** Relative time, switching to an absolute date once "days ago" stops helping. */
export function formatRelative(timestamp, now = Date.now()) {
    const delta = now - timestamp;
    if (delta < 0)
        return 'just now';
    if (delta < 45_000)
        return 'just now';
    if (delta < 3_600_000)
        return `${Math.round(delta / 60_000)}m ago`;
    if (delta < 86_400_000)
        return `${Math.round(delta / 3_600_000)}h ago`;
    if (delta < 7 * 86_400_000)
        return `${Math.round(delta / 86_400_000)}d ago`;
    return new Date(timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(new Date(timestamp).getFullYear() !== new Date(now).getFullYear()
            ? { year: 'numeric' }
            : {}),
    });
}
export function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}
export function formatPercent(fraction, digits = 0) {
    return `${(fraction * 100).toFixed(digits)}%`;
}
/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */
export function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/** Initials for an avatar, from a display name or a username. */
export function initials(name) {
    const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
    if (parts.length === 0)
        return '?';
    if (parts.length === 1)
        return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
/* -------------------------------------------------------------------------- */
/* Interaction                                                                 */
/* -------------------------------------------------------------------------- */
/** True when the platform's primary modifier (⌘ on macOS, Ctrl elsewhere) is held. */
export function isModifier(event) {
    return isApple() ? event.metaKey : event.ctrlKey;
}
export function isApple() {
    if (typeof navigator === 'undefined')
        return false;
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
/** Display string for a shortcut, e.g. `⌘K` or `Ctrl+K`. */
export function shortcut(key) {
    return isApple() ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}
/** Copy to the clipboard, falling back for insecure contexts and older Safari. */
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    }
    catch {
        return false;
    }
}
/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */
/**
 * Readable text colour for a workspace's accent, using the WCAG relative
 * luminance formula so a pale accent gets dark text and vice versa.
 */
export function contrastText(hex) {
    const normalised = hex.replace('#', '');
    if (normalised.length !== 6)
        return '#ffffff';
    const toLinear = (channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = toLinear(parseInt(normalised.slice(0, 2), 16));
    const g = toLinear(parseInt(normalised.slice(2, 4), 16));
    const b = toLinear(parseInt(normalised.slice(4, 6), 16));
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.45 ? '#111114' : '#ffffff';
}
/** Deterministic pleasant colour for a new workspace. */
export const WORKSPACE_COLORS = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
    '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];
export function colorForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length];
}
//# sourceMappingURL=utils.js.map