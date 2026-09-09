/**
 * The card two screens now share.
 *
 * What is worth pinning is what a caller can leave out: the Dashboard shows
 * the same insights as the Memory page but offers fewer verbs, and a card that
 * rendered a button with no handler behind it would be a control that does
 * nothing — the defect this repository calls a briefing for a tool that cannot
 * run, one floor up. So every optional verb is asserted absent when its
 * callback is.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Insight, ReflexionInsightPayload, Workspace } from '@metaclaude/shared';
import { ReflexionInsightPayload as ReflexionInsightPayloadSchema } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { InsightCard } from './InsightCard';

const WORKSPACES = [{ id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' } as Workspace];

/**
 * Built from the fields the component reads, and every one of them set.
 *
 * Five fixtures written from memory were wrong in one session here, each
 * looking like a broken component: the parse fails, the card falls back, and
 * the test times out on an element that was never going to appear.
 */
const insight = (over: Partial<Insight> = {}): Insight =>
  ({
    id: 'ins_1',
    runId: 'run_1',
    workspaceId: 'ws_a',
    kind: 'lesson',
    status: 'new',
    title: 'Always cite the source of a figure',
    body: 'The operator asked twice for where a number came from.',
    confidence: 0.82,
    payload: null,
    createdAt: Date.now() - 3600_000,
    ...over,
  }) as Insight;

describe('the verbs', () => {
  it('decides in both directions, and says which way', () => {
    const onDecide = vi.fn();
    renderWithProviders(
      <InsightCard insight={insight()} workspaces={WORKSPACES} gate={null} onDecide={onDecide} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onDecide).toHaveBeenCalledWith('accepted');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenCalledWith('rejected');
  });

  it('offers Install skill only for a skill proposal, and only with somewhere to send it', () => {
    const { unmount } = renderWithProviders(
      <InsightCard
        insight={insight({ kind: 'skill_proposal' })}
        workspaces={WORKSPACES}
        gate={null}
        onDecide={vi.fn()}
        onInstallSkill={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Install skill' })).toBeTruthy();
    unmount();

    // A caller that does not install skills — the Dashboard — must not be
    // shown the button at all rather than one that answers nothing.
    renderWithProviders(
      <InsightCard
        insight={insight({ kind: 'skill_proposal' })}
        workspaces={WORKSPACES}
        gate={null}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Install skill' })).toBeNull();
  });

  it('spins exactly the control that is in flight', () => {
    renderWithProviders(
      <InsightCard
        insight={insight()}
        workspaces={WORKSPACES}
        gate={null}
        busy={{ deciding: 'accepted' }}
        onDecide={vi.fn()}
      />,
    );

    // A single `busy` flag would spin both, which says something is happening
    // and never which thing.
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('has nothing left to ask of an applied proposal, and points at what it made', () => {
    renderWithProviders(
      <InsightCard
        insight={insight({ kind: 'skill_proposal', status: 'applied' })}
        workspaces={WORKSPACES}
        gate={null}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByRole('link', { name: /Installed/ })).toBeTruthy();
  });
});

describe('the memory gate’s decisions', () => {
  /**
   * Parsed through the schema rather than typed from memory.
   *
   * The first draft of this fixture invented `level: 'workspace'`, which
   * `GateLevel` does not have, and omitted `kind`, `content`, `tags` and
   * `shelf` entirely — the exact mistake this repository has written down: a
   * fixture written from memory fails the parse, the component falls back, and
   * the test times out on an element that was never going to appear.
   */
  const decision = (over: Partial<ReflexionInsightPayload['decisions'][number]>) =>
    ({
      title: 'A note',
      content: 'What it said.',
      kind: 'semantic' as const,
      tags: [],
      level: 'lesson' as const,
      outcome: 'kept' as const,
      reason: '',
      memoryId: null,
      shelf: 'durable' as const,
      ...over,
    });

  const gate: ReflexionInsightPayload = ReflexionInsightPayloadSchema.parse({
    kind: 'reflexion',
    decisions: [
      decision({ outcome: 'skipped', title: 'A note the gate refused', reason: 'too thin', memoryId: null }),
      decision({ outcome: 'kept', title: 'A note the gate kept', memoryId: 'mem_9' }),
    ],
  });

  it('offers Keep on a refused note and Forget on a kept one', () => {
    const onKeepNote = vi.fn();
    const onForgetMemory = vi.fn();
    renderWithProviders(
      <InsightCard
        insight={insight()}
        workspaces={WORKSPACES}
        gate={gate}
        onDecide={vi.fn()}
        onKeepNote={onKeepNote}
        onForgetMemory={onForgetMemory}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Keep A note the gate refused' }));
    expect(onKeepNote).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByRole('button', { name: 'Forget A note the gate kept' }));
    expect(onForgetMemory).toHaveBeenCalledWith('mem_9');
  });

  it('shows the decisions and no buttons for a caller that offers neither verb', () => {
    renderWithProviders(
      <InsightCard insight={insight()} workspaces={WORKSPACES} gate={gate} onDecide={vi.fn()} />,
    );

    // The record is still worth reading — what the run proposed and what
    // became of it — without controls that would answer nothing.
    expect(screen.getByText('A note the gate refused')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Keep / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Forget / })).toBeNull();
  });

  it('shows the body instead when the payload carries no decisions', () => {
    renderWithProviders(
      <InsightCard insight={insight()} workspaces={WORKSPACES} gate={null} onDecide={vi.fn()} />,
    );

    expect(screen.getByText(/asked twice for where a number came from/)).toBeTruthy();
  });
});
