import type { Memory, MemorySearchResult } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { DUPLICATE_THRESHOLD, FORGET_THRESHOLD, MemoryStore, toFtsQuery } from './memory.js';

const DAY = 86_400_000;

/**
 * An embedder that runs `during` on the await every caller pays to embed.
 *
 * The only honest way to test what happens between a read and the write that
 * depends on it: the await is real, it is where a concurrent request would be
 * served, and nothing about the code under test has to know it is a test.
 */
function interposed(during: () => void): HashingEmbedder {
  const inner = new HashingEmbedder();
  let fired = false;
  return {
    id: inner.id,
    dimension: inner.dimension,
    family: inner.family,
    ready: true,
    async embed(text: string) {
      if (!fired) {
        fired = true;
        during();
      }
      return inner.embed(text);
    },
    embedBatch: (texts: string[]) => inner.embedBatch(texts),
  } as HashingEmbedder;
}

let db: Db;
let store: MemoryStore;
let wsA: string;
let wsB: string;
let runId: string;

/** Foreign keys are ON, so scoped rows need real workspaces / sessions / runs. */
function seedScaffolding(): void {
  const now = Date.now();
  const insertWorkspace = db.prepare(
    `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertWorkspace.run('ws_alpha', 'Alpha', 'alpha', '/tmp/alpha', now, now);
  insertWorkspace.run('ws_beta', 'Beta', 'beta', '/tmp/beta', now, now);
  wsA = 'ws_alpha';
  wsB = 'ws_beta';

  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('ses_1', wsA, now, now, now);

  runId = 'run_1';
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
     VALUES (?, ?, ?, ?, 'succeeded', ?)`,
  ).run(runId, 'ses_1', wsA, 'a prompt', now);
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  seedScaffolding();
  store = new MemoryStore(db, new HashingEmbedder());
});

afterEach(() => {
  db.close();
});

describe('tags', () => {
  /**
   * Two writers put tags into memory and neither agreed with the other: the
   * web form lowercases everything it parses, while reflexion hands over
   * whatever case the model produced. Nothing in between normalised, so the
   * same tag lived twice.
   */
  it('folds case when merging a repeated observation, instead of keeping both', async () => {
    // `new Set` over strings is case-sensitive, so a near-duplicate arriving
    // with 'bail' beside a stored 'Bail' kept the pair — and every repeat
    // added another variant until the 24-tag cap started evicting real ones.
    const first = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Préavis de résiliation',
      content: 'Le préavis est de trois mois hors zone tendue.',
      tags: ['Bail', 'Logement'],
    });
    const again = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Préavis de résiliation',
      content: 'Le préavis est de trois mois hors zone tendue, un mois en zone tendue.',
      tags: ['bail', 'LOGEMENT', 'préavis'],
    });

    expect(again.merged).toBe(true);
    expect([...again.memory.tags].sort()).toEqual(['bail', 'logement', 'préavis']);
    expect(first.memory.id).toBe(again.memory.id);
  });

  it('normalises on the way in, whoever the writer is', async () => {
    // Reflexion passes the model's tags through untouched; the store is the
    // one place every writer goes through, so it is where the shape is fixed.
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'episodic',
      title: 'Sinistre déclaré',
      content: 'Déclaration envoyée le 3.',
      tags: ['  Assurance  ', 'ASSURANCE', 'assurance', '', '   '],
    });
    expect(memory.tags).toEqual(['assurance']);
  });

  it('normalises on edit as well as on write', async () => {
    // The third writer, and the one the web edit form uses. Fixing only
    // remember() would have left the path this whole finding started from
    // able to re-introduce the variants.
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Tags à corriger',
      content: 'Contenu.',
      tags: ['bail'],
    });
    const updated = await store.update(memory.id, { tags: ['Bail', 'BAIL', ' logement '] });
    expect(updated?.tags).toEqual(['bail', 'logement']);
  });

  it('keeps the cap after folding, not before', async () => {
    // Trimming to 24 first and deduping second would spend the budget on
    // case variants of the same word.
    const noisy = Array.from({ length: 20 }, (_, i) => [`Tag${i}`, `tag${i}`]).flat();
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Beaucoup de tags',
      content: 'Contenu.',
      tags: noisy,
    });
    expect(memory.tags).toHaveLength(20);
    expect(new Set(memory.tags).size).toBe(20);
  });
});

describe('remember / get', () => {
  it('stores a memory and reads it back', async () => {
    const { memory, merged } = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Test runner',
      content: 'This project runs its tests with vitest, not jest.',
      tags: ['testing', 'tooling'],
    });

    expect(merged).toBe(false);
    expect(memory.id.startsWith('mem_')).toBe(true);
    expect(memory.workspaceId).toBe(wsA);
    expect(memory.kind).toBe('semantic');
    expect(memory.title).toBe('Test runner');
    expect(memory.content).toContain('vitest');
    expect(memory.tags).toEqual(['testing', 'tooling']);
    expect(memory.confidence).toBe(0.7);
    expect(memory.useCount).toBe(0);
    expect(memory.successCount).toBe(0);
    expect(memory.pinned).toBe(false);
    expect(memory.lastUsedAt).toBeNull();

    expect(store.get(memory.id)).toEqual(memory);
    expect(store.get('mem_nope')).toBeNull();
  });

  it('persists the embedding alongside the provider id', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'x',
      content: 'y',
    });
    const row = db
      .prepare<[string], { embedding_dim: number; embedding_model: string; embedding: Buffer }>(
        'SELECT embedding, embedding_dim, embedding_model FROM memories WHERE id = ?',
      )
      .get(memory.id)!;
    expect(row.embedding_model).toBe('hash-v1:512');
    expect(row.embedding_dim).toBe(512);
    expect(row.embedding.byteLength).toBe(512 * 4);
  });

  it('honours explicit confidence, pinning and the title/tag caps', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'procedural',
      title: 'T'.repeat(500),
      content: 'body',
      tags: Array.from({ length: 40 }, (_, i) => `tag-${i}`),
      confidence: 0.95,
      pinned: true,
      sourceRunId: runId,
    });
    expect(memory.title).toHaveLength(300);
    expect(memory.tags).toHaveLength(24);
    expect(memory.confidence).toBe(0.95);
    expect(memory.pinned).toBe(true);
    expect(memory.sourceRunId).toBe(runId);
  });

  it('merges a near-duplicate instead of inserting a second row', async () => {
    const first = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'API port',
      content: 'The API server runs on port 8080',
      tags: ['api'],
    });
    expect(first.merged).toBe(false);
    expect(store.count()).toBe(1);

    const second = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'API port',
      content: 'The API server runs on port 8080.',
      tags: ['ports'],
    });

    expect(second.merged).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(store.count()).toBe(1);
    // Repetition is evidence: confidence rises but never reaches certainty.
    expect(second.memory.confidence).toBeCloseTo(0.78, 6);
    // Tags are unioned and the longer body wins.
    expect(second.memory.tags.sort()).toEqual(['api', 'ports']);
    expect(second.memory.content).toBe('The API server runs on port 8080.');
  });

  it('keeps the longer existing body when the new one is shorter', async () => {
    const long = 'The API server runs on port 8080 in every environment.';
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'API port', content: long });
    const merged = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'API port',
      content: 'The API server runs on port 8080 in every environment',
    });
    expect(merged.merged).toBe(true);
    expect(merged.memory.content).toBe(long);
  });

  it('caps merge-driven confidence below 1', async () => {
    const input = {
      workspaceId: null,
      kind: 'semantic' as const,
      title: 'API port',
      content: 'The API server runs on port 8080',
      confidence: 0.98,
    };
    await store.remember(input);
    for (let i = 0; i < 5; i += 1) {
      const merged = await store.remember(input);
      expect(merged.merged).toBe(true);
      expect(merged.memory.confidence).toBeLessThanOrEqual(0.99);
    }
    expect(store.count()).toBe(1);
  });

  it('does not merge across two workspaces', async () => {
    const input = {
      kind: 'semantic' as const,
      title: 'API port',
      content: 'The API server runs on port 8080',
    };
    expect((await store.remember({ ...input, workspaceId: wsA })).merged).toBe(false);
    expect((await store.remember({ ...input, workspaceId: wsB })).merged).toBe(false);
    expect(store.count()).toBe(2);
  });

  /**
   * The classification is a guess the reflector makes from one run, and it is
   * not stable: the production corpus held "Workspace uses French as primary
   * language" as `semantic` beside "User speaks French; session communication
   * in French" as `procedural`. Filtering duplicates by kind meant the same
   * observation could live once per kind, and did.
   */
  it('merges a duplicate that was classified differently, keeping the stored kind', async () => {
    const input = {
      workspaceId: null,
      title: 'API port',
      content: 'The API server runs on port 8080',
    };
    const first = await store.remember({ ...input, kind: 'semantic' });
    const second = await store.remember({ ...input, kind: 'procedural' });

    expect(second.merged).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.kind).toBe('semantic');
    expect(store.count()).toBe(1);
  });

  /**
   * Inheritance has a direction. A fact the global tier already carries is
   * reachable from this workspace already, so writing a workspace copy of it
   * creates a duplicate that spans two tiers — which `findNearDuplicate` used
   * to be unable to see at all, having scoped itself with `workspace_id IS ?`.
   */
  it('folds a workspace write into the global memory that already says it', async () => {
    const input = {
      kind: 'semantic' as const,
      title: 'API port',
      content: 'The API server runs on port 8080',
    };
    const global = await store.remember({ ...input, workspaceId: null });
    const local = await store.remember({ ...input, workspaceId: wsA });

    expect(local.merged).toBe(true);
    expect(local.memory.id).toBe(global.memory.id);
    expect(local.memory.workspaceId).toBeNull();
    expect(store.count()).toBe(1);
  });

  /** And never the other way: a global fact must not be quietly demoted. */
  it('does not fold a global write into a workspace memory', async () => {
    const input = {
      kind: 'semantic' as const,
      title: 'API port',
      content: 'The API server runs on port 8080',
    };
    await store.remember({ ...input, workspaceId: wsA });
    const global = await store.remember({ ...input, workspaceId: null });

    expect(global.merged).toBe(false);
    expect(global.memory.workspaceId).toBeNull();
    expect(store.count()).toBe(2);
  });

  it('does not merge two genuinely different memories', async () => {
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Test runner',
      content: 'Tests are run with vitest in this repository',
    });
    const second = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Deployment',
      content: 'The deployment uses docker compose on a small VPS',
    });
    expect(second.merged).toBe(false);
    expect(store.count()).toBe(2);
    expect(DUPLICATE_THRESHOLD).toBe(0.92);
  });
});

