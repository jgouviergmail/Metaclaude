/**
 * The strip narrates from the run row alone until opened — the fetch is the
 * price of the detail, not of the transcript — and the cascade dresses only
 * the run that is working right now.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Run } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { RunGenesis } from './RunGenesis';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    runGenesis: vi.fn(async () => ({
      category: 'engineering',
      source: 'learned' as const,
      memories: [
        { id: 'mem_1', title: 'The deploy gates on health', kind: 'semantic' as const, confidence: 0.8, score: 1 },
      ],
      arm: { id: 'pol_1', category: 'engineering', model: 'sonnet', effort: 'high', alpha: 8, beta: 2, trials: 9, meanCostUsd: 0.02, meanDurationMs: 30_000 } as never,
      explanation: 'Across 9 runs, sonnet at high effort performs best.',
    })),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

const run = (overrides: Partial<Run> = {}): Run =>
  ({
    id: 'run_1',
    status: 'succeeded',
    category: 'engineering',
    policy: { model: 'sonnet', effort: 'high', source: 'learned', ultracode: false },
    ...overrides,
  }) as never;

describe('RunGenesis', () => {
  it('narrates from the run row alone — no request until opened', () => {
    renderWithProviders(<RunGenesis run={run()} />);
    expect(screen.getByText('engineering')).toBeDefined();
    expect(screen.getByText('sonnet @ high')).toBeDefined();
    expect(screen.getByText('chosen from experience')).toBeDefined();
    expect(apiMock.runGenesis).not.toHaveBeenCalled();
  });

  /**
   * A run nobody in this browser typed must not read as one somebody did.
   *
   * `docs/SECURITY.md` and the guide both promise this for gateway runs — that
   * an outside program's run is visible as such in the history. Until this
   * shipped, the promise was true of the database and false of the screen:
   * `triggeredBy` was stored and rendered nowhere at all.
   */
  it('says who asked, when it was not the person reading', () => {
    renderWithProviders(<RunGenesis run={run({ triggeredBy: 'api' })} />);

    expect(screen.getByText('asked through the API')).toBeDefined();
  });

  it('names the other non-human origins too', () => {
    for (const [trigger, phrase] of [
      ['automation', 'started by an automation'],
      ['delegation', 'asked by another workspace'],
    ] as const) {
      const { unmount } = renderWithProviders(<RunGenesis run={run({ triggeredBy: trigger })} />);
      expect(screen.getByText(phrase), trigger).toBeDefined();
      unmount();
    }
  });

  it('says nothing for an ordinary run somebody typed', () => {
    // The common case. A strip that labels every run "started by you" stops
    // being read, which would cost the line above its meaning.
    renderWithProviders(<RunGenesis run={run({ triggeredBy: 'user' })} />);

    expect(screen.queryByText(/started by|asked (through|by)/)).toBeNull();
  });

  it('opening fetches the detail: recalled memories and the posterior', async () => {
    renderWithProviders(<RunGenesis run={run()} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(await screen.findByText('The deploy gates on health')).toBeDefined();
    expect(apiMock.runGenesis).toHaveBeenCalledWith('run_1');
    expect(screen.getByRole('img', { name: /expected over 9 trials/i })).toBeDefined();
  });

  it('says honestly when nothing was recalled', async () => {
    apiMock.runGenesis.mockResolvedValueOnce({
      category: 'engineering',
      source: 'workspace',
      memories: [],
      arm: null,
      explanation: '',
    } as never);
    renderWithProviders(<RunGenesis run={run({ policy: { model: 'default', effort: null, source: 'workspace', ultracode: false } as never })} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(await screen.findByText(/started from the prompt alone/i)).toBeDefined();
  });

  it('cascades only while the run is working', () => {
    const { container, unmount } = renderWithProviders(<RunGenesis run={run({ status: 'running' })} />);
    expect(container.querySelector('.genesis-step')).not.toBeNull();
    unmount();

    const { container: done } = renderWithProviders(<RunGenesis run={run()} />);
    expect(done.querySelector('.genesis-step')).toBeNull();
  });

  it('keeps polling an active run whose recall has not landed yet', async () => {
    apiMock.runGenesis.mockResolvedValue({
      category: 'engineering',
      source: 'learned',
      memories: [],
      arm: null,
      explanation: '',
    } as never);
    renderWithProviders(<RunGenesis run={run({ status: 'running' })} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(apiMock.runGenesis).toHaveBeenCalled());
    expect(await screen.findByText(/recalling memory/i)).toBeDefined();
  });
});
