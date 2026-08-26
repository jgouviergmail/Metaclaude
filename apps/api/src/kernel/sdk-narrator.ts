/**
 * The CLI's out-of-band messages, in words an operator can act on.
 *
 * The supervisor translates five of the SDK's message types into transcript
 * events. The rest used to reach `default: return {}` and vanish — which would
 * be fine if they were noise, and they are not. They are the messages that
 * explain a run's behaviour:
 *
 *   - a run that sits still for thirty seconds is an API retry,
 *   - an agent that forgets what it was doing has been compacted,
 *   - a session where everything suddenly fails has an expired login,
 *   - a model that changes mid-session has fallen back after a refusal,
 *   - and on a subscription, a run that stops working has hit a rate limit.
 *
 * Every one of those looked like a bug in Metaclaude, because Metaclaude said
 * nothing. This module is what it says instead.
 *
 * Kept pure and separate from the supervisor so the mapping is testable without
 * an SDK, a CLI or a subprocess — and so the coverage test in
 * `sdk-narrator.test.ts` can hold it against the SDK's own union and fail when
 * an upgrade adds a message type nobody has decided about.
 */

export interface Narration {
  level: 'info' | 'warn' | 'error';
  /** One sentence. Shown as-is in the transcript. */
  message: string;
  /** Structured extras for the UI — a reset timestamp, a token count. */
  data?: Record<string, unknown>;
}

/**
 * Message kinds deliberately not recorded, keyed `type` or `type:subtype`.
 *
 * Two reasons appear here and they are different. Some arrive many times a
 * second (`tool_progress` is a heartbeat, `thinking_tokens` a running total):
 * persisting them turns one long run into thousands of rows and a transcript
 * nobody can read. Others are state synchronisation for a client that maintains
 * its own model of the session — Metaclaude renders from its own transcript, so
 * they say nothing it does not already know.
 *
 * The list exists so that "we dropped it" is a decision on the record. The
 * coverage test requires every member of the SDK's union to either produce a
 * note or be named here, which is what makes the original bug — a `default:`
 * branch silently absorbing whatever came next — impossible to reintroduce.
 */