describe('update / delete', () => {
  it('patches fields and re-embeds only when the text changed', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Old title',
      content: 'Old content about deployment',
    });
    const originalEmbedding = db
      .prepare<[string], { embedding: Buffer }>('SELECT embedding FROM memories WHERE id = ?')
      .get(memory.id)!.embedding;

    const tagOnly = await store.update(memory.id, { tags: ['a'], confidence: 0.4, pinned: true });
    expect(tagOnly!.tags).toEqual(['a']);
    expect(tagOnly!.confidence).toBe(0.4);
    expect(tagOnly!.pinned).toBe(true);
    expect(
      db
        .prepare<[string], { embedding: Buffer }>('SELECT embedding FROM memories WHERE id = ?')
        .get(memory.id)!
        .embedding.equals(originalEmbedding),
    ).toBe(true);

    const retitled = await store.update(memory.id, { title: 'A completely different subject' });
    expect(retitled!.title).toBe('A completely different subject');
    expect(
      db
        .prepare<[string], { embedding: Buffer }>('SELECT embedding FROM memories WHERE id = ?')
        .get(memory.id)!
        .embedding.equals(originalEmbedding),
    ).toBe(false);
  });

  it('returns null when updating or deleting something that is not there', async () => {
    await expect(store.update('mem_nope', { title: 'x' })).resolves.toBeNull();
    expect(store.delete('mem_nope')).toBe(false);
  });

  it('deletes a memory and its FTS row', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Ephemeral',
      content: 'a distinctive marker word: zzyzx',
    });
    expect(store.delete(memory.id)).toBe(true);
    expect(store.get(memory.id)).toBeNull();
    expect(store.count()).toBe(0);
    await expect(store.search('zzyzx')).resolves.toEqual([]);
  });
});

