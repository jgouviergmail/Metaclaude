import type { Run, TranscriptEvent } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { MemoryStore } from './memory.js';
import type { GateDecision, GateInput } from './gatekeeper.js';
import { ReflexionEngine, getInsight, listInsights, parseJsonLoose, pruneInsights, setInsightStatus, withLanguage } from './reflexion.js';

/**
 * `invoke()` needs a live Claude CLI subprocess and is never called here.
 * `reflect()` is, with the model call injected: what it decides between the
 * model's answer and the store — the noise floor, the hand-off to the gate,
 * when an insight is written, which runs are not reflected on — lived
 * unobserved for forty releases because the CLI stood in the way.
 */

let db: Db;
let engine: ReflexionEngine;
const logged: Array<{ level: string; message: string }> = [];
let memory: MemoryStore;
let admitted: GateInput[];
let gateAnswer: (input: GateInput) => Promise<GateDecision[]>;
let invokeAnswer: () => ReflexionOutputLike | null = () => null;
let readOnly: (run: Run, events: TranscriptEvent[]) => boolean = () => false;

interface ReflexionOutputLike {
  summary: string;
  lessons: Array<{ kind: 'semantic' | 'procedural' | 'failure'; title: string; content: string; confidence: number; tags?: string[] }>;
  skillProposal?: { name: string; description: string; body: string };
}

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
      ultracode: false,
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
    rewindPoint: null,
    servedModel: null,
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
  // The rows the foreign keys point at: memories name a workspace, insights a run.
  const now = Date.now();
  db.prepare(`INSERT INTO workspaces (id, name, slug, path, created_at, updated_at) VALUES ('ws_1','W','w','/tmp/w',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at) VALUES ('ses_1','ws_1',?,?,?)`).run(now, now, now);
  for (const id of ['run_1', 'run_2']) {
    db.prepare(`INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at) VALUES (?,'ses_1','ws_1','p','succeeded',?)`).run(id, now);
  }
  memory = new MemoryStore(db, new HashingEmbedder());
  admitted = [];
  gateAnswer = async (input) => {
    // The default fake keeps everything as durable, writing the row itself
    // the way the real gate does, so `written` carries real ids.
    const out: GateDecision[] = [];
    for (const candidate of input.candidates) {
      const { memory: row } = await memory.remember({
        workspaceId: input.workspaceId, kind: candidate.kind, title: candidate.title, content: candidate.content,
        tags: candidate.tags, confidence: Math.min(0.75, candidate.confidence * 0.85), sourceRunId: input.runId,
      });
      out.push({ candidate, level: 'lesson', outcome: 'kept', reason: 'kept by the fake', memoryId: row.id, shelf: 'durable' });
    }
    return out;
  };
  engine = new ReflexionEngine({
    db,
    memory,
    language: () => null,
    env: {},
    claudeBinPath: null,
    cwd: '/tmp',
    gate: {
      admit: async (input) => {
        admitted.push(input);
        return gateAnswer(input);
      },
    },
    invoke: async () => invokeAnswer(),
    readOnlyRun: (run, events) => readOnly(run, events),
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
    expect(getInsight(db, target.id)).toEqual(target);
    expect(getInsight(db, 'ins_nope')).toBeNull();
    expect(setInsightStatus(db, target.id, 'accepted')).toBe(true);
    expect(setInsightStatus(db, 'ins_nope', 'accepted')).toBe(false);
    expect(listInsights(db, { status: 'accepted' }).map((i) => i.id)).toEqual([target.id]);
    expect(listInsights(db, { status: 'new' })).toHaveLength(2);
  });

  it('prunes triaged insights past the retention window, and only those', () => {
    // Nothing else deletes from this table: the status update only writes a
    // column, and `run_id` is ON DELETE SET NULL, so a deleted session leaves
    // its insights behind. Without this the table only ever grows.
    const now = Date.UTC(2026, 0, 1);
    const statuses = ['new', 'accepted', 'rejected', 'applied'] as const;
    for (const status of statuses) {
      engine.recordInsight({
        workspaceId: null,
        runId: null,
        kind: 'lesson',
        title: status,
        body: '',
        confidence: 0.5,
        payload: null,
      });
      const id = listInsights(db, { limit: 1 })[0]!.id;
      // Backdate past the window and set the status, in one statement each.
      db.prepare('UPDATE insights SET status = ?, created_at = ? WHERE id = ?').run(
        status,
        now - 400 * 86_400_000,
        id,
      );
    }
    // One more, terminal but recent: retention is a window, not a status test.
    engine.recordInsight({
      workspaceId: null,
      runId: null,
      kind: 'lesson',
      title: 'recent-applied',
      body: '',
      confidence: 0.5,
      payload: null,
    });
    db.prepare('UPDATE insights SET status = ?, created_at = ? WHERE title = ?').run(
      'applied',
      now - 10 * 86_400_000,
      'recent-applied',
    );

    expect(pruneInsights(db, 365, now)).toBe(2);

    const left = listInsights(db).map((insight) => insight.title).sort();
    // The review queue survives however old it is; only rejected/applied go.
    expect(left).toEqual(['accepted', 'new', 'recent-applied']);
  });
});

