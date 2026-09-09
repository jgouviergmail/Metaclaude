/**
 * Reading a transcript back as text, for something other than the screen.
 *
 * The web app renders a run from its ordered event list; three other callers
 * want the same events as *prose* — the steward's `system_run`, the sessions
 * tools an automation reads other sessions with, and the preamble a chained
 * firing opens with. All three ask the same two questions ("what did it
 * answer", "what was said"), and the answer used to live in one of them: the
 * steward composed `finalText` inline, so the second caller would have copied
 * it and the third would have copied the copy. One definition, three callers.
 *
 * What earns the tests here is the budget. A session is not bounded — measured
 * on the deployment this is built for, the busiest holds 204 kB of events and
 * 36 kB of dialogue — so a tool that returns "the session" has to decide what
 * to drop, and say that it dropped it. Silence there is the failure mode: an
 * agent handed a truncated conversation with no mark reasons about a
 * conversation that did not happen.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@metaclaude/shared';
import { dialogue, finalAnswer, toolsCalled } from './transcript-view.js';

let seq = 0;
const at = (minute: number): number => new Date(2026, 0, 1, 12, minute).getTime();

const user = (text: string, minute = 0): TranscriptEvent => ({
  kind: 'user_message',
  id: `ev_${(seq += 1)}`,
  runId: 'run_1',
  seq,
  at: at(minute),
  text,
  attachments: [],
});

// `streaming` is a parameter rather than something a caller spreads on
// afterwards: spreading over the discriminated union widens it, and the
// typecheck rejects what vitest happily runs.
const assistant = (text: string, minute = 0, streaming = false): TranscriptEvent => ({
  kind: 'assistant_text',
  id: `ev_${(seq += 1)}`,
  runId: 'run_1',
  seq,
  at: at(minute),
  text,
  streaming,
});

const call = (name: string, minute = 0, status: 'ok' | 'error' = 'ok'): TranscriptEvent => ({
  kind: 'tool_call',
  id: `ev_${(seq += 1)}`,
  runId: 'run_1',
  seq,
  at: at(minute),
  toolUseId: `tu_${seq}`,
  name,
  input: { path: 'README.md' },
  status,
  result: 'done',
  resultIsError: status === 'error',
  durationMs: 12,
});

const thinking = (text: string, minute = 0): TranscriptEvent => ({
  kind: 'thinking',
  id: `ev_${(seq += 1)}`,
  runId: 'run_1',
  seq,
  at: at(minute),
  text,
  streaming: false,
});

describe('finalAnswer', () => {
  it('is the last assistant block, whatever follows it', () => {
    const events = [
      user('do the thing'),
      assistant('working on it'),
      call('Read'),
      assistant('here is the answer'),
      {
        kind: 'result',
        id: 'ev_r',
        runId: 'run_1',
        seq: 99,
        at: at(1),
        status: 'succeeded',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          durationMs: 1,
          turns: 1,
        },
        error: null,
      } satisfies TranscriptEvent,
    ];
    expect(finalAnswer(events)).toBe('here is the answer');
  });

  /**
   * A block still streaming is not an answer.
   *
   * The last event of a run interrupted mid-sentence carries `streaming: true`
   * and half a thought. Handing that to a chained automation as "what the
   * upstream said" is worse than handing it nothing: it reads complete.
   */
  it('ignores a block that is still streaming', () => {
    expect(finalAnswer([assistant('settled'), assistant('half a sen', 0, true)])).toBe('settled');
  });

  it('answers null when the run never spoke', () => {
    expect(finalAnswer([user('hello'), call('Bash')])).toBeNull();
    expect(finalAnswer([])).toBeNull();
    // Whitespace is not an answer either.
    expect(finalAnswer([assistant('   \n  ')])).toBeNull();
  });

  it('trims and bounds what it returns', () => {
    const long = 'x'.repeat(5000);
    const answer = finalAnswer([assistant(`  ${long}  `)], 100);
    expect(answer).toHaveLength(100);
    expect(answer?.endsWith('…')).toBe(true);
  });
});

