/**
 * What an operator is shown before being asked to delete rows.
 *
 * The asymmetry between the two verdicts is the contract worth pinning: a
 * repetition can be applied with one press, a contradiction cannot be applied
 * at all. A card that offered a Merge button on a contradiction would be the
 * system guessing which of two opposing memories is the true one.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConsolidationProposal, Workspace } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { ConsolidationCard, readProposal } from './ConsolidationCard';

const WORKSPACES = [
  { id: 'ws_a', name: 'Alpha', slug: 'alpha', color: '#6366f1' } as Workspace,
];

const duplicate: ConsolidationProposal = {
  key: 'mem_1|mem_2|mem_3',
  verdict: 'duplicate',
  reason: 'All three say the workspace works in French.',
  members: [
    { id: 'mem_1', title: 'Workspace uses French', fingerprint: 'aaaa', workspaceId: 'ws_a' },
    { id: 'mem_2', title: 'This workspace operates in French', fingerprint: 'bbbb', workspaceId: 'ws_a' },
    { id: 'mem_3', title: 'User speaks French', fingerprint: 'cccc', workspaceId: 'ws_a' },
  ],
  winnerId: 'mem_2',
  merged: { title: 'The workspace works in French', content: 'Everything is French.', tags: [] },
  promotable: false,
};

const contradiction: ConsolidationProposal = {
  key: 'mem_4|mem_5',
  verdict: 'contradictory',
  reason: 'One requires pnpm, the other forbids it.',
  members: [
    { id: 'mem_4', title: 'Always use pnpm', fingerprint: 'dddd', workspaceId: 'ws_a' },
    { id: 'mem_5', title: 'Never use pnpm', fingerprint: 'eeee', workspaceId: 'ws_a' },
  ],
  winnerId: 'mem_4',
  promotable: false,
};

function render(proposal: ConsolidationProposal, overrides: Partial<{ busy: boolean }> = {}) {
  const onApply = vi.fn();
  const onDismiss = vi.fn();
  renderWithProviders(
    <ConsolidationCard
      proposal={proposal}
      workspaces={WORKSPACES}
      onApply={onApply}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { onApply, onDismiss };
}

describe('a repetition', () => {
  it('shows every member, and says which one survives', () => {
    render(duplicate);

    expect(screen.getByText('Workspace uses French')).toBeTruthy();
    expect(screen.getByText('This workspace operates in French')).toBeTruthy();
    expect(screen.getByText('User speaks French')).toBeTruthy();
    expect(screen.getAllByText('folded in')).toHaveLength(2);
    expect(screen.getAllByText('kept')).toHaveLength(1);
  });

  it('shows the text that would replace them', () => {
    render(duplicate);

    expect(screen.getByText('The workspace works in French')).toBeTruthy();
    expect(screen.getByText('Everything is French.')).toBeTruthy();
  });

  it('merges without promoting by default', () => {
    const { onApply } = render(duplicate);

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    expect(onApply).toHaveBeenCalledWith(false);
  });

  /**
   * Promotion changes what every *other* workspace recalls, so it is a second
   * button rather than a checkbox on the first — and it is absent entirely
   * unless the pass judged the fact to hold beyond this project.
   */
  it('offers promotion only when the fact was judged to hold everywhere', () => {
    render(duplicate);
    expect(screen.queryByRole('button', { name: /make global/i })).toBeNull();

    const { onApply } = render({ ...duplicate, promotable: true });
    fireEvent.click(screen.getByRole('button', { name: /make global/i }));

    expect(onApply).toHaveBeenCalledWith(true);
  });

  it('lets the operator decline without merging', () => {
    const { onApply, onDismiss } = render(duplicate);

    fireEvent.click(screen.getByRole('button', { name: 'Keep them separate' }));

    expect(onDismiss).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('locks the actions while one is in flight', () => {
    render({ ...duplicate, promotable: true }, { busy: true });

    const promote = screen.getByRole('button', { name: /make global/i }) as HTMLButtonElement;
    const dismiss = screen.getByRole('button', { name: 'Keep them separate' }) as HTMLButtonElement;
    expect(promote.disabled).toBe(true);
    expect(dismiss.disabled).toBe(true);
  });
});

