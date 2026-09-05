/**
 * Embedders for tests: a sentence-transformer's *shape* without a model.
 *
 * `ConceptEmbedder` maps words to concepts and a text to the normalised sum of
 * its concept vectors, so two texts that say the same thing in different words
 * land close and unrelated ones do not — the property every gate in
 * `retrieval.ts` is calibrated on, reproduced deterministically. Its `family`
 * is `st`, so the stores pick the semantic profile, and its `ready` flag can
 * be flipped, which is how the not-ready paths are exercised at all.
 */

import type { EmbedderFamily, EmbeddingProvider } from '../learning/embeddings.js';
import { l2Normalise, tokenize } from '../learning/embeddings.js';

const DIMENSION = 64;

/** Words that mean the same thing share a concept; everything else is its own. */
const SYNONYMS: Record<string, string[]> = {
  // The six rephrased questions of the evaluation corpus, each mapped onto
  // the words of the one passage that answers it — the paraphrase a real
  // model bridges, spelled out.
  leave: ['leave', 'quit', 'depart', 'partir', 'quitter', 'congé', 'préavis', 'notice', 'pénalité', 'délai'],
  money: ['money', 'deposit', 'argent', 'dépôt', 'garantie', 'refund', 'rendu', 'restitué', 'restitution', 'sortie'],
  theft: ['cambriolé', 'cambriolage', 'vol', 'effraction', 'volé', 'burglary', 'stolen'],
  water: ['canalisation', 'fuit', 'fuite', 'dégât', 'dégâts', 'eaux', 'franchise', 'poche', 'leak', 'plumbing'],
  boiler: ['boiler', 'chaudière', 'replace', 'remplacement', 'remplacer', 'bailleur', 'landlord', 'charge'],
  install: ['install', 'installer', 'pnpm', 'npm', 'packages', 'paquets', 'gestionnaire'],
  deploy: ['deploy', 'déployer', 'update', 'mise', 'jour', 'release', 'version', 'production', 'prod', 'démarre', 'starts', 'healthy'],
  fail: ['fail', 'failed', 'échec', 'erreur', 'error', 'rollback', 'rolled', 'back', 'retour', 'jamais', 'never'],
  cat: ['cat', 'chat', 'windowsill', 'fenêtre', 'afternoon'],
  recipe: ['recipe', 'recette', 'eggs', 'œufs', 'salt', 'sel'],
};
const CONCEPT_OF = new Map<string, string>();
for (const [concept, words] of Object.entries(SYNONYMS)) {
  for (const word of words) CONCEPT_OF.set(word, concept);
}

function conceptVector(concept: string): Float32Array {
  // A stable pseudo-random unit vector per concept, from a tiny hash.
  const vector = new Float32Array(DIMENSION);
  let seed = 0;
  for (const char of concept) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  for (let i = 0; i < DIMENSION; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vector[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return l2Normalise(vector);
}

export class ConceptEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimension = DIMENSION;
  readonly family: EmbedderFamily = 'st';
  ready: boolean;
  /** Every text embedded, in order — for asserting what reached the model. */
  readonly embedded: string[] = [];

  constructor(options: { id?: string; ready?: boolean } = {}) {
    this.id = options.id ?? 'st:test/concepts';
    this.ready = options.ready ?? true;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedSync(text));
  }

  embedSync(text: string): Float32Array {
    if (!this.ready) throw new Error(`${this.id} is not ready`);
    this.embedded.push(text);
    const vector = new Float32Array(DIMENSION);
    let any = false;
    for (const token of tokenize(text)) {
      const concept = CONCEPT_OF.get(token) ?? (token.length > 3 ? `word:${token}` : null);
      if (!concept) continue;
      any = true;
      const part = conceptVector(concept);
      for (let i = 0; i < DIMENSION; i += 1) vector[i] = (vector[i] as number) + (part[i] as number);
    }
    // A text of nothing but function words gets a fixed, distinct direction
    // rather than a zero vector, as a real model would.
    if (!any) return conceptVector('∅');
    return l2Normalise(vector);
  }
}

/** A provider whose model has not loaded: nothing may be written or compared. */
export function pendingEmbedder(id = 'st:test/concepts'): ConceptEmbedder {
  return new ConceptEmbedder({ id, ready: false });
}
