/**
 * The layout is the contract: sector by kind, radius by recency, size by
 * confidence, and positions that survive a refetch byte-identical.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Memory } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { constellationLayout, MemoryConstellation, recencyOf } from './MemoryConstellation';

const NOW = 1_700_000_000_000;
const W = 640;
const H = 320;

const memory = (overrides: Partial<Memory>): Memory =>
  ({
    id: 'mem_1',
    workspaceId: null,
    kind: 'semantic',
    title: 'A fact',
    content: '',
    tags: [],
    confidence: 0.7,
    useCount: 0,
    successCount: 0,
    pinned: false,
    sourceRunId: null,
    createdAt: NOW - 10 * 24 * 60 * 60_000,
    updatedAt: NOW,
    lastUsedAt: null,
    ...overrides,
  }) as Memory;

describe('constellationLayout', () => {
  it('files each kind into its own sector', () => {
    const { nodes } = constellationLayout(
      [
        memory({ id: 'a', kind: 'semantic' }),
        memory({ id: 'b', kind: 'episodic' }),
        memory({ id: 'c', kind: 'procedural' }),
      ],
      { width: W, height: H, now: NOW },
    );
    const angle = (n: { x: number; y: number }): number =>
      (Math.atan2(n.y - H / 2, n.x - W / 2) * 180) / Math.PI;
    // Sector centres: semantic −90°, episodic 30°, procedural 150°, ±52°.
    const within = (value: number, centre: number) =>
      Math.abs(((value - centre + 540) % 360) - 180) <= 53;
    expect(within(angle(nodes[0]!), -90)).toBe(true);
    expect(within(angle(nodes[1]!), 30)).toBe(true);
    expect(within(angle(nodes[2]!), 150)).toBe(true);
  });

  it('puts the recently recalled near the centre and the fading at the rim', () => {
    const { nodes } = constellationLayout(
      [
        memory({ id: 'fresh', lastUsedAt: NOW - 30 * 60_000 }),
        memory({ id: 'stale', lastUsedAt: NOW - 29 * 24 * 60 * 60_000 }),
      ],
      { width: W, height: H, now: NOW },
    );
    const radius = (n: { x: number; y: number }): number =>
      Math.hypot(n.x - W / 2, n.y - H / 2);
    expect(radius(nodes.find((n) => n.id === 'fresh')!)).toBeLessThan(
      radius(nodes.find((n) => n.id === 'stale')!),
    );
    // And the fresh one is the brighter of the two.
    expect(nodes.find((n) => n.id === 'fresh')!.opacity).toBeGreaterThan(
      nodes.find((n) => n.id === 'stale')!.opacity,
    );
  });

  it('sizes by confidence and keeps positions stable across calls', () => {
    const input = [memory({ id: 'sure', confidence: 0.95 }), memory({ id: 'shaky', confidence: 0.2 })];
    const first = constellationLayout(input, { width: W, height: H, now: NOW });
    const again = constellationLayout(input, { width: W, height: H, now: NOW });

    expect(first.nodes.find((n) => n.id === 'sure')!.size).toBeGreaterThan(
      first.nodes.find((n) => n.id === 'shaky')!.size,
    );
    expect(again.nodes).toEqual(first.nodes);
  });

  it('caps the sky at its brightest and counts what it dropped', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      memory({ id: `m${i}`, confidence: i / 300, lastUsedAt: NOW - 60_000 }),
    );
    const { nodes, dropped } = constellationLayout(many, { width: W, height: H, now: NOW });
    expect(nodes).toHaveLength(240);
    expect(dropped).toBe(60);
    // The brightest survived: the dropped tail is the low-confidence end.
    expect(nodes.some((n) => n.id === 'm299')).toBe(true);
    expect(nodes.some((n) => n.id === 'm0')).toBe(false);
  });

  it('recency is log-scaled — an hour and a day are far apart, two months are not', () => {
    const at = (ageMs: number) => recencyOf({ lastUsedAt: NOW - ageMs, createdAt: 0 }, NOW);
    expect(at(24 * 60 * 60_000) - at(60 * 60_000)).toBeGreaterThan(
      at(60 * 24 * 60 * 60_000) - at(31 * 24 * 60 * 60_000),
    );
  });
});

describe('MemoryConstellation', () => {
  it('renders one star per memory, titled, and selects on click', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <MemoryConstellation
        memories={[memory({ id: 'a', title: 'The deploy gates on health' })]}
        now={NOW}
        onSelect={onSelect}
      />,
    );
    const star = screen.getByRole('button', { name: /the deploy gates on health/i });
    fireEvent.click(star);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('marks a pinned memory with its ring and a fresh recall with the pulse', () => {
    const { container } = renderWithProviders(
      <MemoryConstellation
        memories={[
          memory({ id: 'p', pinned: true }),
          memory({ id: 'l', lastUsedAt: NOW - 60_000 }),
        ]}
        now={NOW}
      />,
    );
    const circles = [...container.querySelectorAll('circle.constellation-node')];
    expect(circles.some((c) => c.getAttribute('stroke') === 'var(--mc-warning)')).toBe(true);
    expect(container.querySelector('.constellation-live')).not.toBeNull();
  });

  it('renders nothing at all for an empty memory', () => {
    const { container } = renderWithProviders(<MemoryConstellation memories={[]} now={NOW} />);
    expect(container.innerHTML).toBe('');
  });
});
