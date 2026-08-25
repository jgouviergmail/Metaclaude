import type { Run, TranscriptEvent } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { MemoryStore } from './memory.js';
import { ReflexionEngine, listInsights, parseJsonLoose, setInsightStatus } from './reflexion.js';

/**
 * `reflect()` and `invoke()` need a live Claude CLI subprocess, so nothing here
 * calls them. Only the pure helpers and the transcript compressor are exercised.
 */

let db: Db;
let engine: ReflexionEngine;
const logged: Array<{ level: string; message: string }> = [];

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    sessionId: 'ses_1',
    workspaceId: 'ws_1',
    prompt: 'Fix the failing crypto tests and explain what was wrong.',
    status: 'succeeded',
    policy: {
      model: 'sonnet',
      effort: null,
      permissionMode: 'default',
      thinking: 'adaptive',
      thinkingBudgetTokens: null,
      agentName: null,
      source: 'workspace',
    },
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.0123,
      durationMs: 92_400,
      turns: 6,
    },
    category: 'debug',
    error: null,
    rating: null,
    reward: null,
    triggeredBy: 'user',
    startedAt: 1000,
    finishedAt: 2000,
    ...overrides,
  };
}

let seq = 0;
function toolCall(
  name: string,
  input: Record<string, unknown>,
  extra: { result?: string; resultIsError?: boolean } = {},
): TranscriptEvent {
  return {
    kind: 'tool_call',
    id: `ev_${seq}`,
    runId: 'run_1',
    seq: seq++,
    at: 1000 + seq,
    toolUseId: `tu_${seq}`,
    name,
    input,
    status: extra.resultIsError ? 'error' : 'ok',
    result: extra.result ?? null,
    resultIsError: extra.resultIsError ?? false,
    durationMs: 5,
  };
}

function assistantText(text: string): TranscriptEvent {
  return {
    kind: 'assistant_text',
    id: `ev_${seq}`,
    runId: 'run_1',
    seq: seq++,
    at: 1000 + seq,
    text,
    streaming: false,
  };
}

beforeEach(() => {
  seq = 0;
  logged.length = 0;
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  engine = new ReflexionEngine({
    db,
    memory: new MemoryStore(db, new HashingEmbedder()),
    env: {},
    claudeBinPath: null,
    cwd: '/tmp',
    log: (level, message) => logged.push({ level, message }),
  });
});

afterEach(() => {
  db.close();
});

describe('parseJsonLoose', () => {
  it('parses a bare JSON object', () => {
    const parsed = parseJsonLoose('{"summary":"did a thing","lessons":[]}');
    expect(parsed).toEqual({ summary: 'did a thing', lessons: [] });
  });

  it('parses JSON wrapped in a fenced code block', () => {
    const parsed = parseJsonLoose(
      'Here is what I found:\n```json\n{"summary":"s","lessons":[{"kind":"semantic","title":"t","content":"c","confidence":0.9}]}\n```\nHope that helps.',
    );
    expect(parsed!.summary).toBe('s');
    expect(parsed!.lessons).toHaveLength(1);
    expect(parsed!.lessons[0]!.title).toBe('t');
  });

  it('parses an unlabelled fenced block', () => {
    expect(parseJsonLoose('```\n{"summary":"s","lessons":[]}\n```')!.summary).toBe('s');
  });

  it('recovers JSON surrounded by prose', () => {
    expect(
      parseJsonLoose('Sure! {"summary":"s","lessons":[]} — let me know if you need more.')!.summary,
    ).toBe('s');
  });

  it('handles nested braces and arrays', () => {
    const parsed = parseJsonLoose(
      '{"summary":"s","lessons":[{"kind":"procedural","title":"t","content":"{not json}","confidence":0.5,"tags":["a","b"]}],"skillProposal":{"name":"do-thing","description":"d","body":"b"}}',
    );
    expect(parsed!.lessons[0]!.content).toBe('{not json}');
    expect(parsed!.lessons[0]!.tags).toEqual(['a', 'b']);
    expect(parsed!.skillProposal!.name).toBe('do-thing');
  });

  it('returns null for empty or blank input', () => {
    expect(parseJsonLoose('')).toBeNull();
    expect(parseJsonLoose('   \n  ')).toBeNull();
    expect(parseJsonLoose(undefined as unknown as string)).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(parseJsonLoose('I could not find anything worth remembering.')).toBeNull();
    expect(parseJsonLoose('{')).toBeNull();
    expect(parseJsonLoose('}{')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseJsonLoose('{"summary": "s", "lessons": [},}')).toBeNull();
    expect(parseJsonLoose('{summary: s}')).toBeNull();
  });

  it('rejects a well-formed object that is not a reflexion output', () => {
    // No `lessons` array means the model answered something else entirely.
    expect(parseJsonLoose('{"summary":"s"}')).toBeNull();
    expect(parseJsonLoose('{"lessons":"not an array"}')).toBeNull();
    expect(parseJsonLoose('{}')).toBeNull();
  });

  it('falls back to the raw text when the fenced block is not the JSON', () => {
    const text = '```\nnot json at all\n```\n{"summary":"s","lessons":[]}';
    expect(parseJsonLoose(text)!.summary).toBe('s');
  });
});

