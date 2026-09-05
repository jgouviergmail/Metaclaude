/**
 * The badge says what retrieval is; the detail says why; the count says
 * what waits. Four states, one component.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RetrievalStatus as Value } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { RetrievalStatus } from './RetrievalStatus';

const status = (patch: Partial<Value> = {}): Value => ({
  embedder: 'st:Xenova/bge-m3',
  family: 'st',
  state: 'ready',
  semantic: true,
  pending: { memories: 0, documents: 0, exemplars: 0 },
  ...patch,
});

describe('RetrievalStatus', () => {
  it('shows a loaded model as semantic, with its short name and the sentence', () => {
    renderWithProviders(<RetrievalStatus status={status()} />);

    expect(screen.getByText('Semantic')).toBeDefined();
    expect(screen.getByText('bge-m3')).toBeDefined();
    expect(screen.getByText(/matches meaning/)).toBeDefined();
  });

  it('says words only for the hashing embedder, and unavailable when the model did not load', () => {
    const { unmount } = renderWithProviders(<RetrievalStatus status={status({ embedder: 'hash-v1:512', family: 'hash', semantic: false })} />);
    expect(screen.getByText('Words only')).toBeDefined();
    unmount();

    renderWithProviders(<RetrievalStatus status={status({ state: 'lexical-only', semantic: false })} />);
    expect(screen.getByText('Model unavailable')).toBeDefined();
    expect(screen.getByText(/did not load/)).toBeDefined();
  });

  it('counts the vectors still waiting, in the plural', () => {
    renderWithProviders(<RetrievalStatus status={status({ state: 'loading', semantic: false, pending: { memories: 2, documents: 1, exemplars: 0 } })} />);

    expect(screen.getByText('Model loading')).toBeDefined();
    expect(screen.getByText(/3 vectors are waiting/)).toBeDefined();
  });

  it('keeps to the badge and the model when compact', () => {
    renderWithProviders(<RetrievalStatus status={status()} compact />);

    expect(screen.getByText('Semantic')).toBeDefined();
    expect(screen.queryByText(/matches meaning/)).toBeNull();
  });
});