export const IGNORED_SDK_MESSAGES: ReadonlySet<string> = new Set([
  // Owned by another branch of the supervisor's translation.
  'assistant',
  'user',
  'result',
  'stream_event',
  'system:init',
  'system:permission_denied',

  // High frequency. Recording these is what makes a transcript unusable.
  'tool_progress',
  'system:thinking_tokens',
  'system:status',
  'system:task_progress',
  'system:hook_progress',
  'system:control_request_progress',

  // State synchronisation for a client that keeps its own session model.
  'system:commands_changed',
  'system:background_tasks_changed',
  'system:session_state_changed',
  'system:files_persisted',
  'system:elicitation_complete',
  'system:task_updated',
  'system:hook_started',
  'tool_use_summary',
  'prompt_suggestion',
  'active_goal',

  // Rendered from the tool call itself, where it has context.
  'system:local_command_output',
  'system:memory_recall',
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `152000` → `152k`. Token counts are read for magnitude, never for precision. */
function tokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`;
}

/** Rate-limit windows named the way a person would say them. */
const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly (overage included)',
  overage: 'overage',
};

const INFORMATIONAL_LEVELS: Record<string, Narration['level']> = {
  info: 'info',
  notice: 'info',
  suggestion: 'info',
  warning: 'warn',
};

/* -------------------------------------------------------------------------- */
/* System subtypes                                                             */
/* -------------------------------------------------------------------------- */

type Narrator = (message: Record<string, unknown>) => Narration | null;

const SYSTEM: Record<string, Narrator> = {
  api_retry(message) {
    const attempt = num(message.attempt) ?? 0;
    const max = num(message.max_retries) ?? 0;
    const delay = num(message.retry_delay_ms) ?? 0;
    const status = num(message.error_status);
    return {
      level: 'warn',
      // The status code is what distinguishes "Anthropic is overloaded, wait"
      // from "something about this request is wrong, stop".
      message: `Claude's API ${status === null ? 'could not be reached' : `returned ${status}`}; retrying (attempt ${attempt} of ${max}) in ${seconds(delay)}.`,
      data: { attempt, maxRetries: max, retryDelayMs: delay, errorStatus: status },
    };
  },

  compact_boundary(message) {
    const meta = asRecord(message.compact_metadata) ?? {};
    const before = num(meta.pre_tokens);
    const after = num(meta.post_tokens);
    const trigger = str(meta.trigger) ?? 'auto';
    // Stated in tokens because that is the only form in which "why did it
    // forget" has a satisfying answer.
    const sizes =
      before !== null && after !== null
        ? ` — ${tokens(before)} → ${tokens(after)} tokens`
        : before !== null
          ? ` — was ${tokens(before)} tokens`
          : '';
    return {
      level: 'info',
      message: `The conversation was compacted (${trigger})${sizes}. Earlier turns are now a summary.`,
      data: { trigger, preTokens: before, postTokens: after },
    };
  },

  model_refusal_fallback(message) {
    const original = str(message.original_model) ?? 'the model';
    const fallback = str(message.fallback_model) ?? 'another model';
    const category = str(message.api_refusal_category);
    return {
      level: 'warn',
      message: `${original} declined this request${category ? ` (${category})` : ''}; it was retried on ${fallback}.`,
      data: { originalModel: original, fallbackModel: fallback, category },
    };
  },

  model_refusal_no_fallback(message) {
    const original = str(message.original_model) ?? 'The model';
    const content = str(message.content);
    const explanation = str(message.api_refusal_explanation);
    return {
      level: 'error',
      // The model's own words, not a paraphrase: a refusal the operator cannot
      // read is one they cannot work around.
      message: content ?? explanation ?? `${original} declined this request and there was no fallback.`,
      data: { originalModel: original, category: str(message.api_refusal_category) },
    };
  },

  notification(message) {
    // No text, no note. An empty message still renders — a bordered box with
    // nothing in it, which reads as a rendering bug rather than as no news.
    const text = str(message.text);
    if (!text) return null;
    const priority = str(message.priority);
    return {
      level: priority === 'high' || priority === 'immediate' ? 'warn' : 'info',
      message: text,
      data: { key: str(message.key), priority },
    };
  },

  informational(message) {
    const content = str(message.content);
    if (!content) return null;
    return {
      // The CLI's vocabulary here is wider than the transcript's, and an
      // unmapped value must not reach a persisted row as `undefined`.
      level: INFORMATIONAL_LEVELS[str(message.level) ?? 'info'] ?? 'info',
      message: content,
      data: {},
    };
  },

  hook_response(message) {
    // A hook is the operator's own code. One that fails silently sends them
    // debugging the agent instead of the hook.
    if (str(message.outcome) === 'success') return null;
    const name = str(message.hook_name) ?? 'a hook';
    const detail = str(message.stderr) ?? str(message.output);
    return {
      level: 'warn',
      message: `The ${name} hook ${str(message.outcome) === 'cancelled' ? 'was cancelled' : 'failed'}${detail ? `: ${detail}` : '.'}`,
      data: { hook: name, exitCode: num(message.exit_code) },
    };
  },

  task_started(message) {
    return {
      level: 'info',
      message: `Background task started: ${str(message.description) ?? 'unnamed task'}.`,
      data: { taskId: str(message.task_id), subagentType: str(message.subagent_type) },
    };
  },

  task_notification(message) {
    const status = str(message.status) ?? 'completed';
    return {
      level: status === 'completed' ? 'info' : 'warn',
      message: `Background task ${status}: ${str(message.summary) ?? 'no summary'}.`,
      data: { taskId: str(message.task_id), status },
    };
  },

  plugin_install(message) {
    const status = str(message.status);
    // Only the ends of the operation say anything; the middle is progress.
    if (status !== 'failed') return null;
    return {
      level: 'warn',
      message: `The CLI could not install the plugin ${str(message.name) ?? ''}: ${str(message.error) ?? 'no reason given'}.`,
      data: { name: str(message.name) },
    };
  },

  mirror_error(message) {
    return {
      level: 'warn',
      message: `The CLI could not mirror this session: ${str(message.error) ?? 'no reason given'}.`,
      data: {},
    };
  },

  worker_shutting_down(message) {
    return {
      level: 'warn',
      message: `The CLI worker is shutting down: ${str(message.reason) ?? 'no reason given'}.`,
      data: {},
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Top-level types                                                             */
/* -------------------------------------------------------------------------- */

const TOP_LEVEL: Record<string, Narrator> = {
  rate_limit_event(message) {
    const info = asRecord(message.rate_limit_info) ?? {};
    const status = str(info.status);
    // "allowed" is the steady state. A note per request to say nothing is wrong
    // would bury the one that says something is.
    if (status !== 'allowed_warning' && status !== 'rejected') return null;

    const window = LIMIT_WINDOWS[str(info.rateLimitType) ?? ''] ?? str(info.rateLimitType) ?? 'usage';
    const utilisation = num(info.utilization);
    // The SDK sends seconds; the rest of the OS is in milliseconds, and a
    // timestamp that is silently a thousand times too small renders as 1970.
    const resetsAt = num(info.resetsAt);
    const resetsAtMs = resetsAt === null ? null : resetsAt * 1000;

    const used = utilisation === null ? '' : ` (${Math.round(utilisation * 100)}% used)`;
    return status === 'rejected'
      ? {
          level: 'error',
          message: `Your ${window} limit is reached${used}. Runs will fail until it resets.`,
          data: { status, window: str(info.rateLimitType), resetsAt: resetsAtMs, utilization: utilisation },
        }
      : {
          level: 'warn',
          message: `Approaching your ${window} limit${used}.`,
          data: { status, window: str(info.rateLimitType), resetsAt: resetsAtMs, utilization: utilisation },
        };
  },

  auth_status(message) {
    // Only a failure is worth a line. On a subscription this is the difference
    // between "Metaclaude is broken" and "sign in again".
    const error = str(message.error);
    if (!error) return null;
    return { level: 'error', message: `Claude authentication failed: ${error}`, data: {} };
  },

  conversation_reset() {
    return {
      level: 'warn',
      message: 'The CLI started a new conversation; earlier context is no longer in scope.',
      data: {},
    };
  },
};

/* -------------------------------------------------------------------------- */

/**
 * Every message kind this module has an opinion about, keyed as above.
 *
 * Derived from the tables rather than written out again, so it cannot drift
 * from them. It is what the coverage test measures against: the question worth
 * asking is "has someone decided about this message type", not "does a probe
 * payload happen to make its handler fire" — several handlers are deliberately
 * conditional (a plugin install is only reported when it fails), and judging
 * them by a synthetic payload would report a decision as a gap.
 */
export const HANDLED_SDK_MESSAGES: ReadonlySet<string> = new Set([
  ...Object.keys(SYSTEM).map((subtype) => `system:${subtype}`),
  ...Object.keys(TOP_LEVEL),
]);

/**
 * Describe one SDK message, or `null` for one that should not be recorded.
 *
 * Null covers three different cases on purpose — already translated elsewhere,
 * deliberately ignored, and not recognised at all — because the caller does the
 * same thing with all three. Which one it was is a question for the coverage
 * test, not for the supervisor.
 */
export function narrate(message: unknown): Narration | null {
  const record = asRecord(message);
  if (!record) return null;

  const type = str(record.type);
  if (!type) return null;

  if (type === 'system') {
    const subtype = str(record.subtype);
    if (!subtype) return null;
    return SYSTEM[subtype]?.(record) ?? null;
  }

  return TOP_LEVEL[type]?.(record) ?? null;
}