describe('search', () => {
  async function seedCorpus(): Promise<void> {
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Test runner',
      content: 'Tests are run with vitest in this repository, never with jest.',
    });
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Deployment',
      content: 'The deployment uses docker compose on a small VPS behind nginx.',
    });
    await store.remember({
      workspaceId: null,
      kind: 'procedural',
      title: 'Database migrations',
      content: 'Migrations live in schema.sql.ts and are append-only.',
    });
  }

  /** The corpus plus two memories that share nothing but stopwords with it. */
  async function seedNoise(): Promise<void> {
    await seedCorpus();
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Coffee',
      content: 'The good beans are in the cupboard above the kettle.',
    });
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Piano',
      content: 'The upright is tuned to A=442 and the middle pedal sticks.',
    });
  }

  it('returns nothing when the corpus is empty', async () => {
    await expect(store.search('anything')).resolves.toEqual([]);
  });

  it('finds a semantically related memory and ranks it first', async () => {
    await seedCorpus();
    const results = await store.search('how do I run the unit tests with vitest?');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.title).toBe('Test runner');
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('does not pad the result with irrelevant memories', async () => {
    // Without a relevance gate the dense arm contributes every memory it holds,
    // so a small corpus fills the caller's limit with whatever exists. Eight
    // unrelated memories in every system prompt wastes context and feeds noise
    // into reinforcement, since recordUsage credits everything it injected.
    await seedCorpus();

    // A query sharing no vocabulary with the corpus must not drag it all back.
    const unrelated = await store.search('parsnip violin sonata');
    expect(unrelated.length).toBeLessThan(3);

    // A query that does match still ranks the right memory first.
    const relevant = await store.search('database migration schema');
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[0]!.memory.title).toBe('Database migrations');
  });

  it('does not let one shared word drag the whole corpus back', async () => {
    // The test above is weaker than it looks: `parsnip violin sonata` matches
    // no token in the corpus, so FTS returns nothing and only the dense arm is
    // ever exercised. The lexical arm's real behaviour is visible only when
    // the MATCH *does* hit — and `toFtsQuery` OR-joins every token, so one
    // incidental word in common is enough to return every row.
    //
    // Ranked last by BM25 is not the same as excluded: fusion adds
    // 1/(K+index+1) for every id the arm returns, unconditionally, and the
    // caller's `limit` is then filled from the bottom of the ranking.
    //
    // `minSimilarity: 1` is what makes this a test of the lexical arm rather
    // than of the embedder: no vector reaches a cosine of 1, so the dense arm
    // contributes nothing and every id below came through BM25.
    await seedNoise();

    const results = await store.search('how are the migrations applied', { minSimilarity: 1 });
    expect(results.map((entry) => entry.memory.title)).toEqual(['Database migrations']);
  });

  it('still returns every genuine lexical match, not just the best one', async () => {
    // The other half of the gate, and the reason it is relative rather than
    // "top 1": two memories that both genuinely match must both survive it.
    await seedNoise();

    const results = await store.search('vitest migrations', { minSimilarity: 1 });
    const titles = results.map((entry) => entry.memory.title);
    expect(titles).toContain('Database migrations');
    expect(titles).toContain('Test runner');
    expect(titles).not.toContain('Coffee');
    expect(titles).not.toContain('Piano');
  });

  it('returns nothing when every match is a stopword, however large the corpus', async () => {
    // The failure a ratio-to-the-best gate cannot see. fts5 clamps a common
    // term's IDF at 1e-6, so when *every* match is noise the best hit is ~0 and
    // `best * fraction` is ~0 too — the test admits everything it was meant to
    // exclude. Measured before the fix: 21 rows matched, 21 kept.
    await seedNoise();
    for (let i = 0; i < 18; i += 1) {
      await store.remember({
        workspaceId: null,
        kind: 'semantic',
        title: `Filler ${i}`,
        content: `The thing number ${i} is in the cupboard and the kettle is beside it.`,
      });
    }

    expect(await store.search('the', { minSimilarity: 1 })).toEqual([]);
  });

  it('keeps a genuine identifier match that is merely in a long document', async () => {
    // The other end of the same mistake. Two memories each containing the
    // identifier once scored -2.74 and -0.45 purely from BM25 length
    // normalisation — a ratio of 0.16 — so a relative gate discarded the longer
    // one, in the arm whose whole job is exact identifiers. Adding unrelated
    // memories moved that cut too, by shifting the average document length.
    //
    // The surrounding corpus is not decoration. BM25's IDF is relative to it,
    // and fts5 clamps the term's weight to ~0 when it appears in *every*
    // document — so with only the two memories below, the identifier carries no
    // discriminative power and the lexical arm rightly says nothing. That is
    // BM25 working, not the gate failing; in production the dense arm covers
    // that case, and here `minSimilarity: 1` deliberately does not.
    await seedNoise();
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Runbook',
      content: 'When HX7Q_SENTINEL fires, restart the worker and check the queue depth.',
    });
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Long runbook',
      content: `HX7Q_SENTINEL ${'padding words to make this document long. '.repeat(40)}`,
    });

    const titles = (await store.search('HX7Q_SENTINEL', { minSimilarity: 1 })).map(
      (entry) => entry.memory.title,
    );
    expect(titles).toContain('Runbook');
    expect(titles).toContain('Long runbook');
  });

  it('respects the requested limit and filters by kind', async () => {
    await seedCorpus();
    // A query that genuinely matches more than one memory, capped to one.
    expect(await store.search('how are migrations and tests handled')).not.toHaveLength(0);
    expect(await store.search('how are migrations and tests handled', { limit: 1 })).toHaveLength(1);

    const procedural = await store.search('migrations schema', { kinds: ['procedural'] });
    expect(procedural.length).toBeGreaterThan(0);
    for (const result of procedural) expect(result.memory.kind).toBe('procedural');

    const episodic = await store.search('migrations schema', { kinds: ['episodic'] });
    expect(episodic).toEqual([]);
  });

  it('scopes results to a workspace plus global memories', async () => {
    await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Alpha convention',
      content: 'In the alpha project the linter is biome and the runner is vitest.',
    });
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Global convention',
      content: 'Across every project the linter runs before the vitest suite.',
    });

    const fromA = await store.search('linter and vitest', { workspaceId: wsA });
    expect(fromA.map((r) => r.memory.title).sort()).toEqual(['Alpha convention', 'Global convention']);

    // A different workspace sees the global memory but never alpha's.
    const fromB = await store.search('linter and vitest', { workspaceId: wsB });
    expect(fromB.map((r) => r.memory.title)).toEqual(['Global convention']);

    // Asking explicitly for global scope excludes every workspace memory.
    const global = await store.search('linter and vitest', { workspaceId: null });
    expect(global.map((r) => r.memory.title)).toEqual(['Global convention']);
  });

  it('never returns a memory that decayed below the retrieval floor', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Forgotten',
      content: 'A fact nobody ever used again: zzyzx.',
    });
    expect(await store.search('zzyzx')).toHaveLength(1);

    await store.update(memory.id, { confidence: FORGET_THRESHOLD - 0.01 });
    expect(await store.search('zzyzx')).toEqual([]);
  });

  it('boosts pinned and high-confidence memories in the ranking', async () => {
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Casual note',
      content: 'The retrieval pipeline fuses dense and lexical arms.',
      confidence: 0.2,
    });
    const pinned = await store.remember({
      workspaceId: null,
      kind: 'procedural',
      title: 'Pinned instruction',
      content: 'The retrieval pipeline fuses dense and lexical arms.',
      confidence: 0.9,
      pinned: true,
    });

    const results = await store.search('retrieval pipeline dense lexical arms');
    expect(results).toHaveLength(2);
    expect(results[0]!.memory.id).toBe(pinned.memory.id);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('does not throw on a query full of FTS metacharacters', async () => {
    await seedCorpus();
    for (const query of [
      'foo* NEAR bar',
      'vitest OR (jest AND NOT mocha)',
      '"unterminated quote',
      'col:on -minus ^caret',
      '*',
      '((((',
      'NEAR/3',
      '',
      '   ',
      '!!! ??? ***',
    ]) {
      await expect(store.search(query)).resolves.toBeInstanceOf(Array);
    }
  });

  it('still retrieves via the dense arm when the lexical query is unusable', async () => {
    await seedCorpus();
    // A query of only one-character tokens produces no FTS expression at all.
    const results = await store.search('a b c vitest');
    expect(results.length).toBeGreaterThan(0);
  });

  it('ignores vectors written by a different embedding provider', async () => {
    await seedCorpus();
    db.prepare("UPDATE memories SET embedding_model = 'st:some-other-model'").run();
    // Dense retrieval is impossible, but BM25 still finds the exact term.
    const results = await store.search('vitest');
    expect(results.map((r) => r.memory.title)).toContain('Test runner');
  });
});

