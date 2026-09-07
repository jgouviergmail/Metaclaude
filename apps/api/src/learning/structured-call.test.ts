/**
 * The shared tool-less structured call.
 *
 * The fake stands in for the SDK's `query`; what is under test is the
 * recovery ladder — `structured_output` first, JSON mined from the text
 * body second, null third — and that the caller's `accept` gate really
 * gates both paths.
 */

import { describe, expect, it } from 'vitest';
import { extractJson, structuredCall } from './structured-call.js';

const context = { env: {}, claudeBinPath: null, cwd: '/tmp/scratch' };

interface Answer {
  worthIt: boolean;
}

const accept = (parsed: unknown): boolean => typeof (parsed as Answer).worthIt === 'boolean';

function fakeQuery(messages: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const message of messages) yield message;
  })() as never;
}

describe('structuredCall', () => {
  it('prefers the structured output when the CLI provides one', async () => {
    const answer = await structuredCall<Answer>(context, {
      prompt: 'p',
      systemPrompt: 's',
      schema: {},
      accept,
      queryFn: (() =>
        fakeQuery([
          { type: 'result', structured_output: { worthIt: true }, result: 'ignored' },
        ])) as never,
    });

    expect(answer).toEqual({ worthIt: true });
  });

  it('recovers JSON from the text body when structured output is missing', async () => {
    // Some CLI versions omit structured_output — found in production, and the
    // reason the fallback exists.
    const answer = await structuredCall<Answer>(context, {
      prompt: 'p',
      systemPrompt: 's',
      schema: {},
      accept,
      queryFn: (() =>
        fakeQuery([
          { type: 'result', result: 'Here you go:\n```json\n{"worthIt": false}\n```' },
        ])) as never,
    });

    expect(answer).toEqual({ worthIt: false });
  });

  it('returns null when neither path yields a shape the caller accepts', async () => {
    const answer = await structuredCall<Answer>(context, {
      prompt: 'p',
      systemPrompt: 's',
      schema: {},
      accept,
      queryFn: (() =>
        fakeQuery([{ type: 'result', structured_output: { wrong: 1 }, result: '{"also": "wrong"}' }])) as never,
    });

    expect(answer).toBeNull();
  });
});

describe('extractJson', () => {
  it('reads a fenced block before the raw text', () => {
    expect(extractJson<Answer>('prose ```json\n{"worthIt": true}\n``` more', accept)).toEqual({
      worthIt: true,
    });
  });

  it('reads bare JSON embedded in prose', () => {
    expect(extractJson<Answer>('the answer is {"worthIt": false} thanks', accept)).toEqual({
      worthIt: false,
    });
  });

  it('rejects JSON the accept gate refuses', () => {
    expect(extractJson<Answer>('{"unrelated": 1}', accept)).toBeNull();
  });

  it('answers null for empty or json-free text', () => {
    expect(extractJson<Answer>('', accept)).toBeNull();
    expect(extractJson<Answer>('no braces here', accept)).toBeNull();
  });
});

/**
 * The turn ceiling.
 *
 * One turn was the default, and the comment beside it already knew the trap:
 * the SDK delivers a schema-constrained answer through a hidden tool call, so
 * a model that spends its single turn writing prose first ends as "Reached
 * maximum number of turns (1)" with no answer at all. The memory gate hit it,
 * measured it and raised *its own* call to three. Nothing raised the others,
 * and the reflector — whose prompt is the longest of the lot, a whole
 * transcript summary — kept the failing default: ten consecutive failures in
 * production, every one of them logged at warn and dropped, which is why an
 * entire day of conversation left no memory behind.
 *
 * A ceiling is not a target. A call that answers on its first turn costs
 * exactly what it cost before, so raising the default is free where it already
 * worked and is the difference between an answer and nothing where it did not.
 */
describe('the turn ceiling', () => {
  const optionsOf = async (request: Partial<Parameters<typeof structuredCall>[1]>) => {
    let seen: Record<string, unknown> = {};
    await structuredCall<Answer>(context, {
      prompt: 'p',
      systemPrompt: 's',
      schema: {},
      accept,
      ...request,
      queryFn: ((input: { options: Record<string, unknown> }) => {
        seen = input.options;
        return fakeQuery([{ type: 'result', structured_output: { worthIt: true } }]);
      }) as never,
    });
    return seen;
  };

  it('leaves room for a turn spent on prose, for every caller', async () => {
    expect((await optionsOf({})).maxTurns).toBe(3);
  });

  it('still lets a caller ask for fewer', async () => {
    expect((await optionsOf({ maxTurns: 1 })).maxTurns).toBe(1);
  });
});