describe('buildTranscriptSummary', () => {
  it('opens with the user request and closes with the outcome', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), []);

    expect(summary).toContain('## User request');
    expect(summary).toContain('Fix the failing crypto tests and explain what was wrong.');
    expect(summary).toContain('## What the assistant did');
    expect(summary).toContain('## Outcome');
    expect(summary).toContain('status: succeeded');
    expect(summary).toContain('duration: 92s, turns: 6, cost: $0.0123');
  });

  it('includes the error on a failed run', () => {
    const summary = engine.buildTranscriptSummary(
      makeRun({ status: 'failed', error: 'Command exited with code 1' }),
      [],
    );
    expect(summary).toContain('status: failed — Command exited with code 1');
  });

  it('truncates a very long prompt and a very long error', () => {
    const summary = engine.buildTranscriptSummary(
      makeRun({ prompt: 'p'.repeat(6000), status: 'failed', error: 'e'.repeat(2000) }),
      [],
    );
    expect(summary).toContain('p'.repeat(4000));
    expect(summary).not.toContain('p'.repeat(4001));
    expect(summary).toContain('e'.repeat(500));
    expect(summary).not.toContain('e'.repeat(501));
  });

  it('tallies the tools that were used', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), [
      toolCall('Read', { file_path: '/ws/a.ts' }),
      toolCall('Read', { file_path: '/ws/b.ts' }),
      toolCall('Bash', { command: 'pnpm test:run' }),
    ]);
    expect(summary).toContain('Tools used: Read×2, Bash×1');
  });

  it('lists the bash commands verbatim, truncated', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), [
      toolCall('Bash', { command: 'pnpm --filter @metaclaude/api exec vitest run' }),
      toolCall('Bash', { command: 'q'.repeat(400) }),
      toolCall('Bash', {}),
    ]);
    expect(summary).toContain('- ran: `pnpm --filter @metaclaude/api exec vitest run`');
    expect(summary).toContain('q'.repeat(200));
    expect(summary).not.toContain('q'.repeat(201));
    // A Bash call with no command string produces no "ran:" line.
    expect(summary.match(/- ran: /g)).toHaveLength(2);
  });

  it('lists the files that were touched, deduplicated', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), [
      toolCall('Read', { file_path: '/ws/a.ts' }),
      toolCall('Edit', { file_path: '/ws/a.ts' }),
      toolCall('Write', { file_path: '/ws/b.ts' }),
      toolCall('Grep', { pattern: 'x' }),
    ]);
    expect(summary).toContain('Files touched: /ws/a.ts, /ws/b.ts');
  });

  it('surfaces the errors that were encountered', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), [
      toolCall('Bash', { command: 'pnpm test' }, { result: 'exit code 1', resultIsError: true }),
      toolCall('Read', { file_path: '/nope' }, { result: 'ENOENT', resultIsError: true }),
      toolCall('Read', { file_path: '/ok' }, { result: 'fine', resultIsError: false }),
    ]);
    expect(summary).toContain('## Errors encountered');
    expect(summary).toContain('Bash: exit code 1');
    expect(summary).toContain('Read: ENOENT');
    expect(summary).not.toContain('fine');
  });

  it('omits the optional sections when there is nothing to report', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), []);
    expect(summary).not.toContain('Tools used:');
    expect(summary).not.toContain('Files touched:');
    expect(summary).not.toContain('## Errors encountered');
    expect(summary).not.toContain("## Assistant's final answer");
  });

  it('quotes the last assistant message as the final answer', () => {
    const summary = engine.buildTranscriptSummary(makeRun(), [
      assistantText('First I will look at the tests.'),
      toolCall('Bash', { command: 'pnpm test' }),
      assistantText('The scrypt parameters were mismatched; I fixed them.'),
    ]);
    expect(summary).toContain("## Assistant's final answer");
    expect(summary).toContain('The scrypt parameters were mismatched; I fixed them.');
    // The final answer section holds only the last block.
    const finalSection = summary.slice(summary.indexOf("## Assistant's final answer"));
    expect(finalSection).not.toContain('First I will look at the tests.');
  });

  it('bounds the number of errors and files it reports', () => {
    const events = [
      ...Array.from({ length: 30 }, (_, i) =>
        toolCall('Read', { file_path: `/ws/file-${i}.ts` }, { result: `err ${i}`, resultIsError: true }),
      ),
    ];
    const summary = engine.buildTranscriptSummary(makeRun(), events);
    expect(summary).toContain('/ws/file-24.ts');
    expect(summary).not.toContain('/ws/file-25.ts');
    expect(summary).toContain('Read: err 7');
    expect(summary).not.toContain('Read: err 8');
  });

  it('is stable and bounded for a realistic transcript', () => {
    const events = [
      assistantText('Let me look at the failing test.'),
      toolCall('Read', { file_path: '/ws/src/security/crypto.ts' }),
      toolCall('Bash', { command: 'pnpm --filter api exec vitest run' }, {
        result: '1 failed',
        resultIsError: true,
      }),
      toolCall('Edit', { file_path: '/ws/src/security/crypto.ts' }),
      assistantText('Fixed: the salt length was wrong.'),
    ];
    const first = engine.buildTranscriptSummary(makeRun(), events);
    const second = engine.buildTranscriptSummary(makeRun(), events);
    expect(first).toBe(second);
    expect(first.length).toBeLessThan(20_000);
    expect(first.split('\n')[0]).toBe('## User request');
  });
});

