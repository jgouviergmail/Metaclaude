/**
 * The knowledge library section.
 *
 * What is pinned here is what an operator does with it: filter by workspace,
 * find a document by title, see where each one reaches, pause one without
 * resending its text, and open a file-backed document rather than an editor
 * that cannot change it.
 */

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDocumentMeta, Workspace } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';
import { KnowledgeSection } from './KnowledgeSection';

const { apiMock, toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  apiMock: {
    knowledge: {
      list: vi.fn(),
      get: vi.fn(),
      save: vi.fn(),
      upload: vi.fn(),
      patch: vi.fn(),
      extract: vi.fn(),
      sourceUrl: (id: string) => `/api/knowledge/${id}/source`,
      delete: vi.fn(),
      search: vi.fn(),
      reindex: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: toastMock }));

const WORKSPACES = [
  { id: 'ws_a', name: 'Alpha', color: '#6366f1' },
  { id: 'ws_b', name: 'Beta', color: '#22c55e' },
] as Workspace[];

const doc = (over: Partial<KnowledgeDocumentMeta> = {}): KnowledgeDocumentMeta =>
  ({
    id: 'doc_1',
    workspaceId: null,
    title: 'Conventions',
    contentLength: 2048,
    enabled: true,
    chunkCount: 3,
    embeddingModel: 'hash-v1:512',
    isGlobal: true,
    workspaceIds: [],
    source: null,
    pageUnit: null,
    pageCount: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }) as KnowledgeDocumentMeta;

const LEASE = doc({
  id: 'doc_2',
  title: 'Bail — Résiliation',
  isGlobal: false,
  workspaceIds: ['ws_a'],
  enabled: false,
  source: {
    name: 'bail.pdf',
    mime: 'application/pdf',
    bytes: 4096,
    extractor: 'pdf@poppler-22.12.0',
  },
  pageUnit: 'page',
  pageCount: 3,
});

const DOCS = [doc(), LEASE];

/** Radix opens on pointerdown, not on click. */
const openMenu = async (name: RegExp | string): Promise<void> => {
  const trigger = screen.getByRole('button', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  await screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.knowledge.list.mockResolvedValue({ documents: DOCS });
  apiMock.knowledge.patch.mockResolvedValue({ document: doc() });
  apiMock.knowledge.get.mockResolvedValue({
    document: { ...doc(), content: '# Titre\n\nLe contenu.' },
  });
});

describe('the shelf', () => {
  it('wears each document’s reach, its format and its pause', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);

    expect(await screen.findByText('Conventions')).toBeDefined();
    expect(screen.getByText('Global')).toBeDefined();
    expect(screen.getByText('Alpha')).toBeDefined();
    expect(screen.getByText('PDF')).toBeDefined();
    expect(screen.getByText('Paused')).toBeDefined();
  });

  it('says how many pages a paged document has', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Bail — Résiliation');
    expect(screen.getByText(/3 pages/)).toBeDefined();
  });

  it('pauses through a patch, without resending the text', async () => {
    // The read-then-save it replaces cannot work for a file-backed document
    // at all: the store refuses its text on the way back in.
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('switch', { name: 'Retrieve from “Conventions”' }));

    await waitFor(() =>
      expect(apiMock.knowledge.patch).toHaveBeenCalledWith('doc_1', { enabled: false }),
    );
    expect(apiMock.knowledge.get).not.toHaveBeenCalled();
  });

  it('deletes only after the confirmation names the document', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    await openMenu('More actions for “Conventions”');
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(apiMock.knowledge.delete).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /delete document/i }));
    await waitFor(() => expect(apiMock.knowledge.delete).toHaveBeenCalledWith('doc_1'));
  });
});

describe('the filters', () => {
  it('asks the server for the scope the page is showing', async () => {
    // The page owns the workspace filter — one question, one control — and the
    // library follows it.
    renderWithProviders(<KnowledgeSection scope="ws_a" workspaces={WORKSPACES} />);
    await waitFor(() =>
      expect(apiMock.knowledge.list).toHaveBeenCalledWith({ workspaceId: 'ws_a' }),
    );
  });

  it('asks for the global shelf alone when the page is showing it', async () => {
    renderWithProviders(<KnowledgeSection scope="global" workspaces={WORKSPACES} />);
    await waitFor(() => expect(apiMock.knowledge.list).toHaveBeenCalledWith({ scope: 'global' }));
  });

  it('finds a document by title, ignoring case and accents', async () => {
    // A French library is full of accents and a phone keyboard is not.
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText('Find a document'), { target: { value: 'resiliation' } });

    expect(screen.getByText('Bail — Résiliation')).toBeDefined();
    expect(screen.queryByText('Conventions')).toBeNull();
  });

  it('finds a document by its file’s name too', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText('Find a document'), { target: { value: 'bail.pdf' } });

    expect(screen.getByText('Bail — Résiliation')).toBeDefined();
  });

  it('keeps the controls and says how many are hidden when nothing matches', async () => {
    // Hiding the filter row with the list is how an operator gets stuck
    // inside a scope with nothing in it.
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText('Find a document'), { target: { value: 'zzz' } });

    expect(screen.getByLabelText('Find a document')).toBeDefined();
    expect(screen.getByText(/2 hidden/)).toBeDefined();
    expect(screen.getByText('No document matches')).toBeDefined();
  });
});