describe('the language lessons are written in', () => {
  /**
   * The gap this closes, measured in production: a French deployment whose
   * only workspace sat on the default `auto` had distilled twenty-two memories
   * and every one was in English. The run's own answers followed the operator,
   * as they always had; everything the system wrote *about* the run did not,
   * because this prompt carried no opinion and nothing gave it one.
   */
  it('appends the directive to the system prompt, without displacing the schema rules', () => {
    const prompt = withLanguage('SCHEMA RULES HERE', 'fr');

    expect(prompt.startsWith('SCHEMA RULES HERE')).toBe(true);
    expect(prompt).toContain('French');
  });

  it('leaves the prompt untouched when there is no opinion', () => {
    expect(withLanguage('SCHEMA RULES HERE', null)).toBe('SCHEMA RULES HERE');
  });

  /**
   * The lesson bodies are prose, but a procedural memory's whole value is
   * often a literal command. Translating `pnpm test:run` would make it wrong,
   * not merely foreign.
   */
  it('tells the writer what must survive verbatim', () => {
    const prompt = withLanguage('X', 'en');

    expect(prompt).toMatch(/command|identifier|path/i);
    expect(prompt).toMatch(/field name|key/i);
  });
});

/* -------------------------------------------------------------------------- */
/* reflect()                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The decision path, driven with a fake model and a fake gate. Untested until
 * now because `invoke` spawned a CLI; the threshold, the gate hand-off, the
 * insight rule and the read-only skip all lived here unobserved.
 */
