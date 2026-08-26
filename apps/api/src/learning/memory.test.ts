import type { MemorySearchResult } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import { DUPLICATE_THRESHOLD, FORGET_THRESHOLD, MemoryStore, toFtsQuery } from './memory.js';

const DAY = 86_400_000;

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

  it('does not merge across workspaces or kinds', async () => {
    const input = {
      kind: 'semantic' as const,
      title: 'API port',
      content: 'The API server runs on port 8080',
    };
    expect((await store.remember({ ...input, workspaceId: null })).merged).toBe(false);
    expect((await store.remember({ ...input, workspaceId: wsA })).merged).toBe(false);
    expect((await store.remember({ ...input, workspaceId: wsB })).merged).toBe(false);
    expect((await store.remember({ ...input, workspaceId: null, kind: 'procedural' })).merged).toBe(
      false,
    );
    expect(store.count()).toBe(4);
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
    expect(toFtsQuery('foo* NEAR bar')).toBe('"foo" OR "near" OR "bar"');
    expect(toFtsQuery('vitest AND NOT jest')).toBe('"vitest" OR "and" OR "not" OR "jest"');
    expect(toFtsQuery('col:on')).toBe('"col" OR "on"');
    expect(toFtsQuery('-minus ^caret')).toBe('"minus" OR "caret"');
    expect(toFtsQuery('a "quoted" phrase')).toBe('"quoted" OR "phrase"');
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
    expect(toFtsQuery('Déployer EN Production')).toBe('"déployer" OR "en" OR "production"');
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
