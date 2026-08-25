/**
 * Query-string coercion.
 *
 * Query parameters arrive as strings and every one of them is attacker-supplied.
 * The naive `Number(request.query.limit)` is unsafe in a way that is easy to
 * miss: `Number('abc')` is `NaN`, and `NaN` silently defeats every bound that
 * would otherwise cap the result set — `Math.min(NaN, 200)` is `NaN`, and
 * `rows.length >= NaN` is `false`, so a clamp written as a guard becomes a
 * no-op and the query runs unbounded. `Number('')` is `0` and `Number(' 1e9 ')`
 * is a billion, which are the same class of problem from the other direction.
 *
 * These helpers parse strictly, reject anything that is not a plain integer,
 * and clamp what survives. An unusable value yields `undefined` so the caller's
 * own default applies, rather than propagating a poisoned number downstream.
 */

/** Integers only — no exponents, no decimals, no leading `+`, no whitespace. */
const INTEGER = /^-?\d{1,15}$/;

export interface IntBounds {
  min: number;
  max: number;
}

/**
 * Parse a bounded integer query parameter.
 *
 * @returns the clamped value, or `undefined` when the parameter is absent,
 *          malformed, or out of range in a way that cannot be clamped
 *          meaningfully (an explicitly negative limit, say).
 */
export function queryInt(raw: unknown, bounds: IntBounds): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!INTEGER.test(trimmed)) return undefined;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return undefined;

  return Math.min(Math.max(value, bounds.min), bounds.max);
}

/**
 * Parse a bounded integer, falling back to a default.
 * The default is returned verbatim; it is trusted, not clamped.
 */
export function queryIntOr(raw: unknown, bounds: IntBounds, fallback: number): number {
  return queryInt(raw, bounds) ?? fallback;
}

/**
 * Parse a bounded integer into an object suitable for spreading into an options
 * literal: `{ key: value }` when usable, `{}` when not.
 *
 * This keeps the call sites in the shape they already have — a conditional
 * spread that lets the service's own default win — while making the value
 * itself trustworthy.
 */
export function spreadInt<K extends string>(
  key: K,
  raw: unknown,
  bounds: IntBounds,
): Partial<Record<K, number>> {
  const value = queryInt(raw, bounds);
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, number>>;
}

/**
 * Parse a millisecond timestamp query parameter (a cursor or a since-marker).
 *
 * Bounded to a plausible epoch range so a nonsensical cursor cannot be used to
 * force a full-table scan, and so a negative value cannot invert a comparison.
 */
export function queryTimestamp(raw: unknown): number | undefined {
  return queryInt(raw, { min: 0, max: 4_102_444_800_000 /* 2100-01-01 */ });
}

/** `queryTimestamp` in the spreadable shape `spreadInt` returns. */
export function spreadTimestamp<K extends string>(
  key: K,
  raw: unknown,
): Partial<Record<K, number>> {
  const value = queryTimestamp(raw);
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, number>>;
}
