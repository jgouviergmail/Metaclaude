/**
 * The ultracode toggle: per-message multi-agent orchestration.
 *
 * The gate matters as much as the wire: a toggle that appears for a model that
 * cannot orchestrate is a control that sometimes does nothing, and the row of
 * per-message controls is exactly where people learn what to trust.
 */

import { screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeCatalogue, PermissionMode } from '@metaclaude/shared';
import { renderInFrench, renderWithProviders } from '@/test/render';
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

function composerProps(value: Partial<ComposerValue>, cat?: ClaudeCatalogue) {
  const onChange = vi.fn();
  return {
    onChange,
    props: {
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
    },
  };
}

function renderComposer(value: Partial<ComposerValue>, cat?: ClaudeCatalogue) {
  const { onChange, props } = composerProps(value, cat);
  renderWithProviders(<Composer {...props} />);
  return { onChange };
}

/** The same, with the French catalogue already loaded. See `renderInFrench`. */
async function renderComposerInFrench(value: Partial<ComposerValue>, cat?: ClaudeCatalogue) {
  const { onChange, props } = composerProps(value, cat);
  await renderInFrench(<Composer {...props} />);
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
    // Through the shared helper: it awaits the catalogue chunk before
    // rendering, so the assertion no longer races a dynamic `import()`. This
    // case failed once in a loaded full run and never in an isolated one,
    // which is the signature of that race rather than of a broken control.
    await renderComposerInFrench({ permissionMode: 'default' }, catalogue([capable]));
    expect(await screen.findByText('Demander')).toBeDefined();
  });
});

/**
 * What an inherited setting says.
 *
 * One rule for model, effort and mode: the workspace gives the base value, a
 * session follows it until a pill is touched, and a touched one stays. The
 * composer therefore has to show what an untouched pill resolves to — or an
 * operator who sets a model on the workspace sees the session go on saying
 * "Auto" and reads the setting as ignored, which is the report this was
 * written for. "Auto" alone is kept for the one case where the workspace
 * itself leaves the choice to the learner; it cannot serve for the mode,
 * whose `auto` member is already labelled Auto.
 */
describe('what an inherited setting resolves to', () => {
  type Defaults = { model: string; effort: 'low' | 'high' | null; permissionMode: PermissionMode };
  const inherited: Partial<ComposerValue> = { model: 'default', effort: null, permissionMode: null };

  function renderWithDefaults(
    value: Partial<ComposerValue>,
    defaults: Defaults,
    options: { allowBypass?: boolean } = {},
  ) {
    const { onChange, props } = composerProps(value, catalogue([capable, incapable]));
    renderWithProviders(
      <Composer {...props} workspaceDefaults={defaults} allowBypass={options.allowBypass ?? false} />,
    );
    return { onChange };
  }

  it('names the workspace’s model, with the catalogue’s label', () => {
    renderWithDefaults(inherited, { model: 'opus', effort: null, permissionMode: 'default' });
    expect(screen.getByRole('button', { name: 'Workspace · Opus' })).toBeDefined();
  });

  it('shows a model id the catalogue has not enumerated as it is', () => {
    renderWithDefaults(inherited, { model: 'claude-opus-5', effort: null, permissionMode: 'default' });
    expect(screen.getByRole('button', { name: 'Workspace · claude-opus-5' })).toBeDefined();
  });

  it('reads plain Auto for model and effort when the workspace leaves both to the learner', () => {
    renderWithDefaults(inherited, { model: 'default', effort: null, permissionMode: 'default' });
    expect(screen.getAllByRole('button', { name: 'Auto' })).toHaveLength(2);
  });

  it('does the same for the effort and the mode', () => {
    renderWithDefaults(inherited, { model: 'default', effort: 'high', permissionMode: 'acceptEdits' });
    expect(screen.getByRole('button', { name: 'Workspace · High' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Workspace · Accept edits' })).toBeDefined();
  });

  it('offers the inherited mode as the first entry, checked, and the way back to it', () => {
    const { onChange } = renderWithDefaults(
      { ...inherited, permissionMode: 'plan' },
      { model: 'default', effort: null, permissionMode: 'acceptEdits' },
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Plan' }));
    const back = screen.getByRole('menuitemcheckbox', { name: /Workspace · Accept edits/ });
    expect(back.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(back);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: null }));
  });

  it('says in the entry’s hint that the workspace decides, not the learner', () => {
    renderWithDefaults(inherited, { model: 'opus', effort: null, permissionMode: 'default' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Workspace · Opus' }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Workspace · Opus/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/The workspace’s setting/)).toBeDefined();
    expect(screen.queryByText('Let Metaclaude choose from what it has learned')).toBeNull();
  });

  it('paints the danger border and banner for a Bypass the session merely inherits', () => {
    // A safety indicator that reads the raw pill misses the case that matters
    // most: the session says nothing and the workspace says Bypass.
    renderWithDefaults(inherited, { model: 'default', effort: null, permissionMode: 'bypassPermissions' }, { allowBypass: true });
    expect(screen.getByText(/Bypass mode: the agent will run commands/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Workspace · Bypass' }).className).toContain('text-danger');
  });

  it('offers Ultracode when the inherited model can orchestrate', () => {
    renderWithDefaults(inherited, { model: 'opus', effort: null, permissionMode: 'default' });
    const toggle = screen.getByRole('button', { name: /ultracode/i });
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
  });

  it('narrows the effort levels by the inherited model', () => {
    // Haiku takes no effort level: nothing but the inherited entry is offered.
    renderWithDefaults(inherited, { model: 'haiku', effort: null, permissionMode: 'default' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Auto' }));
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1);
  });

  it('is not consulted once the composer pins something', () => {
    renderWithDefaults(
      { model: 'opus', effort: 'low', permissionMode: 'plan' },
      { model: 'haiku', effort: 'high', permissionMode: 'acceptEdits' },
    );
    expect(screen.getByRole('button', { name: 'Opus' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Low' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Workspace ·/ })).toBeNull();
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
