/**
 * Reading other sessions of the same workspace, and the fence around it.
 *
 * What earns the tests here is not that a read returns rows — the forwarding
 * test derives that from the schemas — but the boundary. Every id the agent
 * names has to resolve inside *its own* workspace, and a session belonging to
 * another workspace must answer exactly like one that does not exist: saying
 * "that exists but is not yours" already confirms it exists, and these tools
 * are mounted in every ordinary workspace of the deployment.
 *
 * The second thing worth holding is that a truncated read *says* it was
 * truncated. An agent handed a silently cut conversation reasons about a
 * conversation that did not happen, and answers with confidence about it.
 */

import type { Run, Session, TranscriptEvent } from '@metaclaude/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { registeredToolNames } from '../test/mcp.js';
import {
  SESSIONS_TOOL_CATALOGUE,
  buildSessionsServer,
  createSessionsHandlers,
  sessionsToolNames,
  type SessionsFacade,
} from './sessions-tools.js';

const WS = 'ws_1';
const OTHER = 'ws_2';
const NOW = new Date(2026, 0, 10, 12, 0).getTime();
const HOUR = 3_600_000;

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 'ses_1',
    workspaceId: WS,
    title: 'Recherche IA',
    status: 'idle',
    model: 'default',
    effort: null,
    permissionMode: 'default',
    agentName: null,
    pinned: false,
    archived: false,
    totalCostUsd: 1.5,
    runCount: 3,
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW - HOUR,
    lastActivityAt: NOW - HOUR,
    ...over,
  }) as unknown as Session;

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'run_1',
    sessionId: 'ses_1',
    workspaceId: WS,
    prompt: 'Deploy the API',
    status: 'succeeded',
    triggeredBy: 'automation',
    category: 'ops',
    error: null,
    policy: { model: 'claude-sonnet-5', permissionMode: 'default' },
    usage: { costUsd: 0.4, inputTokens: 10, outputTokens: 20, durationMs: 900, turns: 2 },
    startedAt: NOW - HOUR,
    finishedAt: NOW - HOUR + 900,
    ...over,
  }) as unknown as Run;

let sessions: Map<string, Session>;
let runs: Map<string, Run>;
let events: Map<string, TranscriptEvent[]>;
let asked: Array<{ method: string; args: unknown }>;
let facade: SessionsFacade;

let seq = 0;
const say = (who: 'user_message' | 'assistant_text', text: string, at: number): TranscriptEvent =>
  who === 'user_message'
    ? { kind: 'user_message', id: `ev_${(seq += 1)}`, runId: 'run_1', seq, at, text, attachments: [] }
    : { kind: 'assistant_text', id: `ev_${(seq += 1)}`, runId: 'run_1', seq, at, text, streaming: false };

beforeEach(() => {
  seq = 0;
  asked = [];
  sessions = new Map([
    ['ses_1', session()],
    ['ses_old', session({ id: 'ses_old', title: 'Ancienne', archived: true })],
    ['ses_other', session({ id: 'ses_other', title: 'Ailleurs', workspaceId: OTHER })],
  ]);
  runs = new Map([
    ['run_1', run()],
    ['run_other', run({ id: 'run_other', sessionId: 'ses_other', workspaceId: OTHER })],
  ]);
  events = new Map([
    [
      'ses_1',
      [
        say('user_message', 'question ancienne', NOW - 48 * HOUR),
        say('assistant_text', 'réponse ancienne', NOW - 48 * HOUR + 10),
        say('user_message', 'question récente', NOW - 2 * HOUR),
        say('assistant_text', 'réponse récente', NOW - 2 * HOUR + 10),
      ],
    ],
    ['run_1', [say('assistant_text', 'la réponse finale', NOW - HOUR)]],
  ]);

  facade = {
    listSessions: (workspaceId, options) => {
      asked.push({ method: 'listSessions', args: { workspaceId, options } });
      return [...sessions.values()].filter(
        (entry) =>
          entry.workspaceId === workspaceId && (options.includeArchived || !entry.archived),
      );
    },
    getSession: (id) => sessions.get(id) ?? null,
    getRun: (id) => runs.get(id) ?? null,
    sessionEvents: (id, options) => {
      asked.push({ method: 'sessionEvents', args: { id, options } });
      return (events.get(id) ?? []).filter((event) => event.at >= (options.since ?? 0));
    },
    runEvents: (id) => events.get(id) ?? [],
  };
});

