/**
 * Saying which workspaces an extension reaches.
 *
 * The state worth pinning hardest is the one the old model could not express:
 * **nowhere**. Ticking no workspace is a real answer — the extension stays in
 * the library and is mounted nowhere — and it is also a state an operator can
 * arrive at by accident, so the control says so in words rather than showing
 * an empty list and leaving them to work it out.
 *
 * The other is that global and a chosen set cannot both be true. Two sources
 * of truth for one question is how a resolver and a screen come to disagree.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ReachPicker } from './ReachPicker';

const WORKSPACES = [
  { id: 'ws_a', name: 'Alpha', color: '#6366f1' },
  { id: 'ws_b', name: 'Beta', color: '#ec4899' },
];

const show = (value: { global: boolean; workspaceIds: string[] }, onChange = vi.fn()) => {
  renderWithProviders(
    <ReachPicker value={value} workspaces={WORKSPACES} onChange={onChange} />,
  );
  return onChange;
};

describe('the reach picker', () => {
  it('hides the list while it is global, because there is nothing to choose', () => {
    show({ global: true, workspaceIds: [] });

    expect(screen.getByLabelText(/every workspace/i)).toBeTruthy();
    expect(screen.queryByLabelText('Alpha')).toBeNull();
  });

  it('offers one box per workspace once it is not', () => {
    show({ global: false, workspaceIds: [] });

    expect(screen.getByLabelText('Alpha')).toBeTruthy();
    expect(screen.getByLabelText('Beta')).toBeTruthy();
  });

  /**
   * Global and a chosen set are exclusive. Keeping the ids while global would
   * leave two answers to one question, and the next reader would have to guess
   * which one the resolver consults.
   */
  it('drops the chosen set when it becomes global', () => {
    const onChange = show({ global: false, workspaceIds: ['ws_a'] });

    fireEvent.click(screen.getByLabelText(/every workspace/i));

    expect(onChange).toHaveBeenCalledWith({ global: true, workspaceIds: [] });
  });

  /**
   * What this proves is the shape of the answer, not a transition out of
   * global: the list is hidden while the reach is global, so no box here can
   * be ticked from that state and no test can discriminate the `global: false`
   * the handler writes. Said rather than implied.
   */
  it('reports a ticked workspace, and never as global', () => {
    const onChange = show({ global: false, workspaceIds: [] });

    fireEvent.click(screen.getByLabelText('Beta'));

    expect(onChange).toHaveBeenCalledWith({ global: false, workspaceIds: ['ws_b'] });
  });

  it('unticks without disturbing the others', () => {
    const onChange = show({ global: false, workspaceIds: ['ws_a', 'ws_b'] });

    fireEvent.click(screen.getByLabelText('Alpha'));

    expect(onChange).toHaveBeenCalledWith({ global: false, workspaceIds: ['ws_b'] });
  });

  /**
   * The state the single `workspace_id` column could not hold, and the reason
   * an extension useful to three projects out of eight had to be either global
   * or written three times.
   */
  it('says in words that nothing is ticked, rather than showing an empty list', () => {
    show({ global: false, workspaceIds: [] });

    expect(screen.getByText(/runs nowhere/i)).toBeTruthy();
  });

  it('counts what is ticked', () => {
    show({ global: false, workspaceIds: ['ws_a', 'ws_b'] });

    expect(screen.getByText(/2 workspaces/i)).toBeTruthy();
  });

  it('ticks and unticks the lot', () => {
    const all = show({ global: false, workspaceIds: [] });
    fireEvent.click(screen.getByRole('button', { name: /^tick all$/i }));
    expect(all).toHaveBeenCalledWith({ global: false, workspaceIds: ['ws_a', 'ws_b'] });

    const none = show({ global: false, workspaceIds: ['ws_a', 'ws_b'] });
    fireEvent.click(screen.getAllByRole('button', { name: /^untick all$/i })[1]!);
    expect(none).toHaveBeenCalledWith({ global: false, workspaceIds: [] });
  });

  it('offers no bulk action that would change nothing', () => {
    show({ global: false, workspaceIds: [] });

    expect(
      (screen.getByRole('button', { name: /^untick all$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
