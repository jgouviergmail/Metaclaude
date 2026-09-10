/**
 * The card for the one proposal that changes something the moment it is
 * accepted.
 *
 * What it owes the operator is not decoration: the diff, because approving a
 * rewrite you cannot see is the thing this loop must never be; the runs, as
 * links, because a claim nobody can check is a claim nobody should act on; and
 * a way back, because "reversible" has to be a button rather than a principle.
 * Each of those is asserted here, and so is the degraded case for each —
 * a proposal with no diff, a run whose session retention has pruned, and a
 * revision already taken back.
 */

import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdvisorProposal, RevisionPayload as RevisionPayloadType } from '@metaclaude/shared';
import { RevisionPayload } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { RevisionProposalCard } from './RevisionProposalCard';
import { readRevision } from './revision-payload';

/**
 * Built through the schema, never by hand.
 *
 * Five fixtures written from memory in one session were wrong, and each looked
 * like a broken component: the parse fails, the caller falls back, and the test
 * times out on an element that was never going to appear.
 */
const payload = (over: Record<string, unknown> = {}): RevisionPayloadType =>
  RevisionPayload.parse({
    target: { kind: 'skill', id: 'skl_1', name: 'review-migrations', workspaceId: 'ws_1' },
    field: 'description',
    before: 'Reviews migrations.',
    after: 'Use when reviewing a database migration before it ships.',
    beforeFingerprint: 'abc123',
    diff: '@@ -1 +1 @@\n-Reviews migrations.\n+Use when reviewing a database migration before it ships.',
    rationale: 'It was offered to fourteen runs and opened by none.',
    evidence: [
      { runId: 'run_1', sessionId: 'ses_1', workspaceId: 'ws_1', note: 'never opened' },
      { runId: 'run_2', sessionId: null, workspaceId: null, note: 'never opened' },
    ],
    findings: [],
    ...over,
  });

const proposal = (over: Partial<AdvisorProposal> = {}): AdvisorProposal =>
  ({
    id: 'prp_1',
    workspaceId: 'ws_1',
    runId: null,
    kind: 'revision',
    name: 'skill:skl_1:description',
    summary: 'Rewrite the description of review-migrations',
    rationale: 'r',
    payload: {},
    status: 'pending',
    createdAt: Date.now() - 60_000,
    decidedAt: null,
    decidedBy: null,
    ...over,
  }) as AdvisorProposal;

describe('readRevision', () => {
  it('reads a revision payload', () => {
    expect(readRevision({ kind: 'revision', payload: payload() })?.field).toBe('description');
  });

  it('answers null for another kind of proposal', () => {
    expect(readRevision({ kind: 'skill', payload: payload() })).toBeNull();
  });

  /** A hand-edited or older row must degrade, never throw on a dashboard. */
  it('answers null for a payload that is not one', () => {
    expect(readRevision({ kind: 'revision', payload: { nonsense: true } })).toBeNull();
    expect(readRevision({ kind: 'revision', payload: {} })).toBeNull();
  });

  it('does not mistake an inherited property for a target kind', () => {
    // `kind in TARGET_LABELS` walks the prototype chain, so `constructor` and
    // `toString` answer true and the label the card then renders is a
    // *function*, which React throws on. The label tables are lookups, so the
    // question is whether the object carries the key itself.
    for (const inherited of ['constructor', 'toString', 'valueOf', '__proto__']) {
      expect(
        readRevision({
          kind: 'revision',
          payload: { ...payload(), target: { ...payload().target, kind: inherited } },
        }),
      ).toBeNull();
      expect(
        readRevision({ kind: 'revision', payload: { ...payload(), field: inherited } }),
      ).toBeNull();
    }
  });
});

