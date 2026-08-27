/**
 * The geometry is the behaviour: the curve must peak at the distribution's
 * mode, stay finite for α or β below 1, and mark the mean where it belongs.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BetaCurve, betaDensityPoints } from './BetaCurve';

const W = 100;
const H = 30;

/** x of the lowest y — the sampled mode. */
function peakX(alpha: number, beta: number): number {
  const points = betaDensityPoints(alpha, beta, W, H);
  return points.reduce((best, p) => (p.y < best.y ? p : best), points[0]!).x;
}

describe('betaDensityPoints', () => {
  it('peaks at the mode: (α−1)/(α+β−2)', () => {
    // Beta(8, 2): mode at 7/8. Sampling grid is 1/48 wide, so allow one cell.
    expect(peakX(8, 2) / W).toBeCloseTo(7 / 8, 1);
    // And the mirrored distribution peaks mirrored — the asymmetry is real.
    expect(peakX(2, 8) / W).toBeCloseTo(1 / 8, 1);
  });

  it('narrows as trials accumulate — same mean, less spread', () => {
    const spreadAbove = (alpha: number, beta: number): number =>
      betaDensityPoints(alpha, beta, W, H).filter((p) => p.y < H / 2).length;
    // Beta(3,3) and Beta(30,30) share their mean; only the second is confident.
    expect(spreadAbove(30, 30)).toBeLessThan(spreadAbove(3, 3));
  });

  it('stays finite when α or β dips below 1', () => {
    for (const point of betaDensityPoints(0.5, 0.5, W, H)) {
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});

describe('BetaCurve', () => {
  it('renders an accessible image with the area and the mean marker', () => {
    render(<BetaCurve alpha={8} beta={2} label="engineering — 80% expected" />);
    const svg = screen.getByRole('img', { name: 'engineering — 80% expected' });
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    // Mean 0.8 of the default 88px width.
    const marker = svg.querySelectorAll('line')[1] as SVGLineElement;
    expect(Number(marker.getAttribute('x1'))).toBeCloseTo(0.8 * 88, 1);
  });
});