describe('recordUsage and reinforce', () => {
  async function remembered(pinned = false): Promise<MemorySearchResult> {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: pinned ? 'Pinned fact' : 'Ordinary fact',
      content: pinned ? 'An operator instruction that must not drift.' : 'A learned observation.',
      confidence: 0.7,
      pinned,
    });
    return { memory, score: 0.5 };
  }

  it('records which memories a run used and bumps their use count', async () => {
    const result = await remembered();
    store.recordUsage(runId, [result]);

    const after = store.get(result.memory.id)!;
    expect(after.useCount).toBe(1);
    expect(after.lastUsedAt).not.toBeNull();

    const links = db
      .prepare<[string], { memory_id: string; score: number }>(
        'SELECT memory_id, score FROM memory_usages WHERE run_id = ?',
      )
      .all(runId);
    // The stored score is rank-normalised within the retrieval, so the top hit
    // is 1. Raw fused scores all sit near 0.03 and made attribution inert.
    expect(links).toEqual([{ memory_id: result.memory.id, score: 1 }]);
  });

  it('reads back what a run recalled, best-first, with live titles', async () => {
    const first = await remembered();
    const { memory: second } = await store.remember({
      workspaceId: null,
      kind: 'procedural',
      title: 'How deploys run',
      content: 'The pipeline gates on health.',
      confidence: 0.9,
    });
    store.recordUsage(runId, [first, { memory: second, score: 0.25 }]);

    const recalled = store.recalledFor(runId);
    expect(recalled.map((entry) => entry.title)).toEqual(['Ordinary fact', 'How deploys run']);
    expect(recalled[0]).toMatchObject({ kind: 'semantic', score: 1 });
    expect(recalled[1]?.score).toBeCloseTo(0.5);
    expect(recalled[1]?.confidence).toBeCloseTo(0.9);
    // A run that recalled nothing answers empty, not an error.
    expect(store.recalledFor('run_none')).toEqual([]);
  });

  it('is a no-op for an empty result set', () => {
    expect(() => store.recordUsage(runId, [])).not.toThrow();
    expect(
      db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memory_usages').get()!.n,
    ).toBe(0);
  });

  it('raises confidence on a high reward and lowers it on a low one', async () => {
    const good = await remembered();
    store.recordUsage(runId, [good]);
    store.reinforce(runId, 1);
    const raised = store.get(good.memory.id)!;
    expect(raised.confidence).toBeGreaterThan(0.7);
    expect(raised.confidence).toBeCloseTo(0.7 + 0.12 * (1 - 0.7), 6);
    expect(raised.successCount).toBe(1);

    store.reinforce(runId, 0);
    const lowered = store.get(good.memory.id)!;
    expect(lowered.confidence).toBeLessThan(raised.confidence);
    // A low reward does not count as a success.
    expect(lowered.successCount).toBe(1);
  });

  it('lands a re-rating where a single observation of that value would', async () => {
    // `previousReward` is the caller saying "this run was already rated; that
    // rating is superseded, not added to." The success-count arm honoured it.
    // Confidence did not: it applied a fresh full EMA move from the
    // already-moved stored value, so re-rating the same run walked confidence
    // up without bound — eight identical thumbs-up took 0.5 to 0.80 where one
    // observation puts it at 0.55. `rateRun` has no idempotence guard, so the
    // public API reaches this directly.
    const memo = await remembered();
    store.recordUsage(runId, [memo]);

    store.reinforce(runId, 0.9);
    const once = store.get(memo.memory.id)!.confidence;

    // Same rating, three more times. Nothing new was observed.
    store.reinforce(runId, 0.9, 0.9);
    store.reinforce(runId, 0.9, 0.9);
    store.reinforce(runId, 0.9, 0.9);
    expect(store.get(memo.memory.id)!.confidence).toBeCloseTo(once, 6);

    // And changing the rating lands where that value alone would have, rather
    // than somewhere along the path taken to get there.
    store.reinforce(runId, 0.1, 0.9);
    expect(store.get(memo.memory.id)!.confidence).toBeCloseTo(0.7 + 0.12 * (0.1 - 0.7), 6);
  });

  it('attributes proportionally to how strongly the memory was retrieved', async () => {
    const strong = await remembered();
    const weak = await store.remember({
      workspaceId: null,
      kind: 'procedural',
      title: 'Weakly retrieved',
      content: 'Something only tangentially relevant.',
      confidence: 0.7,
    });

    store.recordUsage(runId, [strong, { memory: weak.memory, score: 0.01 }]);
    store.reinforce(runId, 1);

    const strongAfter = store.get(strong.memory.id)!;
    const weakAfter = store.get(weak.memory.id)!;
    expect(strongAfter.confidence).toBeGreaterThan(weakAfter.confidence);
    expect(weakAfter.confidence).toBeGreaterThan(0.7);
  });

  it('never moves confidence outside [0, 1]', async () => {
    const result = await remembered();
    for (let i = 0; i < 50; i += 1) {
      store.recordUsage(runId, [result]);
      store.reinforce(runId, i % 2 === 0 ? 1 : 0);
      const current = store.get(result.memory.id)!;
      expect(current.confidence).toBeGreaterThanOrEqual(0);
      expect(current.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('leaves pinned memories alone', async () => {
    const pinned = await remembered(true);
    store.recordUsage(runId, [pinned]);
    store.reinforce(runId, 0);

    const after = store.get(pinned.memory.id)!;
    expect(after.confidence).toBe(0.7);
    expect(after.successCount).toBe(0);
    // The usage link is still recorded — only the confidence move is skipped.
    expect(after.useCount).toBe(1);
  });

  it('is a no-op for a run that used nothing', () => {
    expect(() => store.reinforce('run_never_seen', 1)).not.toThrow();
  });
});

describe('decay', () => {
  it('does not compound when the janitor sweeps repeatedly', async () => {
    // The janitor calls decay() every six hours. Applying a factor derived from
    // TOTAL idle time to an ALREADY-DECAYED value compounds quadratically: a
    // memory meant to reach the 0.15 floor after ~200 idle days reached it after
    // ~25, became unretrievable, and was then deleted by collect(). Sweeping
    // often must land in the same place as sweeping once.
    const { memory: swept } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Swept often',
      content: 'This one is decayed by a busy janitor.',
      confidence: 0.8,
    });
    const { memory: once } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Swept once',
      content: 'A completely unrelated note about parsnips and violins.',
      confidence: 0.8,
    });

    const start = Date.now();
    const SIX_HOURS = 6 * 60 * 60 * 1000;

    // 180 days of sweeps, four per day, on the first memory only.
    for (let t = SIX_HOURS; t <= 180 * DAY; t += SIX_HOURS) {
      store.decay({ halfLifeDays: 90, now: start + t });
    }

    const sweptAfter = store.get(swept.id)!;
    // A single sweep over the same span, for comparison.
    store.decay({ halfLifeDays: 90, now: start + 180 * DAY });
    const onceAfter = store.get(once.id)!;

    expect(sweptAfter.confidence).toBeCloseTo(onceAfter.confidence, 4);
    // Two half-lives: 0.8 -> 0.2, comfortably above the 0.15 collection floor.
    expect(sweptAfter.confidence).toBeCloseTo(0.2, 3);
    expect(sweptAfter.confidence).toBeGreaterThan(FORGET_THRESHOLD);
  });

  it('reduces confidence for memories that have been idle', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Idle fact',
      content: 'Nothing has needed this for a long time.',
      confidence: 0.8,
    });

    const now = Date.now() + 90 * DAY;
    expect(store.decay({ halfLifeDays: 90, now })).toBe(1);

    const after = store.get(memory.id)!;
    // One half-life of idleness halves the confidence.
    expect(after.confidence).toBeCloseTo(0.4, 3);
    expect(after.confidence).toBeLessThan(0.8);
  });

  it('leaves recently used memories alone', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Fresh fact',
      content: 'Used yesterday.',
      confidence: 0.8,
    });

    // Inside the grace period of a quarter of a half-life.
    expect(store.decay({ halfLifeDays: 90, now: Date.now() + 20 * DAY })).toBe(0);
    expect(store.get(memory.id)!.confidence).toBe(0.8);
  });

  it('measures idleness from the last use, not from creation', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Recently used',
      content: 'Used often.',
      confidence: 0.8,
    });
    const now = Date.now();
    db.prepare('UPDATE memories SET created_at = ?, last_used_at = ? WHERE id = ?').run(
      now - 300 * DAY,
      now,
      memory.id,
    );
    expect(store.decay({ halfLifeDays: 90, now })).toBe(0);
    expect(store.get(memory.id)!.confidence).toBe(0.8);
  });

  it('never decays a pinned memory', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Pinned fact',
      content: 'An explicit operator instruction.',
      confidence: 0.8,
      pinned: true,
    });
    expect(store.decay({ halfLifeDays: 90, now: Date.now() + 400 * DAY })).toBe(0);
    expect(store.get(memory.id)!.confidence).toBe(0.8);
  });

  it('is monotonic: more idle time means less confidence', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Fading',
      content: 'Nobody has needed this.',
      confidence: 0.9,
    });
    const start = Date.now();
    let previous = 0.9;
    for (const days of [40, 90, 180, 365]) {
      store.decay({ halfLifeDays: 90, now: start + days * DAY });
      const current = store.get(memory.id)!.confidence;
      expect(current).toBeLessThan(previous);
      expect(current).toBeGreaterThanOrEqual(0);
      previous = current;
    }
  });
});

