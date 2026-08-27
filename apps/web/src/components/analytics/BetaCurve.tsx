/**
 * A Beta(α, β) posterior, drawn honestly.
 *
 * The bar chart this replaces showed only the mean, and the mean is the least
 * interesting thing a posterior knows: two arms at 70% look identical there
 * even when one has 3 trials (a broad, uncommitted hump) and the other has 40
 * (a narrow spike). The width of the curve IS the learner's confidence, so
 * drawing the density makes the bandit's actual state legible — including why
 * it still explores an arm whose mean trails the leader.
 *
 * Pure SVG, no library: 48 samples of the log-density, normalised to the
 * curve's own maximum. Log-space matters — x^(α−1)(1−x)^(β−1) overflows a
 * float long before an arm reaches the trial counts a busy workspace
 * produces, while the log form never does.
 */

const SAMPLES = 48;

/**
 * The density polyline for Beta(α, β), scaled to width × height, as SVG path
 * points from x=0 to x=width. Exported bare for tests: the geometry is the
 * behaviour here.
 */
export function betaDensityPoints(
  alpha: number,
  beta: number,
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  const logDensity = (x: number): number => (alpha - 1) * Math.log(x) + (beta - 1) * Math.log(1 - x);

  // Sample strictly inside (0, 1): at the edges an α or β below 1 sends the
  // log-density to +∞, and a NaN path draws as nothing at all.
  const xs = Array.from({ length: SAMPLES }, (_, i) => (i + 0.5) / SAMPLES);
  const logs = xs.map(logDensity);
  const max = Math.max(...logs);

  return xs.map((x, i) => {
    const density = Math.exp((logs[i] as number) - max); // in (0, 1], peak = 1
    return { x: x * width, y: height - density * (height - 1) };
  });
}

/** Closed area path under the density, for filling. */
export function betaAreaPath(alpha: number, beta: number, width: number, height: number): string {
  const points = betaDensityPoints(alpha, beta, width, height);
  const line = points.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('');
  return `M0,${height}${line}L${width},${height}Z`;
}

import { useId } from 'react';

export function BetaCurve({
  alpha,
  beta,
  width = 88,
  height = 28,
  tone = 'accent',
  label,
  className,
}: {
  alpha: number;
  beta: number;
  width?: number;
  height?: number;
  /** Semantic colour family; resolves to the theme tokens. */
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  label: string;
  className?: string;
}) {
  const uid = useId();
  const mean = alpha / (alpha + beta);
  const area = betaAreaPath(alpha, beta, width, height);
  const meanX = mean * width;

  const toneClass = {
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className={`${toneClass}${className ? ` ${className}` : ''}`}
    >
      <defs>
        {/* The belief fades to the baseline instead of sitting on it flat. */}
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.38} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.04} />
        </linearGradient>
      </defs>
      {/* Quartile ticks so 0–100% is readable without labels. */}
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line
          key={fraction}
          x1={fraction * width}
          y1={height - 4}
          x2={fraction * width}
          y2={height}
          stroke="var(--mc-border)"
        />
      ))}
      <line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke="var(--mc-border)" />
      <path d={area} fill={`url(#${uid}-fill)`} />
      <path d={area} fill="none" stroke="currentColor" strokeWidth={1.25} />
      {/* The mean, marked — the single number the old bar reduced this to. */}
      <line
        data-mean
        x1={meanX}
        y1={4}
        x2={meanX}
        y2={height}
        stroke="currentColor"
        strokeDasharray="2 2"
      />
      <circle cx={meanX} cy={height - 0.5} r={2.2} fill="currentColor" />
    </svg>
  );
}