describe('RevisionProposalCard', () => {
  it('draws the diff rather than describing it', () => {
    render(<RevisionProposalCard proposal={proposal()} payload={payload()} onAccept={vi.fn()} />);

    expect(screen.getByText('Use when reviewing a database migration before it ships.')).toBeTruthy();
    expect(screen.getByText('Reviews migrations.')).toBeTruthy();
  });

  it('says so when there is no diff, rather than showing an empty box', () => {
    render(<RevisionProposalCard proposal={proposal()} payload={payload({ diff: '' })} />);

    expect(screen.getByText(/No diff was recorded/)).toBeTruthy();
  });

  it('names what it would rewrite, and where', () => {
    render(<RevisionProposalCard proposal={proposal()} payload={payload()} workspaceName="Alpha" />);

    expect(screen.getByText('review-migrations')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  /**
   * A run id alone is not a destination — the Memory page learned that when
   * `source_run_id` sat stored and unshown for releases.
   */
  it('links each run it is based on to the session it happened in', () => {
    render(<RevisionProposalCard proposal={proposal()} payload={payload()} />);

    const link = screen.getByRole('link', { name: 'run_1' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/w/ws_1/s/ses_1');
  });

  /** Retention prunes runs. A pruned one is still worth naming. */
  it('names a run whose session is gone without pretending it is a link', () => {
    render(<RevisionProposalCard proposal={proposal()} payload={payload()} />);

    expect(screen.queryByRole('link', { name: 'run_2' })).toBeNull();
    expect(screen.getByText('run_2')).toBeTruthy();
  });

  /**
   * A revision of something every workspace reaches is a different decision
   * from one confined to this project — the consequence that makes promoting a
   * memory ask first, and just as invisible from the row it is pressed on.
   */
  it('warns when the target reaches every workspace', () => {
    render(
      <RevisionProposalCard
        proposal={proposal()}
        payload={payload({
          target: { kind: 'skill', id: 'skl_1', name: 'review-migrations', workspaceId: null },
        })}
      />,
    );

    expect(screen.getByText(/reaches every workspace/)).toBeTruthy();
  });

  it('does not warn for the workspace’s own instructions, which reach only it', () => {
    render(
      <RevisionProposalCard
        proposal={proposal()}
        payload={payload({
          target: { kind: 'workspace', id: 'ws_1', name: 'Alpha', workspaceId: null },
          field: 'systemPromptAppend',
        })}
      />,
    );

    expect(screen.queryByText(/reaches every workspace/)).toBeNull();
  });

  it('offers Apply and Dismiss while pending, and calls back', () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      <RevisionProposalCard proposal={proposal()} payload={payload()} onAccept={onAccept} onDismiss={onDismiss} />,
    );

    screen.getByRole('button', { name: /Apply/ }).click();
    screen.getByRole('button', { name: /Dismiss/ }).click();
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  /**
   * The verb that makes accepting one safe. Every other proposal in this inbox
   * lands disabled; this one is in force on the next run.
   */
  it('offers a way back once it is applied, and no Apply', () => {
    const onRevert = vi.fn();
    render(
      <RevisionProposalCard
        proposal={proposal({ status: 'accepted' })}
        payload={payload()}
        onRevert={onRevert}
      />,
    );

    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
    screen.getByRole('button', { name: /Take it back/ }).click();
    expect(onRevert).toHaveBeenCalledOnce();
  });

  it('says when it has already been taken back, and offers nothing', () => {
    render(
      <RevisionProposalCard
        proposal={proposal({ status: 'accepted' })}
        payload={payload({ revertedAt: Date.now() - 1000 })}
        onRevert={vi.fn()}
      />,
    );

    expect(screen.getByText(/taken back/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take it back/ })).toBeNull();
  });

  /**
   * The half that closes the loop: at the next review the pass recomputes the
   * finding that motivated the change and says whether it recurred. A pass
   * that cannot say whether its own advice worked is one nobody should take
   * advice from.
   */
  it('reports what became of an applied revision, either way', () => {
    const followUp = { at: Date.now(), windowRuns: 12, recurred: false, note: '' };
    const { unmount } = render(
      <RevisionProposalCard proposal={proposal({ status: 'accepted' })} payload={payload({ followUp })} />,
    );
    expect(screen.getByText(/has not happened again/)).toBeTruthy();
    unmount();

    render(
      <RevisionProposalCard
        proposal={proposal({ status: 'accepted' })}
        payload={payload({ followUp: { ...followUp, recurred: true } })}
      />,
    );
    expect(screen.getByText(/happened again/)).toBeTruthy();
  });

  /**
   * A row of buttons that cannot shrink below its own text overflows a 360px
   * screen with no wrap and no scroll — the automation dialog shipped exactly
   * that. happy-dom has no layout, so what a test can hold is the class
   * contract on the row.
   */
  it('lays its verbs out as a grid on a phone rather than a bare flex row', () => {
    const { container } = render(
      <RevisionProposalCard proposal={proposal()} payload={payload()} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );

    const row = container.querySelector('.grid.grid-cols-2');
    expect(row).toBeTruthy();
    expect(row?.className).toContain('sm:flex');
  });

  it('gives every control a name a screen reader can read', () => {
    render(
      <RevisionProposalCard proposal={proposal()} payload={payload()} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );

    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it('shows nothing to decide for one that was dismissed', () => {
    render(
      <RevisionProposalCard
        proposal={proposal({ status: 'dismissed' })}
        payload={payload()}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
    expect(screen.getByText('Dismissed.')).toBeTruthy();
  });

  it('renders the rationale it was given', () => {
    const { container } = render(<RevisionProposalCard proposal={proposal()} payload={payload()} />);

    expect(within(container).getByText(/offered to fourteen runs/)).toBeTruthy();
  });
});

/*
 * Naming the actions.
 *
 * A dashboard shows several of these at once, and three buttons all called
 * "Apply" are three buttons a screen reader lists identically — the generic
 * proposal rows in `AdvisorCard` name theirs after the proposal for exactly
 * this reason, and one half of a list that does not is the two-copies smell.
 * The accessible name contains the visible label, so the two do not disagree.
 */
describe('naming the actions', () => {
  it('names each action after the text it acts on', () => {
    render(
      <RevisionProposalCard
        proposal={proposal()}
        payload={payload()}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /Apply .*review-migrations/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Dismiss .*review-migrations/ })).toBeDefined();
  });

  it('names the way back too', () => {
    render(
      <RevisionProposalCard
        proposal={proposal({ status: 'accepted' })}
        payload={payload()}
        onRevert={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /Take it back: .*review-migrations/ })).toBeDefined();
  });
});
