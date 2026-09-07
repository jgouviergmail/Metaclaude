/**
 * Choosing which MCP tools a workspace pre-approves.
 *
 * The defect behind it: under `Don't ask` the CLI refuses everything not
 * pre-approved, and the interface could only ever tick a closed list of seven
 * built-ins — so a workspace with a working MCP server had no way to use it
 * unattended, and nothing on the screen said why.
 *
 * What is pinned here is the arithmetic more than the pixels. The component is
 * handed the workspace's *whole* pre-approval list, built-ins included, and
 * hands back a whole list; a bulk action that dropped the entries it does not
 * own would silently un-approve `WebFetch` while the operator was ticking a
 * mail tool.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceMcpServerTools } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { McpToolPicker } from './McpToolPicker';

const server = (
  name: string,
  tools: string[],
  describedAt: number | null = 1,
  internal = false,
): WorkspaceMcpServerTools => ({
  id: `mcp_${name}`,
  name,
  describedAt,
  internal,
  tools: tools.map((tool) => ({
    bare: tool,
    qualified: `mcp__${name}__${tool}`,
    description: `Does ${tool}.`,
  })),
});

function show(
  servers: WorkspaceMcpServerTools[],
  selected: string[] = [],
  handlers: { onChange?: (next: string[]) => void; onDescribe?: (id: string) => void } = {},
) {
  const onChange = handlers.onChange ?? vi.fn();
  const onDescribe = handlers.onDescribe ?? vi.fn();
  renderWithProviders(
    <McpToolPicker
      servers={servers}
      selected={selected}
      onChange={onChange}
      onDescribe={onDescribe}
    />,
  );
  return { onChange, onDescribe };
}

describe('the MCP tool picker', () => {
  it('renders nothing at all when the workspace has no server', () => {
    const { container } = renderWithProviders(
      <McpToolPicker servers={[]} selected={[]} onChange={vi.fn()} onDescribe={vi.fn()} />,
    );

    expect(container.textContent).toBe('');
  });

  /**
   * happy-dom does not implement `<details>` hiding — a closed fold's children
   * are findable, visible and clickable — so the fold has to be asserted on the
   * element's own `open`. Asserting visibility would pass just as happily on a
   * panel that never folds.
   */
  it('folds each server, and says on the summary how many are ticked', () => {
    show([server('google', ['gmail_read', 'drive_read'])], ['mcp__google__gmail_read']);

    const fold = document.querySelector('details') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('google');
    expect(fold.querySelector('summary')!.textContent).toContain('1 of 2');
  });

  it('says when a server has never been asked what it offers', () => {
    show([server('quiet', [], null)]);

    expect(screen.getByText(/nobody has asked this server/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /list its tools/i })).toBeTruthy();
  });

  it('asks the server when told to', () => {
    const onDescribe = vi.fn();
    show([server('quiet', [], null)], [], { onDescribe });

    fireEvent.click(screen.getByRole('button', { name: /list its tools/i }));

    expect(onDescribe).toHaveBeenCalledWith('mcp_quiet');
  });

  /**
   * A server Metaclaude mounts itself has nothing to ask: its tools are a
   * table in the repository. Offering "list its tools" there would be a button
   * that can only fail, on the one entry an operator most needs to trust.
   */
  it('tells a server Metaclaude provides from one the operator configured', () => {
    show([server('metaclaude', ['delegate'], null, true), server('google', ['gmail_read'])]);

    const folds = Array.from(document.querySelectorAll('details'));
    const internal = folds.find((fold) => fold.textContent?.includes('metaclaude'))!;
    const configured = folds.find((fold) => fold.textContent?.includes('google'))!;

    expect(internal.querySelector('summary')!.textContent).toContain('built in');
    expect(configured.querySelector('summary')!.textContent).not.toContain('built in');
    // Nothing to ask such a server: its tools are a table in the repository.
    expect(screen.queryByRole('button', { name: /list its tools/i })).toBeNull();
    expect(screen.getByLabelText('delegate')).toBeTruthy();
  });

  it('adds a tool by its qualified name, keeping what it does not own', () => {
    const onChange = vi.fn();
    show([server('google', ['gmail_read'])], ['WebFetch'], { onChange });

    fireEvent.click(screen.getByLabelText('gmail_read'));

    expect(onChange).toHaveBeenCalledWith(['WebFetch', 'mcp__google__gmail_read']);
  });

  it('removes a tool without disturbing the rest of the list', () => {
    const onChange = vi.fn();
    show([server('google', ['gmail_read'])], ['WebFetch', 'mcp__google__gmail_read'], { onChange });

    fireEvent.click(screen.getByLabelText('gmail_read'));

    expect(onChange).toHaveBeenCalledWith(['WebFetch']);
  });

  it('ticks a whole server at once', () => {
    const onChange = vi.fn();
    show([server('google', ['gmail_read', 'drive_read'])], ['WebFetch'], { onChange });

    fireEvent.click(screen.getByRole('button', { name: /^tick all$/i }));

    expect(onChange).toHaveBeenCalledWith([
      'WebFetch',
      'mcp__google__gmail_read',
      'mcp__google__drive_read',
    ]);
  });

  /**
   * The bulk action that could do real damage: unticking a server must not
   * take the built-ins with it, and must not touch another server's tools.
   */
  it('unticks a whole server and leaves every other entry alone', () => {
    const onChange = vi.fn();
    show(
      [server('google', ['gmail_read', 'drive_read']), server('mailer', ['send'])],
      ['WebFetch', 'mcp__google__gmail_read', 'mcp__google__drive_read', 'mcp__mailer__send'],
      { onChange },
    );

    fireEvent.click(screen.getAllByRole('button', { name: /^untick all$/i })[0]!);

    expect(onChange).toHaveBeenCalledWith(['WebFetch', 'mcp__mailer__send']);
  });

  it('offers no bulk action that would do nothing', () => {
    // A button that is enabled and changes nothing teaches the operator that
    // the screen does not respond.
    show([server('google', ['gmail_read'])], []);

    expect((screen.getByRole('button', { name: /^untick all$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: /^tick all$/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('locks every control for a workspace whose tools are fixed', () => {
    renderWithProviders(
      <McpToolPicker
        servers={[server('google', ['gmail_read'])]}
        selected={[]}
        onChange={vi.fn()}
        onDescribe={vi.fn()}
        disabled
      />,
    );

    expect((screen.getByLabelText('gmail_read') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^tick all$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
