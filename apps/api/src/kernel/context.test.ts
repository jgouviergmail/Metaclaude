import type { Memory, MemoryKind, MemorySearchResult, Workspace } from '@metaclaude/shared';
import { WorkspaceSettings } from '@metaclaude/shared';
import type { KnowledgeSearchResult } from '../learning/knowledge.js';
import { searchHit } from '../test/knowledge.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../db/index.js';
import { WorkspaceRepo } from './repositories.js';
import {
  MEMORY_CONTEXT_BUDGET,
  buildMemoryContext,
  delegationPeers,
  DIRECTORY_CONTEXT_BUDGET,
  DIRECTORY_CONTEXT_MINIMUM,
  selectDirectoryContext,
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
  const passage = (n: number, size = 400): KnowledgeSearchResult =>
    searchHit({
      chunkId: `chk_${n}`,
      documentId: `doc_${n}`,
      documentTitle: `Document ${n}`,
      heading: `Section ${n}`,
      text: 'contenu '.repeat(Math.ceil(size / 8)).slice(0, size),
      score: 1 - n / 100,
    });

  it('renders passages with their source, so the model can cite them', () => {
    const { text } = selectKnowledgeContext([passage(1, 60)]);
    expect(text).toContain('## Reference passages');
    expect(text).toContain('**Document 1 › Section 1**');
  });

  it('gives a located passage its page and lines, and asks for them in the citation', () => {
    // The whole point of the locations: a quotation from a forty-page PDF
    // that cannot say where it came from is a quotation nobody can check.
    const { text } = selectKnowledgeContext([
      searchHit({
        documentTitle: 'Bail',
        heading: 'Résiliation',
        text: 'Trois mois.',
        pageUnit: 'page',
        pageStart: 2,
        pageEnd: 2,
        lineStart: 40,
        lineEnd: 52,
      }),
    ]);
    expect(text).toContain('**Bail › Résiliation** (page 2, lines 40–52)');
    expect(text).toContain('page and lines');
  });

  it('says nothing about a location a passage does not have', () => {
    // Passages indexed before the library recorded offsets carry none, and a
    // pasted document has no pages. The sentence gets shorter, never wrong.
    const { text } = selectKnowledgeContext([
      searchHit({ documentTitle: 'Note', heading: '', text: 'Du texte.' }),
    ]);
    // On the rendered line, not on the whole block: the header names the
    // locator in its instruction, parentheses and all.
    const line = text.split('\n').find((one) => one.startsWith('- '))!;
    expect(line).toBe('- **Note**');
  });

  it('counts the locator against the budget, because it is part of the block', () => {
    const located = Array.from({ length: 40 }, (_, i) =>
      searchHit({
        chunkId: `chk_${i}`,
        documentId: `doc_${i}`,
        documentTitle: `Document ${i}`,
        heading: `Section ${i}`,
        text: 'contenu '.repeat(100),
        pageUnit: 'page',
        pageStart: i + 1,
        pageEnd: i + 1,
        lineStart: i * 10,
        lineEnd: i * 10 + 9,
      }),
    );
    const { text } = selectKnowledgeContext(located);
    expect(text.length).toBeLessThanOrEqual(KNOWLEDGE_CONTEXT_BUDGET);
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

/* -------------------------------------------------------------------------- */
/* The peer directory                                                          */
/* -------------------------------------------------------------------------- */

function peer(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: `ws_${overrides.slug ?? 'x'}`,
    name: 'A project',
    slug: 'a-project',
    description: 'The public site.',
    path: '/srv/metaclaude/workspaces/a-project',
    color: '#6366f1',
    icon: 'folder',
    archived: false,
    settings: WorkspaceSettings.parse({}),
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A workspace that declined to be consulted by other workspaces' agents. */
const optedOut = (overrides: Partial<Workspace> = {}) =>
  peer({ ...overrides, settings: WorkspaceSettings.parse({ delegable: false }) });

describe('delegationPeers', () => {
  it('leaves out the workspace doing the asking', () => {
    const self = peer({ id: 'ws_self', slug: 'self' });
    const other = peer({ id: 'ws_other', slug: 'other' });

    expect(delegationPeers([self, other], 'ws_self').map((one) => one.slug)).toEqual(['other']);
  });

  it('leaves out an archived workspace', () => {
    const live = peer({ id: 'ws_live', slug: 'live' });
    const gone = peer({ id: 'ws_gone', slug: 'gone', archived: true });

    expect(delegationPeers([live, gone], 'ws_self').map((one) => one.slug)).toEqual(['live']);
  });

  it('leaves out a workspace that declined to be consulted', () => {
    const open = peer({ id: 'ws_open', slug: 'open' });
    const closed = optedOut({ id: 'ws_closed', slug: 'closed' });

    expect(delegationPeers([open, closed], 'ws_self').map((one) => one.slug)).toEqual(['open']);
  });

  /**
   * The order is the directory's own, not the caller's.
   *
   * `WorkspaceRepo.list` orders by `updated_at DESC`, which is neither total —
   * several workspaces can share a millisecond — nor stable: touching any one
   * of them reorders the list. The budget degrades the tail, so an unstable
   * order would change what the directory says from one run to the next with
   * no cause the operator can see. Same family as the audit chain's `rowid`.
   * Slugs are `[a-z0-9-]` by schema, so a plain comparison is already a total
   * order and, unlike `localeCompare`, does not depend on the runtime's ICU.
   */
  it('orders by slug whatever order it was handed', () => {
    const listed = [
      peer({ id: 'ws_c', slug: 'zebra' }),
      peer({ id: 'ws_a', slug: 'alpha' }),
      peer({ id: 'ws_b', slug: 'mango' }),
    ];

    expect(delegationPeers(listed, 'ws_self').map((one) => one.slug)).toEqual([
      'alpha',
      'mango',
      'zebra',
    ]);
  });

  it('answers empty when the deployment holds only this workspace', () => {
    expect(delegationPeers([peer({ id: 'ws_self', slug: 'self' })], 'ws_self')).toEqual([]);
  });
});

describe('selectDirectoryContext', () => {
  const many = (count: number, description: string) =>
    Array.from({ length: count }, (_, index) => {
      const slug = `projet-${String(index + 1).padStart(3, '0')}`;
      return peer({ id: `ws_${slug}`, slug, name: `Projet ${index + 1}`, description });
    });

  it('says nothing at all when there is no peer', () => {
    expect(selectDirectoryContext([])).toEqual({ text: '', described: [] });
  });

  it('names each peer by slug and carries its description', () => {
    const { text, described } = selectDirectoryContext([
      peer({ id: 'ws_shop', slug: 'shop', name: 'Boutique', description: 'The storefront.' }),
    ]);

    expect(text).toContain('shop');
    expect(text).toContain('Boutique');
    expect(text).toContain('The storefront.');
    expect(described.map((one) => one.slug)).toEqual(['shop']);
  });

  /**
   * A slug is made from the name at creation and then frozen, so for most
   * workspaces the two are the same words twice. Read against a real
   * deployment every entry came out as `- **bac-a-sable** — Bac a sable. Bac a
   * sable pour les essais jetables.`, which a fixture whose slug and name were
   * invented separately can never show. The name earns its place only once a
   * rename has made it say something the slug no longer does.
   */
  it('does not repeat the name its slug already spells', () => {
    const { text } = selectDirectoryContext([
      peer({ id: 'ws_1', slug: 'bac-a-sable', name: 'Bac a sable', description: 'Throwaway tries.' }),
    ]);

    expect(text).toContain('- **bac-a-sable** — Throwaway tries.');
  });

  /**
   * The case a hand-rolled flattening gets wrong, and the one this deployment
   * is full of: `slugify` folds accents, so `Bac à sable` *is* `bac-a-sable`
   * — while a naive `[^a-z0-9]+` reads it as `bac-sable` and calls the two
   * different, printing every accented name in a French deployment twice.
   * Reusing the real function rather than restating it is what makes this
   * true by construction.
   */
  it('folds accents the way the slug itself was folded', () => {
    const { text } = selectDirectoryContext([
      peer({ id: 'ws_1', slug: 'bac-a-sable', name: 'Bac à sable', description: 'Essais.' }),
    ]);

    expect(text).toContain('- **bac-a-sable** — Essais.');
    expect(text).not.toContain('Bac à sable');
  });

  it('keeps a name a rename has moved away from the slug', () => {
    const { text } = selectDirectoryContext([
      peer({ id: 'ws_1', slug: 'old-name', name: 'Billing v2', description: 'Invoices.' }),
    ]);

    expect(text).toContain('- **old-name** (Billing v2) — Invoices.');
  });

  /**
   * A peer with no description is reachable and unlisted, and the asymmetry is
   * deliberate: the directory says who declared a role, while the tool still
   * accepts any reachable slug a person names. Listing a roleless entry would
   * spend budget on a line that helps nobody choose.
   */
  it('leaves out a peer that never said what it is for', () => {
    const { text, described } = selectDirectoryContext([
      peer({ id: 'ws_told', slug: 'told', description: 'The billing service.' }),
      peer({ id: 'ws_mute', slug: 'mute', description: '   ' }),
    ]);

    expect(text).toContain('told');
    expect(text).not.toContain('mute');
    expect(described.map((one) => one.slug)).toEqual(['told']);
  });

  /**
   * Peers exist and not one has declared a role. Silence here would reproduce
   * the very defect this section exists to fix — a mounted tool nobody is told
   * about — so the note says the tool works and what is missing for it to be
   * worth using.
   */
  it('says peers exist even when not one of them is described', () => {
    const { text, described } = selectDirectoryContext([
      peer({ id: 'ws_a', slug: 'a', description: '' }),
      peer({ id: 'ws_b', slug: 'b', description: '' }),
    ]);

    expect(text).not.toBe('');
    expect(text).toContain('2');
    expect(described).toEqual([]);
  });

  /**
   * Two ways to have no list, and they blame different things.
   *
   * The first draft answered "not one of them has described what it is for"
   * whenever a single entry would not fit — so an operator who had squeezed
   * the budget was sent editing descriptions that were already written, and
   * the note itself came out at 292 characters against a budget of 200. A
   * message that is both false and over its own limit is worse than silence.
   */
  it('blames the budget, not the operator, when there is no room to list anyone', () => {
    const peers = many(3, 'A description that exists and is not the problem here.');

    const { text } = selectDirectoryContext(peers, 300);

    expect(text).toContain('no room');
    expect(text).not.toContain('described what it is for');
  });

  /**
   * Derived from the notes rather than hand-checked against them: rewording
   * one is exactly how a floor quietly stops being one, and the block that
   * explains why there is no list is the one thing that may never be dropped
   * for want of room — that lands back on a tool mounted and unexplained.
   */
  it('can always fit whichever note it needs at the floor', () => {
    const described = many(200, 'Something.');
    const bare = many(200, '');

    for (const peers of [described, bare]) {
      const { text } = selectDirectoryContext(peers, DIRECTORY_CONTEXT_MINIMUM);
      expect(text).not.toBe('');
      expect(text.length).toBeLessThanOrEqual(DIRECTORY_CONTEXT_MINIMUM);
    }
  });

  it('stays inside its budget', () => {
    const { text } = selectDirectoryContext(many(40, 'x'.repeat(2000)));

    expect(text.length).toBeLessThanOrEqual(DIRECTORY_CONTEXT_BUDGET);
  });

  /**
   * The property that matters most, and the one the first draft got wrong.
   *
   * Capping a sorted list keeps a *prefix*, so under a total order by slug the
   * same tail would be invisible on every run for ever: `zephyr` unreachable
   * because `alpha` through `hotel` had spent the budget. Descriptions are
   * what degrades; membership is not negotiable, because a peer absent from
   * the directory is a peer the agent never thinks to ask.
   */
  it('lists every peer even when their descriptions cannot all fit', () => {
    const peers = many(60, 'A description far too long for sixty of them to share the budget.');

    const { text, described } = selectDirectoryContext(peers);

    for (const one of peers) expect(text).toContain(one.slug);
    expect(described).toEqual([]);
    expect(text.length).toBeLessThanOrEqual(DIRECTORY_CONTEXT_BUDGET);
  });

  /**
   * Past the point where the names alone exhaust the budget there is nothing
   * left to shrink, and this is where a silent prefix would do real damage: an
   * agent handed a truncated list believes it has seen the whole deployment.
   * Told "and a hundred and twenty-one more", it can ask.
   */
  it('says how many it could not fit rather than trailing off', () => {
    const peers = many(200, 'Short.');

    const { text } = selectDirectoryContext(peers);

    const listed = peers.filter((one) => text.includes(one.slug)).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(peers.length);
    expect(text).toContain(`${peers.length - listed} other workspaces`);
    expect(text.length).toBeLessThanOrEqual(DIRECTORY_CONTEXT_BUDGET);
  });

  it('drops the descriptions together rather than dropping some peers', () => {
    const { described } = selectDirectoryContext(many(100, 'Something worth reading.'));

    // Nobody described, rather than the first eight described and the rest
    // silently bare: an arbitrary subset reads as a directory lying about the
    // rest, and which subset it is would depend on the alphabet.
    expect(described).toEqual([]);
  });

  it('describes everyone at an ordinary size', () => {
    const peers = many(10, 'Handles invoicing, credit notes and the monthly export.');

    const { described, text } = selectDirectoryContext(peers);

    expect(described).toHaveLength(10);
    expect(text).toContain('Handles invoicing');
  });

  it('clips a description that would crowd out its neighbours', () => {
    const long = 'word '.repeat(400);
    const { text } = selectDirectoryContext([peer({ id: 'ws_1', slug: 'one', description: long })]);

    expect(text).toContain('…');
    expect(text.length).toBeLessThan(long.length);
  });

  it('folds a multi-line description onto one line', () => {
    // A description is free text out of a textarea. A newline inside an entry
    // would read as the end of the list to anything reading it by line.
    const { text } = selectDirectoryContext([
      peer({ id: 'ws_1', slug: 'one', description: 'First line.\n\nSecond line.' }),
    ]);

    const entries = text.split('\n').filter((line) => line.startsWith('- '));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('First line. Second line.');
  });
});

/* -------------------------------------------------------------------------- */
/* The directory, against real rows                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything above builds a `Workspace` by hand, which cannot see the one
 * thing the whole opt-out rests on: `delegable` is stored inside a JSON column
 * and reparsed through the schema on every read, so a row written before the
 * field existed has no such key and takes the default. That claim is what
 * makes the release migration-free, and a fixture literal can never test it —
 * the same shape as the edge-schema trap, where the feature was dead below the
 * layer every test started at.
 *
 * Measured on the deployment this was written against: the stored settings
 * objects carried twenty keys where the schema had twenty-one, `language`
 * being the one absent and healed on read. These rows reproduce that.
 */
describe('delegationPeers, against rows a database actually holds', () => {
  let db: ReturnType<typeof openDatabase>;
  let workspaces: WorkspaceRepo;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    migrate(db);
    workspaces = new WorkspaceRepo(db);
  });

  afterEach(() => db.close());

  const create = (slug: string, settings: Record<string, unknown> = {}) =>
    workspaces.create({
      name: slug,
      slug,
      description: `The ${slug} project.`,
      path: `/srv/metaclaude/workspaces/${slug}`,
      color: '#6366f1',
      icon: 'folder',
      settings: WorkspaceSettings.parse(settings),
    });

  it('reaches a workspace stored with no delegable key at all', () => {
    const legacy = create('legacy');
    // The row as an older version left it: every key except this one. Written
    // straight to the column, because the repository would parse the default
    // back in on the way and prove nothing.
    const stored = JSON.parse(
      db.prepare<[string], { settings: string }>('SELECT settings FROM workspaces WHERE id = ?')
        .get(legacy.id)!.settings,
    ) as Record<string, unknown>;
    delete stored.delegable;
    db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(
      JSON.stringify(stored),
      legacy.id,
    );
    expect('delegable' in stored).toBe(false);

    const peers = delegationPeers(workspaces.list(), 'ws_someone_else');

    expect(peers.map((one) => one.slug)).toEqual(['legacy']);
  });

  it('leaves out a workspace whose stored settings decline', () => {
    create('open');
    create('closed', { delegable: false });

    const peers = delegationPeers(workspaces.list(), 'ws_someone_else');

    expect(peers.map((one) => one.slug)).toEqual(['open']);
  });

  it('survives the round trip through an update', () => {
    // The path an operator's checkbox actually takes: a partial patch merged
    // over the stored row and reparsed. `patchSchema` strips the defaults, so
    // a patch naming one field must not carry the others back to theirs.
    const one = create('shop');
    workspaces.update(one.id, { settings: { delegable: false } });
    workspaces.update(one.id, { settings: { memoryEnabled: false } });

    const stored = workspaces.get(one.id)!;

    expect(stored.settings.delegable).toBe(false);
    expect(delegationPeers(workspaces.list(), 'ws_someone_else')).toEqual([]);
  });

  /**
   * `WorkspaceRepo.list` answers `updated_at DESC`, which is neither total nor
   * stable — and it is what the directory is built from. Touching one
   * workspace must not change what the block says about the others.
   */
  it('answers the same order however the rows were last touched', () => {
    create('alpha');
    const middle = create('mango');
    create('zebra');
    const before = delegationPeers(workspaces.list(), 'x').map((one) => one.slug);

    workspaces.update(middle.id, { name: 'touched' });

    expect(delegationPeers(workspaces.list(), 'x').map((one) => one.slug)).toEqual(before);
    expect(before).toEqual(['alpha', 'mango', 'zebra']);
  });
});