describe('collect', () => {
  it('removes only sub-threshold memories that were never useful', async () => {
    const doomed = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Doomed',
      content: 'A guess that never helped.',
    });
    const proven = await store.remember({
      workspaceId: null,
      kind: 'procedural',
      title: 'Proven',
      content: 'A procedure that worked at least once.',
    });
    const pinned = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Pinned',
      content: 'An explicit instruction that must survive anything.',
      pinned: true,
    });
    const healthy = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Healthy',
      content: 'Still trusted.',
    });

    // Give `proven` a success, then push everything except `healthy` below the floor.
    store.recordUsage(runId, [{ memory: proven.memory, score: 0.5 }]);
    store.reinforce(runId, 1);
    expect(store.get(proven.memory.id)!.successCount).toBe(1);

    for (const id of [doomed.memory.id, proven.memory.id, pinned.memory.id]) {
      await store.update(id, { confidence: 0.01 });
    }

    expect(store.collect()).toBe(1);
    expect(store.get(doomed.memory.id)).toBeNull();
    expect(store.get(proven.memory.id)).not.toBeNull();
    expect(store.get(pinned.memory.id)).not.toBeNull();
    expect(store.get(healthy.memory.id)).not.toBeNull();
  });

  it('collects nothing when everything is above the floor', async () => {
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'A', content: 'a' });
    expect(store.collect()).toBe(0);
    expect(store.count()).toBe(1);
  });

  it('decay followed by collect eventually forgets an unused memory', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Never used',
      content: 'A one-off observation.',
      confidence: 0.7,
    });
    store.decay({ halfLifeDays: 90, now: Date.now() + 3 * 365 * DAY });
    expect(store.get(memory.id)!.confidence).toBeLessThan(FORGET_THRESHOLD);
    expect(store.collect()).toBe(1);
    expect(store.get(memory.id)).toBeNull();
  });
});

describe('reindex', () => {
  it('rebuilds vectors written by a different provider', async () => {
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'A', content: 'alpha' });
    await store.remember({ workspaceId: null, kind: 'semantic', title: 'B', content: 'beta' });
    expect(await store.reindex()).toBe(0);

    db.prepare("UPDATE memories SET embedding_model = 'st:other'").run();
    expect(await store.reindex()).toBe(2);
    expect(await store.reindex()).toBe(0);

    const models = db
      .prepare<[], { embedding_model: string }>('SELECT DISTINCT embedding_model FROM memories')
      .all();
    expect(models).toEqual([{ embedding_model: 'hash-v1:512' }]);
  });
});

describe('list / count / stats', () => {
  async function seed(): Promise<void> {
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Global semantic',
      content: 'global',
      confidence: 0.5,
    });
    await store.remember({
      workspaceId: wsA,
      kind: 'procedural',
      title: 'Alpha procedural',
      content: 'alpha steps',
      confidence: 0.6,
    });
    await store.remember({
      workspaceId: wsA,
      kind: 'episodic',
      title: 'Alpha episodic',
      content: 'alpha happened',
      confidence: 0.9,
      pinned: true,
    });
    await store.remember({
      workspaceId: wsB,
      kind: 'semantic',
      title: 'Beta semantic',
      content: 'beta',
      confidence: 0.8,
    });
  }

  it('lists pinned first, then by confidence', async () => {
    await seed();
    const listed = store.list({ workspaceId: wsA });
    expect(listed.map((m) => m.title)).toEqual([
      'Alpha episodic', // pinned
      'Alpha procedural', // 0.6
      'Global semantic', // 0.5
    ]);
  });

  it('scopes listing the same way retrieval does', async () => {
    await seed();
    expect(store.list({ workspaceId: null }).map((m) => m.title)).toEqual(['Global semantic']);
    expect(store.list({ workspaceId: wsB }).map((m) => m.title).sort()).toEqual([
      'Beta semantic',
      'Global semantic',
    ]);
    expect(store.list()).toHaveLength(4);
  });

  it('filters by kind and by a substring search', async () => {
    await seed();
    expect(store.list({ kind: 'semantic' }).map((m) => m.title).sort()).toEqual([
      'Beta semantic',
      'Global semantic',
    ]);
    expect(store.list({ search: 'alpha' }).map((m) => m.title).sort()).toEqual([
      'Alpha episodic',
      'Alpha procedural',
    ]);
    expect(store.list({ search: '   ' })).toHaveLength(4);
    expect(store.list({ search: 'no-such-text' })).toHaveLength(0);
  });

  it('paginates', async () => {
    await seed();
    const all = store.list();
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.list({ limit: 2, offset: 2 }).map((m) => m.id)).toEqual(
      all.slice(2).map((m) => m.id),
    );
    expect(store.list({ limit: 10, offset: 10 })).toEqual([]);
  });

  it('counts globally and per workspace', async () => {
    await seed();
    expect(store.count()).toBe(4);
    expect(store.count(null)).toBe(1);
    // A workspace id counts that workspace plus the global memories, matching
    // what `list` returns for the same scope.
    expect(store.count(wsA)).toBe(3);
    expect(store.count(wsB)).toBe(2);
    expect(store.count('ws_nonexistent')).toBe(1);
  });

  it('reports counts per kind, always with every kind present', async () => {
    expect(store.stats()).toEqual({ episodic: 0, semantic: 0, procedural: 0 });
    await seed();
    expect(store.stats()).toEqual({ episodic: 1, semantic: 2, procedural: 1 });
    // Workspace plus globals, consistent with `count` and `list`.
    expect(store.stats(wsA)).toEqual({ episodic: 1, semantic: 1, procedural: 1 });
    expect(store.stats(null)).toEqual({ episodic: 0, semantic: 1, procedural: 0 });
  });
});

