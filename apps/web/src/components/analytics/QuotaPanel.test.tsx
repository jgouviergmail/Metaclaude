/**
 * The subscription quota panel.
 *
 * The truthfulness rules: a missing bucket is not a bucket at 0%, "does not
 * apply" is said in words rather than rendered as nothing, and the CLI's own
 * caveat about its attribution being approximate is shown — the one thing
 * that stops the panel overclaiming.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ClaudeUsage } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { QuotaPanel } from './QuotaPanel';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

const usage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
  subscriptionType: 'max',
  windows: [
    {
      key: 'five_hour',
      label: 'Session (5 h)',
      utilization: 42,
      resetsAt: Date.parse('2026-08-26T15:00:00.000Z'),
    },
    { key: 'model:Fable', label: 'Fable', utilization: 91, resetsAt: null },
  ],
  extraUsage: { isEnabled: true, monthlyLimit: 50, usedCredits: 3.5, utilization: 7 },
  behaviors: {
    day: {
      requestCount: 120,
      sessionCount: 6,
      behaviors: [{ key: 'subagent_heavy', pct: 34, count: 41 }],
      agents: [],
      skills: [],
      plugins: [],
      mcpServers: [{ name: 'github', pct: 9 }],
    },
    week: {
      requestCount: 900,
      sessionCount: 40,
      behaviors: [],
      agents: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
  },
  unavailable: [],
  fetchedAt: NOW,
  ...over,
});

describe('QuotaPanel', () => {
  it('renders each window with its utilization and reset', () => {
    render(<QuotaPanel usage={usage()} now={NOW} />);

    expect(screen.getByText('Session (5 h)')).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();
    expect(screen.getByText(/resets in 3h/i)).toBeDefined();
    expect(screen.getByText('Fable')).toBeDefined();
  });

  it('marks a window near its ceiling', () => {
    render(<QuotaPanel usage={usage()} now={NOW} />);
    // 91% — the bar that needs to be seen before the run that hits 100.
    expect(screen.getByTestId('quota-bar-model:Fable').className).toContain('bg-danger');
    expect(screen.getByTestId('quota-bar-five_hour').className).not.toContain('bg-danger');
  });

  it('says in words when the plan has no windows', () => {
    render(
      <QuotaPanel
        usage={usage({ windows: [], unavailable: ['rate_limits'], behaviors: null })}
        now={NOW}
      />,
    );
    expect(screen.getByText(/do not apply/i)).toBeDefined();
  });

  it('shows the attribution with the CLI’s own caveat', () => {
    render(<QuotaPanel usage={usage()} now={NOW} />);

    expect(screen.getByText(/subagent_heavy/)).toBeDefined();
    expect(screen.getByText(/34%/)).toBeDefined();
    // Overclaiming guard: this data is local-transcripts-only and says so.
    expect(screen.getByText(/this machine/i)).toBeDefined();
  });
});