describe('reflect()', () => {
  const events = (n = 3): TranscriptEvent[] =>
    Array.from({ length: n }, () => toolCall('Bash', { command: 'pnpm test' }, { result: 'ok' }));

  afterEach(() => {
    invokeAnswer = () => null;
    readOnly = () => false;
  });

  it('hands the gate every lesson above the noise floor, and returns what it kept', async () => {
    invokeAnswer = () => ({
      summary: 'Ran the tests.',
      lessons: [
        { kind: 'procedural', title: 'Build shared first', content: 'pnpm --filter shared build before the rest.', confidence: 0.9 },
        { kind: 'failure', title: 'npm test fails', content: 'Use pnpm.', confidence: 0.6, tags: ['tests'] },
        { kind: 'semantic', title: 'A guess', content: 'Maybe.', confidence: 0.3 },
        { kind: 'semantic', title: '   ', content: 'Blank title.', confidence: 0.9 },
      ],
    });

    const written = await engine.reflect(makeRun({ status: 'succeeded' }), events());

    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.candidates.map((c) => c.title)).toEqual(['Build shared first', 'npm test fails']);
    expect(admitted[0]!.candidates[1]!.tags).toEqual(['tests', 'failure-mode']);
    expect(admitted[0]!.failed).toBe(false);
    expect(written).toHaveLength(2);
    expect(memory.get(written[0]!)?.title).toBe('Build shared first');
  });

  it('records an insight carrying every decision when something was kept, and none otherwise', async () => {
    invokeAnswer = () => ({ summary: 'Routine.', lessons: [{ kind: 'semantic', title: 'State', content: 'The form has three tabs.', confidence: 0.8 }] });
    gateAnswer = async (input) => [{ candidate: input.candidates[0]!, level: 'state', outcome: 'skipped', reason: 'changes next release' }];

    await engine.reflect(makeRun({ status: 'succeeded' }), events());
    expect(listInsights(db, { limit: 10 })).toHaveLength(0);

    gateAnswer = async (input) => {
      const { memory: row } = await memory.remember({ workspaceId: input.workspaceId, kind: 'semantic', title: 'Kept', content: 'Kept.', sourceRunId: input.runId });
      return [
        { candidate: input.candidates[0]!, level: 'state', outcome: 'skipped', reason: 'changes next release' },
        { candidate: { ...input.candidates[0]!, title: 'Kept' }, level: 'fact', outcome: 'kept', reason: 'holds', memoryId: row.id, shelf: 'volatile' },
      ];
    };
    await engine.reflect(makeRun({ id: 'run_2', status: 'succeeded' }), events());

    const [insight] = listInsights(db, { limit: 10 });
    expect(insight?.kind).toBe('lesson');
    expect(insight?.body).toContain('[skipped · state] State');
    expect(insight?.body).toContain('[kept · volatile · fact] Kept');
    const payload = JSON.parse(insight!.payload as string) as { kind: string; decisions: Array<{ outcome: string; memoryId: string | null }> };
    expect(payload.kind).toBe('reflexion');
    expect(payload.decisions.map((d) => d.outcome)).toEqual(['skipped', 'kept']);
    expect(payload.decisions[1]!.memoryId).toBeTruthy();
  });

  it('records a failure insight even when the gate kept nothing', async () => {
    invokeAnswer = () => ({ summary: 'The build broke.', lessons: [{ kind: 'failure', title: 'Broke', content: 'Why it broke.', confidence: 0.7 }] });
    gateAnswer = async (input) => [{ candidate: input.candidates[0]!, level: 'episodic', outcome: 'skipped', reason: 'one-off' }];

    await engine.reflect(makeRun({ status: 'failed', error: 'exit 1' }), events());

    const [insight] = listInsights(db, { limit: 10 });
    expect(insight?.kind).toBe('failure');
    expect(admitted[0]!.failed).toBe(true);
  });

  it('does not reflect on a read-only run of the workspace the caller names, unless it failed', async () => {
    invokeAnswer = () => ({ summary: 'Read things.', lessons: [{ kind: 'semantic', title: 'X', content: 'Y.', confidence: 0.9 }] });
    readOnly = () => true;

    expect(await engine.reflect(makeRun({ status: 'succeeded' }), events())).toEqual([]);
    expect(admitted).toHaveLength(0);

    expect(await engine.reflect(makeRun({ status: 'failed', error: 'x' }), events())).toHaveLength(1);
  });

  it('survives a gate that throws: nothing stored, a warning, no insight', async () => {
    invokeAnswer = () => ({ summary: 'S.', lessons: [{ kind: 'semantic', title: 'T', content: 'C.', confidence: 0.9 }] });
    gateAnswer = async () => {
      throw new Error('gate down');
    };

    expect(await engine.reflect(makeRun({ status: 'succeeded' }), events())).toEqual([]);
    expect(memory.count()).toBe(0);
    expect(logged.some((entry) => /memory gate failed/.test(entry.message))).toBe(true);
    expect(listInsights(db, { limit: 10 })).toHaveLength(0);
  });
});
