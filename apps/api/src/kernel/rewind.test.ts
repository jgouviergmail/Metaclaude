/**
 * Deciding whether a run can be rewound.
 *
 * Kept apart from the kernel because the kernel has no test fixture yet, and
 * "can this be undone" is exactly the logic that must not go untested: every
 * branch here is a case where doing the obvious thing destroys the operator's
 * files or lies to them about having restored them.
 */

import { describe, expect, it } from 'vitest';
import type { Run, Session } from '@metaclaude/shared';
import { planRewind } from './rewind.js';

const run: Run = {
  id: 'run_1',
  sessionId: 'ses_1',
  workspaceId: 'ws_1',
  prompt: 'refactor the parser',
  status: 'succeeded',
  policy: {
    model: 'default',
    effort: null,
    permissionMode: 'default',
    thinking: 'disabled',
    thinkingBudgetTokens: null,
    agentName: null,
    source: 'explicit',
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
  rewindPoint: '11111111-1111-4111-8111-111111111111',
  startedAt: 0,
  finishedAt: 1,
};

const session = { id: 'ses_1', claudeSessionId: 'sdk-session' } as Session;

describe('planRewind', () => {
  it('produces the three things a rewind needs', () => {
    const plan = planRewind(run, session);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rewindPoint).toBe('11111111-1111-4111-8111-111111111111');
    expect(plan.claudeSessionId).toBe('sdk-session');
  });

  it('refuses a run that has not finished', () => {
    // The CLI is mid-edit. Restoring files under a process that is still
    // writing them produces a tree that matches neither state.
    for (const status of ['queued', 'running', 'waiting_approval'] as const) {
      const plan = planRewind({ ...run, status }, session);
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.reason).toMatch(/still|running|finish/i);
    }
  });

  it('allows rewinding a failed or interrupted run', () => {
    // This is the common case, not an edge one: a run that went wrong is
    // exactly the run an operator wants to undo.
    for (const status of ['failed', 'interrupted'] as const) {
      expect(planRewind({ ...run, status }, session).ok).toBe(true);
    }
  });

  it('says why when the run has no anchor', () => {
    // Almost always "checkpointing was off for this workspace". A bare "cannot
    // rewind" leaves the operator with no idea how to make the next run
    // recoverable, which is the only useful thing to tell them here.
    const plan = planRewind({ ...run, rewindPoint: null }, session);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/checkpoint/i);
  });

  it('refuses when the session was never registered with the CLI', () => {
    // No CLI session id means there is nothing to resume, so there are no
    // checkpoints to find.
    const plan = planRewind(run, { ...session, claudeSessionId: null } as Session);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/session/i);
  });
});
