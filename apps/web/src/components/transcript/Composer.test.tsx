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

/**
 * The permission modes are declared in `packages/shared` and rendered here.
 *
 * That one fact put them outside every i18n check: all three scan
 * `apps/web/src`, so twelve strings — six labels and six descriptions, on the
 * control an operator touches every single run — were never looked at, and the
 * picker stayed entirely in English on a French screen. The measures said
 * zero. This asserts the render site translates rather than reads.
 */
describe('the permission-mode control', () => {
  it('translates the label it shows, rather than rendering the contract verbatim', () => {
    renderComposer({ permissionMode: 'default' }, catalogue([capable]));

    // `PERMISSION_MODE_INFO.default.label` is 'Ask'. Under the English
    // catalogue `t()` is the identity, so what this pins is that the value
    // goes *through* `t()` at all: swap it back to a bare read and the French
    // assertion below is what breaks.
    expect(screen.getAllByText('Ask').length).toBeGreaterThan(0);
  });

  it('shows the French label and description once the catalogue is French', async () => {
    window.localStorage.setItem('mc-lang', 'fr');
    try {
      renderComposer({ permissionMode: 'default' }, catalogue([capable]));
      expect(await screen.findByText('Demander')).toBeDefined();
    } finally {
      window.localStorage.removeItem('mc-lang');
    }
  });
});

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

  it('is inert under Auto — visible with its reason, but a click changes nothing', () => {
    // Withheld under Auto is the design (the learner may pick a model that
    // cannot orchestrate); withheld *silently* read as the feature missing.
    const { onChange } = renderComposer({ model: 'default' }, catalogue([capable]));

    const toggle = screen.getByRole('button', { name: /ultracode/i });
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
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
        value={{ model: 'opus', effort: null, permissionMode: 'default', ultracode: false, toolControls: null }}
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

  it('offers the tools picker only when the workspace has something to steer', () => {
    renderWithProviders(
      <Composer
        value={{ model: 'opus', effort: null, permissionMode: 'default', ultracode: false, toolControls: null }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        isRunning={false}
        toolOptions={{ skills: [], mcpServers: [] }}
      />,
    );
    expect(screen.queryByRole('button', { name: /^tools$/i })).toBeNull();
  });

  it('shows the steering summary under the composer while something is steered', () => {
    renderWithProviders(
      <Composer
        value={{
          model: 'opus',
          effort: null,
          permissionMode: 'default',
          ultracode: false,
          toolControls: {
            requiredSkills: ['deploy'],
            excludedMcpServers: ['docs'],
            preferredMcpServers: [],
          },
        }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        isRunning={false}
        toolOptions={{ skills: ['deploy'], mcpServers: ['docs'] }}
      />,
    );

    // The summary is the honest part: steering that is on must be readable
    // where the next message is typed, not remembered.
    expect(screen.getByText(/skills required: deploy/i)).toBeTruthy();
    expect(screen.getByText(/mcp off: docs/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^tools$/i }).textContent).toContain('2');
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

describe('slash-command suggestions', () => {
  const withCommands = (): ClaudeCatalogue => ({
    ...catalogue([capable]),
    commands: [
      { name: 'compact', description: 'Compact the conversation', argumentHint: null },
      { name: 'review', description: 'Review the diff', argumentHint: null },
    ] as unknown as ClaudeCatalogue['commands'],
  });

  it('offers the CLI’s commands while a /token is being typed', () => {
    renderComposer({}, withCommands());
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: '/re' },
    });

    const listbox = screen.getByRole('listbox', { name: /slash commands/i });
    expect(listbox.textContent).toContain('/review');
    expect(listbox.textContent).not.toContain('/compact');
  });

  it('completes with Enter instead of sending the message', () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <Composer
        value={{ model: 'opus', effort: null, permissionMode: 'default', ultracode: false, toolControls: null }}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onInterrupt={vi.fn()}
        isRunning={false}
        catalogue={withCommands()}
      />,
    );
    const box = screen.getByRole('textbox', { name: /prompt/i }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '/rev' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.value).toBe('/review ');
    // The list is gone once the command is chosen — a space follows it.
    expect(screen.queryByRole('listbox', { name: /slash commands/i })).toBeNull();
  });

  it('goes away on Escape and stays away until the draft changes', () => {
    renderComposer({}, withCommands());
    const box = screen.getByRole('textbox', { name: /prompt/i });
    fireEvent.change(box, { target: { value: '/' } });
    expect(screen.getByRole('listbox', { name: /slash commands/i })).toBeTruthy();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: /slash commands/i })).toBeNull();

    fireEvent.change(box, { target: { value: '/r' } });
    expect(screen.getByRole('listbox', { name: /slash commands/i })).toBeTruthy();
  });

  it('never appears mid-sentence', () => {
    renderComposer({}, withCommands());
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'look at src/lib please' },
    });
    expect(screen.queryByRole('listbox', { name: /slash commands/i })).toBeNull();
  });
});
