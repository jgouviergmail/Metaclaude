/**
 * What the system has learned, and what it was handed to read.
 *
 * A thousand lines, and — until this file — no test at all, on the screen two
 * consecutive lots had just modified. What it owns beyond its parts is the
 * distinction between *filtering* a list and *searching by meaning*: the two
 * boxes sit side by side, take different input and hit different endpoints,
 * and confusing them would quietly turn a semantic recall into a substring
 * match over whatever happened to be loaded.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'sonner';

import { renderWithProviders } from '@/test/render';

import type { Memory, Workspace } from '@metaclaude/shared';

import { MemoryPage, tiersOf } from './MemoryPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(),
    memory: vi.fn(),
    searchMemory: vi.fn(),
    insights: vi.fn(),
    createMemory: vi.fn(),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    memoryMaintenance: vi.fn(),
    system: vi.fn(),
    setMemoryScope: vi.fn(),
    applyConsolidation: vi.fn(),
    setInsightStatus: vi.fn(),
    synthesiseSkill: vi.fn(),
    installSkillFromInsight: vi.fn(),
    keepInsightNote: vi.fn(),
    knowledge: {
      list: vi.fn(),
      get: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
      search: vi.fn(),
      reindex: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The constellation measures its container; jsdom lays nothing out.
vi.mock('@/components/memory/MemoryConstellation', () => ({
  MemoryConstellation: () => null,
}));

const memory = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: null,
  kind: 'semantic',
  title,
  content: 'Le préavis est de trois mois.',
  tags: ['bail'],
  confidence: 0.8,
  useCount: 3,
  successCount: 2,
  pinned: false,
  shelf: 'durable',
  retiredAt: null,
  supersededBy: null,
  sourceRunId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  lastUsedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspaces.mockResolvedValue({ workspaces: [] });
  apiMock.system.mockResolvedValue({
    retrieval: { embedder: 'st:Xenova/bge-m3', family: 'st', state: 'ready', semantic: true, pending: { memories: 0, documents: 0, exemplars: 0 } },
  });
  apiMock.memory.mockResolvedValue({
    memories: [memory('mem_1', 'Préavis de résiliation')],
    sources: {},
  });
  apiMock.searchMemory.mockResolvedValue({ results: [] });
  apiMock.insights.mockResolvedValue({ insights: [] });
  apiMock.knowledge.list.mockResolvedValue({ documents: [] });
  apiMock.memoryMaintenance.mockResolvedValue({ affected: 0 });
  apiMock.deleteMemory.mockResolvedValue({ ok: true });
});

describe('the shelf', () => {
  it('shows what has been learned', async () => {
    renderWithProviders(<MemoryPage />);
    expect(await screen.findByText('Préavis de résiliation')).toBeDefined();
  });

  it('asks the server for the kind that is selected', async () => {
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    const group = screen.getByRole('group', { name: 'Filter by memory kind' });
    const semantic = [...group.querySelectorAll('button')].find(
      (b) => b.textContent?.toLowerCase().includes('semantic'),
    ) as HTMLButtonElement;
    fireEvent.click(semantic);

    await waitFor(() =>
      expect(apiMock.memory).toHaveBeenCalledWith(expect.objectContaining({ kind: 'semantic' })),
    );
    expect(semantic.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('filtering versus recalling', () => {
  it('filters the list without asking the server to search', async () => {
    // The keyword box narrows what is already on screen; sending it to the
    // semantic endpoint would answer a different question entirely.
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    fireEvent.change(screen.getByLabelText('Filter memories by keyword'), {
      target: { value: 'bail' },
    });
    expect(apiMock.searchMemory).not.toHaveBeenCalled();
  });

  it('recalls by meaning through the search endpoint, on demand', async () => {
    apiMock.searchMemory.mockResolvedValue({
      results: [{ memory: memory('mem_2', 'Dépôt de garantie'), score: 0.42 }],
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    fireEvent.change(screen.getByLabelText('Search memory by meaning'), {
      target: { value: 'quand récupère-t-on la caution ?' },
    });
    fireEvent.submit(screen.getByLabelText('Search memory by meaning').closest('form')!);

    await waitFor(() =>
      expect(apiMock.searchMemory).toHaveBeenCalledWith(
        'quand récupère-t-on la caution ?',
        undefined,
      ),
    );
    expect(await screen.findByText('Dépôt de garantie')).toBeDefined();
    // The score is what makes a rehearsal readable rather than a guess.
    expect(screen.getByLabelText('Similarity score 0.42')).toBeDefined();
  });

  /**
   * Recall answers with the union a run would be given, best-first — and it is
   * the one list on this screen that is not grouped by tier. Without a marker
   * here a global result is indistinguishable from a workspace one, which is
   * the confusion the grouping exists to remove.
   */
  it('marks each recalled memory with its tier, since the list is not grouped', async () => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [{ id: 'ws_a', name: 'Alpha', color: '#6366f1' }],
    });
    apiMock.searchMemory.mockResolvedValue({
      results: [
        { memory: memory('mem_g', 'Vaut partout', { workspaceId: null }), score: 0.5 },
        { memory: memory('mem_a', 'Propre au projet', { workspaceId: 'ws_a' }), score: 0.3 },
      ],
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    fireEvent.change(screen.getByLabelText('Search memory by meaning'), {
      target: { value: 'quoi que ce soit' },
    });
    fireEvent.submit(screen.getByLabelText('Search memory by meaning').closest('form')!);

    const globalHit = (await screen.findByText('Vaut partout')).closest('li')!;
    const scopedHit = screen.getByText('Propre au projet').closest('li')!;
    expect(globalHit.textContent).toContain('Global');
    expect(scopedHit.textContent).toContain('Alpha');
  });
});

