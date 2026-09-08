/**
 * Reading a document at the line a run quoted.
 *
 * The editor cannot serve for this: a file-backed document's text is what its
 * extractor produced, and the point of opening it is to *check* a citation —
 * which means seeing the line and its neighbours.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';
import { KnowledgeViewer } from './KnowledgeViewer';

const { apiMock, toastMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {}
  return {
    ApiErrorMock,
    toastMock: { success: vi.fn(), error: vi.fn() },
    apiMock: {
      knowledge: {
        get: vi.fn(),
        extract: vi.fn(),
        sourceUrl: (id: string) => `/api/knowledge/${id}/source`,
      },
    },
  };
});

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }));
vi.mock('sonner', () => ({ toast: toastMock }));

const LINES = ['Article 1 — Objet.', 'Le présent contrat.', 'Article 2 — Durée.', 'Trois ans.'];

const document_ = (over: Record<string, unknown> = {}) => ({
  id: 'doc_1',
  workspaceId: null,
  title: 'Bail',
  content: LINES.join('\n'),
  contentLength: 64,
  enabled: true,
  chunkCount: 2,
  embeddingModel: 'hash-v1:512',
  isGlobal: true,
  workspaceIds: [],
  source: {
    name: 'bail.pdf',
    mime: 'application/pdf',
    bytes: 4096,
    extractor: 'pdf@poppler-22.12.0',
  },
  pageUnit: 'page',
  pageCount: 3,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.knowledge.get.mockResolvedValue({ document: document_() });
  // happy-dom does not implement it, and the effect calls it on the cited line.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('the viewer', () => {
  it('numbers every line of the document', async () => {
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );

    expect(await screen.findByText('Article 1 — Objet.')).toBeDefined();
    expect(screen.getByText('Trois ans.')).toBeDefined();
    // The line numbers themselves, which are what a citation names.
    expect(screen.getByText('4')).toBeDefined();
  });

  it('brings the cited line into view', async () => {
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" line={3} onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText('Article 2 — Durée.');

    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('fetches nothing while it is closed', () => {
    renderWithProviders(
      <KnowledgeViewer documentId={null} onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );
    expect(apiMock.knowledge.get).not.toHaveBeenCalled();
  });

  it('says what the document is made of, and which engine read it', async () => {
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText('Article 1 — Objet.');

    expect(screen.getByText('PDF')).toBeDefined();
    expect(screen.getByText('bail.pdf')).toBeDefined();
    expect(screen.getByText('pdf@poppler-22.12.0')).toBeDefined();
    expect(screen.getByText(/3 pages/)).toBeDefined();
  });

  it('offers the original as a download the browser performs itself', async () => {
    // A link, not a fetch: a twenty-megabyte file must not pass through this
    // process's memory to be saved.
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText('Article 1 — Objet.');

    const link = screen.getByRole('link', { name: /download the original/i });
    expect(link.getAttribute('href')).toBe('/api/knowledge/doc_1/source');
    expect(link.getAttribute('download')).toBe('bail.pdf');
  });

  it('reads the file again on demand, and says what came back', async () => {
    apiMock.knowledge.extract.mockResolvedValue({
      document: document_({ chunkCount: 5, source: { ...document_().source, extractor: 'pdf@pdfjs' } }),
    });
    const onChanged = vi.fn();
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" onOpenChange={vi.fn()} onChanged={onChanged} />,
    );
    await screen.findByText('Article 1 — Objet.');

    fireEvent.click(screen.getByRole('button', { name: /read the file again/i }));

    await waitFor(() => expect(apiMock.knowledge.extract).toHaveBeenCalledWith('doc_1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith(
      'Read again with pdf@pdfjs',
      expect.objectContaining({ description: '5 passages indexed' }),
    );
  });

  it('keeps the failure on screen rather than swallowing it', async () => {
    apiMock.knowledge.extract.mockRejectedValue(new ApiErrorMock('The original file is missing.'));
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText('Article 1 — Objet.');

    fireEvent.click(screen.getByRole('button', { name: /read the file again/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('The original file is missing.'),
    );
  });

  it('offers neither download nor re-read for a document that was pasted', async () => {
    apiMock.knowledge.get.mockResolvedValue({
      document: document_({ source: null, pageUnit: null, pageCount: null }),
    });
    renderWithProviders(
      <KnowledgeViewer documentId="doc_1" onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText('Article 1 — Objet.');

    expect(screen.queryByRole('link', { name: /download the original/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /read the file again/i })).toBeNull();
  });

  it('says plainly when a document cannot be opened', async () => {
    // A deep link to a document somebody has since deleted.
    apiMock.knowledge.get.mockResolvedValue({ document: undefined });
    renderWithProviders(
      <KnowledgeViewer documentId="doc_gone" onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    );

    expect(await screen.findByText(/could not be opened/i)).toBeDefined();
  });
});
