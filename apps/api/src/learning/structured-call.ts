/**
 * One tool-less, schema-constrained model call.
 *
 * The shape both reflexion and skill synthesis need: a plain system prompt
 * (never the claude_code preset — these are classifiers, not agents), no
 * tools offered and none permitted, a small turn ceiling, a JSON schema on
 * the output,
 * and a hard timeout because background passes must never run long. The
 * fallback matters in production: some CLI versions omit `structured_output`,
 * so the text body is mined for JSON before giving up.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel } from '@metaclaude/shared';
import { DELEGATION_TOOLS, SKILL_TOOL } from '@metaclaude/shared';

/**
 * What a background pass runs on unless an operator says otherwise.
 *
 * One name for it, in one place: the shipped default the five structured
 * passes share, the value each phase row on the settings screen states, and
 * what a review row records when nothing was pinned. Three copies of `haiku`
 * is three chances to disagree, and the one that disagreed would be the row
 * telling the operator which model judged their instructions.
 */
export const STRUCTURED_DEFAULT_MODEL = 'haiku';

/**
 * What serves one background pass, as the operator has pinned it.
 *
 * `null` on either side means "unpinned" — the shipped default — and never
 * "no model" or "no effort". Both are read through a getter rather than held
 * as a value, because every one of these calls is built once at boot and the
 * settings behind them are hot: a captured model would need a restart, which
 * for a setting about spend is the wrong answer.
 */
export interface PhasePolicy {
  model: string | null;
  effort: EffortLevel | null;
}

export type PhasePolicyReader = () => PhasePolicy;

/** The reader a factory takes when its caller pins nothing — tests, mostly. */
export const NO_PHASE_POLICY: PhasePolicyReader = () => ({ model: null, effort: null });

/**
 * The pinned fields of a request, **omitted** when nothing is pinned.
 *
 * Absence and `null` are different answers here: an absent `model` lets the
 * call take its own default, and an absent `effort` lets the CLI choose for
 * the model it is serving, while `effort: null` is a value the SDK would carry.
 * Every factory spreads this rather than spelling the two conditionals out,
 * so there is one place that knows it.
 */
export function pinnedFields(policy: PhasePolicyReader): { model?: string; effort?: EffortLevel } {
  const { model, effort } = policy();
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export interface StructuredCallContext {
  /** Environment for the CLI subprocess (carries subscription auth). */
  env: Record<string, string>;
  claudeBinPath: string | null;
  /** Working directory. A scratch dir, never a workspace. */
  cwd: string;
}

export interface StructuredCallRequest {
  prompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  /** Accept only shapes the caller can actually use; rejects become null. */
  accept: (parsed: unknown) => boolean;
  model?: string;
  /**
   * Reasoning effort, when the operator has pinned one for this pass.
   *
   * Omitted rather than defaulted, because absence and a value mean different
   * things to the CLI: absent lets it choose for the model it is serving, and
   * a level on a model without the knob is *silently downgraded* — measured,
   * and true of Haiku, which is what these passes ship on. So pinning one here
   * does nothing until the model is also changed to one that has it, and the
   * settings screen says so rather than letting the operator believe otherwise.
   */
  effort?: EffortLevel | null;
  timeoutMs?: number;
  /**
   * Turns the CLI may take. Three by default.
   *
   * It was one — a classifier, not an agent — and that was wrong in a way that
   * took a day of lost memory to see. The SDK delivers a schema-constrained
   * answer through a hidden tool call, so a model that spends its single turn
   * producing prose before that call ends as "Reached maximum number of turns
   * (1)" with no answer at all. The memory gate measured six failures in
   * thirty calls at one turn and two at two, and raised *its own* call to
   * three; every other caller kept the failing default, and the reflector —
   * whose prompt is the longest here, a whole transcript summary — failed ten
   * times running in production, each failure logged at warn and dropped.
   *
   * The default belongs here rather than in each caller because the trap is a
   * property of the mechanism, not of any one prompt, and because a ceiling is
   * not a target: a call that answers on its first turn costs exactly what it
   * cost at one. A caller that genuinely wants a single turn still says so.
   */
  maxTurns?: number;
  /** Injectable for tests. */
  queryFn?: typeof sdkQuery;
}

export async function structuredCall<T>(
  context: StructuredCallContext,
  request: StructuredCallRequest,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);
  timer.unref?.();

  try {
    let structured: unknown = null;
    let text = '';

    for await (const message of (request.queryFn ?? sdkQuery)({
      prompt: request.prompt,
      options: {
        cwd: context.cwd,
        systemPrompt: request.systemPrompt,
        model: request.model ?? STRUCTURED_DEFAULT_MODEL,
        ...(request.effort ? { effort: request.effort } : {}),
        maxTurns: request.maxTurns ?? 3,
        // Belt and braces: no tools offered, and none permitted.
        allowedTools: [],
        // Belt and braces twice over, since `allowedTools: []` already
        // refuses everything: the delegation tool's real name is `Agent`,
        // measured — `Task` alone was a list that named nothing the CLI sends.
        disallowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
          ...DELEGATION_TOOLS, SKILL_TOOL,
        ],
        permissionMode: 'dontAsk',
        settingSources: [],
        thinking: { type: 'disabled' },
        outputFormat: { type: 'json_schema', schema: request.schema },
        abortController: controller,
        env: context.env,
        ...(context.claudeBinPath ? { pathToClaudeCodeExecutable: context.claudeBinPath } : {}),
      },
    })) {
      if (message.type === 'result') {
        structured = (message as { structured_output?: unknown }).structured_output ?? null;
        const result = (message as { result?: string }).result;
        if (typeof result === 'string') text = result;
      }
    }

    if (structured && typeof structured === 'object' && request.accept(structured)) {
      return structured as T;
    }
    return extractJson<T>(text, request.accept);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort JSON recovery from a model response that may be wrapped in
 * prose or a fenced code block.
 */
export function extractJson<T>(text: string, accept: (parsed: unknown) => boolean): T | null {
  if (!text?.trim()) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && accept(parsed)) return parsed as T;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