describe('isWorthReflecting', () => {
  /** The predicate is private but has no dependency on the CLI. */
  function worth(run: Run, events: TranscriptEvent[]): boolean {
    return (
      engine as unknown as {
        isWorthReflecting(run: Run, events: TranscriptEvent[]): boolean;
      }
    ).isWorthReflecting(run, events);
  }

  it('skips an interrupted run', () => {
    expect(worth(makeRun({ status: 'interrupted' }), [toolCall('Bash', {}), toolCall('Read', {})])).toBe(
      false,
    );
  });

  it('skips a trivially short prompt', () => {
    expect(worth(makeRun({ prompt: 'hi' }), [toolCall('Bash', {}), toolCall('Read', {})])).toBe(false);
    expect(worth(makeRun({ prompt: 'x'.repeat(23) }), [toolCall('Bash', {}), toolCall('Read', {})])).toBe(
      false,
    );
    expect(worth(makeRun({ prompt: 'x'.repeat(24) }), [toolCall('Bash', {}), toolCall('Read', {})])).toBe(
      true,
    );
  });

  it('reflects on any failure, because a failure is informative', () => {
    expect(worth(makeRun({ status: 'failed' }), [])).toBe(true);
  });

  it('reflects once real work happened', () => {
    expect(worth(makeRun(), [])).toBe(false);
    expect(worth(makeRun(), [toolCall('Read', {})])).toBe(false);
    expect(worth(makeRun(), [toolCall('Read', {}), toolCall('Bash', {})])).toBe(true);
  });

  it('reflects on a long written answer even with no tool calls', () => {
    expect(worth(makeRun(), [assistantText('x'.repeat(599))])).toBe(false);
    expect(worth(makeRun(), [assistantText('x'.repeat(600))])).toBe(true);
    expect(worth(makeRun(), [assistantText('x'.repeat(300)), assistantText('y'.repeat(300))])).toBe(
      true,
    );
  });
});

describe('insights', () => {
  it('records an insight and reads it back', () => {
    engine.recordInsight({
      workspaceId: null,
      runId: null,
      kind: 'lesson',
      title: 'Tests run with vitest',
      body: 'The api package uses vitest, not jest.',
      confidence: 0.7,
      payload: null,
    });

    const insights = listInsights(db);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      kind: 'lesson',
      title: 'Tests run with vitest',
      confidence: 0.7,
      status: 'new',
      payload: null,
    });
    expect(insights[0]!.id.startsWith('ins_')).toBe(true);
  });

  it('truncates an oversized title and body', () => {
    engine.recordInsight({
      workspaceId: null,
      runId: null,
      kind: 'pattern',
      title: 't'.repeat(500),
      body: 'b'.repeat(30_000),
      confidence: 0.5,
      payload: null,
    });
    const insight = listInsights(db)[0]!;
    expect(insight.title).toHaveLength(300);
    expect(insight.body).toHaveLength(20_000);
  });

  it('filters by status and by workspace, newest first', () => {
    for (const kind of ['lesson', 'failure', 'skill_proposal'] as const) {
      engine.recordInsight({
        workspaceId: null,
        runId: null,
        kind,
        title: kind,
        body: '',
        confidence: 0.5,
        payload: kind === 'skill_proposal' ? '{"name":"x"}' : null,
      });
    }

    expect(listInsights(db)).toHaveLength(3);
    expect(listInsights(db, { workspaceId: null })).toHaveLength(3);
    expect(listInsights(db, { workspaceId: 'ws_other' })).toHaveLength(0);
    expect(listInsights(db, { status: 'new' })).toHaveLength(3);
    expect(listInsights(db, { status: 'accepted' })).toHaveLength(0);
    expect(listInsights(db, { limit: 1 })).toHaveLength(1);

    const target = listInsights(db)[0]!;
    expect(setInsightStatus(db, target.id, 'accepted')).toBe(true);
    expect(setInsightStatus(db, 'ins_nope', 'accepted')).toBe(false);
    expect(listInsights(db, { status: 'accepted' }).map((i) => i.id)).toEqual([target.id]);
    expect(listInsights(db, { status: 'new' })).toHaveLength(2);
  });
});