describe('toFtsQuery', () => {
  it('quotes every token, which neutralises the FTS operators', () => {
    // "and"/"not"/"on" are function words now and drop out — the small-corpus
    // stopword lesson (see retrieval.ts); the operators they might have been
    // are neutralised either way.
    expect(toFtsQuery('foo* NEAR bar')).toBe('"foo" OR "near" OR "bar"');
    expect(toFtsQuery('vitest AND NOT jest')).toBe('"vitest" OR "jest"');
    expect(toFtsQuery('col:on')).toBe('"col"');
    expect(toFtsQuery('-minus ^caret')).toBe('"minus" OR "caret"');
    expect(toFtsQuery('a "quoted" phrase')).toBe('"quoted" OR "phrase"');
  });

  it('abstains entirely on a query of nothing but function words', () => {
    // On a small corpus a stopword can carry real IDF (measured: "un" in one
    // chunk of two ranked −0.0325, through the clamp gate), so the arm must
    // refuse to match on grammar rather than trust the gate to catch it.
    expect(toFtsQuery('le la de et un')).toBeNull();
    expect(toFtsQuery('the and of a it')).toBeNull();
  });

  it('never leaves an unbalanced quote in the output', () => {
    for (const input of ['"', 'a"b cd', '""""" xyz', 'he said "hello there"']) {
      const query = toFtsQuery(input);
      if (query === null) continue;
      expect((query.match(/"/g) ?? []).length % 2).toBe(0);
      expect(query.includes('""')).toBe(false);
    }
  });

  it('returns null when there is nothing searchable', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('!!! ??? ***')).toBeNull();
    expect(toFtsQuery('a b c')).toBeNull(); // every token is too short
  });

  it('lowercases, keeps accented words, and bounds the token count', () => {
    expect(toFtsQuery('Déployer EN Production')).toBe('"déployer" OR "production"');
    const many = toFtsQuery(Array.from({ length: 100 }, (_, i) => `token${i}`).join(' '))!;
    expect(many.split(' OR ')).toHaveLength(24);
  });

  it('produces an expression SQLite accepts', async () => {
    await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Marker',
      content: 'a distinctive marker word: zzyzx',
    });
    for (const query of ['foo* NEAR bar', 'zzyzx', 'col:on -minus', '"unterminated']) {
      const expression = toFtsQuery(query);
      if (!expression) continue;
      expect(() =>
        db
          .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?')
          .all(expression),
      ).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation: merging, promoting, confining                               */
/* -------------------------------------------------------------------------- */

describe('reconcile', () => {
  /** A second run, so a merge has usage history on more than one run to carry. */
  function anotherRun(): void {
    db.prepare(
      `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at)
       VALUES (?, ?, ?, ?, 'succeeded', ?)`,
    ).run('run_2', 'ses_1', wsA, 'another prompt', Date.now());
  }

  const usagesOf = (run: string) =>
    db
      .prepare<[string], { memory_id: string; score: number }>(
        'SELECT memory_id, score FROM memory_usages WHERE run_id = ? ORDER BY memory_id',
      )
      .all(run);

  async function pair(): Promise<[Memory, Memory]> {
    const a = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Winner',
      content: 'The surviving body of text.',
      tags: ['alpha'],
    });
    const b = await store.remember({
      workspaceId: wsA,
      kind: 'procedural',
      title: 'Loser',
      content: 'A different body entirely.',
      tags: ['beta'],
    });
    return [a.memory, b.memory];
  }

  it('folds one memory into another and deletes the absorbed row', async () => {
    const [winner, loser] = await pair();

    const result = await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    expect(result.absorbed).toEqual([loser.id]);
    expect(result.memory.id).toBe(winner.id);
    expect(store.get(loser.id)).toBeNull();
    expect(store.count()).toBe(1);
  });

  /**
   * The usage rows are what `recalledFor` reads to show a run's genesis, and
   * `memory_usages.memory_id` cascades on delete. Folding without repointing
   * them rewrites history: a finished run silently loses a memory it was
   * demonstrably given. The counter-proof below is the same scenario with a
   * plain delete, and it is what makes this test worth having.
   */
  it('carries the absorbed memory’s usage history onto the winner', async () => {
    anotherRun();
    const [winner, loser] = await pair();
    db.prepare('INSERT INTO memory_usages VALUES (?, ?, ?)').run('run_2', loser.id, 0.7);

    await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    expect(usagesOf('run_2')).toEqual([{ memory_id: winner.id, score: 0.7 }]);
    expect(store.recalledFor('run_2').map((entry) => entry.title)).toEqual(['Winner']);
  });

  it('a plain delete would have lost that history — the counter-proof', async () => {
    anotherRun();
    const [, loser] = await pair();
    db.prepare('INSERT INTO memory_usages VALUES (?, ?, ?)').run('run_2', loser.id, 0.7);

    store.delete(loser.id);

    expect(usagesOf('run_2')).toEqual([]);
  });

  it('keeps the better score when one run had seen both', async () => {
    const [winner, loser] = await pair();
    const link = db.prepare('INSERT INTO memory_usages VALUES (?, ?, ?)');
    link.run(runId, winner.id, 0.4);
    link.run(runId, loser.id, 0.9);

    await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    // (run_id, memory_id) is the primary key, so the two rows collide. Taking
    // the larger score keeps the attribution `reinforce` derives from it.
    expect(usagesOf(runId)).toEqual([{ memory_id: winner.id, score: 0.9 }]);
  });

  it('sums the evidence and unions the protections', async () => {
    const [winner, loser] = await pair();
    db.prepare(
      `UPDATE memories SET use_count=3, success_count=2, confidence=0.5,
         last_used_at=5000, created_at=200 WHERE id=?`,
    ).run(winner.id);
    db.prepare(
      `UPDATE memories SET use_count=4, success_count=1, confidence=0.8, pinned=1,
         last_used_at=9000, created_at=100 WHERE id=?`,
    ).run(loser.id);

    const { memory } = await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    expect(memory.useCount).toBe(7);
    expect(memory.successCount).toBe(3);
    expect(memory.confidence).toBe(0.8);
    expect(memory.pinned).toBe(true);
    expect(memory.tags).toEqual(['alpha', 'beta']);
    expect(memory.lastUsedAt).toBe(9000);
    expect(memory.createdAt).toBe(100);
  });

  it('keeps the winner’s kind and title when the caller rewrites neither', async () => {
    const [winner, loser] = await pair();

    const { memory } = await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    expect(memory.kind).toBe('semantic');
    expect(memory.title).toBe('Winner');
    expect(memory.content).toBe('The surviving body of text.');
  });

  /**
   * Folding two never-used memories must leave `last_used_at` null, not 0.
   *
   * `Math.max` over nullables answers 0 for "never", and `decay` reads that
   * column as an epoch millisecond: a 0 means used in 1970, so the memory is
   * three hundred half-lives idle and the very first sweep takes its
   * confidence to nothing. The row would then be below the retrieval floor,
   * never retrievable again, and `collect()` would delete it permanently — a
   * merge that silently destroys what it was asked to preserve. Written after
   * a deliberate sabotage of `latest()` failed to turn any test red.
   */
  it('a merge of never-used memories stays never-used, and does not fall off the 1970 cliff', async () => {
    const [winner, loser] = await pair();
    db.prepare('UPDATE memories SET created_at = ?, last_used_at = NULL').run(Date.now() - 30 * DAY);

    const { memory } = await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    expect(memory.lastUsedAt).toBeNull();

    // Decay measures idleness from `last_used_at ?? created_at`. Thirty days
    // past the grace period is a third of a half-life, so 0.7 lands near 0.56.
    // Written as a 0 instead of a null it would be a third of a *century*, and
    // this single sweep would take the memory below the retrieval floor — from
    // which nothing can retrieve it again and `collect()` deletes it for good.
    store.decay();
    const after = store.get(winner.id)!.confidence;
    expect(after).toBeGreaterThan(0.5);
    expect(after).toBeLessThan(0.7);
  });

  it('inherits a provenance the winner does not have', async () => {
    const [winner, loser] = await pair();
    db.prepare('UPDATE memories SET source_run_id = ? WHERE id = ?').run(runId, loser.id);

    const { memory } = await store.reconcile({ winnerId: winner.id, loserIds: [loser.id] });

    expect(memory.sourceRunId).toBe(runId);
  });

  /**
   * The rows are read to build the embedding text, and embedding is awaited —
   * so anything that runs on that await sees a half-decided reconciliation.
   * A concurrent delete used to leave the winner carrying the use counts of a
   * row that no longer existed, and a concurrent edit used to have its text
   * silently overwritten by the copy read before the await. The decision is
   * re-taken inside the transaction, where nothing else can interleave.
   *
   * Driven through the embedder because that is where the await genuinely is:
   * a test that only asserted the guard exists would pass against a guard
   * placed anywhere at all.
   */
  it('refuses rather than folding a memory deleted while it was being prepared', async () => {
    const [winner, loser] = await pair();
    const racing = new MemoryStore(
      db,
      interposed(() => {
        db.prepare('DELETE FROM memories WHERE id = ?').run(loser.id);
      }),
    );

    await expect(
      racing.reconcile({ winnerId: winner.id, loserIds: [loser.id], content: 'rewritten' }),
    ).rejects.toThrow(/no longer exists|changed/i);

    expect(store.get(winner.id)?.useCount).toBe(0);
    expect(store.get(winner.id)?.content).toBe('The surviving body of text.');
  });

  it('refuses rather than overwriting an edit made while it was being prepared', async () => {
    const [winner, loser] = await pair();
    const racing = new MemoryStore(
      db,
      interposed(() => {
        db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('edited elsewhere', winner.id);
      }),
    );

    // The caller rewrote only the title, so the body would come from the copy
    // read before the await — the operator's edit, gone without a trace.
    await expect(
      racing.reconcile({ winnerId: winner.id, loserIds: [loser.id], title: 'Renamed' }),
    ).rejects.toThrow(/changed/i);

    expect(store.get(winner.id)?.content).toBe('edited elsewhere');
    expect(store.get(loser.id)).not.toBeNull();
  });

  it('re-embeds when the caller rewrites the surviving text', async () => {
    const [winner, loser] = await pair();

    await store.reconcile({
      winnerId: winner.id,
      loserIds: [loser.id],
      title: 'Consolidated',
      content: 'A single sentence about zzyzx, the distinctive marker.',
    });

    const found = await store.search('zzyzx', { workspaceId: wsA });
    expect(found.map((entry) => entry.memory.title)).toEqual(['Consolidated']);
    // And the absorbed row leaves nothing behind in the lexical index either.
    expect(await store.search('different body entirely', { workspaceId: wsA })).toHaveLength(0);
  });

  /**
   * The one rule that cannot be relaxed. Two workspaces are two projects, and
   * folding one's memory into the other's would carry knowledge across the
   * boundary every scope clause in this file exists to enforce.
   */
  it('refuses to fold a memory belonging to another workspace', async () => {
    const [winner] = await pair();
    const { memory: elsewhere } = await store.remember({
      workspaceId: wsB,
      kind: 'semantic',
      title: 'Belongs to beta',
      content: 'Another project entirely.',
    });

    await expect(store.reconcile({ winnerId: winner.id, loserIds: [elsewhere.id] })).rejects.toThrow(
      /same workspace/i,
    );

    expect(store.get(elsewhere.id)).not.toBeNull();
    expect(store.count()).toBe(3);
  });

  it('allows a global memory and a workspace one to be folded together', async () => {
    const [winner] = await pair();
    const { memory: global } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Everywhere',
      content: 'Applies to every workspace.',
    });

    const result = await store.reconcile({ winnerId: winner.id, loserIds: [global.id] });

    expect(result.absorbed).toEqual([global.id]);
    expect(result.memory.workspaceId).toBe(wsA);
  });

  it('refuses a winner listed among its own losers, and unknown ids', async () => {
    const [winner, loser] = await pair();

    await expect(store.reconcile({ winnerId: winner.id, loserIds: [winner.id] })).rejects.toThrow(
      /itself/i,
    );
    await expect(store.reconcile({ winnerId: 'mem_nope', loserIds: [loser.id] })).rejects.toThrow(
      /no longer exists/i,
    );
    await expect(store.reconcile({ winnerId: winner.id, loserIds: ['mem_nope'] })).rejects.toThrow(
      /no longer exists/i,
    );

    expect(store.count()).toBe(2);
  });

  it('leaves nothing half-done when a later loser is invalid', async () => {
    const [winner, loser] = await pair();
    db.prepare('UPDATE memories SET use_count = 5 WHERE id = ?').run(loser.id);

    await expect(
      store.reconcile({ winnerId: winner.id, loserIds: [loser.id, 'mem_nope'] }),
    ).rejects.toThrow();

    // One transaction for the whole call: the valid loser survives untouched
    // rather than being folded in on the way to the failure.
    expect(store.get(loser.id)).not.toBeNull();
    expect(store.get(winner.id)?.useCount).toBe(0);
  });

  it('folds several memories at once', async () => {
    const [winner, first] = await pair();
    const { memory: second } = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Third',
      content: 'Yet another body.',
      tags: ['gamma'],
    });
    db.prepare('UPDATE memories SET use_count = 2 WHERE id IN (?, ?)').run(first.id, second.id);

    const result = await store.reconcile({
      winnerId: winner.id,
      loserIds: [first.id, second.id],
    });

    expect(result.absorbed.sort()).toEqual([first.id, second.id].sort());
    expect(result.memory.useCount).toBe(4);
    expect(result.memory.tags).toEqual(['alpha', 'beta', 'gamma']);
    expect(store.count()).toBe(1);
  });
});

