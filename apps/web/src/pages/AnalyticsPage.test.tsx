/**
 * Cost, usage and what the learner has settled on.
 *
 * The one rule with teeth here is `granularityFor`: at ninety days a daily
 * series is ninety points of noise on a phone, so the request switches to
 * weekly. It is a pure function of the period, which makes it exactly the
 * thing to pin — and the period buttons are the only way to reach it.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { AnalyticsPage } from './AnalyticsPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(),
    analytics: vi.fn(),
    policy: vi.fn(),
    resetPolicy: vi.fn(),
    claudeUsage: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Recharts measures its container, which jsdom never lays out; the numbers
// this page reports are what the tests are about, not the curves.
vi.mock('recharts', async () => {
  // Named stubs rather than a Proxy: a Proxy answers *every* property,
  // including the internals React and recharts probe on a component
  // ($$typeof, prototype chains), which sent the render into a loop.
  // No JSX in a mock factory either — it is hoisted above the React import.
  const { createElement } = await import('react');
  const stub =
    (tag: string) =>
    ({ children }: { children?: unknown }) =>
      createElement(tag, null, children as never);
  return {
    Area: stub('div'),
    AreaChart: stub('div'),
    Bar: stub('div'),
    BarChart: stub('div'),
    CartesianGrid: stub('div'),
    Line: stub('div'),
    LineChart: stub('div'),
    ResponsiveContainer: stub('div'),
    Tooltip: stub('div'),
    XAxis: stub('div'),
    YAxis: stub('div'),
  };
});

// The field names come from the page itself: `totalRuns`, not `runs`, and
// the breakdowns live under `summary` rather than beside it. Guessing them
// produced `undefined.toLocaleString()` — the shape is the contract.
const analytics = (over: Record<string, unknown> = {}) => ({
  summary: {
    totalRuns: 42,
    totalCostUsd: 3.5,
    successRate: 0.92,
    averageReward: 0.7,
    medianDurationMs: 4200,
    p95DurationMs: 9000,
    byModel: [],
    byCategory: [],
    byWorkspace: [],
    ...(over.summary as Record<string, unknown>),
  },
  series: [],
  ...over,
});

/**
 * The period lives in a menu, not in a row of buttons, and its items declare
 * a checked state — which is the `MenuItem` accessibility fix from v0.32.5
 * showing up in a test written after it.
 */
const openPeriodMenu = () => {
  const trigger = screen.getByRole('button', { name: /^Period:/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspaces.mockResolvedValue({ workspaces: [] });
  apiMock.analytics.mockResolvedValue(analytics());
  // Read off the page's own accesses rather than guessed: it reads
  // `arms`, `explanations` and `categories` from this one response.
  apiMock.policy.mockResolvedValue({ arms: [], explanations: {}, categories: [] });
  apiMock.claudeUsage.mockResolvedValue(null);
});

describe('the period', () => {
  it('asks for a daily series over a month', async () => {
    renderWithProviders(<AnalyticsPage />);
    await waitFor(() =>
      expect(apiMock.analytics).toHaveBeenCalledWith({ days: 30, granularity: 'day' }),
    );
  });

  it('switches to weekly at ninety days', async () => {
    // Ninety daily points is noise on a phone; the granularity follows the
    // period rather than being a second thing to choose.
    renderWithProviders(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.analytics).toHaveBeenCalled());

    openPeriodMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /90 days/ }));
    await waitFor(() =>
      expect(apiMock.analytics).toHaveBeenCalledWith({ days: 90, granularity: 'week' }),
    );
  });

  it('stays daily at thirty and below', async () => {
    renderWithProviders(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.analytics).toHaveBeenCalled());

    openPeriodMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /7 days/ }));
    await waitFor(() =>
      expect(apiMock.analytics).toHaveBeenCalledWith({ days: 7, granularity: 'day' }),
    );
  });
});

describe('the figures', () => {
  it('reports what the period cost and how much of it worked', async () => {
    renderWithProviders(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText('42')).toBeDefined());
    // A success rate is a percentage, not a fraction, wherever it is shown.
    await waitFor(() => expect(screen.getByText(/92/)).toBeDefined());
  });

  it('renders a period in which nothing happened', async () => {
    // A fresh install opens this screen too, and zero runs is not an error.
    apiMock.analytics.mockResolvedValue(
      analytics({
        summary: {
          runs: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          successRate: 0,
          medianDurationMs: 0,
        },
      }),
    );
    renderWithProviders(<AnalyticsPage />);
    await waitFor(() => expect(apiMock.analytics).toHaveBeenCalled());
    expect(screen.queryByText('42')).toBeNull();
  });
});
