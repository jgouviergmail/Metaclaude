/** Small presentation helpers shared across the app. */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { currentLang } from './lang';

/** Merge Tailwind classes, letting later conditional classes win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cost, rendered at a precision that stays informative across three orders of
 * magnitude — a fraction of a cent up to tens of dollars.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The short forms, per language.
 *
 * Not in the catalogue: these are called from inside `.map()` bodies where no
 * hook can run, so they cannot go through `t()`, and a table of eight strings
 * is clearer than eight keys whose values are "m" and "h". French drops the
 * period after an abbreviated unit ("min", "h", "j") and puts the elapsing
 * *before* the amount, which is why this is a table and not a suffix.
 */
const RELATIVE = {
  en: {
    now: 'just now',
    minutes: (n: number) => `${n}m ago`,
    hours: (n: number) => `${n}h ago`,
    days: (n: number) => `${n}d ago`,
  },
  fr: {
    now: 'à l’instant',
    minutes: (n: number) => `il y a ${n} min`,
    hours: (n: number) => `il y a ${n} h`,
    days: (n: number) => `il y a ${n} j`,
  },
} as const;

/**
 * Relative time, switching to an absolute date once "days ago" stops helping.
 *
 * The language comes from `lib/lang`, not from a parameter: this is called from
 * about thirty places, most of them inside a `.map()` where a hook cannot go,
 * and every one of them said "2h ago" under a French heading. `undefined` as
 * the locale would follow the *browser*, which is a different question from the
 * one the operator answered in Settings.
 */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const words = RELATIVE[currentLang()];
  const delta = now - timestamp;
  // A timestamp in the future is a clock disagreement, not a prediction.
  if (delta < 45_000) return words.now;
  if (delta < 3_600_000) return words.minutes(Math.round(delta / 60_000));
  if (delta < 86_400_000) return words.hours(Math.round(delta / 3_600_000));
  if (delta < 7 * 86_400_000) return words.days(Math.round(delta / 86_400_000));

  return new Date(timestamp).toLocaleDateString(currentLang(), {
    month: 'short',
    day: 'numeric',
    ...(new Date(timestamp).getFullYear() !== new Date(now).getFullYear()
      ? { year: 'numeric' }
      : {}),
  });
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(currentLang(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Initials for an avatar, from a display name or a username. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return `${(parts[0] as string)[0]}${(parts[1] as string)[0]}`.toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Interaction                                                                 */
/* -------------------------------------------------------------------------- */

/** True when the platform's primary modifier (⌘ on macOS, Ctrl elsewhere) is held. */
export function isModifier(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return isApple() ? event.metaKey : event.ctrlKey;
}

export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Display string for a shortcut, e.g. `⌘K` or `Ctrl+K`. */
export function shortcut(key: string): string {
  return isApple() ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** Copy to the clipboard, falling back for insecure contexts and older Safari. */
export async function copyToClipboard(text: string): Promise<boolean> {
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
  } catch {
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
export function contrastText(hex: string): string {
  const normalised = hex.replace('#', '');
  if (normalised.length !== 6) return '#ffffff';

  const toLinear = (channel: number): number => {
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
] as const;

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length] as string;
}
