#!/usr/bin/env node
/**
 * The retrieval bench: measure, do not believe.
 *
 * `retrieval-quality.test.ts` guards the numbers this deployment already
 * achieves. This script is for the other question — "would changing X help?"
 * — and its whole reason to exist is that the answer has been surprising
 * twice already:
 *
 *   • The first measurement returned 100% on every metric, which said nothing
 *     about retrieval and everything about a seventeen-chunk corpus.
 *   • The second, on questions sharing no words with their answers, returned
 *     0% — and 0% *at the candidate pool*, which is what proved a reranking
 *     stage could not help: it reorders candidates, and there were none.
 *
 * Run it after changing the embedder, the chunker, the relevance gates or the
 * fusion. Nothing here asserts; the output is for a person to read.
 *
 *     pnpm --filter @metaclaude/api build
 *     node scripts/eval-retrieval.mjs            # from apps/api
 *     node scripts/eval-retrieval.mjs --copies 12
 *
 * On a deployment where the local sentence-transformer actually loads (this
 * one needs to reach huggingface.co), set METACLAUDE_EMBEDDINGS=local to
 * measure the difference. That is the comparison that matters: the semantic
 * block below is the part a real embedder is expected to unblock.
 */

import { migrate, openDatabase } from '../dist/db/index.js';
import { createEmbeddingProvider } from '../dist/learning/embeddings.js';
import { evalCorpus, EVAL_QUERIES } from '../dist/learning/eval-corpus.js';
import { evaluate, formatReport, recallAt } from '../dist/learning/eval.js';
import { KnowledgeStore } from '../dist/learning/knowledge.js';

const argv = process.argv.slice(2);
const copies = Number(argv[argv.indexOf('--copies') + 1]) || 4;

const flat = (text) => text.replace(/\s+/gu, ' ');

/**
 * Questions phrased the way people actually ask them, sharing (almost) no
 * content word with the passage that answers them. The hashing embedder
 * cannot bridge these; a sentence-transformer should.
 */
const SEMANTIC = [
  ['puis-je partir avant la fin sans pénalité ?', 'Le délai de préavis est de trois'],
  ['quand mon argent me sera-t-il rendu à la sortie ?', 'restitué dans un délai de deux mois'],
  ['on m’a cambriolé, j’ai combien de temps ?', 'ramené à deux jours ouvrés en cas de'],
  ['combien je paie de ma poche si une canalisation fuit ?', 'franchise de 150 euros'],
  ['que se passe-t-il si la nouvelle version ne démarre jamais ?', 'rolled back automatically'],
  ['who pays to replace an old boiler?', 'restent à la charge du bailleur'],
];

const embedder = await createEmbeddingProvider({
  provider: process.env.METACLAUDE_EMBEDDINGS ?? 'hash',
  model: process.env.METACLAUDE_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
  cacheDir: process.env.METACLAUDE_EMBEDDING_CACHE ?? '/tmp/metaclaude-models',
  log: (level, message) => console.log(`[${level}] ${message}`),
});

const db = openDatabase({ path: ':memory:' });
migrate(db);
const store = new KnowledgeStore(db, embedder);

for (const document of evalCorpus(copies)) {
  await store.upsert({ workspaceId: null, title: document.title, content: document.content });
}

const chunks = db.prepare('SELECT id, text FROM document_chunks').all();
const resolve = (needle) => {
  const hits = chunks.filter((chunk) => flat(chunk.text).includes(flat(needle)));
  if (hits.length !== 1) throw new Error(`ground truth "${needle}" matched ${hits.length} chunks`);
  return hits[0].id;
};

console.log(
  `\nembedder ${embedder.id} (${embedder.dimension}d) · ${chunks.length} chunks · copies=${copies}\n`,
);

const lexical = await evaluate(
  EVAL_QUERIES.map((query) => ({
    query: query.query,
    probes: query.probes,
    relevant: query.answers.map(resolve),
  })),
  async (query) => (await store.search(query, { workspaceId: null, limit: 5 })).map((r) => r.chunkId),
  5,
);
console.log(formatReport('questions in-vocabulary', lexical));

const semantic = await evaluate(
  SEMANTIC.map(([query, answer]) => ({ query, probes: 'no lexical overlap', relevant: [resolve(answer)] })),
  async (query) => (await store.search(query, { workspaceId: null, limit: 5 })).map((r) => r.chunkId),
  5,
);
console.log(formatReport('questions rephrased', semantic));

// The ceiling: what any reranking stage could possibly be handed.
let inPool = 0;
for (const [query, answer] of SEMANTIC) {
  const pool = (await store.search(query, { workspaceId: null, limit: 50 })).map((r) => r.chunkId);
  if (recallAt(50, pool, [resolve(answer)]) > 0) inPool += 1;
}
console.log(
  `\nreranking ceiling: the right passage is a candidate for ${inPool}/${SEMANTIC.length} rephrased questions.`,
);
console.log(
  inPool === 0
    ? '  A reranker reorders candidates; there are none to reorder. The embedder is the lever.'
    : '  Reranking could now rescue some of these — worth measuring a cross-encoder.',
);

console.log('\nper rephrased question:');
for (const score of semantic.queries) {
  console.log(`  ${score.recall === 1 ? 'OK  ' : 'MISS'}  ${score.query}`);
}

db.close();
