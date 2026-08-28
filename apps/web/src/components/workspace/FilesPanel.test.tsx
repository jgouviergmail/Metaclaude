/**
 * The workspace file browser and its editor.
 *
 * Two guards here protect things that cannot be undone from the interface.
 * A *truncated* file must never be savable — writing the visible half back
 * would silently discard the rest — and the name filter must not fire a
 * recursive server-side walk on every keystroke. Both are one boolean away
 * from being wrong, and neither is visible in the rendered output.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { FilesPanel } from './FilesPanel';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    files: vi.fn(),
    searchFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// CodeMirror needs layout jsdom does not perform; the editor's *rules* are
// what this file tests, not its rendering.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea aria-label="File contents" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }));

const entry = (name: string, type: 'file' | 'directory' = 'file') => ({
  name,
  path: name,
  type,
  size: 128,
  modifiedAt: 1_700_000_000_000,
});

const openFile = async (name: string) => {
  // The row is a <button> wrapping the name; click the control, not the text.
  const row = (await screen.findByText(name)).closest('button') as HTMLButtonElement;
  fireEvent.click(row);
  return screen.findByLabelText('File contents');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiMock.files.mockResolvedValue({
    entries: [entry('bail.md'), entry('notes.txt'), entry('src', 'directory')],
  });
  apiMock.searchFiles.mockResolvedValue({ entries: [] });
  apiMock.readFile.mockResolvedValue({
    content: 'Le préavis est de trois mois.',
    language: 'markdown',
    truncated: false,
  });
  apiMock.writeFile.mockResolvedValue({});
});

afterEach(() => vi.useRealTimers());

describe('browsing', () => {
  it('lists the folder it was pointed at', async () => {
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    expect(await screen.findByText('bail.md')).toBeDefined();
    expect(screen.getByText('src')).toBeDefined();
  });

  it('says when a folder is empty rather than showing nothing', async () => {
    apiMock.files.mockResolvedValue({ entries: [] });
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    expect(await screen.findByText('This folder is empty')).toBeDefined();
  });

  it('says when a folder cannot be read', async () => {
    apiMock.files.mockRejectedValue(new Error('EACCES'));
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    expect(await screen.findByText('This folder could not be read')).toBeDefined();
  });

  it('closes on demand', async () => {
    const onClose = vi.fn();
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close files' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the name filter', () => {
  it('waits for a pause before spending a recursive walk', async () => {
    // Every keystroke firing a server-side tree walk is the difference
    // between a filter and a denial of service against your own box.
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    const input = await screen.findByLabelText('Find a file by name');

    fireEvent.change(input, { target: { value: 'ba' } });
    fireEvent.change(input, { target: { value: 'bai' } });
    fireEvent.change(input, { target: { value: 'bail' } });
    expect(apiMock.searchFiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(apiMock.searchFiles).toHaveBeenCalledTimes(1));
    expect(apiMock.searchFiles).toHaveBeenCalledWith('ws_a', 'bail');
  });

  it('does not search on a single character', async () => {
    // One letter matches most of a tree; the walk is not worth it.
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Find a file by name'), {
      target: { value: 'b' },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(apiMock.searchFiles).not.toHaveBeenCalled();
  });
});

describe('the editor', () => {
  it('opens a markdown file as a note first, not as source', async () => {
    // A note is something to read; dropping straight into a text editor for
    // it is the wrong default, and switching is one click away.
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    const row = (await screen.findByText('bail.md')).closest('button') as HTMLButtonElement;
    fireEvent.click(row);

    await waitFor(() => expect(apiMock.readFile).toHaveBeenCalledWith('ws_a', 'bail.md'));
    expect(screen.queryByLabelText('File contents')).toBeNull();
  });

  it('shows what the file holds', async () => {
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    const editor = await openFile('notes.txt');
    expect((editor as HTMLTextAreaElement).value).toBe('Le préavis est de trois mois.');
  });

  it('cannot save until something changed', async () => {
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    await openFile('notes.txt');
    expect(screen.getByRole('button', { name: /Save/ })).toHaveProperty('disabled', true);
  });

  it('saves the edited text', async () => {
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    const editor = await openFile('notes.txt');

    fireEvent.change(editor, { target: { value: "Le préavis est d'un mois." } });
    const save = screen.getByRole('button', { name: /Save/ });
    expect(save).toHaveProperty('disabled', false);

    fireEvent.click(save);
    await waitFor(() =>
      expect(apiMock.writeFile).toHaveBeenCalledWith('ws_a', 'notes.txt', "Le préavis est d'un mois."),
    );
  });

  it('refuses to save a truncated file, however edited', async () => {
    // The panel only received part of the file. Writing that back would
    // discard everything past the cut, with no way to notice from here.
    apiMock.readFile.mockResolvedValue({
      content: 'first half…',
      language: 'markdown',
      truncated: true,
    });
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    const editor = await openFile('notes.txt');

    fireEvent.change(editor, { target: { value: 'first half… edited' } });
    expect(screen.getByRole('button', { name: /Save/ })).toHaveProperty('disabled', true);
  });

  it('swallows the browser’s save dialog even when it will not save', async () => {
    // ⌘S over an editor is never aimed at "save this web page", so the
    // shortcut is intercepted whether or not there is anything to write.
    apiMock.readFile.mockResolvedValue({ content: 'x', language: null, truncated: true });
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    await openFile('notes.txt');

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(apiMock.writeFile).not.toHaveBeenCalled();
  });

  it('writes on ⌘S when there is something to write', async () => {
    renderWithProviders(<FilesPanel workspaceId="ws_a" onClose={vi.fn()} />);
    const editor = await openFile('notes.txt');
    fireEvent.change(editor, { target: { value: 'modifié' } });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
    await waitFor(() => expect(apiMock.writeFile).toHaveBeenCalledWith('ws_a', 'notes.txt', 'modifié'));
  });
});