describe('toolsCalled', () => {
  it('names each call with its outcome, most recent last', () => {
    expect(toolsCalled([call('Read'), assistant('x'), call('Bash', 0, 'error')])).toEqual([
      { name: 'Read', status: 'ok' },
      { name: 'Bash', status: 'error' },
    ]);
  });

  it('keeps the most recent when there are more than the cap', () => {
    const many = Array.from({ length: 10 }, (_, index) => call(`Tool${index}`));
    expect(toolsCalled(many, 3).map((entry) => entry.name)).toEqual(['Tool7', 'Tool8', 'Tool9']);
  });
});

describe('dialogue', () => {
  it('reads as a conversation, oldest first, with who said what', () => {
    const rendered = dialogue([user('ship it', 0), assistant('shipped', 1)]);
    expect(rendered.text).toBe('You: ship it\n\nAgent: shipped');
    expect(rendered.truncated).toBe(false);
    expect(rendered.omitted).toBe(0);
  });

  /**
   * Thinking is not dialogue. It is the model's own scratch space, it is the
   * bulkiest thing in a transcript after tool results, and quoting it back to
   * another model invites it to continue a train of thought rather than read a
   * conclusion.
   */
  it('leaves out thinking, and leaves out tools unless asked', () => {
    const events = [user('go'), thinking('let me see'), call('Read'), assistant('done')];
    expect(dialogue(events).text).toBe('You: go\n\nAgent: done');

    const withTools = dialogue(events, { includeTools: true });
    expect(withTools.text).toContain('[tool] Read → ok');
    expect(withTools.text).not.toContain('let me see');
  });

  it('keeps only what is inside the window when one is given', () => {
    const events = [user('old', 0), assistant('old answer', 1), user('new', 30), assistant('new answer', 31)];
    const rendered = dialogue(events, { since: at(20) });
    expect(rendered.text).toBe('You: new\n\nAgent: new answer');
    expect(rendered.omitted).toBe(2);
    // A window that drops events is not "truncated": nothing was cut for size.
    expect(rendered.truncated).toBe(false);
  });

  /**
   * The budget keeps the *end* of the conversation, and says so.
   *
   * Which end is a real choice: the most recent turn is what a caller asking
   * "use the data from session X" means, and it is what the session's own
   * `bySession` cap already keeps. Saying it was cut is the other half —
   * without the mark the agent reads a conversation that never happened.
   */
  it('drops the oldest turns to fit a budget, and reports what it dropped', () => {
    const events = [
      user('first', 0),
      assistant('a'.repeat(400), 1),
      user('second', 2),
      assistant('b'.repeat(400), 3),
    ];
    const rendered = dialogue(events, { maxChars: 500 });

    expect(rendered.truncated).toBe(true);
    expect(rendered.omitted).toBe(2);
    expect(rendered.text).toContain('b'.repeat(400));
    expect(rendered.text).not.toContain('a'.repeat(400));
    expect(rendered.text.length).toBeLessThanOrEqual(500);
  });

  /**
   * One turn larger than the whole budget still has to come back as
   * something. Returning nothing would read as an empty session, which is a
   * different fact entirely.
   */
  it('returns a cut single turn rather than nothing when one turn exceeds the budget', () => {
    const rendered = dialogue([assistant('z'.repeat(5000))], { maxChars: 200 });
    expect(rendered.truncated).toBe(true);
    expect(rendered.text.length).toBeLessThanOrEqual(200);
    expect(rendered.text).toContain('z');
  });

  it('says an empty session is empty rather than pretending', () => {
    expect(dialogue([])).toEqual({ text: '', truncated: false, omitted: 0, turns: 0 });
    // Only tool calls, and tools not asked for: no dialogue, but events exist.
    expect(dialogue([call('Read')])).toEqual({ text: '', truncated: false, omitted: 1, turns: 0 });
  });

  it('counts the turns it kept', () => {
    expect(dialogue([user('a'), assistant('b'), user('c'), assistant('d')]).turns).toBe(4);
  });
});
