import type { Memory, MemoryKind, MemorySearchResult } from '@metaclaude/shared';
import { describe, expect, it } from 'vitest';
import { MEMORY_CONTEXT_BUDGET, buildMemoryContext, composeSystemAppend } from './context.js';

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_1',
    workspaceId: null,
    kind: 'semantic' as MemoryKind,
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

describe('composeSystemAppend', () => {
  it('joins both parts with a horizontal rule, conventions first', () => {
    const composed = composeSystemAppend({
      workspaceInstructions: 'Always use pnpm.',
      memoryBlock: '## Recalled context\n\n- **X** something',
    });
    expect(composed).toBe('Always use pnpm.\n\n---\n\n## Recalled context\n\n- **X** something');
    expect(composed.indexOf('Always use pnpm.')).toBeLessThan(composed.indexOf('Recalled context'));
  });

  it('omits an empty part along with its separator', () => {
    expect(
      composeSystemAppend({ workspaceInstructions: 'Only this.', memoryBlock: '' }),
    ).toBe('Only this.');
    expect(
      composeSystemAppend({ workspaceInstructions: '', memoryBlock: 'Only memory.' }),
    ).toBe('Only memory.');
    expect(composeSystemAppend({ workspaceInstructions: '   ', memoryBlock: '\n\n' })).toBe('');
    expect(composeSystemAppend({ workspaceInstructions: '', memoryBlock: '' })).toBe('');
  });

  it('trims each part before joining', () => {
    expect(
      composeSystemAppend({ workspaceInstructions: '  a  \n', memoryBlock: '\n  b  ' }),
    ).toBe('a\n\n---\n\nb');
  });

  it('composes cleanly with a real memory block', () => {
    const memoryBlock = buildMemoryContext([result({ title: 'Runner', content: 'vitest' }, 1)]);
    const composed = composeSystemAppend({
      workspaceInstructions: 'Prefer TypeScript.',
      memoryBlock,
    });
    expect(composed.startsWith('Prefer TypeScript.\n\n---\n\n## Recalled context')).toBe(true);
    expect(composed).toContain('**Runner**');
  });
});
