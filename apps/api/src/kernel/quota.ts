/**
 * Telling "this model is spent" from "everything is spent".
 *
 * The distinction is the whole feature. A run refused for quota can be saved by
 * switching model *only* when the exhausted window belongs to that model; when
 * the global window is the one that ran out, every model draws on it and
 * switching buys nothing but three more refusals and a confusing transcript.
 *
 * Two attempts at this discriminator were refuted by measurement before the
 * third, and both failures are worth recording because both looked right:
 *
 *  1. "Switch when `rateLimitType` is `seven_day_<model>`." The enum declares
 *     `seven_day_opus` and `seven_day_sonnet`, so the rule reads well. Measured
 *     against a genuinely exhausted Fable bucket, the rejected event carried
 *     `rateLimitType: 'seven_day_overage_included'` — the rule would never have
 *     fired for the very case it was written for.
 *  2. "Let the CLI do it: pass `fallbackModel`." The SDK documents it as the
 *     fallback for a primary model that is "overloaded or unavailable".
 *     Measured, `fable` with `fallbackModel: 'sonnet'` produced a result byte
 *     for byte identical to `fable` alone: the CLI's fallback does not cover
 *     quota. Shipping it would have been a setting that does nothing.
 *
 * What does discriminate, measured in the same session: the rejected event's
 * `unifiedWindows` showed `seven_day` at 0.97 — a warning, not a rejection —
 * while Fable was refused and Sonnet answered normally. So the global windows'
 * own utilisation is the signal, and it is present in two places.
 */

import type { ClaudeUsageWindow } from '@metaclaude/shared';
import { modelWindowKey } from './rate-limits.js';

export interface QuotaBlock {
  /** The model the run asked for and did not get. */
  model: string;
  /**
   * `model` — another model may serve, so a switch is worth trying.
   * `global`  — nothing will until the window resets; switching is futile.
   */
  scope: 'model' | 'global';
  /** When the blocking window resets, epoch millis; null when unsaid. */
  resetsAt: number | null;
}

/**
 * The windows that gate every model. A rejection while one of these is spent is
 * a rejection no other model can answer.
 */
const GLOBAL_KEYS = new Set(['five_hour', 'seven_day']);

/**
 * At what utilisation a window counts as spent.
 *
 * Measured: the rejected Fable bucket read exactly 1.0 (100 in the usage
 * payload's scale) while the global weekly window read 0.97 and still served.
 * The threshold is just below 1 so a window reported as 0.999 by rounding is
 * not read as "room left".
 */
const SPENT = 0.995;

/*
 * Two sources, two scales, and the scale is a property of the *source* - never
 * inferred from the magnitude.
 *
 * The inferring version read `u > 1 ? u / 100 : u`, which is unambiguous for 97
 * and catastrophic for 1. Measured on this deployment, `rate_limits.five_hour`
 * reported `{ utilization: 1 }` meaning **one percent**, and the sniffing rule
 * read it as a spent window - so every model-scoped refusal would have been
 * classified global, and the model switch, which is the whole feature, would
 * never have fired. The value cannot say which scale it is on. The source can.
 */

/** `unifiedWindows` on a rate-limit event: a fraction. */
const fromEventScale = (utilisation: number): number => utilisation;

/** `ClaudeUsageWindow.utilization`, and the CLI payload behind it: a percentage. */
const fromWindowScale = (utilisation: number): number => utilisation / 100;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Is a global window spent, according to the event's own `unifiedWindows`?
 *
 * `unifiedWindows` is **not declared** on `SDKRateLimitInfo`. It is on the wire
 * — captured from a real rejection — but the compiler cannot protect a read of
 * it, and a future CLI may stop sending it. Hence `null` for "could not tell",
 * which the caller answers from the usage snapshot instead of guessing.
 */
function globalFromEvent(info: Record<string, unknown>): boolean | null {
  const unified = record(info.unifiedWindows);
  if (!unified) return null;

  let sawOne = false;
  for (const key of GLOBAL_KEYS) {
    const utilisation = num(record(unified[key])?.utilization);
    if (utilisation === null) continue;
    sawOne = true;
    if (fromEventScale(utilisation) >= SPENT) return true;
  }
  return sawOne ? false : null;
}

/** Is a global window spent, according to the CLI's usage snapshot? */
function globalFromWindows(windows: readonly ClaudeUsageWindow[]): boolean | null {
  let sawOne = false;
  for (const window of windows) {
    if (!GLOBAL_KEYS.has(window.key) || window.utilization === null) continue;
    sawOne = true;
    if (fromWindowScale(window.utilization) >= SPENT) return true;
  }
  return sawOne ? false : null;
}

/** When does the blocking window reset? The event speaks seconds. */
function resetAt(info: Record<string, unknown>): number | null {
  const seconds = num(info.resetsAt);
  return seconds === null ? null : seconds * 1000;
}

/**
 * Classify the rate-limit events a refused attempt produced.
 *
 * Returns null when nothing was rejected — an `allowed_warning` is the CLI
 * saying a window is filling up, which is not a refusal and must not start a
 * model switch.
 */
export function classifyQuotaRejection(input: {
  /** The model the attempt asked for. */
  model: string;
  /** `rate_limit_info` payloads seen during the attempt, in arrival order. */
  rateLimits: readonly unknown[];
  /** The CLI's usage snapshot, when one is at hand. */
  windows?: readonly ClaudeUsageWindow[];
}): QuotaBlock | null {
  const rejected = input.rateLimits
    .map(record)
    .filter((info): info is Record<string, unknown> => info !== null && info.status === 'rejected');
  const last = rejected[rejected.length - 1];
  if (!last) return null;

  const global = globalFromEvent(last) ?? globalFromWindows(input.windows ?? []);

  /*
   * Undeterminable defaults to `model`, and the asymmetry is deliberate.
   *
   * Guessing `model` when it was global costs at most three further attempts,
   * and a quota refusal is refused before the CLI reaches the API — measured at
   * essentially no tokens and under five seconds. Guessing `global` when it was
   * one model fails a run that would have succeeded. The cheap mistake is the
   * one to make.
   */
  return {
    model: input.model,
    scope: global === true ? 'global' : 'model',
    resetsAt: resetAt(last),
  };
}

/**
 * Which model to try instead.
 *
 * The order is the learner's own — `PolicyLearner.list` returns arms by
 * posterior mean, and since the prior became cost-aware that ordering is
 * meaningful from the very first run rather than only after eight trials. The
 * posterior *mean* rather than a Thompson draw, because a retry must be
 * predictable: an operator reading two identical warnings should not see two
 * different models.
 *
 * Returns null when nothing is left to try, which is a plain failure and says
 * so rather than looping.
 */
export function chooseReplacement(input: {
  /** Arms in the learner's preferred order, best first. */
  ranked: ReadonlyArray<{ model: string; effort: string | null }>;
  /** Models already refused during this run, or known spent. */
  unavailable: ReadonlySet<string>;
}): { model: string; effort: string | null } | null {
  for (const arm of input.ranked) {
    if (!input.unavailable.has(arm.model)) return arm;
  }
  return null;
}

/** The window key a model's own bucket is filed under, for a usage lookup. */
export function modelBucketKey(displayName: string): string {
  return modelWindowKey(displayName);
}
