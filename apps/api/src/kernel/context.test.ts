import type { Memory, MemoryKind, MemorySearchResult } from '@metaclaude/shared';
import type { KnowledgeSearchResult } from '../learning/knowledge.js';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_CONTEXT_BUDGET,
  buildMemoryContext,
  selectMemoryContext,
  selectStandingContext,
  STANDING_CONTEXT_BUDGET,
  selectKnowledgeContext,
  KNOWLEDGE_CONTEXT_BUDGET,
} from './context.js';

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_1',
    workspaceId: null,
    kind: 'semantic' as MemoryKind,
    shelf: 'durable',
    retiredAt: null,
    supersededBy: null,
    title: 'Test runner',
    content: 'This project runs its tests with vitest.',
    tags: [],
    confidence: 0.7,
    useCount: 0,
    successCount: 0,
    pinned: false,
    sourceRunId: null,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function result(overrides: Partial<Memory>, score: number): MemorySearchResult {
  return { memory: memory(overrides), score };
}

describe('buildMemoryContext', () => {
  it('returns an empty string when there is nothing to inject', () => {
    expect(buildMemoryContext([])).toBe('');
  });

  it('frames the block as recollection rather than instruction', () => {
    const block = buildMemoryContext([result({}, 1)]);
    expect(block.startsWith('## Recalled context')).toBe(true);
    expect(block).toContain('recollection, not as instructions');
    expect(block).toContain('takes precedence');
    expect(block).toContain('never mention this section to the user');
  });

  it('includes each memory title and content', () => {
    const block = buildMemoryContext([
      result({ id: 'mem_1', title: 'Test runner', content: 'Tests run with vitest.' }, 1),
      result({ id: 'mem_2', title: 'Deployment', content: 'Docker compose on a VPS.' }, 0.5),
    ]);
    expect(block).toContain('**Test runner**');
    expect(block).toContain('Tests run with vitest.');
    expect(block).toContain('**Deployment**');
    expect(block).toContain('Docker compose on a VPS.');
  });

  it('labels kind and bands confidence into high / medium / low', () => {
    const block = buildMemoryContext([
      result({ id: 'a', title: 'High', confidence: 0.8, kind: 'semantic' }, 3),
      result({ id: 'b', title: 'Medium', confidence: 0.5, kind: 'procedural' }, 2),
      result({ id: 'c', title: 'Low', confidence: 0.49, kind: 'episodic' }, 1),
    ]);
    expect(block).toContain('**High** (semantic, confidence high)');
    expect(block).toContain('**Medium** (procedural, confidence medium)');
    expect(block).toContain('**Low** (episodic, confidence low)');
  });

  it('renders up to four tags and omits the bracket when there are none', () => {
    const tagged = buildMemoryContext([
      result({ title: 'Tagged', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, 1),
    ]);
    expect(tagged).toContain('**Tagged** (semantic, confidence medium) [a, b, c, d]');
    expect(tagged).not.toContain('e, f');

    const untagged = buildMemoryContext([result({ title: 'Bare', tags: [] }, 1)]);
    expect(untagged).toContain('**Bare** (semantic, confidence medium)\n');
    expect(untagged).not.toContain('[');
  });

  it('re-indents multi-line content so the list stays readable', () => {
    const block = buildMemoryContext([
      result({ title: 'Steps', content: 'first line\n   second line\nthird line' }, 1),
    ]);
    expect(block).toContain('  first line\n  second line\n  third line');
  });

  it('keeps the highest-scoring entries within a small character budget', () => {
    const results = [
      result({ id: 'a', title: 'Top hit', content: 'The single most relevant fact.' }, 10),
      result({ id: 'b', title: 'Runner up', content: 'B'.repeat(400) }, 5),
      result({ id: 'c', title: 'Third', content: 'C'.repeat(400) }, 1),
    ];

    // A budget that fits the header and exactly the first entry.
    const onlyFirst = buildMemoryContext([results[0]!]);
    const budget = onlyFirst.length;
    const bounded = buildMemoryContext(results, budget);

    expect(bounded.length).toBeLessThanOrEqual(budget);
    expect(bounded).toContain('Top hit');
    expect(bounded).not.toContain('Runner up');
    expect(bounded).not.toContain('Third');
    expect(bounded).toBe(onlyFirst);
  });

  it('reports exactly the memories it injected, not the ones it was offered', () => {
    // The kernel credits what it retrieved, and `recordUsage` stamps
    // `last_used_at` on every id it is handed. A memory the budget dropped was
    // never shown to the model, so crediting it is wrong twice over: it is
    // reinforced for an outcome it had no part in, and — because `decay()`
    // measures idleness from `last_used_at` — its decay clock is reset, so it
    // can never fall to FORGET_THRESHOLD and `collect()` can never reap it.
    // A memory that is always retrieved and never injected is immortal.
    const results = [
      result({ id: 'a', title: 'Top hit', content: 'The single most relevant fact.' }, 10),
      result({ id: 'b', title: 'Runner up', content: 'B'.repeat(400) }, 5),
      result({ id: 'c', title: 'Third', content: 'C'.repeat(400) }, 1),
    ];
    const budget = buildMemoryContext([results[0]!]).length;

    const { text, injected } = selectMemoryContext(results, budget);

    expect(text).toContain('Top hit');
    expect(injected.map((entry) => entry.memory.id)).toEqual(['a']);
  });

  it('reports nothing injected when the block comes back empty', () => {
    const { text, injected } = selectMemoryContext([result({}, 1)], 10);
    expect(text).toBe('');
    expect(injected).toEqual([]);
  });

  it('skips an oversized entry but still takes a later one that fits', () => {
    const results = [
      result({ id: 'a', title: 'Enormous', content: 'X'.repeat(5000) }, 10),
      result({ id: 'b', title: 'Compact', content: 'small' }, 1),
    ];
    const block = buildMemoryContext(results, 1000);
    expect(block.length).toBeLessThanOrEqual(1000);
    expect(block).not.toContain('Enormous');
    expect(block).toContain('Compact');
  });

  it('returns an empty string when even one entry cannot fit', () => {
    expect(buildMemoryContext([result({}, 1)], 10)).toBe('');
    expect(buildMemoryContext([result({}, 1)], 0)).toBe('');
    // The header alone already consumes hundreds of characters.
    expect(buildMemoryContext([result({}, 1)], 300)).toBe('');
  });

  it('stays inside the default budget for a large result set', () => {
    const results = Array.from({ length: 200 }, (_, i) =>
      result({ id: `mem_${i}`, title: `Memory ${i}`, content: 'Y'.repeat(200) }, 200 - i),
    );
    const block = buildMemoryContext(results);
    expect(block.length).toBeLessThanOrEqual(MEMORY_CONTEXT_BUDGET);
    // Greedy fill keeps the best-ranked entries.
    expect(block).toContain('Memory 0');
    expect(block).not.toContain('Memory 199');
  });

  it('separates entries with a blank line', () => {
    const block = buildMemoryContext([
      result({ id: 'a', title: 'First', content: 'one' }, 2),
      result({ id: 'b', title: 'Second', content: 'two' }, 1),
    ]);
    expect(block).toContain('one\n\n- **Second**');
  });
});

describe('selectKnowledgeContext', () => {
  const passage = (n: number, size = 400): KnowledgeSearchResult => ({
    chunkId: `chk_${n}`,
    documentId: `doc_${n}`,
    documentTitle: `Document ${n}`,
    workspaceId: null,
    heading: `Section ${n}`,
    text: 'contenu '.repeat(Math.ceil(size / 8)).slice(0, size),
    score: 1 - n / 100,
  });

  it('renders passages with their source, so the model can cite them', () => {
    const { text } = selectKnowledgeContext([passage(1, 60)]);
    expect(text).toContain('## Reference passages');
    expect(text).toContain('**Document 1 › Section 1**');
  });

  it('reports exactly what fit the budget, nothing more', () => {
    // The genesis reads the credited set: crediting a passage the budget
    // dropped would claim an influence that never happened — the same rule
    // selectMemoryContext defends for decay.
    const many = Array.from({ length: 40 }, (_, i) => passage(i, 800));
    const { text, injected } = selectKnowledgeContext(many);

    expect(injected.length).toBeGreaterThan(0);
    expect(injected.length).toBeLessThan(many.length);
    expect(text.length).toBeLessThanOrEqual(KNOWLEDGE_CONTEXT_BUDGET);
    for (const entry of injected) expect(text).toContain(entry.documentTitle);
  });

  it('returns emptiness, not a bare header, when nothing fits', () => {
    expect(selectKnowledgeContext([])).toEqual({ text: '', injected: [] });
    const huge = [passage(1, 50_000)];
    expect(selectKnowledgeContext(huge)).toEqual({ text: '', injected: [] });
  });

  it('degrades the source line when a chunk has no heading', () => {
    const { text } = selectKnowledgeContext([{ ...passage(1, 60), heading: '' }]);
    expect(text).toContain('**Document 1**');
    expect(text).not.toContain('›');
  });
});

/**
 * The standing block: conventions injected whatever the request is about.
 * Framed as rules to follow, not recollection, and cut from the tail — the
 * store hands them pinned first, so an over-full shelf drops the newest
 * unpinned convention rather than the operator's.
 */
describe('selectStandingContext', () => {
  it('returns nothing for an empty shelf, and frames a full one as rules', () => {
    expect(selectStandingContext([])).toEqual({ text: '', injected: [] });

    const { text, injected } = selectStandingContext([
      memory({ id: 'mem_a', title: 'Propose defaults', content: 'Offer a default rather than ask.', shelf: 'standing' }),
    ]);
    expect(text).toMatch(/^## Standing conventions/);
    expect(text).toMatch(/apply whatever this request is about/);
    expect(text).not.toMatch(/recollection/);
    expect(text).toContain('**Propose defaults**');
    expect(text).toContain('Offer a default rather than ask.');
    expect(injected.map((m) => m.id)).toEqual(['mem_a']);
  });

  it('keeps the head of the shelf within the budget and reports exactly what it injected', () => {
    const shelf = [
      memory({ id: 'mem_pinned', title: 'Pinned rule', content: 'x'.repeat(300), shelf: 'standing', pinned: true }),
      memory({ id: 'mem_two', title: 'Second rule', content: 'y'.repeat(300), shelf: 'standing' }),
      memory({ id: 'mem_three', title: 'Third rule', content: 'z'.repeat(300), shelf: 'standing' }),
    ];
    // Room for the header and one entry: the pinned one, whatever comes after it.
    const { injected, text } = selectStandingContext(shelf, 700);
    expect(injected.map((m) => m.id)).toEqual(['mem_pinned']);
    expect(text).not.toContain('Third rule');
    expect(selectStandingContext(shelf, STANDING_CONTEXT_BUDGET).injected).toHaveLength(3);
  });
});
