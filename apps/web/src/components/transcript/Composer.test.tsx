/**
 * The ultracode toggle: per-message multi-agent orchestration.
 *
 * The gate matters as much as the wire: a toggle that appears for a model that
 * cannot orchestrate is a control that sometimes does nothing, and the row of
 * per-message controls is exactly where people learn what to trust.
 */

import { screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeCatalogue } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { Composer, type ComposerValue } from './Composer';

const catalogue = (models: ClaudeCatalogue['models']): ClaudeCatalogue => ({
  models,
  commands: [],
  agents: [],
  mcpServers: [],
  account: null,
  unavailable: [],
  fetchedAt: 0,
});

const capable: ClaudeCatalogue['models'][number] = {
  value: 'opus',
  displayName: 'Opus',
  description: 'Deep',
  resolvedModel: 'claude-opus-5',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true,
};

const incapable: ClaudeCatalogue['models'][number] = {
  value: 'haiku',
  displayName: 'Haiku',
  description: 'Fast',
  resolvedModel: 'claude-haiku-4-5',
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAdaptiveThinking: false,
};

function renderComposer(value: Partial<ComposerValue>, cat?: ClaudeCatalogue) {
  const onChange = vi.fn();
  const props = {
    value: {
      model: 'opus',
      effort: null,
      permissionMode: 'default',
      ultracode: false,
      ...value,
    } as ComposerValue,
    onChange,
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    isRunning: false,
    catalogue: cat,
  };
  renderWithProviders(<Composer {...props} />);
  return { onChange };
}

describe('the ultracode toggle', () => {
  it('is offered for an xhigh-capable model and flips the value', () => {
    const { onChange } = renderComposer(
      { model: 'opus' },
      catalogue([capable, incapable]),
    );

    const toggle = screen.getByRole('button', { name: /ultracode/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ultracode: true }));
  });

  it('is withheld for a model that cannot reach xhigh', () => {
    renderComposer({ model: 'haiku' }, catalogue([capable, incapable]));
    expect(screen.queryByRole('button', { name: /ultracode/i })).toBeNull();
  });

  it('is withheld under Auto, where the learner picks the model', () => {
    renderComposer({ model: 'default' }, catalogue([capable]));
    expect(screen.queryByRole('button', { name: /ultracode/i })).toBeNull();
  });

  it('says what it costs while it is on', () => {
    renderComposer({ model: 'opus', ultracode: true }, catalogue([capable]));
    expect(screen.getByRole('button', { name: /ultracode/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // The hint is the honest part: orchestration multiplies token spend, and
    // the person deciding must read that where they decide.
    expect(screen.getByText(/fans out/i)).toBeTruthy();
  });
});