const handlers = (): ReturnType<typeof createSessionsHandlers> =>
  createSessionsHandlers(facade, { workspaceId: WS, sessionId: 'ses_current', now: () => NOW });

describe('session_list', () => {
  it('lists this workspace’s sessions and marks the one the run is in', () => {
    const listed = handlers().list({});
    expect(listed.sessions.map((entry) => entry.id)).toEqual(['ses_1']);
    expect(listed.sessions[0]).toMatchObject({ title: 'Recherche IA', runCount: 3 });
    // Never another workspace's, whatever it is called.
    expect(listed.sessions.some((entry) => entry.id === 'ses_other')).toBe(false);
  });

  it('marks the current session, so the agent does not read itself back', () => {
    sessions.set('ses_current', session({ id: 'ses_current', title: 'En cours' }));
    const listed = handlers().list({});
    const current = listed.sessions.find((entry) => entry.id === 'ses_current');
    expect(current?.isCurrent).toBe(true);
    expect(listed.sessions.find((entry) => entry.id === 'ses_1')?.isCurrent).toBe(false);
  });

  /**
   * The title filter runs before the cap, not after it.
   *
   * Filtering what a capped listing returned means a session older than the
   * cap cannot be found by name — and "the session about the API" is, by the
   * time an operator names it that way, usually an old one. Same shape as
   * capping a directory before sorting it: the cheap filter belongs on the
   * whole set, and the cap on what the filter left.
   */
  it('searches the whole workspace, not just the first page of it', () => {
    for (let index = 0; index < 60; index += 1) {
      sessions.set(`ses_bulk_${index}`, session({ id: `ses_bulk_${index}`, title: `Bruit ${index}` }));
    }
    sessions.set('ses_buried', session({ id: 'ses_buried', title: 'Le sujet cherché' }));

    // A caller's small limit must not decide what is searchable.
    const found = handlers().list({ query: 'sujet cherché', limit: 5 });
    expect(found.sessions.map((entry) => entry.id)).toEqual(['ses_buried']);

    // And the limit still bounds what comes back when the query matches many.
    expect(handlers().list({ query: 'Bruit', limit: 5 }).sessions).toHaveLength(5);
  });

  it('finds by title, case- and accent-insensitively', () => {
    expect(handlers().list({ query: 'recherche' }).sessions.map((e) => e.id)).toEqual(['ses_1']);
    expect(handlers().list({ query: 'RECHERCHE IA' }).sessions.map((e) => e.id)).toEqual(['ses_1']);
    // `\b` is ASCII-only and accents are where that shows: a French title has
    // to be findable typed without them.
    sessions.set('ses_acc', session({ id: 'ses_acc', title: 'Évaluation du modèle' }));
    expect(handlers().list({ query: 'evaluation' }).sessions.map((e) => e.id)).toEqual(['ses_acc']);
    expect(handlers().list({ query: 'rien du tout' }).sessions).toEqual([]);
  });

  it('leaves archived sessions out unless asked', () => {
    expect(handlers().list({}).sessions.map((e) => e.id)).not.toContain('ses_old');
    expect(handlers().list({ includeArchived: true }).sessions.map((e) => e.id)).toContain('ses_old');
  });
});

