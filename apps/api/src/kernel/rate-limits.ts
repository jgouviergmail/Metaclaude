/**
 * Reading the CLI's rate-limit windows - in both shapes it speaks at once.
 *
 * The SDK declares `rate_limits` as an object keyed by window name
 * (`five_hour`, `seven_day`, `seven_day_opus`, ...). Measured against Claude
 * Code in production, the CLI sends *both*: those keys, and a `limits` array of
 * `{ kind, group, percent, scope, resets_at }` rows.
 *
 * The mapping this replaces read only the object keys, which is why the two
 * global windows were displayed correctly and every **model-scoped** bucket was
 * invisible: `model_scoped` is `undefined` on this payload, and the per-model
 * rows exist only inside `limits[]`. So on a subscription whose Fable bucket sat
 * at 100%, the screen showed the session and weekly windows and said nothing at
 * all about Fable - which is the one thing an operator needed to see.
 *
 * Worth recording as method rather than as trivia: the first inspection printed
 * the payload through a 2000-character truncation, saw `limits` and concluded
 * the object keys were absent. They were not, and a changelog went out saying
 * the screen had been blank. Print the whole thing before concluding anything
 * about what is *not* in it.
 *
 * Both shapes are read here because a CLI may send either or both, and neither
 * is guessed at - the array shape is transcribed from a captured production
 * payload, which is also the fixture the test uses.
 */

import type { ClaudeUsageWindow } from '@metaclaude/shared';

/** ISO 8601 → epoch millis; a malformed or absent stamp is null. */
function at(iso: unknown): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Operator-facing names for the windows the object shape declares, and the
 * `kind` values the array shape uses for the same things.
 *
 * `weekly_scoped` is deliberately absent: it carries the model in `scope` and
 * is named after it, which is the whole reason it is worth reading.
 */
const OBJECT_WINDOWS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['five_hour', 'Session (5 h)'],
  ['seven_day', 'Week — all models'],
  ['seven_day_oauth_apps', 'Week — connected apps'],
  ['seven_day_opus', 'Week — Opus'],
  ['seven_day_sonnet', 'Week — Sonnet'],
];

const ARRAY_KINDS: Readonly<Record<string, { key: string; label: string }>> = {
  session: { key: 'five_hour', label: 'Session (5 h)' },
  weekly_all: { key: 'seven_day', label: 'Week — all models' },
  weekly_oauth_apps: { key: 'seven_day_oauth_apps', label: 'Week — connected apps' },
};

/** The key a model bucket is filed under, whichever shape named it. */
export function modelWindowKey(displayName: string): string {
  return `model:${displayName}`;
}

/**
 * Every window the CLI reported, normalised.
 *
 * Returns an empty array when the payload carries none — which the caller must
 * not confuse with "this plan has no windows"; that is what
 * `rate_limits_available` says.
 */
export function readRateLimitWindows(rateLimits: unknown): ClaudeUsageWindow[] {
  const limits = record(rateLimits);
  if (!limits) return [];

  const windows: ClaudeUsageWindow[] = [];

  // The shape the CLI actually sends: one row per window, the model-scoped
  // ones naming their model in `scope`.
  const rows = limits.limits;
  if (Array.isArray(rows)) {
    for (const entry of rows) {
      const row = record(entry);
      if (!row) continue;
      const kind = typeof row.kind === 'string' ? row.kind : '';
      const scopedModel = record(record(row.scope)?.model)?.display_name;
      const named = ARRAY_KINDS[kind];

      if (named) {
        windows.push({
          key: named.key,
          label: named.label,
          utilization: num(row.percent),
          resetsAt: at(row.resets_at),
        });
      } else if (typeof scopedModel === 'string' && scopedModel !== '') {
        windows.push({
          key: modelWindowKey(scopedModel),
          label: scopedModel,
          utilization: num(row.percent),
          resetsAt: at(row.resets_at),
        });
      }
      // A kind we do not recognise and that names no model is dropped rather
      // than shown under its raw wire name: the screen is for an operator.
    }
    return windows;
  }

  // The shape the SDK declares. Kept because a CLI may still answer with it.
  for (const [key, label] of OBJECT_WINDOWS) {
    // null and absent both mean "no such bucket on this plan" — which is not a
    // bucket at 0%.
    const window = record(limits[key]);
    if (!window) continue;
    windows.push({
      key,
      label,
      utilization: num(window.utilization),
      resetsAt: at(window.resets_at),
    });
  }
  for (const entry of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const bucket = record(entry);
    const name = typeof bucket?.display_name === 'string' ? bucket.display_name : null;
    if (!bucket || name === null) continue;
    windows.push({
      key: modelWindowKey(name),
      label: name,
      utilization: num(bucket.utilization),
      resetsAt: at(bucket.resets_at),
    });
  }
  return windows;
}
