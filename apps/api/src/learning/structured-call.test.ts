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
