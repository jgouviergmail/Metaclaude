/**
 * The doctor's report, rendered.
 *
 * What matters: every check is listed with its own verdict, the evidence
 * (detail) is shown for anything that is not ok, and the report's overall
 * status is visible without reading the list.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { DoctorReportView } from './DoctorReportView';

const report = (over: Partial<DoctorReport> = {}): DoctorReport => ({
  status: 'warn',
  version: '0.1.0',
  ranAt: 1_000,
  checks: [
    { name: 'database', status: 'ok', summary: 'SQLite reports the file intact.', detail: null },
    {
      name: 'vault',
      status: 'fail',
      summary: 'Some secrets cannot be decrypted.',
      detail: 'mcp:github/token',
    },
    {
      name: 'automations',
      status: 'warn',
      summary: '1 automation was switched off by the failure guard.',
      detail: 'nightly-digest',
    },
  ],
  ...over,
});

describe('DoctorReportView', () => {
  it('lists every check with its verdict', () => {
    render(<DoctorReportView report={report()} />);

    expect(screen.getByText('database')).toBeDefined();
    expect(screen.getByText('SQLite reports the file intact.')).toBeDefined();
    expect(screen.getAllByText('ok').length).toBeGreaterThan(0);
    expect(screen.getByText('fail')).toBeDefined();
  });

  it('shows the evidence for anything not ok', () => {
    render(<DoctorReportView report={report()} />);

    expect(screen.getByText(/mcp:github\/token/)).toBeDefined();
    expect(screen.getByText(/nightly-digest/)).toBeDefined();
  });

  it('states the overall verdict without making the reader scan', () => {
    render(<DoctorReportView report={report({ status: 'fail' })} />);
    expect(screen.getByText(/needs attention/i)).toBeDefined();
  });
});
