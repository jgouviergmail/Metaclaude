/**
 * Dropping files into the library.
 *
 * What is under test is the part an operator lives with: that a refusal stays
 * legible, that a big file is refused before it is read, and that the queue is
 * a queue rather than three uploads racing.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionReach, KnowledgeDocumentMeta } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';
import { KnowledgeUploadZone } from './KnowledgeUploadZone';

const { apiMock, ApiErrorMock } = vi.hoisted(() => {
  // Declared inside `vi.hoisted`: a class defined beside `vi.mock` is in its
  // temporal dead zone when the hoisted factory runs.
  class ApiErrorMock extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiErrorMock,
    apiMock: { knowledge: { upload: vi.fn() } },
  };
});

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }));

const GLOBAL: ExtensionReach = { global: true, workspaceIds: [] };

const document_ = (over: Partial<KnowledgeDocumentMeta> = {}): KnowledgeDocumentMeta =>
  ({
    id: 'doc_1',
    workspaceId: null,
    title: 'bail',
    contentLength: 1024,
    enabled: true,
    chunkCount: 3,
    embeddingModel: 'hash-v1:512',
    isGlobal: true,
    workspaceIds: [],
    source: { name: 'bail.docx', mime: 'text/plain', bytes: 10, extractor: 'docx@1' },
    pageUnit: null,
    pageCount: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as KnowledgeDocumentMeta;

/** A File whose `size` is whatever the test needs, without allocating it. */
function file(name: string, { size = 10, type = '' } = {}): File {
  const made = new File(['x'], name, { type });
  Object.defineProperty(made, 'size', { value: size });
  Object.defineProperty(made, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  return made;
}

/** The drop zone itself, found from the input it contains. */
const drop = (files: File[]): void => {
  const zone = screen.getByLabelText(/choose files/i).closest('div')!;
  fireEvent.drop(zone, { dataTransfer: { files } });
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.knowledge.upload.mockResolvedValue({ document: document_() });
});

