/**
 * The per-run parameters, shown with every result.
 *
 * The case that motivated this: everything on Auto, and no way to know what
 * actually ran. So the chips must show the *served* model when the CLI named
 * one, fall back to the policy when it did not, and say who made the choice
 * — the learner, the workspace default, or the operator.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunPolicy } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { RunMetaChips } from './RunMetaChips';

const policy = (over: Partial<RunPolicy> = {}): RunPolicy => ({
  model: 'default',
  effort: null,
  permissionMode: 'default',
  thinking: 'adaptive',
  thinkingBudgetTokens: null,
  agentName: null,
  ultracode: false,
  source: 'workspace',
  ...over,
});

describe('RunMetaChips', () => {
  it('shows the served model when the CLI named one — the Auto case', () => {
    render(<RunMetaChips policy={policy()} servedModel="claude-opus-5" />);

    expect(screen.getByText('claude-opus-5')).toBeDefined();
    // Effort was left to the CLI; said rather than omitted.
    expect(screen.getByText(/effort auto/i)).toBeDefined();
  });

  it('falls back to the requested model when the CLI never said', () => {
    render(<RunMetaChips policy={policy({ model: 'sonnet', effort: 'high' })} servedModel={null} />);

    expect(screen.getByText('sonnet')).toBeDefined();
    expect(screen.getByText('high')).toBeDefined();
  });

  it('says when the learner made the choice', () => {
    render(
      <RunMetaChips
        policy={policy({ model: 'sonnet', effort: 'high', source: 'learned' })}
        servedModel={null}
      />,
    );
    expect(screen.getByText(/learned/i)).toBeDefined();
  });

  it('marks an ultracode run — the one that multiplies spend', () => {
    render(<RunMetaChips policy={policy({ ultracode: true })} servedModel={null} />);
    expect(screen.getByText(/ultracode/i)).toBeDefined();
  });

  it('shows the permission mode by its label', () => {
    render(<RunMetaChips policy={policy({ permissionMode: 'plan' })} servedModel={null} />);
    expect(screen.getByText('Plan')).toBeDefined();
  });
});