describe('adding documents', () => {
  it('offers a drop zone whose reach follows the scope', async () => {
    renderWithProviders(<KnowledgeSection scope="ws_a" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    // The zone is there, and its input accepts the library's types.
    const input = screen.getByLabelText(/choose files/i) as HTMLInputElement;
    expect(input.accept).toContain('application/pdf');
  });

  it('saves a pasted document with the reach the picker shows', async () => {
    apiMock.knowledge.save.mockResolvedValue({ document: doc({ title: 'Runbook' }) });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /paste a document/i }));
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Runbook' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Le contenu.' } });
    fireEvent.click(screen.getByRole('button', { name: /add to the library/i }));

    await waitFor(() =>
      expect(apiMock.knowledge.save).toHaveBeenCalledWith({
        title: 'Runbook',
        content: 'Le contenu.',
        workspaceId: null,
        enabled: true,
        reach: { global: true, workspaceIds: [] },
      }),
    );
  });

  it('aims a new document at the workspace the scope names', async () => {
    apiMock.knowledge.save.mockResolvedValue({ document: doc() });
    renderWithProviders(<KnowledgeSection scope="ws_a" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /paste a document/i }));
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Note' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Texte.' } });
    fireEvent.click(screen.getByRole('button', { name: /add to the library/i }));

    await waitFor(() =>
      expect(apiMock.knowledge.save).toHaveBeenCalledWith(
        expect.objectContaining({ reach: { global: false, workspaceIds: ['ws_a'] } }),
      ),
    );
  });
});

describe('a document that came from a file', () => {
  it('offers to view, download and re-read it, which a pasted one does not', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Bail — Résiliation');

    await openMenu('More actions for “Bail — Résiliation”');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^view$/i })).toBeDefined();
    expect(within(menu).getByRole('menuitem', { name: /download the original/i })).toBeDefined();
    expect(within(menu).getByRole('menuitem', { name: /read the file again/i })).toBeDefined();
  });

  it('offers none of those for a document that was pasted', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    await openMenu('More actions for “Conventions”');
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /download the original/i })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /read the file again/i })).toBeNull();
  });

  it('re-reads the file on demand', async () => {
    apiMock.knowledge.extract.mockResolvedValue({ document: LEASE });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Bail — Résiliation');

    await openMenu('More actions for “Bail — Résiliation”');
    fireEvent.click(screen.getByRole('menuitem', { name: /read the file again/i }));

    await waitFor(() => expect(apiMock.knowledge.extract).toHaveBeenCalledWith('doc_2'));
  });

  it('does not serve the old text after the file has been read again', async () => {
    // The whole point of the viewer is checking a citation, so showing the
    // text from before a re-extraction — with its old line numbers — is the
    // exact failure the provenance work exists to prevent. React Query holds
    // a query fresh for fifteen seconds, which is long enough to re-extract
    // and reopen inside it.
    apiMock.knowledge.get.mockResolvedValue({
      document: { ...LEASE, content: 'Avant.' },
    });
    apiMock.knowledge.extract.mockResolvedValue({ document: LEASE });
    // Production's cache, not the test one: `createTestQueryClient` keeps
    // nothing fresh, so with it this test could not fail whatever the code did.
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />, {
      queryClient: new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
          mutations: { retry: false },
        },
      }),
    });
    await screen.findByText('Bail — Résiliation');

    fireEvent.click(screen.getByRole('button', { name: 'Bail — Résiliation' }));
    expect(await screen.findByText('Avant.')).toBeDefined();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Avant.')).toBeNull());

    apiMock.knowledge.get.mockResolvedValue({
      document: { ...LEASE, content: 'Après une nouvelle lecture.' },
    });
    await openMenu('More actions for “Bail — Résiliation”');
    fireEvent.click(screen.getByRole('menuitem', { name: /read the file again/i }));
    await waitFor(() => expect(apiMock.knowledge.extract).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Bail — Résiliation' }));

    expect(await screen.findByText('Après une nouvelle lecture.')).toBeDefined();
  });

  it('opens the viewer rather than an editor that could not change it', async () => {
    apiMock.knowledge.get.mockResolvedValue({
      document: { ...LEASE, content: 'Article 1.\nArticle 2.' },
    });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Bail — Résiliation' }));

    // The viewer, which shows the text with line numbers and the original.
    expect(await screen.findByRole('button', { name: /read the file again/i })).toBeDefined();
    expect(screen.getByText('Article 1.')).toBeDefined();
    expect(screen.queryByLabelText('Content')).toBeNull();
  });

  it('renames and re-aims it through a patch, never through a save', async () => {
    apiMock.knowledge.patch.mockResolvedValue({ document: LEASE });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Bail — Résiliation');

    await openMenu('More actions for “Bail — Résiliation”');
    fireEvent.click(screen.getByRole('menuitem', { name: /rename and re-aim/i }));

    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Bail 2026' } });
    fireEvent.click(screen.getByRole('button', { name: /save document/i }));

    await waitFor(() =>
      expect(apiMock.knowledge.patch).toHaveBeenCalledWith('doc_2', {
        title: 'Bail 2026',
        enabled: false,
        reach: { global: false, workspaceIds: ['ws_a'] },
      }),
    );
    expect(apiMock.knowledge.save).not.toHaveBeenCalled();
  });

  it('does not offer a text box for a file’s text, and says why', async () => {
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Bail — Résiliation');

    await openMenu('More actions for “Bail — Résiliation”');
    fireEvent.click(screen.getByRole('menuitem', { name: /rename and re-aim/i }));

    await screen.findByLabelText('Title');
    expect(screen.queryByLabelText('Content')).toBeNull();
    expect(screen.getByText(/read from a file/i)).toBeDefined();
  });
});