describe('the drop zone', () => {
  it('uploads a dropped file with the reach it was given', async () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('bail.docx')]);

    await waitFor(() =>
      expect(apiMock.knowledge.upload).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'bail.docx', reach: GLOBAL }),
      ),
    );
  });

  it('passes the workspace reach through unchanged', async () => {
    const scoped: ExtensionReach = { global: false, workspaceIds: ['ws_a'] };
    renderWithProviders(<KnowledgeUploadZone reach={scoped} onUploaded={vi.fn()} />);

    drop([file('note.md')]);

    await waitFor(() =>
      expect(apiMock.knowledge.upload).toHaveBeenCalledWith(
        expect.objectContaining({ reach: scoped }),
      ),
    );
  });

  it('tells the caller about each document, so the list can refresh', async () => {
    const onUploaded = vi.fn();
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={onUploaded} />);

    drop([file('bail.docx')]);

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(document_()));
  });

  it('says how many passages were indexed, which is the useful confirmation', async () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('bail.docx')]);

    expect(await screen.findByText('3 passages indexed')).toBeDefined();
  });

  it('uploads one file at a time, rather than three at once', async () => {
    // A queue an operator can read, and a server that extracts one file per
    // worker thread on a two-core host.
    let resolveFirst: (value: unknown) => void = () => undefined;
    apiMock.knowledge.upload
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue({ document: document_() });

    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);
    drop([file('a.md'), file('b.md')]);

    await waitFor(() => expect(apiMock.knowledge.upload).toHaveBeenCalledTimes(1));
    // Both are listed as queued while only one is in flight.
    expect(screen.getAllByText('Uploading…')).toHaveLength(2);

    resolveFirst({ document: document_() });
    await waitFor(() => expect(apiMock.knowledge.upload).toHaveBeenCalledTimes(2));
  });

  it('holds a second drop behind the upload already running', async () => {
    // The case above sequences the files of one drop and says nothing about
    // this one: a twenty-megabyte PDF takes long enough that dropping the
    // next file before it lands is ordinary, and each drop started a loop of
    // its own. Two uploads then ran at once — against a promise made at the
    // top of the file — and whichever finished first declared the queue idle,
    // which is what puts "Clear the list" under a row still in flight.
    let resolveFirst: (value: unknown) => void = () => undefined;
    apiMock.knowledge.upload
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValue({ document: document_() });

    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);
    drop([file('a.md')]);
    await waitFor(() => expect(apiMock.knowledge.upload).toHaveBeenCalledTimes(1));

    drop([file('b.md')]);
    // Waited on the row appearing, a thing that happens, rather than on the
    // second call *not* happening — an expectation any first poll satisfies.
    await screen.findByText('b.md');
    expect(apiMock.knowledge.upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/clear the list/i)).toBeNull();

    resolveFirst({ document: document_() });
    await waitFor(() => expect(apiMock.knowledge.upload).toHaveBeenCalledTimes(2));
  });

  it('gives the picker link a hit area a thumb can find', async () => {
    // Measured by `check:responsive` in a real browser, in both languages:
    // "choose them 72x16 offers 16" and "choisissez-les 79x16 offers 16",
    // against a floor of 32. It is a link inside a sentence, so it is as tall
    // as its line and no more — the case `TOUCH_TARGET_TEXT` exists for, and
    // the same one the dashboard's "Settings → System" link failed at. Only a
    // browser can measure it, so what a test here can hold is the class that
    // asks for it, which is the difference between a fix and a coincidence.
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);
    const link = screen.getByRole('button', { name: /choose them/i });
    expect(link.className).toContain('before:-inset-y-2.5');
  });

  it('refuses a file larger than the cap without sending it', async () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('film.pdf', { size: 25 * 1024 * 1024 })]);

    expect(await screen.findByText(/larger than/i)).toBeDefined();
    expect(apiMock.knowledge.upload).not.toHaveBeenCalled();
  });

  it('refuses a type the library does not read, without sending it', async () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('archive.zip', { type: 'application/zip' })]);

    expect(await screen.findByText(/not read/i)).toBeDefined();
    expect(apiMock.knowledge.upload).not.toHaveBeenCalled();
  });

  it('accepts a file whose browser sent no type at all', async () => {
    // Measured in the attachments: several platforms hand over an empty type
    // for a drag-dropped .md, and refusing it here would be inexplicable.
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('notes.md', { type: '' })]);

    await waitFor(() => expect(apiMock.knowledge.upload).toHaveBeenCalled());
  });

  it('keeps the server’s own sentence on screen instead of a generic toast', async () => {
    // "This PDF is a scan" is the useful half; a toast is gone before it has
    // been read, and a generic message throws the diagnosis away.
    apiMock.knowledge.upload.mockRejectedValueOnce(
      new ApiErrorMock(422, 'This PDF has no text layer — it is a scan.'),
    );
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('scan.pdf', { type: 'application/pdf' })]);

    expect(await screen.findByText(/no text layer/i)).toBeDefined();
  });

  it('carries on with the next file after one is refused', async () => {
    apiMock.knowledge.upload
      .mockRejectedValueOnce(new ApiErrorMock(409, 'Already in the library.'))
      .mockResolvedValue({ document: document_() });
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);

    drop([file('a.md'), file('b.md')]);

    expect(await screen.findByText('Already in the library.')).toBeDefined();
    expect(await screen.findByText('3 passages indexed')).toBeDefined();
  });

  it('lets a finished line be dismissed', async () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);
    drop([file('bail.docx')]);
    await screen.findByText('3 passages indexed');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss “bail.docx”' }));

    await waitFor(() => expect(screen.queryByText('3 passages indexed')).toBeNull());
  });

  it('names the accepted types and the cap, so the rule is visible before the refusal', () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);
    const hint = screen.getByText(/\.pdf/);
    expect(hint.textContent).toContain('.docx');
    expect(hint.textContent).toContain('.pptx');
    expect(hint.textContent).toMatch(/20/);
  });

  it('gives the file input an accessible name and the accepted types', () => {
    renderWithProviders(<KnowledgeUploadZone reach={GLOBAL} onUploaded={vi.fn()} />);
    const input = screen.getByLabelText(/choose files/i) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain('application/pdf');
    expect(input.accept).toContain('.pptx');
  });
});
