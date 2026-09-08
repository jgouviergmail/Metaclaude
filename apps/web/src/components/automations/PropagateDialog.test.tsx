/**
 * Which fields travel between copies, and how the question is asked.
 *
 * The rule lives here rather than in a page test on purpose: driving it through
 * the whole editor means every unrelated field that fails to round-trip — a
 * trigger shape, an effort the model does not support — silently changes the
 * answer, and the test then measures the fixture instead of the rule.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Automation } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { PropagateDialog, propagatableFields } from './PropagateDialog';

const WORKSPACES = [
  { id: 'ws_a', name: 'Alpha', color: '#6366f1', icon: 'folder' },
  { id: 'ws_b', name: 'Beta', color: '#f59e0b', icon: 'folder' },
];

const sibling = (id: string, workspaceId: string): Automation =>
  ({ id, workspaceId, name: 'Revue', prompt: 'p' }) as Automation;

describe('propagatableFields', () => {
  it('carries what the copies share', () => {
    expect(propagatableFields({ prompt: 'x', description: 'y' }).sort()).toEqual([
      'description',
      'prompt',
    ]);
  });

  it('never carries the workspace: a copy is defined by living somewhere else', () => {
    expect(propagatableFields({ workspaceId: 'ws_b' })).toEqual([]);
  });

  it('never carries the paused state, which is set per copy on purpose', () => {
    // Carrying `enabled` would let saving the original wake a copy somebody had
    // deliberately stopped — and a copy lands paused precisely so it can be read
    // before it fires.
    expect(propagatableFields({ enabled: true })).toEqual([]);
    expect(propagatableFields({ prompt: 'x', enabled: true })).toEqual(['prompt']);
  });

  it('ignores a field it does not know rather than carrying it blind', () => {
    expect(propagatableFields({ sessionId: 'ses_x', runCount: 4 })).toEqual([]);
  });
});

describe('PropagateDialog', () => {
  const render = (onDecide = vi.fn()) => {
    renderWithProviders(
      <PropagateDialog
        fields={['prompt']}
        siblings={[sibling('aut_2', 'ws_b')]}
        workspaces={WORKSPACES}
        onDecide={onDecide}
        busy={false}
      />,
    );
    return onDecide;
  };

  it('names what changed and which copy would hear it', () => {
    render();
    expect(screen.getByText(/the prompt/)).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('ticks every copy, because opening it is already the answer', () => {
    const onDecide = render();
    fireEvent.click(screen.getByRole('button', { name: 'Carry it over' }));
    expect(onDecide).toHaveBeenCalledWith(['aut_2']);
  });

  it('lets one copy be unticked, which is how a copy goes its own way', () => {
    const onDecide = render();
    fireEvent.click(screen.getByRole('checkbox'));
    // Nothing left to carry, so the primary action is refused rather than
    // silently doing nothing.
    expect((screen.getByRole('button', { name: 'Carry it over' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Only this one' }));
    expect(onDecide).toHaveBeenCalledWith([]);
  });

  it('treats "only this one" as an answer, not a cancel', () => {
    // The edit is already made; the question is only who else hears about it.
    const onDecide = render();
    fireEvent.click(screen.getByRole('button', { name: 'Only this one' }));
    expect(onDecide).toHaveBeenCalledWith([]);
  });
});
