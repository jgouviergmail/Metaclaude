/**
 * Where the subscription actually went.
 *
 * Analytics could already scope to one workspace at a time, which answers "how
 * much did this one cost" and never "which one is eating the quota". On a plan
 * with a weekly ceiling the second question is the one that matters, and it is
 * the only one that needs every workspace on screen at once.
 *
 * The chart is proportional, so the tests are mostly about the ways a
 * proportional chart lies: one workspace at 100%, everything at zero, a single
 * row that fills the width and implies a comparison that was never made.
 */

import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AnalyticsSummary } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { WorkspaceUsageBars } from './WorkspaceUsageBars';

type Row = AnalyticsSummary['byWorkspace'][number];

const row = (over: Partial<Row> = {}): Row => ({
  workspaceId: 'ws_a',
  name: 'alpha',
  color: '#6366f1',
  runs: 4,
  costUsd: 1,
  inputTokens: 1000,
  outputTokens: 100,
  successRate: 1,
  ...over,
});

const widthOf = (element: HTMLElement): number =>
  Number.parseFloat(element.style.width.replace('%', ''));

describe('WorkspaceUsageBars', () => {
  it('lists each workspace by name', () => {
    render(
      <WorkspaceUsageBars
        rows={[row({ name: 'alpha' }), row({ workspaceId: 'ws_b', name: 'beta' })]}
      />,
    );

    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
  });

  it('sizes each bar against the heaviest, not against the total', () => {
    // Against the total, four similar workspaces are four short stubs and the
    // chart says nothing. Against the leader, the comparison is legible.
    render(
      <WorkspaceUsageBars
        rows={[
          row({ workspaceId: 'ws_a', name: 'alpha', inputTokens: 1000, outputTokens: 0 }),
          row({ workspaceId: 'ws_b', name: 'beta', inputTokens: 250, outputTokens: 0 }),
        ]}
      />,
    );

    const bars = screen.getAllByTestId('usage-bar');
    expect(widthOf(bars[0] as HTMLElement)).toBe(100);
    expect(widthOf(bars[1] as HTMLElement)).toBe(25);
  });

  it('does not divide by zero when nothing has been used', () => {
    // Reachable on a fresh install, and the naive version renders NaN% widths.
    render(<WorkspaceUsageBars rows={[row({ inputTokens: 0, outputTokens: 0, costUsd: 0 })]} />);

    const bar = screen.getAllByTestId('usage-bar')[0] as HTMLElement;
    expect(Number.isFinite(widthOf(bar))).toBe(true);
  });

  it('states each workspace’s share of the whole in words', () => {
    // The bar shows the comparison; the number has to carry the actual share,
    // or "twice as long as the other one" gets read as "half the quota".
    render(
      <WorkspaceUsageBars
        rows={[
          row({ workspaceId: 'ws_a', name: 'alpha', inputTokens: 750, outputTokens: 0 }),
          row({ workspaceId: 'ws_b', name: 'beta', inputTokens: 250, outputTokens: 0 }),
        ]}
      />,
    );

    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
  });

  it('counts input and output together, because both are billed', () => {
    render(
      <WorkspaceUsageBars
        rows={[
          row({ workspaceId: 'ws_a', name: 'alpha', inputTokens: 500, outputTokens: 500 }),
          row({ workspaceId: 'ws_b', name: 'beta', inputTokens: 1000, outputTokens: 0 }),
        ]}
      />,
    );

    // Equal totals, so equal bars — an output-blind chart would show 50/100.
    const bars = screen.getAllByTestId('usage-bar');
    expect(widthOf(bars[0] as HTMLElement)).toBe(widthOf(bars[1] as HTMLElement));
  });

  it('shows a cost only where one was reported', () => {
    // A subscription reports no per-run dollar cost. Rendering "$0.00" against
    // every workspace reads as "this was free", which is exactly backwards.
    render(<WorkspaceUsageBars rows={[row({ costUsd: 0 })]} />);

    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it('gives each row a readable accessible summary', () => {
    // A bar is invisible to a screen reader; the row has to say what it depicts.
    render(<WorkspaceUsageBars rows={[row({ name: 'alpha', runs: 4 })]} />);

    const item = screen.getByRole('listitem');
    expect(within(item).getByLabelText(/alpha/i)).toBeTruthy();
  });

  it('says so when there is nothing to compare', () => {
    render(<WorkspaceUsageBars rows={[]} />);

    expect(screen.getByText(/no usage/i)).toBeTruthy();
  });

  it('does not imply a comparison when there is only one workspace', () => {
    // A single bar at 100% looks like a finding. It is not one.
    render(<WorkspaceUsageBars rows={[row()]} />);

    expect(screen.queryByText('100%')).toBeNull();
  });
});
