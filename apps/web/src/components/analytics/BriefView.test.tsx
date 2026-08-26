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

  it('stays calm on a quiet day', () => {
    render(
      <BriefView
        brief={brief({
          headline: 'A quiet day.',
          failures: [],
          automations: { disabledByGuard: [], nextRun: null },
        })}
      />,
    );

    expect(screen.getByText('A quiet day.')).toBeDefined();
    expect(screen.queryByText(/failure guard/)).toBeNull();
  });
});
