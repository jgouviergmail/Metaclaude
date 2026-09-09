/**
 * A transcript, read back as prose.
 *
 * The event list is the source of truth and the web app renders it directly.
 * Everything else that wants a transcript wants *text*: the steward's
 * `system_run`, the sessions tools an automation reads other sessions with,
 * and the preamble a chained firing opens with. All three ask the same two
 * questions — what did it answer, what was said — and the answers lived inside
 * the first of them. A second caller would have copied that code and a third
 * would have copied the copy; two copies of a projection diverge the same way
 * two copies of a component do.
 *
 * Everything here is pure: it takes events and returns text. The repository
 * decides which events, the caller decides the budget.
 */

import type { TranscriptEvent } from '@metaclaude/shared';

/** What a model is handed as "the answer" when nothing narrower is asked for. */
export const FINAL_ANSWER_CHARS = 4000;

/**
 * What `session_read` returns by default, and its ceiling.
 *
 * Measured on the deployment this was built for: the busiest session holds
 * 204 kB of events and 36 kB of dialogue, and the busiest single day 120 kB.
 * 40 kB therefore returns most sessions whole while keeping a runaway one from
 * costing more than the run that asked for it; the ceiling is where a caller
 * who knows what they are doing stops.
 */
export const DIALOGUE_CHARS = 40_000;
export const DIALOGUE_CHARS_MAX = 120_000;

/** Cut to `max`, marking the cut. Never returns more than `max` characters. */
export function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The run's answer: its last completed assistant block.
 *
 * "Completed" is load-bearing. A run interrupted mid-sentence leaves a block
 * with `streaming: true` holding half a thought, and handing that to a chained
 * automation as what the upstream said is worse than handing it nothing —
 * it reads as finished. Null when the run never spoke, which a caller has to
 * be able to tell apart from an empty answer.
 */
export function finalAnswer(
  events: readonly TranscriptEvent[],
  max = FINAL_ANSWER_CHARS,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind !== 'assistant_text' || event.streaming) continue;
    const text = event.text.trim();
    if (text) return excerpt(text, max);
  }
  return null;
}

/** The tools a run called, oldest first, capped to the most recent `max`. */
export function toolsCalled(
  events: readonly TranscriptEvent[],
  max = 60,
): Array<{ name: string; status: string }> {
  const calls = events.flatMap((event) =>
    event.kind === 'tool_call' ? [{ name: event.name, status: event.status }] : [],
  );
  return calls.slice(-max);
}

export interface Dialogue {
  /** The conversation as text, oldest turn first. Empty when there was none. */
  text: string;
  /** Whether the budget cut turns out. Distinct from a window's `omitted`. */
  truncated: boolean;
  /** Events not in the returned text — outside the window, cut, or not dialogue. */
  omitted: number;
  /** How many turns the text holds. */
  turns: number;
}

/**
 * The conversation, as one block of text a model can read.
 *
 * Thinking is left out on purpose: it is the model's own scratch space, the
 * bulkiest thing in a transcript after tool results, and quoting it back
 * invites a reader to continue a train of thought rather than read a
 * conclusion. Tool calls are out by default and available on request — a
 * caller asking "what did that session do" wants them, one asking "what was
 * decided" does not.
 *
 * The budget keeps the **end**. That is what "use the data from session X"
 * means in practice, and it is what the repository's own cap already keeps, so
 * the two agree rather than fighting. What matters as much is that the cut is
 * *reported*: an agent handed a silently truncated conversation reasons about
 * a conversation that did not happen.
 */
export function dialogue(
  events: readonly TranscriptEvent[],
  options: { since?: number; includeTools?: boolean; maxChars?: number } = {},
): Dialogue {
  const maxChars = Math.max(1, Math.min(options.maxChars ?? DIALOGUE_CHARS, DIALOGUE_CHARS_MAX));
  const inWindow = options.since === undefined ? events : events.filter((event) => event.at >= options.since!);

  const lines: string[] = [];
  for (const event of inWindow) {
    if (event.kind === 'user_message') {
      const text = event.text.trim();
      if (text) lines.push(`You: ${text}`);
      continue;
    }
    if (event.kind === 'assistant_text') {
      const text = event.text.trim();
      if (text) lines.push(`Agent: ${text}`);
      continue;
    }
    if (event.kind === 'tool_call' && options.includeTools) {
      lines.push(`[tool] ${event.name} → ${event.status}`);
    }
  }

  if (lines.length === 0) {
    return { text: '', truncated: false, omitted: events.length, turns: 0 };
  }

  // Fill backwards from the most recent turn, so what survives is the end.
  const SEPARATOR = '\n\n';
  const kept: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const cost = size === 0 ? line.length : line.length + SEPARATOR.length;
    if (size + cost > maxChars) break;
    kept.unshift(line);
    size += cost;
  }

  // One turn larger than the whole budget still has to come back as something:
  // returning nothing would read as an empty session, a different fact.
  if (kept.length === 0) {
    return {
      text: excerpt(lines[lines.length - 1] as string, maxChars),
      truncated: true,
      omitted: events.length - 1,
      turns: 1,
    };
  }

  const dropped = lines.length - kept.length;
  return {
    text: kept.join(SEPARATOR),
    truncated: dropped > 0,
    omitted: events.length - kept.length,
    turns: kept.length,
  };
}
