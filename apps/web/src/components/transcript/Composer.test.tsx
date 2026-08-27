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
import type { PendingAttachment } from '@/lib/attachments';
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

describe('attachments', () => {
  function renderWithAttachments(
    attachments: PendingAttachment[],
    handlers: { onAttachFiles?: (files: File[]) => void; onRemoveAttachment?: (key: string) => void } = {},
  ) {
    const onSubmit = vi.fn();
    renderWithProviders(
      <Composer
        value={{ model: 'opus', effort: null, permissionMode: 'default', ultracode: false }}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onInterrupt={vi.fn()}
        isRunning={false}
        attachments={attachments}
        onAttachFiles={handlers.onAttachFiles ?? vi.fn()}
        onRemoveAttachment={handlers.onRemoveAttachment ?? vi.fn()}
      />,
    );
    return { onSubmit };
  }

  it('offers the attach button only when the page wires the flow', () => {
    renderComposer({});
    expect(screen.queryByRole('button', { name: /attach files/i })).toBeNull();
  });

  it('renders each pending file as a chip, removable', () => {
    const onRemoveAttachment = vi.fn();
    renderWithAttachments(
      [
        { key: 'k1', id: 'att_1', name: 'plan.png', bytes: 2048, mime: 'image/png', status: 'ready' },
        { key: 'k2', id: null, name: 'big.pdf', bytes: 1, mime: 'application/pdf', status: 'error', error: 'Over 20 MB' },
      ],
      { onRemoveAttachment },
    );

    expect(screen.getByText('plan.png')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('Over 20 MB')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /remove plan\.png/i }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('k1');
  });

  it('holds the message while an upload is in flight', () => {
    const { onSubmit } = renderWithAttachments([
      { key: 'k1', id: null, name: 'shot.png', bytes: 10, mime: 'image/png', status: 'uploading' },
    ]);

    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'look at this' },
    });
    const send = screen.getByRole('button', { name: /^send$/i });
    expect(send.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('hands picked files to the page', () => {
    const onAttachFiles = vi.fn();
    renderWithAttachments([], { onAttachFiles });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['bytes'], 'notes.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(onAttachFiles.mock.calls[0]?.[0]?.[0]?.name).toBe('notes.md');
  });
});
