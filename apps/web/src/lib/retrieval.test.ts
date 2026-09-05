/**
 * "Semantic" is claimed in exactly one place, and only when it is true.
 */

import { describe, expect, it } from 'vitest';
import type { RetrievalStatus } from '@metaclaude/shared';
import { describeRetrieval, RETRIEVAL_COPY, shortModelName } from './retrieval';

const status = (patch: Partial<RetrievalStatus> = {}): RetrievalStatus => ({
  embedder: 'st:Xenova/bge-m3',
  family: 'st',
  state: 'ready',
  semantic: true,
  pending: { memories: 0, documents: 0, exemplars: 0 },
  ...patch,
});

describe('describeRetrieval', () => {
  it('calls a loaded sentence-transformer semantic, and nothing else', () => {
    expect(describeRetrieval(status())).toMatchObject({ label: RETRIEVAL_COPY.semantic.label, tone: 'success', model: 'bge-m3', attention: false, semantic: true });
    expect(describeRetrieval(status({ state: 'loading', semantic: false }))).toMatchObject({ label: RETRIEVAL_COPY.loading.label, tone: 'thinking', attention: true });
    expect(describeRetrieval(status({ state: 'lexical-only', semantic: false }))).toMatchObject({ label: RETRIEVAL_COPY.unavailable.label, tone: 'warning', attention: true });
    expect(describeRetrieval(status({ embedder: 'hash-v1:512', family: 'hash', semantic: false }))).toMatchObject({ label: RETRIEVAL_COPY.words.label, tone: 'neutral', model: 'hash', attention: false, semantic: false });
    // Loading is not semantic yet, whatever the family says.
    expect(describeRetrieval(status({ state: 'loading', semantic: false })).semantic).toBe(false);
  });

  it('counts every store’s pending rows together, and asks for attention when any wait', () => {
    const view = describeRetrieval(status({ pending: { memories: 2, documents: 1, exemplars: 3 } }));

    expect(view.pending).toBe(6);
    expect(view.attention).toBe(true);
  });

  it('answers something neutral before the server has said anything', () => {
    expect(describeRetrieval(undefined)).toMatchObject({ label: RETRIEVAL_COPY.unknown.label, tone: 'neutral', model: '', pending: 0, attention: false });
  });
});

describe('shortModelName', () => {
  it('drops the family prefix and the publisher', () => {
    expect(shortModelName('st:Xenova/bge-m3')).toBe('bge-m3');
    expect(shortModelName('st:local-model')).toBe('local-model');
    expect(shortModelName('hash-v1:512')).toBe('hash');
  });
});