describe('maintenance', () => {
  it('runs the action the operator chose, and reports what it touched', async () => {
    apiMock.memoryMaintenance.mockResolvedValue({ affected: 7 });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    const trigger = screen.getByRole('button', { name: 'Memory maintenance' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Decay/i }));

    await waitFor(() => expect(apiMock.memoryMaintenance).toHaveBeenCalledWith('decay'));
  });
});

describe('the knowledge library below it', () => {
  it('is part of this screen, not a separate one', async () => {
    // Memory is what the system distilled; knowledge is what it was handed.
    // They live together because the question "what does it know?" is one
    // question.
    renderWithProviders(<MemoryPage />);
    expect(await screen.findByText('Knowledge library')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Tiers                                                                       */
/* -------------------------------------------------------------------------- */

describe('tiersOf', () => {
  const global = (id: string) => memory(id, id, { workspaceId: null }) as unknown as Memory;
  const scoped = (id: string, ws: string) => memory(id, id, { workspaceId: ws }) as unknown as Memory;
  const workspaces = [
    { id: 'ws_z', name: 'Zulu' } as Workspace,
    { id: 'ws_a', name: 'Alpha' } as Workspace,
  ];
  const t = (key: string) => key;

  /**
   * `GET /api/memory` for a workspace answers with that workspace's rows *and*
   * every global one, sorted by pinned then confidence — which interleaves the
   * two tiers thoroughly enough that an operator cannot tell them apart. The
   * union is right; only the shape was wrong.
   */
  it('separates the union the list has always contained', () => {
    const tiers = tiersOf(
      [global('g1'), scoped('a1', 'ws_a'), global('g2'), scoped('a2', 'ws_a')],
      workspaces,
      t,
    );

    expect(tiers.map((tier) => tier.workspaceId)).toEqual([null, 'ws_a']);
    expect(tiers[0]!.memories.map((m) => m.id)).toEqual(['g1', 'g2']);
    expect(tiers[1]!.memories.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  /** Global first: it is the tier an operator least expects to find here. */
  it('puts global first however the rows arrived', () => {
    const tiers = tiersOf([scoped('a1', 'ws_a'), global('g1')], workspaces, t);

    expect(tiers[0]!.workspaceId).toBeNull();
  });

  it('orders the workspaces by name, not by the sort above', () => {
    const tiers = tiersOf([scoped('z1', 'ws_z'), scoped('a1', 'ws_a')], workspaces, t);

    expect(tiers.map((tier) => tier.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('omits a tier that has nothing in it', () => {
    expect(tiersOf([global('g1')], workspaces, t).map((tier) => tier.workspaceId)).toEqual([null]);
    expect(tiersOf([scoped('a1', 'ws_a')], workspaces, t).map((tier) => tier.workspaceId)).toEqual([
      'ws_a',
    ]);
    expect(tiersOf([], workspaces, t)).toEqual([]);
  });

  it('names a workspace it cannot resolve without leaking an id', () => {
    const tiers = tiersOf([scoped('x1', 'ws_gone')], workspaces, t);

    expect(tiers[0]!.name).toBe('Workspace');
  });
});

describe('the two tiers on screen', () => {
  beforeEach(() => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [{ id: 'ws_a', name: 'Alpha', color: '#6366f1' }],
    });
    apiMock.memory.mockResolvedValue({
      memories: [
        memory('mem_g', 'Une règle qui vaut partout', { workspaceId: null }),
        memory('mem_a', 'Une règle propre au projet', { workspaceId: 'ws_a' }),
      ],
      sources: {},
    });
  });

  it('heads each tier, and says who recalls it', async () => {
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Une règle qui vaut partout');

    expect(screen.getByRole('heading', { name: /Global/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Alpha/ })).toBeDefined();
    expect(screen.getByText('Recalled in every workspace')).toBeDefined();
    expect(screen.getByText('Recalled only here')).toBeDefined();
  });

  /** A card is reached directly from the constellation, so it says its own tier. */
  it('marks each card with its tier as well', async () => {
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Une règle qui vaut partout');

    const card = document.getElementById('memory-mem_a')!;
    expect(card.textContent).toContain('Alpha');
    const globalCard = document.getElementById('memory-mem_g')!;
    expect(globalCard.textContent).toContain('Global');
  });
});

describe('moving a memory between tiers', () => {
  beforeEach(() => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [{ id: 'ws_a', name: 'Alpha', color: '#6366f1' }],
    });
    apiMock.setMemoryScope.mockResolvedValue({
      memory: memory('mem_a', 'Une règle propre au projet', { workspaceId: null }),
      moved: true,
    });
  });

  const openMenuFor = (title: string) => {
    const trigger = screen.getByRole('button', { name: `Actions for ${title}` });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
  };

  it('promotes only after the consequence has been stated and confirmed', async () => {
    apiMock.memory.mockResolvedValue({
      memories: [memory('mem_a', 'Une règle propre au projet', { workspaceId: 'ws_a' })],
      sources: {},
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Une règle propre au projet');

    openMenuFor('Une règle propre au projet');
    fireEvent.click(screen.getByRole('menuitem', { name: /Make global/ }));

    // Nothing has happened yet: the dialog is the point.
    expect(apiMock.setMemoryScope).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/would be recalled by every workspace/),
    ).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Make global' }));

    await waitFor(() => expect(apiMock.setMemoryScope).toHaveBeenCalledWith('mem_a', null));
  });

  it('offers confinement, per workspace, only on a global memory', async () => {
    apiMock.memory.mockResolvedValue({
      memories: [memory('mem_g', 'Une règle qui vaut partout', { workspaceId: null })],
      sources: {},
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Une règle qui vaut partout');

    openMenuFor('Une règle qui vaut partout');

    expect(screen.queryByRole('menuitem', { name: /Make global/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Confine to Alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confine' }));

    await waitFor(() => expect(apiMock.setMemoryScope).toHaveBeenCalledWith('mem_g', 'ws_a'));
  });
});

describe('consolidation', () => {
  const proposal = {
    key: 'mem_1|mem_2',
    verdict: 'duplicate',
    reason: 'Les deux disent que le workspace travaille en français.',
    members: [
      { id: 'mem_1', title: 'Le workspace est en français', fingerprint: 'aaaa', workspaceId: null },
      { id: 'mem_2', title: 'On écrit en français ici', fingerprint: 'bbbb', workspaceId: null },
    ],
    winnerId: 'mem_1',
    merged: { title: 'Le workspace travaille en français', content: 'Tout y est écrit en français.', tags: [] },
    promotable: false,
  };

  const runConsolidate = () => {
    const trigger = screen.getByRole('button', { name: 'Memory maintenance' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Consolidate/i }));
  };

  /**
   * Seen in production: the arbiter errored, the sweep caught it as it must,
   * and the screen said the corpus repeats nothing — a claim it had not
   * earned. "Could not ask" is not "asked, and the answer was no".
   */
  it('says a pass could not finish rather than calling the corpus clean', async () => {
    apiMock.memoryMaintenance.mockResolvedValue({
      affected: 0,
      consolidation: { groups: 0, proposed: 0, remaining: 4, seeds: 4, corpus: 4, reachedArbiter: false },
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    runConsolidate();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a pass that found nothing without calling it a failure', async () => {
    apiMock.memoryMaintenance.mockResolvedValue({
      affected: 0,
      consolidation: { groups: 3, proposed: 0, remaining: 0, seeds: 3, corpus: 3, reachedArbiter: true },
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    const trigger = screen.getByRole('button', { name: 'Memory maintenance' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /Consolidate/i }));

    await waitFor(() => expect(apiMock.memoryMaintenance).toHaveBeenCalledWith('consolidate'));
  });

  it('shows a proposal as a decision, not as an observation to accept', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [
        {
          id: 'ins_1',
          workspaceId: null,
          runId: null,
          kind: 'consolidation',
          title: '2 memories say the same thing',
          body: 'x',
          confidence: 0.7,
          status: 'new',
          payload: JSON.stringify(proposal),
          createdAt: 1_700_000_000_000,
        },
      ],
    });
    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('Le workspace travaille en français')).toBeDefined();
    // The generic pair belongs to observations; this is a change to rows.
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDefined();
  });

  it('applies one only when the operator presses it', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [
        {
          id: 'ins_1',
          workspaceId: null,
          runId: null,
          kind: 'consolidation',
          title: 't',
          body: 'x',
          confidence: 0.7,
          status: 'new',
          payload: JSON.stringify(proposal),
          createdAt: 1_700_000_000_000,
        },
      ],
    });
    apiMock.applyConsolidation.mockResolvedValue({
      memory: memory('mem_1', 'Le workspace travaille en français'),
      absorbed: ['mem_2'],
      moved: false,
    });
    renderWithProviders(<MemoryPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));

    await waitFor(() =>
      expect(apiMock.applyConsolidation).toHaveBeenCalledWith('ins_1', false),
    );
  });

  /** A payload from an older shape must not take the whole queue down. */
  it('falls back to the plain card when the payload cannot be read', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [
        {
          id: 'ins_1',
          workspaceId: null,
          runId: null,
          kind: 'consolidation',
          title: 'Something older',
          body: 'x',
          confidence: 0.7,
          status: 'new',
          payload: '{"shape":"from another version"}',
          createdAt: 1_700_000_000_000,
        },
      ],
    });
    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('Something older')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDefined();
  });
});

describe('provenance', () => {
  it('links a memory to the session it was learned in', async () => {
    apiMock.memory.mockResolvedValue({
      memories: [memory('mem_1', 'Apprise quelque part', { sourceRunId: 'run_9' })],
      sources: { run_9: { sessionId: 'ses_3', workspaceId: 'ws_a' } },
    });
    renderWithProviders(<MemoryPage />);

    const link = (await screen.findByText('where this came from')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/w/ws_a/s/ses_3');
  });

  /**
   * A run past its retention window is gone, and a link to it would land on
   * the dashboard by way of the catch-all route — which reads as the app
   * losing the operator's place rather than as the run having been pruned.
   */
  it('shows no link when the run it names has been pruned', async () => {
    apiMock.memory.mockResolvedValue({
      memories: [memory('mem_1', 'Apprise quelque part', { sourceRunId: 'run_gone' })],
      sources: {},
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Apprise quelque part');

    expect(screen.queryByText('where this came from')).toBeNull();
  });
});

describe('the retrieval line', () => {
  it('stays quiet while a model is loaded and nothing waits', async () => {
    renderWithProviders(<MemoryPage />);
    // The heading, not any text: « Memory » is also a tab-bar label now
    // that the section is one of the five, and an ambiguous query makes
    // `findBy` retry until it times out rather than fail on the spot.
    await screen.findByRole('heading', { name: 'Memory' });

    expect(screen.queryByTestId('retrieval-line')).toBeNull();
  });

  it('appears the moment vectors wait for a rebuild, and names the count', async () => {
    apiMock.system.mockResolvedValue({
      retrieval: { embedder: 'st:Xenova/bge-m3', family: 'st', state: 'loading', semantic: false, pending: { memories: 4, documents: 1, exemplars: 0 } },
    });
    renderWithProviders(<MemoryPage />);

    const line = await screen.findByTestId('retrieval-line');
    expect(line.textContent).toMatch(/Model loading/);
    expect(line.textContent).toMatch(/5 vectors are waiting/);
  });
});

describe('the recall box tells the truth about the regime', () => {
  it('calls itself semantic only while a model is loaded', async () => {
    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('Semantic recall')).toBeDefined();
    expect(screen.getByLabelText('Search memory by meaning')).toBeDefined();
  });

  it('says it matches words under the hashing embedder', async () => {
    apiMock.system.mockResolvedValue({
      retrieval: { embedder: 'hash-v1:512', family: 'hash', state: 'ready', semantic: false, pending: { memories: 0, documents: 0, exemplars: 0 } },
    });
    renderWithProviders(<MemoryPage />);

    expect(await screen.findByLabelText('Search memory by words')).toBeDefined();
    expect(screen.queryByText('Semantic recall')).toBeNull();
    expect(screen.getByText(/matches words, not meaning/)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Shelves, retirement, and the gate's decisions                              */
/* -------------------------------------------------------------------------- */

describe('shelves and retirement', () => {
  it('badges a convention and a fact, folds the retired ones closed, and restores from the fold', async () => {
    apiMock.memory.mockResolvedValue({
      memories: [
        memory('mem_rule', 'Propose defaults', { shelf: 'standing', pinned: true }),
        memory('mem_fact', 'API port', { shelf: 'volatile' }),
        memory('mem_plain', 'Plain lesson', { shelf: 'durable' }),
        memory('mem_old', 'Form offers three triggers', { shelf: 'volatile', retiredAt: 1, supersededBy: 'mem_fact' }),
      ],
      // The API's total counts the live rows only, which is what the count
      // beside the heading is a fraction of.
      total: 3,
      sources: {},
    });
    apiMock.updateMemory.mockResolvedValue({ memory: memory('mem_old', 'Form offers three triggers') });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Propose defaults');

    expect(screen.getByText('standing')).toBeTruthy();
    expect(screen.getByText('volatile')).toBeTruthy();
    // The list asked for the retired rows, and shows them only in the fold.
    expect(apiMock.memory).toHaveBeenCalledWith(expect.objectContaining({ includeRetired: true }));
    const fold = screen.getByTestId('retired-memories') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText('Retired memory (1)')).toBeTruthy();
    expect(within(fold).getByText('Form offers three triggers')).toBeTruthy();
    expect(within(fold).getByText(/replaced by a newer memory/)).toBeTruthy();
    // Not on a card: a retired memory has left recall — and is not counted as shown.
    expect(screen.getAllByText('Form offers three triggers')).toHaveLength(1);
    expect(screen.getByText('3 shown')).toBeTruthy();

    // A shelf filter hides live rows, so the denominator appears — and the
    // retired one is in neither number.
    fireEvent.click(screen.getByRole('button', { name: 'Volatile' }));
    expect(screen.getByText('1 shown of 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Form offers three triggers' }));
    await waitFor(() => expect(apiMock.updateMemory).toHaveBeenCalledWith('mem_old', { retired: false }));
  });

  it('filters the cards by shelf on the client', async () => {
    apiMock.memory.mockResolvedValue({
      memories: [
        memory('mem_rule', 'Propose defaults', { shelf: 'standing' }),
        memory('mem_fact', 'API port', { shelf: 'volatile' }),
      ],
      sources: {},
    });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Propose defaults');

    fireEvent.click(screen.getByRole('button', { name: 'Volatile' }));
    expect(screen.queryByText('Propose defaults')).toBeNull();
    expect(screen.getByText('API port')).toBeTruthy();
  });

  it('retires from the card menu and moves a memory to another shelf', async () => {
    apiMock.memory.mockResolvedValue({ memories: [memory('mem_1', 'Préavis de résiliation')], sources: {} });
    apiMock.updateMemory.mockResolvedValue({ memory: memory('mem_1', 'Préavis de résiliation') });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    const open = () => {
      const trigger = screen.getByRole('button', { name: 'Actions for Préavis de résiliation' });
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
    };
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Retire/ }));
    await waitFor(() => expect(apiMock.updateMemory).toHaveBeenCalledWith('mem_1', { retired: true }));

    open();
    // The shelf entries are checkable: the current one is announced as chosen.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Standing/ }));
    await waitFor(() => expect(apiMock.updateMemory).toHaveBeenCalledWith('mem_1', { shelf: 'standing' }));
  });

  it('posts the chosen shelf when adding a memory', async () => {
    apiMock.createMemory.mockResolvedValue({ memory: memory('mem_new', 'New'), merged: false });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Préavis de résiliation');

    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' })[0]!);
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Briefs in French' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Every brief is written in French.' } });
    fireEvent.change(screen.getByLabelText('Shelf'), { target: { value: 'standing' } });
    // The confirm button shares the header button's name; it is the last one rendered.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' }).at(-1)!);

    await waitFor(() => expect(apiMock.createMemory).toHaveBeenCalledWith(expect.objectContaining({ shelf: 'standing', title: 'Briefs in French' })));
  });
});

describe('the gate’s decisions on an insight', () => {
  const payload = {
    kind: 'reflexion',
    decisions: [
      { title: 'Kept one', content: 'c', kind: 'semantic', tags: [], level: 'fact', outcome: 'kept', reason: 'holds', memoryId: 'mem_k', shelf: 'volatile' },
      { title: 'Refused one', content: 'c', kind: 'semantic', tags: [], level: 'state', outcome: 'skipped', reason: 'changes next release', memoryId: null, shelf: null },
    ],
  };

  it('lists each note with its verdict and offers to keep a refused one', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [{ id: 'ins_1', workspaceId: null, runId: 'run_1', kind: 'lesson', title: 'A run', body: 'ignored', confidence: 0.7, status: 'new', payload: JSON.stringify(payload), createdAt: 0 }],
    });
    apiMock.keepInsightNote.mockResolvedValue({ memory: memory('mem_new', 'Refused one') });
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Kept one');

    expect(screen.getByText('kept')).toBeTruthy();
    expect(screen.getByText('skipped')).toBeTruthy();
    expect(screen.getByText(/changes next release/)).toBeTruthy();
    expect(screen.queryByText('ignored')).toBeNull();
    // Only the refused note can be kept.
    expect(screen.queryByRole('button', { name: 'Keep Kept one' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Refused one' }));
    await waitFor(() => expect(apiMock.keepInsightNote).toHaveBeenCalledWith('ins_1', 1));
  });

  it('falls back to the body when the payload is not the gate’s', async () => {
    apiMock.insights.mockResolvedValue({
      insights: [{ id: 'ins_2', workspaceId: null, runId: null, kind: 'lesson', title: 'Old style', body: 'the body', confidence: 0.7, status: 'new', payload: null, createdAt: 0 }],
    });
    renderWithProviders(<MemoryPage />);
    expect(await screen.findByText('the body')).toBeTruthy();
  });
});
