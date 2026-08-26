/**
 * Live session state.
 *
 * This store is fed by a socket, so it must survive the things a socket does:
 * frames for a session the user has navigated away from, frames replayed out of
 * order after a reconnect, and an HTTP refetch landing in the middle of both.
 * Every test below is one of those, not a happy path.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, Run, Session, TranscriptEvent } from '@metaclaude/shared';
import { sessionTopic } from '@metaclaude/shared';
import { useSessionStore } from './store.js';

const SESSION_ID = 'ses_current';
const OTHER_ID = 'ses_elsewhere';
const TOPIC = sessionTopic(SESSION_ID);
const OTHER_TOPIC = sessionTopic(OTHER_ID);

function session(id = SESSION_ID): Session {
  return {
    id,
    workspaceId: 'ws_1',
    title: 'Session',
    claudeSessionId: null,
    status: 'idle',
    model: 'default',
    effort: null,
    permissionMode: 'default',
    agentName: null,
    pinned: false,
    archived: false,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    runCount: 0,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  };
}

function run(id: string, status: Run['status'], sessionId = SESSION_ID): Run {
  return {
    id,
    sessionId,
    workspaceId: 'ws_1',
    prompt: 'do the thing',
    status,
    policy: {
      model: 'default',
      effort: null,
      permissionMode: 'default',
      thinking: 'adaptive',
      thinkingBudgetTokens: null,
      agentName: null,
      ultracode: false,
      source: 'workspace',
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
    },
    category: null,
    error: null,
    rating: null,
    reward: null,
    triggeredBy: 'user',
    rewindPoint: null,
    startedAt: 1,
    finishedAt: null,
  };
}

function textEvent(id: string, text: string): TranscriptEvent {
  return { kind: 'assistant_text', id, runId: 'run_1', seq: 1, at: 1, text, streaming: false };
}

function resultEvent(id: string): TranscriptEvent {
  return {
    kind: 'result',
    id,
    runId: 'run_1',
    seq: 2,
    at: 2,
    status: 'succeeded',
    error: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 1,
    },
  };
}

function approval(id: string, sessionId = SESSION_ID): ApprovalRequest {
  return {
    id,
    runId: 'run_1',
    sessionId,
    workspaceId: 'ws_1',
    toolUseId: 'tu_1',
    toolName: 'Bash',
    input: { command: 'ls' },
    summary: 'ls',
    risk: 'low',
    reason: null,
    createdAt: 1,
    expiresAt: 10_000,
  };
}

const store = () => useSessionStore.getState();

beforeEach(() => {
  useSessionStore.getState().clear();
  useSessionStore.getState().load({
    session: session(),
    events: [],
    runs: [],
    approvals: [],
    isRunning: false,
  });
});

describe('session scoping', () => {
  it('ignores a transcript event addressed to another session', () => {
    // A `TranscriptEvent` carries no session id — only the frame's topic says
    // where it belongs — so without the topic guard this lands in whatever
    // transcript happens to be open.
    store().applyEvent(OTHER_TOPIC, textEvent('ev_1', 'not yours'));
    expect(store().events).toEqual([]);

    store().applyEvent(TOPIC, textEvent('ev_2', 'yours'));
    expect(store().events).toHaveLength(1);
  });

  it('ignores a delta addressed to another session', () => {
    store().applyDelta(OTHER_TOPIC, 'ev_1', 'assistant_text', 'nope');
    expect(store().streaming.size).toBe(0);

    store().applyDelta(TOPIC, 'ev_1', 'assistant_text', 'yes');
    expect(store().streaming.get('ev_1')?.text).toBe('yes');
  });

  it('ignores runs, sessions and approvals belonging elsewhere', () => {
    store().applyRun(run('run_x', 'running', OTHER_ID));
    expect(store().runs).toEqual([]);
    expect(store().isRunning).toBe(false);

    store().applySession({ ...session(OTHER_ID), title: 'renamed' });
    expect(store().session?.title).toBe('Session');

    store().addApproval(approval('apr_x', OTHER_ID));
    expect(store().approvals).toEqual([]);
  });
});

describe('transcript', () => {
  it('appends new events and replaces an event resent under the same id', () => {
    store().applyEvent(TOPIC, textEvent('ev_1', 'partial'));
    store().applyEvent(TOPIC, textEvent('ev_1', 'complete'));

    expect(store().events).toHaveLength(1);
    expect((store().events[0] as { text: string }).text).toBe('complete');
  });

  it('is idempotent under a replay of frames it already has', () => {
    const frames = [textEvent('ev_1', 'one'), textEvent('ev_2', 'two')];
    for (const frame of frames) store().applyEvent(TOPIC, frame);
    // A reconnect can hand back a window the client already applied.
    for (const frame of frames) store().applyEvent(TOPIC, frame);

    expect(store().events.map((event) => event.id)).toEqual(['ev_1', 'ev_2']);
  });

  it('accumulates deltas and drops the buffer when the real event lands', () => {
    store().applyDelta(TOPIC, 'ev_1', 'assistant_text', 'Hel');
    store().applyDelta(TOPIC, 'ev_1', 'assistant_text', 'lo');
    expect(store().streaming.get('ev_1')?.text).toBe('Hello');

    store().applyEvent(TOPIC, textEvent('ev_1', 'Hello'));
    expect(store().streaming.has('ev_1')).toBe(false);
  });

  it('clears orphaned streaming buffers when a run ends', () => {
    // A block whose completion never arrived would otherwise linger forever.
    store().applyDelta(TOPIC, 'ev_orphan', 'thinking', 'half a thought');
    store().applyEvent(TOPIC, resultEvent('ev_result'));
    expect(store().streaming.size).toBe(0);
  });
});

describe('isRunning', () => {
  it('follows the run set rather than the last frame seen', () => {
    store().applyRun(run('run_1', 'running'));
    expect(store().isRunning).toBe(true);

    store().applyRun(run('run_1', 'succeeded'));
    expect(store().isRunning).toBe(false);
  });

  it('stays true while any run is still active', () => {
    store().applyRun(run('run_1', 'running'));
    store().applyRun(run('run_2', 'waiting_approval'));
    store().applyRun(run('run_1', 'succeeded'));

    // Taking the last frame at face value would have blanked the badge here.
    expect(store().isRunning).toBe(true);

    store().applyRun(run('run_2', 'succeeded'));
    expect(store().isRunning).toBe(false);
  });

  it('is not cleared by a result event for a run that already finished', () => {
    store().applyRun(run('run_old', 'succeeded'));
    store().applyRun(run('run_new', 'running'));

    // A replayed terminal event from the earlier run must not stop the badge.
    store().applyEvent(TOPIC, resultEvent('ev_old_result'));
    expect(store().isRunning).toBe(true);
  });
});

describe('run status is monotonic', () => {
  it('refuses to move a finished run back to running', () => {
    // The race: a reconnect replays a `running` frame after an HTTP refetch has
    // already reported the run as finished.
    store().applyRun(run('run_1', 'succeeded'));
    store().applyRun(run('run_1', 'running'));

    expect(store().runs[0]?.status).toBe('succeeded');
    expect(store().isRunning).toBe(false);
  });

  it('refuses for every terminal status', () => {
    for (const terminal of ['succeeded', 'failed', 'interrupted'] as const) {
      useSessionStore.getState().load({
        session: session(),
        events: [],
        runs: [run('run_1', terminal)],
        approvals: [],
        isRunning: false,
      });
      store().applyRun(run('run_1', 'queued'));
      expect(store().runs[0]?.status, terminal).toBe(terminal);
    }
  });

  it('still allows forward transitions and a terminal-to-terminal correction', () => {
    store().applyRun(run('run_1', 'queued'));
    store().applyRun(run('run_1', 'running'));
    expect(store().runs[0]?.status).toBe('running');

    store().applyRun(run('run_1', 'waiting_approval'));
    expect(store().runs[0]?.status).toBe('waiting_approval');

    store().applyRun(run('run_1', 'succeeded'));
    // A late correction between two terminal states is a real update, not a
    // regression, so it is accepted.
    store().applyRun(run('run_1', 'failed'));
    expect(store().runs[0]?.status).toBe('failed');
  });
});

describe('approvals', () => {
  it('does not add the same approval twice', () => {
    store().addApproval(approval('apr_1'));
    store().addApproval(approval('apr_1'));
    expect(store().approvals).toHaveLength(1);
  });

  it('removes one by id and leaves the rest', () => {
    store().addApproval(approval('apr_1'));
    store().addApproval(approval('apr_2'));
    store().resolveApproval('apr_1');

    expect(store().approvals.map((entry) => entry.id)).toEqual(['apr_2']);
  });
});

describe('lifecycle', () => {
  it('load replaces everything, including stale streaming buffers', () => {
    store().applyDelta(TOPIC, 'ev_1', 'assistant_text', 'stale');
    store().applyEvent(TOPIC, textEvent('ev_1', 'stale'));

    useSessionStore.getState().load({
      session: session(),
      events: [textEvent('ev_fresh', 'fresh')],
      runs: [run('run_1', 'running')],
      approvals: [approval('apr_1')],
      isRunning: true,
    });

    expect(store().events.map((event) => event.id)).toEqual(['ev_fresh']);
    expect(store().streaming.size).toBe(0);
    expect(store().isRunning).toBe(true);
  });

  it('clear leaves nothing behind for the next session', () => {
    store().applyEvent(TOPIC, textEvent('ev_1', 'x'));
    store().applyRun(run('run_1', 'running'));
    store().addApproval(approval('apr_1'));

    useSessionStore.getState().clear();

    expect(store().sessionId).toBeNull();
    expect(store().events).toEqual([]);
    expect(store().runs).toEqual([]);
    expect(store().approvals).toEqual([]);
    expect(store().isRunning).toBe(false);

    // And a frame arriving after the clear finds no session to attach to.
    store().applyEvent(TOPIC, textEvent('ev_2', 'late'));
    expect(store().events).toEqual([]);
  });
});
