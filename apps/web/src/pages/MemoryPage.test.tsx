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

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { MemoryPage } from './MemoryPage';

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
    setInsightStatus: vi.fn(),
    synthesiseSkill: vi.fn(),
    installSkillFromInsight: vi.fn(),
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
  sourceRunId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  lastUsedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspaces.mockResolvedValue({ workspaces: [] });
  apiMock.memory.mockResolvedValue({ memories: [memory('mem_1', 'Préavis de résiliation')] });
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
