/**
 * The knowledge library section: scope is worn on every card, saving goes
 * through the API with the scope the form shows, and the retrieval rehearsal
 * displays exactly what the API returned — passages, sources, scores.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { KnowledgeSection } from './KnowledgeSection';

const { apiMock, toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  apiMock: {
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
vi.mock('sonner', () => ({ toast: toastMock }));

const WORKSPACES = [
  { id: 'ws_a', name: 'Alpha' },
  { id: 'ws_b', name: 'Beta' },
] as Workspace[];

const DOCS = [
  {
    id: 'doc_1',
    workspaceId: null,
    title: 'Conventions',
    contentLength: 2048,
    enabled: true,
    chunkCount: 3,
    embeddingModel: 'hash-v1:512',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
  {
    id: 'doc_2',
    workspaceId: 'ws_a',
    title: 'Bail — 12 rue des Lilas',
    contentLength: 4096,
    enabled: false,
    chunkCount: 7,
    embeddingModel: '',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.knowledge.list.mockResolvedValue({ documents: DOCS });
  apiMock.knowledge.save.mockResolvedValue({
    document: { ...DOCS[0], title: 'Nouveau', chunkCount: 2 },
  });
  apiMock.knowledge.delete.mockResolvedValue({ ok: true });
  apiMock.knowledge.search.mockResolvedValue({ results: [] });
  apiMock.knowledge.reindex.mockResolvedValue({ affected: 7 });
});

describe('the shelf', () => {
  it('wears the scope on every card, and marks the paused one', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);

    expect(await screen.findByText('Conventions')).toBeDefined();
    // The global document says Global; the scoped one names its workspace.
    expect(screen.getByText('Global')).toBeDefined();
    expect(screen.getByText('Alpha')).toBeDefined();
    // A disabled document is visibly paused, not silently absent.
    expect(screen.getByText('Paused')).toBeDefined();
  });

  it('saves a new document as global by default', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /add document/i }));
    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: 'Runbook' } });
    fireEvent.change(screen.getByLabelText(/content/i), { target: { value: 'Le contenu.' } });
    fireEvent.click(screen.getByRole('button', { name: /add to the library/i }));

    await waitFor(() =>
      expect(apiMock.knowledge.save).toHaveBeenCalledWith({
        title: 'Runbook',
        content: 'Le contenu.',
        workspaceId: null,
        enabled: true,
      }),
    );
  });

  it('pre-selects the workspace when the page is already scoped to one', async () => {
    renderWithProviders(<KnowledgeSection scope="ws_a" workspaces={WORKSPACES} />);
    await waitFor(() => expect(apiMock.knowledge.list).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /add document/i }));
    const select = (await screen.findByLabelText(/scope/i)) as HTMLSelectElement;
    expect(select.value).toBe('ws_a');
  });

  it('deletes only after the confirmation names the document', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: 'Delete “Conventions”' }));
    expect(apiMock.knowledge.delete).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /delete document/i }));
    await waitFor(() => expect(apiMock.knowledge.delete).toHaveBeenCalledWith('doc_1'));
  });
});

describe('the retrieval rehearsal', () => {
  it('shows the passages a run would be shown, with their source and score', async () => {
    apiMock.knowledge.search.mockResolvedValue({
      results: [
        {
          chunkId: 'chk_1',
          documentId: 'doc_2',
          documentTitle: 'Bail — 12 rue des Lilas',
          workspaceId: 'ws_a',
          heading: 'Résiliation',
          text: 'Le préavis de résiliation est de 45 jours.',
          score: 0.0331,
        },
      ],
    });
    renderWithProviders(<KnowledgeSection scope="ws_a" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText(/rehearse a retrieval/i), {
      target: { value: 'préavis ?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    // The exact run pipeline was asked, scoped to this workspace.
    await waitFor(() => expect(apiMock.knowledge.search).toHaveBeenCalledWith('préavis ?', 'ws_a'));
    expect(await screen.findByText('Bail — 12 rue des Lilas › Résiliation')).toBeDefined();
    expect(screen.getByText(/45 jours/)).toBeDefined();
    expect(screen.getByText('0.033')).toBeDefined();
  });

  it('says plainly when a run would receive nothing', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText(/rehearse a retrieval/i), {
      target: { value: 'le la de' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    expect(await screen.findByText(/no passages for this/i)).toBeDefined();
  });
});

describe('re-indexing', () => {
  it('offers the button only once there is something to re-index', async () => {
    apiMock.knowledge.list.mockResolvedValue({ documents: [] });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText(/nothing on the shelf yet/i);
    expect(screen.queryByRole('button', { name: /re-index/i })).toBeNull();
  });

  it('re-embeds every passage on demand — the twin of memory maintenance', async () => {
    // After an embedding-provider change the dense arm silently stops
    // contributing while the lexical arm keeps answering; without a button
    // there is no way to notice or to fix it from the interface.
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /re-index/i }));
    await waitFor(() => expect(apiMock.knowledge.reindex).toHaveBeenCalled());
  });

  it('counts in the singular when exactly one passage moved', async () => {
    // Memory maintenance already says "1 memory affected"; a library that
    // reports "1 passages" reads as a rounding artefact rather than a count.
    apiMock.knowledge.reindex.mockResolvedValue({ affected: 1 });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /re-index/i }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('1 passage re-embedded.'));
  });

  it('says so plainly when there was nothing to re-embed', async () => {
    apiMock.knowledge.reindex.mockResolvedValue({ affected: 0 });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /re-index/i }));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'Everything was already indexed with the current embedder.',
      ),
    );
  });
});

describe('vectors pending', () => {
  it('marks a document whose chunks await the model, and only that one', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);

    await screen.findByText('Conventions');
    expect(screen.getAllByText('Vectors pending')).toHaveLength(1);
  });
});

describe('vectors pending after a change of embedder', () => {
  it('marks every document not embedded with the live provider', async () => {
    renderWithProviders(<KnowledgeSection scope="all" embedder="st:Xenova/bge-m3" workspaces={WORKSPACES} />);

    await screen.findByText('Conventions');
    // The hashed one and the pending one: neither carries the live id.
    expect(screen.getAllByText('Vectors pending')).toHaveLength(2);
  });

  it('marks none when every document is current', async () => {
    renderWithProviders(<KnowledgeSection scope="all" embedder="hash-v1:512" workspaces={WORKSPACES} />);

    await screen.findByText('Conventions');
    // doc_2 was written pending and stays marked whatever the live id.
    expect(screen.getAllByText('Vectors pending')).toHaveLength(1);
  });
});
