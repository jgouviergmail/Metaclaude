/**
 * The memory, as a sky — every visual dimension carries a real datum.
 *
 * Polar and deterministic, not force-directed: a simulation would burn a
 * phone's battery to produce positions that mean nothing. Here every channel
 * answers a question the Memory page already gets asked:
 *
 *   - sector    → kind (semantic, episodic, procedural)
 *   - radius    → recency: what was recalled lately sits near the centre,
 *                 what is drifting toward the forgetting curve's edge sits
 *                 out at the rim (log scale — an hour and a month both read)
 *   - size      → confidence, the number reinforcement actually moves
 *   - brightness→ recency again, so the sky dims toward the rim
 *   - a ring    → pinned: exempt from decay, and visibly so
 *   - a pulse   → recalled in the last 24 h (stilled by reduced-motion)
 *
 * Positions derive from a hash of the id, so the sky is stable across
 * renders and refetches: a memory keeps its place until reinforcement or
 * decay genuinely moves it inward or outward. Watching a star drift toward
 * the rim IS the forgetting curve.
 */

import { useId, useMemo } from 'react';
import type { Memory, MemoryKind } from '@metaclaude/shared';
import { useT } from '@/lib/i18n';
import { cn, formatPercent, formatRelative } from '@/lib/utils';

/** Oldest age the radius resolves; beyond this everything sits at the rim. */
export const HORIZON_MS = 30 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** Cap the sky, honestly: the faintest stars drop and the legend says so. */
const MAX_NODES = 240;

/** Matches the list badges (KIND_TONE on the page): one hue per kind. */
const KIND_VAR: Record<MemoryKind, string> = {
  semantic: 'var(--mc-info)',
  episodic: 'var(--mc-accent)',
  procedural: 'var(--mc-thinking)',
};

/** Sector centres, degrees; each kind owns a 120° slice minus a margin. */
const SECTOR_CENTRE: Record<MemoryKind, number> = {
  semantic: -90,
  episodic: 30,
  procedural: 150,
};
const SECTOR_HALF_WIDTH = 52;

export interface ConstellationNode {
  id: string;
  title: string;
  kind: MemoryKind;
  x: number;
  y: number;
  size: number;
  opacity: number;
  pinned: boolean;
  /** Recalled within the last day — the node that gets the pulse. */
  live: boolean;
  confidence: number;
  lastUsedAt: number | null;
}

/** Small stable hash → [0, 1). Positions must survive refetches unchanged. */
function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** 0 = touched this instant, 1 = at or beyond the horizon. Log-scaled. */
export function recencyOf(memory: Pick<Memory, 'lastUsedAt' | 'createdAt'>, now: number): number {
  const age = Math.max(0, now - (memory.lastUsedAt ?? memory.createdAt));
  return Math.min(1, Math.log1p(age / HOUR_MS) / Math.log1p(HORIZON_MS / HOUR_MS));
}

export function constellationLayout(
  memories: Memory[],
  options: { width: number; height: number; now: number },
): { nodes: ConstellationNode[]; dropped: number } {
  const { width, height, now } = options;
  const cx = width / 2;
  const cy = height / 2;
  const rMin = Math.min(width, height) * 0.08;
  const rMax = Math.min(width, height) * 0.46;

  // Keep the brightest sky when there are too many: high confidence and
  // recent use win, which is also the reinforcement loop's own ranking.
  const kept = [...memories]
    .sort(
      (a, b) =>
        b.confidence * (1 - recencyOf(b, now)) - a.confidence * (1 - recencyOf(a, now)),
    )
    .slice(0, MAX_NODES);

  const nodes = kept.map((memory) => {
    const recency = recencyOf(memory, now);
    const angleJitter = (hash01(memory.id) * 2 - 1) * SECTOR_HALF_WIDTH;
    const radialJitter = 1 + (hash01(`${memory.id}:r`) * 2 - 1) * 0.07;
    const angle = ((SECTOR_CENTRE[memory.kind] + angleJitter) * Math.PI) / 180;
    const radius = (rMin + recency * (rMax - rMin)) * radialJitter;

    return {
      id: memory.id,
      title: memory.title,
      kind: memory.kind,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      size: 2.5 + memory.confidence * 5.5,
      opacity: 0.35 + 0.65 * (1 - recency),
      pinned: memory.pinned,
      live: now - (memory.lastUsedAt ?? 0) < DAY_MS,
      confidence: memory.confidence,
      lastUsedAt: memory.lastUsedAt,
    };
  });

  return { nodes, dropped: memories.length - kept.length };
}