describe('promote / confine', () => {
  it('promotion makes a memory reachable from every other workspace', async () => {
    const { memory } = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Test command',
      content: 'The tests run with pnpm test:run from the repository root.',
    });

    expect(await store.search('pnpm test', { workspaceId: wsB })).toHaveLength(0);

    const result = await store.promote(memory.id);

    expect(result.moved).toBe(true);
    expect(result.memory.workspaceId).toBeNull();
    expect(await store.search('pnpm test', { workspaceId: wsB })).toHaveLength(1);
  });

  /**
   * `memories.workspace_id` cascades on workspace delete, so the tier a memory
   * sits on decides whether it survives its project. Worth pinning: it is the
   * one consequence of promotion that has nothing to do with retrieval.
   */
  it('promotion outlives the workspace the memory was learned in', async () => {
    const kept = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Promoted',
      content: 'Survives its project.',
    });
    const doomed = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Left behind',
      content: 'Does not survive its project.',
    });

    await store.promote(kept.memory.id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsA);

    expect(store.get(kept.memory.id)).not.toBeNull();
    expect(store.get(doomed.memory.id)).toBeNull();
  });

  it('promoting something already global is a no-op, not an error', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Already there',
      content: 'Global from birth.',
    });

    const result = await store.promote(memory.id);

    expect(result.moved).toBe(false);
    expect(result.memory).toEqual(memory);
  });

  it('confining a global memory takes it out of every other workspace', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Test command',
      content: 'The tests run with pnpm test:run from the repository root.',
    });

    expect(await store.search('pnpm test', { workspaceId: wsB })).toHaveLength(1);

    const result = await store.confine(memory.id, wsA);

    expect(result.moved).toBe(true);
    expect(result.memory.workspaceId).toBe(wsA);
    expect(await store.search('pnpm test', { workspaceId: wsB })).toHaveLength(0);
    expect(await store.search('pnpm test', { workspaceId: wsA })).toHaveLength(1);
  });

  it('confining to the workspace it already sits in is a no-op', async () => {
    const { memory } = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Stays put',
      content: 'Already where it belongs.',
    });

    const result = await store.confine(memory.id, wsA);

    expect(result.moved).toBe(false);
    expect(result.memory).toEqual(memory);
  });

  it('refuses to confine to a workspace that does not exist', async () => {
    const { memory } = await store.remember({
      workspaceId: null,
      kind: 'semantic',
      title: 'Anything',
      content: 'Anything at all.',
    });

    await expect(store.confine(memory.id, 'ws_nope')).rejects.toThrow(/no such workspace/i);
    expect(store.get(memory.id)?.workspaceId).toBeNull();
  });

  it('refuses to promote or confine a memory that is gone', async () => {
    await expect(store.promote('mem_nope')).rejects.toThrow(/no longer exists/i);
    await expect(store.confine('mem_nope', wsA)).rejects.toThrow(/no longer exists/i);
  });

  it('a scope move touches updated_at, so the recency prior sees the curation', async () => {
    const { memory } = await store.remember({
      workspaceId: wsA,
      kind: 'semantic',
      title: 'Curated',
      content: 'Moved by hand.',
    });
    db.prepare('UPDATE memories SET updated_at = 1000 WHERE id = ?').run(memory.id);

    const result = await store.promote(memory.id);

    expect(result.memory.updatedAt).toBeGreaterThan(1000);
  });
});

/* -------------------------------------------------------------------------- */
/* Shelves, retirement and supersession                                       */
/* -------------------------------------------------------------------------- */

/**
 * The durability of a memory, orthogonal to its kind. Measured before it
 * existed: five memories saying the same fact at five moments, none of them
 * distinguishable from a convention by anything in the row, the steward
 * writing "[Obsolete]" into titles for lack of a way to retire one, and a
 * state fact staying retrievable for 230 idle days.
 */
