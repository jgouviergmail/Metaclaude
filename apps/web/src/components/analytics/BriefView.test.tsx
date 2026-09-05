/**
 * The morning brief, rendered.
 *
 * The headline leads, every failure links to its session, and the silently
 * disabled automations are named — that being the only surface that says so.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Brief } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { BriefView } from './BriefView';

const activity: Brief['activity'] = {
  totalRuns: 3,
  successRate: 2 / 3,
  totalCostUsd: 0,
  totalInputTokens: 1000,
  totalOutputTokens: 2000,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  medianDurationMs: 5000,
  p95DurationMs: 9000,
  averageReward: null,
  byModel: [],
  byCategory: [],
  byWorkspace: [],
};

const brief = (over: Partial<Brief> = {}): Brief => ({
  since: 0,
  generatedAt: 1_000,
  headline: '3 runs in the last 24 hours, 1 failure worth a look.',
  activity,
  failures: [
    {
      runId: 'run_9',
      sessionId: 'ses_9',
      workspaceId: 'ws_1',
      workspaceName: 'Alpha',
      prompt: 'deploy the parser',
      error: 'the build broke',
      at: 900,
    },
  ],
  pendingApprovals: 0,
  automations: { disabledByGuard: ['runaway-loop'], nextRun: { name: 'nightly', at: 2_000 } },
  doctor: { status: 'ok', checks: [], version: '0.1.0', ranAt: 1_000 },
  quota: null,
  newInsights: 2,
  board: { inReview: 0, blocked: 0, inFlight: 0, dueSoon: 0 },
  ...over,
});

describe('BriefView', () => {
  it('leads with the headline', () => {
    render(<BriefView brief={brief()} />);
    expect(screen.getByText(/1 failure worth a look/)).toBeDefined();
  });

  it('links each failure to its session, with the error in sight', () => {
    render(<BriefView brief={brief()} />);

    const link = screen.getByRole('link', { name: /deploy the parser/i });
    expect(link.getAttribute('href')).toBe('/w/ws_1/s/ses_9');
    expect(screen.getByText(/the build broke/)).toBeDefined();
    expect(screen.getByText('Alpha')).toBeDefined();
  });

  it('names the automations the failure guard switched off', () => {
    render(<BriefView brief={brief()} />);
    expect(screen.getByText(/runaway-loop/)).toBeDefined();
  });

  it('links the board line when cards need eyes, and says which', () => {
    render(
      <BriefView
        brief={brief({ board: { inReview: 2, blocked: 1, inFlight: 3, dueSoon: 0 } })}
      />,
    );

    const link = screen.getByRole('link', { name: /board:/i });
    expect(link.getAttribute('href')).toBe('/board');
    expect(link.textContent).toContain('2 in review');
    expect(link.textContent).toContain('1 card blocked');
    expect(link.textContent).toContain('3 being worked');
    expect(link.textContent).not.toContain('due soon');
  });

  it('keeps the board line off an empty board', () => {
    render(<BriefView brief={brief()} />);
    expect(screen.queryByRole('link', { name: /board:/i })).toBeNull();
  });

  // The headline is composed here from the counts rather than read from
  // `brief.headline`: that field is English prose the server assembled, and a
  // finished sentence cannot be translated. The fixture carries a *different*
  // headline on purpose, so a component that went back to reading the
  // server's would fail this rather than pass it by coincidence.
  it('stays calm on a quiet day', () => {
    render(
      <BriefView
        brief={brief({
          headline: 'this sentence must not reach the screen',
          activity: { ...activity, totalRuns: 0 },
          failures: [],
          automations: { disabledByGuard: [], nextRun: null },
        })}
      />,
    );

    expect(screen.getByText(/A quiet day — no runs in the last 24 hours/)).toBeDefined();
    expect(screen.queryByText(/this sentence must not reach the screen/)).toBeNull();
    expect(screen.queryByText(/failure guard/)).toBeNull();
  });
});