export function MemoryConstellation({
  memories,
  now = Date.now(),
  onSelect,
}: {
  memories: Memory[];
  now?: number;
  onSelect?: (id: string) => void;
}) {
  const t = useT();
  const uid = useId();
  const width = 640;
  const height = 300;

  const { nodes, dropped } = useMemo(
    () => constellationLayout(memories, { width, height, now }),
    [memories, now],
  );

  if (memories.length === 0) return null;

  const cx = width / 2;
  const cy = height / 2;
  const rMin = Math.min(width, height) * 0.08;
  const rMax = Math.min(width, height) * 0.46;
  const ringRadius = (ms: number): number =>
    rMin + recencyOf({ lastUsedAt: now - ms, createdAt: 0 }, now) * (rMax - rMin);
  // Real durations on the log scale, so the rings can be read as dates.
  const rings: Array<[number, string]> = [
    [DAY_MS, t('a day')],
    [7 * DAY_MS, t('a week')],
    [HORIZON_MS, t('a month')],
  ];

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="group"
        aria-label={t('The memory as a constellation — recent at the centre, fading toward the rim')}
      >
        <defs>
          {/* The sky: a touch deeper than the card, lifting at the centre —
              the empty space becomes space, not blankness. */}
          <radialGradient id={`${uid}-sky`} cx="50%" cy="50%" r="65%">
            <stop offset="0%" stopColor="var(--mc-surface)" />
            <stop offset="100%" stopColor="var(--mc-surface-sunken)" />
          </radialGradient>
          {/* One halo per kind, shared by every star of that kind. */}
          {(Object.keys(KIND_VAR) as MemoryKind[]).map((kind) => (
            <radialGradient key={kind} id={`${uid}-halo-${kind}`}>
              <stop offset="0%" stopColor={KIND_VAR[kind]} stopOpacity={0.5} />
              <stop offset="55%" stopColor={KIND_VAR[kind]} stopOpacity={0.12} />
              <stop offset="100%" stopColor={KIND_VAR[kind]} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>

        <rect x={0} y={0} width={width} height={height} rx={12} fill={`url(#${uid}-sky)`} />

        {rings.map(([ms, label]) => (
          <g key={ms}>
            <circle
              cx={cx}
              cy={cy}
              r={ringRadius(ms)}
              fill="none"
              stroke="var(--mc-border)"
              strokeDasharray="2 5"
              opacity={0.7}
            />
            <text
              x={cx}
              y={cy - ringRadius(ms) - 4}
              textAnchor="middle"
              fontSize={9}
              fill="var(--mc-text-subtle)"
              opacity={0.8}
            >
              {label}
            </text>
          </g>
        ))}

        {nodes.map((node) => (
          <g key={node.id} className={cn(node.live && 'constellation-live')}>
            {/* The glow first, the star on top of its own light. */}
            <circle
              cx={node.x}
              cy={node.y}
              r={node.size * 2.8}
              fill={`url(#${uid}-halo-${node.kind})`}
              opacity={node.opacity}
              aria-hidden
            />
            {node.pinned ? (
              <circle
                cx={node.x}
                cy={node.y}
                r={node.size + 3}
                fill="none"
                stroke="var(--mc-warning)"
                strokeWidth={1.25}
                strokeDasharray="3 3"
                opacity={0.9}
                aria-hidden
              />
            ) : null}
            <circle
              cx={node.x}
              cy={node.y}
              r={node.size}
              fill={KIND_VAR[node.kind]}
              opacity={Math.min(1, node.opacity + 0.15)}
              stroke={node.pinned ? 'var(--mc-warning)' : 'none'}
              strokeWidth={node.pinned ? 1 : 0}
              className={cn('constellation-node', onSelect && 'cursor-pointer')}
              tabIndex={onSelect ? 0 : undefined}
              role={onSelect ? 'button' : undefined}
              aria-label={`${node.title} — ${formatPercent(node.confidence)}`}
              onClick={onSelect ? () => onSelect(node.id) : undefined}
              onKeyDown={
                onSelect
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(node.id);
                      }
                    }
                  : undefined
              }
            >
              <title>
                {node.title} — {formatPercent(node.confidence)}
                {node.lastUsedAt ? ` · ${formatRelative(node.lastUsedAt)}` : ''}
              </title>
            </circle>
          </g>
        ))}
      </svg>

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-subtle">
        {(Object.keys(KIND_VAR) as MemoryKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: KIND_VAR[kind] }}
            />
            {t(kind)}
          </span>
        ))}
        <span>{t('size = confidence · centre = recently recalled · ring = pinned')}</span>
        {dropped > 0 ? <span>{t('{n} fainter ones not drawn', { n: dropped })}</span> : null}
      </figcaption>
    </figure>
  );
}