describe('a contradiction', () => {
  it('has nothing to apply', () => {
    render(contradiction);

    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    expect(screen.queryByRole('button', { name: /make global/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('names both sides and says why they conflict', () => {
    render(contradiction);

    expect(screen.getByText('Always use pnpm')).toBeTruthy();
    expect(screen.getByText('Never use pnpm')).toBeTruthy();
    expect(screen.getByText('One requires pnpm, the other forbids it.')).toBeTruthy();
    // Nothing is marked as surviving: neither is being kept over the other.
    expect(screen.queryByText('kept')).toBeNull();
  });
});

describe('readProposal', () => {
  it('reads a well-formed payload', () => {
    expect(readProposal(JSON.stringify(duplicate))?.winnerId).toBe('mem_2');
  });

  it('refuses anything it could not render', () => {
    expect(readProposal(null)).toBeNull();
    expect(readProposal('not json')).toBeNull();
    expect(readProposal('{}')).toBeNull();
    // A single member is not a group; an unknown verdict is a newer shape.
    expect(readProposal(JSON.stringify({ ...duplicate, members: [duplicate.members[0]] }))).toBeNull();
    expect(readProposal(JSON.stringify({ ...duplicate, verdict: 'complementary' }))).toBeNull();
    expect(readProposal(JSON.stringify({ ...duplicate, winnerId: 42 }))).toBeNull();
    // A member of the wrong shape would draw an empty row rather than an
    // obviously broken card, which is the worse of the two failures.
    expect(readProposal(JSON.stringify({ ...duplicate, members: [1, 2] }))).toBeNull();
    expect(
      readProposal(JSON.stringify({ ...duplicate, members: [{ id: 'a' }, { id: 'b' }] })),
    ).toBeNull();
    // And the pre-triaged "these are distinct" marker, which carries a key
    // and nothing else, is not a proposal either.
    expect(readProposal(JSON.stringify({ key: 'mem_1|mem_2' }))).toBeNull();
  });
});

describe('which project the card says it is about', () => {
  /**
   * The survivor's tier and the group's project are not the same thing: a
   * group of one workspace's memories can be won by a global one, because a
   * global member always wins. The card names the project, which is where the
   * proposal is filed and where an operator will be looking at it.
   */
  it('names the project, not the global survivor’s tier', () => {
    render({
      ...duplicate,
      members: [
        { id: 'mem_g', title: 'Global twin', fingerprint: 'gggg', workspaceId: null },
        { id: 'mem_1', title: 'Workspace uses French', fingerprint: 'aaaa', workspaceId: 'ws_a' },
      ],
      winnerId: 'mem_g',
    });

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Global')).toBeNull();
  });

  it('says Global when every member is', () => {
    render({
      ...duplicate,
      members: [
        { id: 'mem_g', title: 'One', fingerprint: 'gggg', workspaceId: null },
        { id: 'mem_h', title: 'Two', fingerprint: 'hhhh', workspaceId: null },
      ],
      winnerId: 'mem_g',
    });

    expect(screen.getByText('Global')).toBeTruthy();
  });
});

/**
 * The card carries three pieces of free text an arbiter wrote — a reason, a
 * title and up to four thousand characters of merged body — beside buttons the
 * operator has to reach. `whitespace-pre-wrap` wraps at whitespace only, so a
 * path or a URL with no space in it pushes the card wider than the phone it is
 * being read on, and the page scrolls sideways.
 *
 * Asserted from `className` because that is what jsdom can see: it lays
 * nothing out, so a width is unobservable while a class is not. Same reasoning
 * as expressing safe-area insets as Tailwind classes elsewhere in this app.
 */
describe('long text on a narrow screen', () => {
  const long = 'x'.repeat(400);

  it('breaks an unbroken token rather than widening the card', () => {
    const { container } = renderWithProviders(
      <ConsolidationCard
        proposal={{
          ...duplicate,
          reason: long,
          merged: { title: long, content: long, tags: [] },
        }}
        workspaces={WORKSPACES}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const paragraphs = [...container.querySelectorAll('p')].filter((p) =>
      p.textContent?.includes(long),
    );
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    for (const paragraph of paragraphs) expect(paragraph.className).toContain('break-words');
  });

  /** And the body is bounded, so the buttons stay reachable without scrolling past it. */
  it('scrolls the merged body inside its own box', () => {
    const { container } = renderWithProviders(
      <ConsolidationCard
        proposal={{ ...duplicate, merged: { title: 't', content: long, tags: [] } }}
        workspaces={WORKSPACES}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const body = [...container.querySelectorAll('p')].find((p) => p.textContent === long)!;
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toMatch(/max-h-/);
  });
});
