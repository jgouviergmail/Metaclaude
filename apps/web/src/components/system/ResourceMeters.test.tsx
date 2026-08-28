/**
 * The three meters, and the state they spend most of their life in on a
 * developer's machine: unmeasurable.
 */

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { SystemResources } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { ResourceMeters } from './ResourceMeters';

const GB = 1024 ** 3;

function resources(overrides: Partial<SystemResources> = {}): SystemResources {
  return {
    cpu: { usagePct: 24, cores: 2, load1: 0.63 },
    memory: {
      usedBytes: Math.round(0.22 * GB),
      limitBytes: Math.round(2.86 * GB),
      hostTotalBytes: Math.round(3.9 * GB),
      rssBytes: Math.round(0.12 * GB),
    },
    disk: { freeBytes: 31 * GB, totalBytes: 38 * GB },
    ...overrides,
  };
}

describe('ResourceMeters', () => {
  it('renders each reading as a percentage of what the container may use', () => {
    renderWithProviders(<ResourceMeters resources={resources()} />);

    expect(screen.getByText('24 %')).toBeDefined();
    // 0.22 of 2.86 GB — against the container's ceiling, not the host's 3.9.
    expect(screen.getByText('8 %')).toBeDefined();
    // 31 GB free of 38 is 18% used, and the meter shows usage, not headroom.
    expect(screen.getByText('18 %')).toBeDefined();
  });

  it('shows a dash, never a zero, for a figure nobody could measure', () => {
    renderWithProviders(
      <ResourceMeters
        resources={resources({
          cpu: { usagePct: null, cores: null, load1: null },
          memory: { usedBytes: null, limitBytes: null, hostTotalBytes: null, rssBytes: 0 },
          disk: { freeBytes: null, totalBytes: null },
        })}
      />,
    );

    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('0 %')).toBeNull();
    // All three, CPU included: on a host with neither /proc nor a cgroup the
    // reading will never arrive, and "Measuring…" would be a patient lie.
    expect(screen.getAllByText('Not measurable here')).toHaveLength(3);
    expect(screen.queryByText('Measuring…')).toBeNull();
  });

  it('says it is still measuring rather than reporting an idle CPU', () => {
    // The rate needs two samples, so the first poll after a restart has
    // nothing to subtract from — but this host clearly can measure, since it
    // answered every other question.
    renderWithProviders(
      <ResourceMeters resources={resources({ cpu: { usagePct: null, cores: 2, load1: 0.1 } })} />,
    );

    expect(screen.getByText('Measuring…')).toBeDefined();
  });

  it('renders while the request is still in flight', () => {
    renderWithProviders(<ResourceMeters resources={undefined} />);

    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('escalates the tone as a resource fills, and the meter carries the reading for a screen reader', () => {
    const { rerender } = renderWithProviders(
      <ResourceMeters resources={resources({ disk: { freeBytes: 4 * GB, totalBytes: 38 * GB } })} />,
    );
    // 34 of 38 used — 89%, warning but not yet critical.
    expect(screen.getByLabelText('Disk 89 %')).toBeDefined();
    expect(screen.getByText('89 %').className).toContain('text-warning');

    rerender(
      <ResourceMeters resources={resources({ disk: { freeBytes: 1 * GB, totalBytes: 38 * GB } })} />,
    );
    expect(screen.getByText('97 %').className).toContain('text-danger');
  });

  it('never divides by a zero ceiling', () => {
    renderWithProviders(
      <ResourceMeters
        resources={resources({
          memory: { usedBytes: 100, limitBytes: 0, hostTotalBytes: null, rssBytes: 10 },
          disk: { freeBytes: 0, totalBytes: 0 },
        })}
      />,
    );

    expect(screen.queryByText('NaN %')).toBeNull();
    expect(screen.queryByText('Infinity %')).toBeNull();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});
