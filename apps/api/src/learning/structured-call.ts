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
        model: request.model ?? 'haiku',
        maxTurns: request.maxTurns ?? 3,
        // Belt and braces: no tools offered, and none permitted.
        allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'],
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