describe('session_read', () => {
  it('returns the conversation, oldest first, with what it left out', () => {
    const read = handlers().read({ sessionId: 'ses_1' });
    expect(read.title).toBe('Recherche IA');
    expect(read.text).toContain('You: question ancienne');
    expect(read.text).toContain('Agent: réponse récente');
    expect(read.truncated).toBe(false);
    expect(read.turns).toBe(4);
  });

  /**
   * The window is what "use the last 7 days of session X" becomes, and it has
   * to reach the repository — filtering after the read would apply the cap
   * first and answer with whatever survived it.
   */
  it('passes a time window down rather than filtering what came back', () => {
    const read = handlers().read({ sessionId: 'ses_1', sinceHours: 24 });
    expect(read.text).not.toContain('ancienne');
    expect(read.text).toContain('récente');

    const call = asked.find((entry) => entry.method === 'sessionEvents');
    expect((call?.args as { options: { since?: number } }).options.since).toBe(NOW - 24 * HOUR);
  });

  it('says when it cut, rather than returning a conversation that never happened', () => {
    const read = handlers().read({ sessionId: 'ses_1', maxChars: 40 });
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(40);
    expect(read.omitted).toBeGreaterThan(0);
  });

  it('includes the tools it called only when asked', () => {
    events.set('ses_1', [
      say('user_message', 'go', NOW - HOUR),
      {
        kind: 'tool_call',
        id: 'ev_t',
        runId: 'run_1',
        seq: 90,
        at: NOW - HOUR,
        toolUseId: 'tu_1',
        name: 'Bash',
        input: {},
        status: 'ok',
        result: null,
        resultIsError: false,
        durationMs: 5,
      },
    ]);
    expect(handlers().read({ sessionId: 'ses_1' }).text).not.toContain('Bash');
    expect(handlers().read({ sessionId: 'ses_1', tools: true }).text).toContain('Bash');
  });

  /**
   * One message for "no such session" and for "another workspace's". These
   * tools are mounted in every ordinary workspace, so a distinct refusal is a
   * way to confirm that a session id exists somewhere else in the deployment.
   */
  it('refuses another workspace’s session exactly as it refuses a missing one', () => {
    const missing = (): unknown => handlers().read({ sessionId: 'ses_nope' });
    const foreign = (): unknown => handlers().read({ sessionId: 'ses_other' });
    expect(missing).toThrow(/No session/);
    expect(foreign).toThrow(/No session/);

    let a = '';
    let b = '';
    try { missing(); } catch (error) { a = (error as Error).message.replace('ses_nope', 'ID'); }
    try { foreign(); } catch (error) { b = (error as Error).message.replace('ses_other', 'ID'); }
    expect(a).toBe(b);
  });
});

describe('run_result', () => {
  it('gives the prompt, the outcome and the final answer', () => {
    const result = handlers().runResult({ runId: 'run_1' });
    expect(result).toMatchObject({
      id: 'run_1',
      status: 'succeeded',
      sessionId: 'ses_1',
      finalText: 'la réponse finale',
    });
    expect(result.prompt).toBe('Deploy the API');
  });

  /**
   * The prompt is bounded like the answer.
   *
   * An automation's prompt may be 100 000 characters by schema, and a chained
   * firing calls this on the run that triggered it — so an unbounded prompt
   * would put the *upstream's instructions* in front of the downstream's own,
   * which is the thing the preamble's own budget exists to prevent. Bounded at
   * the same 4 000 as the answer, and marked the same way.
   */
  it('bounds the prompt it hands back, as it bounds the answer', () => {
    runs.set('run_long', run({ id: 'run_long', prompt: 'P'.repeat(9000) }));
    events.set('run_long', [say('assistant_text', 'A'.repeat(9000), NOW)]);

    const result = handlers().runResult({ runId: 'run_long' });
    expect(result.prompt.length).toBeLessThanOrEqual(4000);
    expect(result.prompt.endsWith('…')).toBe(true);
    expect((result.finalText ?? '').length).toBeLessThanOrEqual(4000);
  });

  it('refuses another workspace’s run the same way it refuses a missing one', () => {
    expect(() => handlers().runResult({ runId: 'run_nope' })).toThrow(/No run/);
    expect(() => handlers().runResult({ runId: 'run_other' })).toThrow(/No run/);
  });

  it('says a run that never spoke never spoke, rather than returning an empty answer', () => {
    events.set('run_1', []);
    expect(handlers().runResult({ runId: 'run_1' }).finalText).toBeNull();
  });
});

describe('the catalogue', () => {
  /**
   * The catalogue is what a workspace pre-approves; the server is what the run
   * can call. A name in one and not the other is either a pre-approval of
   * nothing or an approval card the operator was promised they would not see.
   */
  it('registers exactly the catalogue, under the names the pre-approvals use', () => {
    const server = buildSessionsServer(facade, {
      workspaceId: WS,
      sessionId: 'ses_current',
      now: () => NOW,
    });

    expect(registeredToolNames(server).sort()).toEqual(
      SESSIONS_TOOL_CATALOGUE.map((entry) => entry.name).sort(),
    );
    expect(sessionsToolNames()).toEqual(
      SESSIONS_TOOL_CATALOGUE.map((entry) => `mcp__metaclaude_sessions__${entry.name}`),
    );
  });

  /**
   * Every one of these reads. Nothing here changes anything, which is what
   * lets all three be pre-approved — a run under `dontAsk` that had to raise a
   * card would simply be refused, and an automation is exactly that run.
   */
  it('is read-only, so all of it can be pre-approved', () => {
    expect(SESSIONS_TOOL_CATALOGUE.every((entry) => entry.ring === 1)).toBe(true);
  });
});