describe('shelves, retirement and supersession', () => {
  const DAY = 86_400_000;
  const seed = (title: string, content: string, extra: Record<string, unknown> = {}) =>
    store.remember({ workspaceId: wsA, kind: 'semantic', title, content, ...extra });

  it('stores the shelf, defaulting to durable, and exposes the retirement fields', async () => {
    const { memory: volatile } = await seed('Port', 'The API listens on 8787.', { shelf: 'volatile' });
    const { memory: plain } = await seed('Plain', 'Nothing about durability said.');

    expect(volatile.shelf).toBe('volatile');
    expect(volatile).toMatchObject({ retiredAt: null, supersededBy: null });
    expect(plain.shelf).toBe('durable');
    expect((await store.update(plain.id, { shelf: 'standing' }))?.shelf).toBe('standing');
  });

  it('a retired memory leaves search and the duplicate check, stays listed, and comes back on restore', async () => {
    // Three rows: bm25 needs a corpus for its IDF to be non-zero.
    const { memory: target } = await seed('Vault key', 'The vault key is rotated quarterly by hand.');
    await seed('Filler one', 'Deploys run from the pipeline.');
    await seed('Filler two', 'Backups land nightly on the volume.');

    expect((await store.search('vault key rotated', { workspaceId: wsA })).map((r) => r.memory.id)).toContain(target.id);
    const retired = store.retire(target.id, { now: 1_000 });
    expect(retired).toMatchObject({ retiredAt: 1_000, supersededBy: null });

    expect((await store.search('vault key rotated', { workspaceId: wsA })).map((r) => r.memory.id)).not.toContain(target.id);
    // Off the list every reader uses — synthesis, the steward, the counts —
    // and on it only where the Memory page asks, to fold it rather than lose it.
    expect(store.list({ workspaceId: wsA }).some((m) => m.id === target.id)).toBe(false);
    expect(store.list({ workspaceId: wsA, includeRetired: true }).some((m) => m.id === target.id && m.retiredAt !== null)).toBe(true);
    expect(store.count(wsA)).toBe(2);
    expect(store.stats(wsA).semantic).toBe(2);
    // A retired near-duplicate must not absorb a fresh write of the same text.
    const again = await seed('Vault key', 'The vault key is rotated quarterly by hand.');
    expect(again.merged).toBe(false);
    expect(again.memory.id).not.toBe(target.id);

    expect(store.restore(target.id)?.retiredAt).toBeNull();
    expect((await store.search('vault key rotated', { workspaceId: wsA })).map((r) => r.memory.id)).toContain(target.id);
  });

  it('refuses to retire a pinned memory', async () => {
    const { memory } = await seed('Pinned', 'Never lose this.', { pinned: true });
    expect(() => store.retire(memory.id)).toThrow(/pinned/);
    expect(store.get(memory.id)?.retiredAt).toBeNull();
  });

  /**
   * A machine decides a supersession, so it is bounded by rule rather than
   * by the model's judgement: the arbiter was measured wanting to replace the
   * operator's pinned convention with a note derived from it.
   */
  it('supersede retires the loser pointing at the winner, and refuses a pinned, a non-volatile or a foreign loser', async () => {
    const { memory: old } = await seed('Form', 'The form offers cron, interval and manual.', { shelf: 'volatile' });
    const { memory: current } = await seed('Form now', 'The form offers cron, interval, manual and event.', { shelf: 'volatile' });
    const { memory: durable } = await seed('Rule', 'Tests run with pnpm test:run.');
    const { memory: pinned } = await seed('Convention', 'Requests go through the board.', { shelf: 'volatile', pinned: true });
    const { memory: elsewhere } = await store.remember({ workspaceId: wsB, kind: 'semantic', title: 'Other', content: 'Another project.', shelf: 'volatile' });

    expect(store.supersede(old.id, current.id, 5_000)).toMatchObject({ retiredAt: 5_000, supersededBy: current.id });
    expect(() => store.supersede(durable.id, current.id)).toThrow(/volatile/);
    expect(() => store.supersede(pinned.id, current.id)).toThrow(/pinned/);
    expect(() => store.supersede(elsewhere.id, current.id)).toThrow(/same workspace/);
    expect(() => store.supersede(current.id, current.id)).toThrow(/itself/);
    expect(() => store.supersede(current.id, old.id)).toThrow(/retired/);
    // A global winner may supersede a workspace loser: the tier is exempt both ways.
    const { memory: global } = await store.remember({ workspaceId: null, kind: 'semantic', title: 'Global', content: 'Holds everywhere.' });
    const { memory: local } = await seed('Local', 'Held here once.', { shelf: 'volatile' });
    expect(store.supersede(local.id, global.id).supersededBy).toBe(global.id);
  });

  it('standing() lists the scope conventions and the global ones, pinned first, never a retired one', async () => {
    const { memory: a } = await seed('Brief in French', 'Briefs are written in French.', { shelf: 'standing' });
    const { memory: b } = await seed('Propose defaults', 'Propose a default rather than ask three questions.', { shelf: 'standing', pinned: true });
    const { memory: g } = await store.remember({ workspaceId: null, kind: 'procedural', title: 'Board first', content: 'Requests go through the board.', shelf: 'standing' });
    const { memory: gone } = await seed('Old rule', 'Retired convention.', { shelf: 'standing' });
    await store.remember({ workspaceId: wsB, kind: 'semantic', title: 'Theirs', content: 'Another workspace convention.', shelf: 'standing' });
    await seed('Just a fact', 'Not standing at all.');
    store.retire(gone.id);

    const ids = store.standing(wsA).map((m) => m.id);
    expect(ids[0]).toBe(b.id);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id, g.id]));
    expect(store.standing(null).map((m) => m.id)).toEqual([g.id]);
  });

  it('search can leave the standing shelf out, since the kernel injects it whole', async () => {
    const { memory: rule } = await seed('Deploy rule', 'Deploys wait for a green pipeline.', { shelf: 'standing' });
    await seed('Deploy note', 'Deploys take about two minutes.');
    await seed('Filler', 'Unrelated content about tests.');

    const all = await store.search('deploys pipeline', { workspaceId: wsA });
    const without = await store.search('deploys pipeline', { workspaceId: wsA, excludeStanding: true });
    expect(all.map((r) => r.memory.id)).toContain(rule.id);
    expect(without.map((r) => r.memory.id)).not.toContain(rule.id);
    expect(without.length).toBeGreaterThan(0);
  });

  it('decays each shelf on its own clock: standing never, volatile three times faster than durable', async () => {
    const start = Date.now();
    const { memory: standing } = await seed('Standing', 'A convention.', { shelf: 'standing', confidence: 0.8 });
    const { memory: durable } = await seed('Durable', 'A lesson.', { confidence: 0.8 });
    const { memory: volatile } = await seed('Volatile', 'A fact.', { shelf: 'volatile', confidence: 0.8 });

    store.decay({ halfLifeDays: 90, now: start + 30 * DAY });

    expect(store.get(standing.id)?.confidence).toBe(0.8);
    expect(store.get(volatile.id)?.confidence).toBeCloseTo(0.4, 2);
    expect(store.get(durable.id)?.confidence).toBeCloseTo(0.8 * 0.5 ** (30 / 90), 2);
  });

  it('reinforce leaves a standing memory alone', async () => {
    const { memory: standing } = await seed('Standing', 'A convention.', { shelf: 'standing', confidence: 0.5 });
    const { memory: durable } = await seed('Durable', 'A lesson.', { confidence: 0.5 });
    store.recordUsage(runId, [
      { memory: standing, score: 1 } as MemorySearchResult,
      { memory: durable, score: 1 } as MemorySearchResult,
    ]);

    store.reinforce(runId, 1);

    expect(store.get(standing.id)?.confidence).toBe(0.5);
    expect(store.get(durable.id)!.confidence).toBeGreaterThan(0.5);
  });

  it('collect removes a retired memory after thirty days, not before, and never a pinned one', async () => {
    const { memory: recent } = await seed('Recent', 'Retired yesterday.');
    const { memory: old } = await seed('Old', 'Retired long ago.');
    const { memory: kept } = await seed('Kept', 'Still current.');
    const now = Date.now();
    store.retire(recent.id, { now: now - DAY });
    store.retire(old.id, { now: now - 31 * DAY });

    expect(store.collect(now)).toBe(1);
    expect(store.get(old.id)).toBeNull();
    expect(store.get(recent.id)?.retiredAt).not.toBeNull();
    expect(store.get(kept.id)).not.toBeNull();
  });
});
