import { HASH_EMBEDDING_DIM } from '@metaclaude/shared';
import { describe, expect, it } from 'vitest';
import { HashingEmbedder, cosineSimilarity, l2Normalise, tokenize } from './embeddings.js';

const embedder = new HashingEmbedder();

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

describe('tokenize', () => {
  it('lowercases and splits on non word characters', () => {
    expect(tokenize('Hello, World! 42')).toEqual(['hello', 'world', '42']);
    expect(tokenize('snake_case stays_one_token')).toEqual(['snake_case', 'stays_one_token']);
    expect(tokenize('a-b/c.d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps accented French words whole rather than splitting them', () => {
    expect(tokenize('Déployer la mise à jour')).toEqual(['déployer', 'la', 'mise', 'à', 'jour']);
    expect(tokenize("L'élève a réussi")).toEqual(['l', 'élève', 'a', 'réussi']);
    expect(tokenize('ÉCRIS un RÉSUMÉ')).toEqual(['écris', 'un', 'résumé']);
  });

  it('handles non-latin scripts', () => {
    expect(tokenize('привет мир')).toEqual(['привет', 'мир']);
    expect(tokenize('日本語 テスト')).toEqual(['日本語', 'テスト']);
  });

  it('drops empty tokens and absurdly long ones', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   !!!   ')).toEqual([]);
    expect(tokenize(`short ${'x'.repeat(45)} tail`)).toEqual(['short', 'tail']);
    expect(tokenize('x'.repeat(39))).toHaveLength(1);
  });
});

describe('l2Normalise', () => {
  it('scales a vector to unit length', () => {
    const vector = Float32Array.from([3, 4]);
    const result = l2Normalise(vector);
    expect(result).toBe(vector); // normalises in place
    expect(norm(result)).toBeCloseTo(1, 6);
    expect(result[0]).toBeCloseTo(0.6, 6);
    expect(result[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves a zero vector untouched rather than producing NaN', () => {
    const zero = new Float32Array(8);
    const result = l2Normalise(zero);
    expect(Array.from(result)).toEqual(Array.from(new Float32Array(8)));
    for (const value of result) expect(Number.isNaN(value)).toBe(false);
  });

  it('preserves direction and sign', () => {
    const vector = Float32Array.from([-2, 0, 2]);
    l2Normalise(vector);
    expect(vector[0]).toBeLessThan(0);
    expect(vector[1]).toBe(0);
    expect(vector[2]).toBeGreaterThan(0);
    expect(vector[0]).toBeCloseTo(-vector[2]!, 6);
  });
});

describe('cosineSimilarity', () => {
  it('is a dot product for unit vectors', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, Float32Array.from([-1, 0, 0]))).toBeCloseTo(-1, 6);
  });

  it('returns 0 on a dimension mismatch instead of throwing or reading garbage', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array(0), Float32Array.from([1]))).toBe(0);
  });

  it('is symmetric', () => {
    const a = embedder.embedSync('reciprocal rank fusion');
    const b = embedder.embedSync('dense retrieval with bm25');
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });
});