describe('the retrieval rehearsal', () => {
  it('shows each passage with its source, its location and its score', async () => {
    apiMock.knowledge.search.mockResolvedValue({
      results: [
        {
          chunkId: 'chk_1',
          documentId: 'doc_2',
          documentTitle: 'Bail',
          sourceName: 'bail.pdf',
          workspaceId: null,
          heading: 'Résiliation',
          text: 'Le préavis est de trois mois.',
          score: 0.87,
          pageUnit: 'page',
          pageStart: 2,
          pageEnd: 2,
          lineStart: 40,
          lineEnd: 52,
        },
      ],
    });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText('Rehearse a retrieval'), {
      target: { value: 'préavis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    expect(await screen.findByText('Bail › Résiliation')).toBeDefined();
    expect(screen.getByText('p. 2 · l. 40–52')).toBeDefined();
    expect(screen.getByText('0.870')).toBeDefined();
  });

  it('says plainly when a run would receive nothing', async () => {
    apiMock.knowledge.search.mockResolvedValue({ results: [] });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.change(screen.getByLabelText('Rehearse a retrieval'), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    expect(await screen.findByText(/no passages for this/i)).toBeDefined();
  });
});

describe('re-indexing', () => {
  it('offers the button only once there is something to re-index', async () => {
    apiMock.knowledge.list.mockResolvedValueOnce({ documents: [] });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Nothing on the shelf yet');
    expect(screen.queryByRole('button', { name: /re-index/i })).toBeNull();
  });

  it('re-embeds every passage on demand', async () => {
    apiMock.knowledge.reindex.mockResolvedValue({ affected: 7 });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Conventions');

    fireEvent.click(screen.getByRole('button', { name: /re-index/i }));

    await waitFor(() => expect(apiMock.knowledge.reindex).toHaveBeenCalled());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('7 passages re-embedded.'));
  });
});

describe('vectors pending', () => {
  it('marks a document whose chunks await the model, and only that one', async () => {
    apiMock.knowledge.list.mockResolvedValue({
      documents: [doc(), doc({ id: 'doc_3', title: 'Attente', embeddingModel: '' })],
    });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} />);
    await screen.findByText('Attente');
    expect(screen.getAllByText('Vectors pending')).toHaveLength(1);
  });

  it('marks every document not embedded with the live provider', async () => {
    apiMock.knowledge.list.mockResolvedValue({
      documents: [doc({ embeddingModel: 'hash-v1:512' }), doc({ id: 'doc_3', title: 'Autre' })],
    });
    renderWithProviders(<KnowledgeSection scope="all" workspaces={WORKSPACES} embedder="st:Xenova/bge-m3" />);
    await screen.findByText('Autre');
    expect(screen.getAllByText('Vectors pending')).toHaveLength(2);
  });
});
