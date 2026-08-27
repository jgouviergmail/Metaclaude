/**
 * The pulse must not lie: 24 bars always, quiet hours as real zeros, the
 * split between success and failure preserved, and the sentence matching
 * what is actually in flight.
 */

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UsagePoint } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { pulseBars, SystemPulse } from './SystemPulse';

const HOUR = 60 * 60_000;
const NOW = Math.floor(1_700_000_000_000 / HOUR) * HOUR + 12 * 60_000;

const point = (hoursAgo: number, runs: number, successRate: number): UsagePoint => ({
  bucket: Math.floor(NOW / HOUR) * HOUR - hoursAgo * HOUR,
  runs,
  successRate,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  medianDurationMs: 0,
});

const { apiMock } = vi.hoisted(() => ({
  apiMock: { analytics: vi.fn(async () => ({ summary: {} as never, series: [] as UsagePoint[] })) },
}));
vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

describe('pulseBars', () => {
  it('always yields 24 bars, holes filled with real zeros, oldest first', () => {
    const bars = pulseBars([point(0, 3, 1), point(5, 2, 0.5)], NOW);
    expect(bars).toHaveLength(24);
    expect(bars[23]).toMatchObject({ runs: 3, ok: 3, failed: 0 });
    expect(bars[18]).toMatchObject({ runs: 2, ok: 1, failed: 1 });
    expect(bars.filter((bar) => bar.runs === 0)).toHaveLength(22);
    expect(bars[0]!.hour).toBeLessThan(bars[23]!.hour);
  });

  it('ignores buckets older than the window instead of shifting everything', () => {
    const bars = pulseBars([point(30, 9, 1), point(1, 4, 1)], NOW);
    expect(bars.reduce((sum, bar) => sum + bar.runs, 0)).toBe(4);
  });
});

describe('SystemPulse', () => {
  it('says what is in flight, with the queue and the waiting decisions', async () => {
    renderWithProviders(
      <SystemPulse activeRuns={2} queuedRuns={1} approvals={3} lastFinishedAt={null} />,
    );
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('2 run(s) working right now');
    expect(status.textContent).toContain('1 queued');
    expect(status.textContent).toContain('3 decision(s) waiting on you');
  });

  it('is honestly quiet when nothing runs, naming the last finish', async () => {
    renderWithProviders(
      <SystemPulse activeRuns={0} queuedRuns={0} approvals={0} lastFinishedAt={NOW - HOUR} />,
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/all quiet/i);
  });

  it('draws the heartbeat from the hourly series', async () => {
    // Not `Once`: a stray refetch from an earlier mount would swallow it.
    apiMock.analytics.mockResolvedValue({
      summary: {} as never,
      series: [point(0, 5, 0.8), point(2, 1, 1)],
    });
    renderWithProviders(
      <SystemPulse activeRuns={0} queuedRuns={0} approvals={0} lastFinishedAt={null} now={NOW} />,
    );
    const svg = await screen.findByRole('img', { name: /over the last 24 hours/i });
    // 22 quiet ticks + (1 ok + 1 fail) for the busy hour + 1 ok for the other —
    // awaited, because the first paint happens before the series arrives.
    await waitFor(() => expect(svg.querySelectorAll('rect')).toHaveLength(25));
    expect(apiMock.analytics).toHaveBeenCalledWith({ days: 1, granularity: 'hour' });
  });
});