describe('HashingEmbedder', () => {
  it('advertises a stable id and dimension', () => {
    expect(embedder.dimension).toBe(HASH_EMBEDDING_DIM);
    expect(embedder.id).toBe(`hash-v1:${HASH_EMBEDDING_DIM}`);
    expect(new HashingEmbedder(128).id).toBe('hash-v1:128');
    expect(new HashingEmbedder(128).embedSync('anything')).toHaveLength(128);
  });

  it('produces unit-length vectors', () => {
    for (const text of [
      'hello world',
      'The kernel schedules runs and records their usage.',
      "Déployer l'API derrière nginx avec docker compose",
      'a',
      '  spaced   out  ',
      'x'.repeat(5000),
    ]) {
      const vector = embedder.embedSync(text);
      expect(vector).toHaveLength(HASH_EMBEDDING_DIM);
      expect(norm(vector)).toBeCloseTo(1, 5);
    }
  });

  it('is deterministic for identical input', () => {
    const text = 'reciprocal rank fusion combines dense and lexical retrieval';
    const a = embedder.embedSync(text);
    const b = embedder.embedSync(text);
    const c = new HashingEmbedder().embedSync(text);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).toEqual(Array.from(c));
  });

  it('gives identical texts a cosine of exactly 1', () => {
    const text = 'the audit log is hash chained';
    expect(cosineSimilarity(embedder.embedSync(text), embedder.embedSync(text))).toBeCloseTo(1, 6);
  });

  it('scores related texts above unrelated ones', () => {
    const anchor = embedder.embedSync('Tests are run with vitest in this repository');
    const related = embedder.embedSync('Unit tests run under vitest for this project');
    const unrelated = embedder.embedSync('The deployment uses docker compose on a small VPS');

    const relatedScore = cosineSimilarity(anchor, related);
    const unrelatedScore = cosineSimilarity(anchor, unrelated);
    expect(relatedScore).toBeGreaterThan(unrelatedScore);
    expect(relatedScore).toBeGreaterThan(0.15);
    expect(unrelatedScore).toBeLessThan(0.15);
  });

  it('treats a near-identical restatement as a near-duplicate', () => {
    const a = embedder.embedSync('The API server runs on port 8080');
    const b = embedder.embedSync('The API server runs on port 8080.');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.92);
  });

  it('is robust to a small typo thanks to character n-grams', () => {
    const correct = embedder.embedSync('the workspace repository resolves paths inside a jail');
    const typo = embedder.embedSync('the workspce repository resolves paths inside a jail');
    const different = embedder.embedSync('the bandit samples a beta posterior per arm');
    expect(cosineSimilarity(correct, typo)).toBeGreaterThan(cosineSimilarity(correct, different));
  });

  it('does not produce NaN for empty or whitespace-only input', () => {
    for (const text of ['', '   ', '\n\t', '!!!']) {
      const vector = embedder.embedSync(text);
      expect(vector).toHaveLength(HASH_EMBEDDING_DIM);
      for (const value of vector) expect(Number.isNaN(value)).toBe(false);
      expect(Number.isNaN(cosineSimilarity(vector, embedder.embedSync('anything')))).toBe(false);
    }
    // An empty string has no features at all, so it stays the zero vector.
    expect(norm(embedder.embedSync(''))).toBe(0);
    expect(cosineSimilarity(embedder.embedSync(''), embedder.embedSync('x'))).toBe(0);
  });

  it('separates different texts: the mean off-diagonal similarity stays low', () => {
    const texts = [
      'rate limiting with a token bucket',
      'the audit log is a hash chain',
      'thompson sampling over a beta posterior',
      'path jailing rejects symlink escapes',
      'the event bus buffers frames for replay',
    ];
    const vectors = texts.map((t) => embedder.embedSync(t));
    for (let i = 0; i < vectors.length; i += 1) {
      for (let j = i + 1; j < vectors.length; j += 1) {
        expect(cosineSimilarity(vectors[i]!, vectors[j]!)).toBeLessThan(0.35);
      }
    }
  });

  it('embed() and embedBatch() agree with embedSync()', async () => {
    const texts = ['first text', 'second text', ''];
    const batch = await embedder.embedBatch(texts);
    expect(batch).toHaveLength(3);
    for (let i = 0; i < texts.length; i += 1) {
      expect(Array.from(batch[i]!)).toEqual(Array.from(embedder.embedSync(texts[i]!)));
      expect(Array.from(await embedder.embed(texts[i]!))).toEqual(
        Array.from(embedder.embedSync(texts[i]!)),
      );
    }
    expect(await embedder.embedBatch([])).toEqual([]);
  });

  it('weights repeated terms sub-linearly rather than letting them dominate', () => {
    const once = embedder.embedSync('memory retrieval');
    const many = embedder.embedSync(`memory retrieval ${'memory '.repeat(30)}`);
    // Still recognisably about the same thing despite the repetition.
    expect(cosineSimilarity(once, many)).toBeGreaterThan(0.3);
  });
});
