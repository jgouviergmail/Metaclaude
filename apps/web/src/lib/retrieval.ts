/**
 * What retrieval is, in words a screen can show.
 *
 * One reading of the server's `retrieval` status for every place that shows
 * it — the Settings row, the Memory page, the Dashboard stat — so "semantic"
 * is claimed in exactly one place, and only when a sentence-transformer is
 * loaded and answering. The strings are module constants translated at the
 * render site, the pattern the catalogue ratchets know.
 */

import type { RetrievalStatus } from '@metaclaude/shared';

export type RetrievalTone = 'success' | 'warning' | 'neutral' | 'thinking';

export interface RetrievalView {
  /** One or two words for a badge. */
  label: string;
  tone: RetrievalTone;
  /** One sentence for a detail line; null when there is nothing to add. */
  detail: string;
  /** The model, short: `bge-m3`, `hash`. */
  model: string;
  /** Rows waiting for a rebuild, all stores together. */
  pending: number;
  /** True when the state deserves a line on screens that otherwise stay quiet. */
  attention: boolean;
  /** True only while a sentence-transformer is loaded and answering — the one case a screen may say "meaning". */
  semantic: boolean;
}

export const RETRIEVAL_COPY = {
  semantic: { label: 'Semantic', detail: 'Search matches meaning, in French and English alike.' },
  loading: { label: 'Model loading', detail: 'Search matches words until the model is ready; new memories wait for their vectors.' },
  unavailable: { label: 'Model unavailable', detail: 'The model did not load, so search matches words, not meaning. The doctor says why.' },
  words: { label: 'Words only', detail: 'The built-in hashing embedder matches words, not meaning.' },
  unknown: { label: 'Unknown', detail: 'The server has not said what retrieval is running on.' },
} as const;

/** `st:Xenova/bge-m3` → `bge-m3`; `hash-v1:512` → `hash`. */
export function shortModelName(id: string): string {
  if (id.startsWith('hash')) return 'hash';
  return id.replace(/^st:/, '').replace(/^[^/]+\//, '');
}

export function describeRetrieval(status: RetrievalStatus | null | undefined): RetrievalView {
  if (!status) {
    return { ...RETRIEVAL_COPY.unknown, tone: 'neutral', model: '', pending: 0, attention: false, semantic: false };
  }
  const pending = status.pending.memories + status.pending.documents + status.pending.exemplars;
  const model = shortModelName(status.embedder);
  if (status.family === 'hash') {
    return { ...RETRIEVAL_COPY.words, tone: 'neutral', model, pending, attention: pending > 0, semantic: false };
  }
  if (status.state === 'loading') {
    return { ...RETRIEVAL_COPY.loading, tone: 'thinking', model, pending, attention: true, semantic: false };
  }
  if (status.state === 'lexical-only') {
    return { ...RETRIEVAL_COPY.unavailable, tone: 'warning', model, pending, attention: true, semantic: false };
  }
  return { ...RETRIEVAL_COPY.semantic, tone: 'success', model, pending, attention: pending > 0, semantic: true };
}
