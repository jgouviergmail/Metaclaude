/**
 * Retrieval fixtures, built from the contract rather than typed from memory.
 *
 * A `KnowledgeSearchResult` carries eleven fields, six of which describe a
 * provenance most tests do not care about — and a fixture written by hand,
 * field by field, is how a suite ends up asserting against a shape the code
 * no longer produces. This builder fills the uninteresting half with the
 * values a passage with no location genuinely has, so a test names only what
 * it is about, and a new field breaks *here* rather than in thirty places.
 */

import type { KnowledgeSearchResult } from '../learning/knowledge.js';

/** A retrieved passage with no location — what a pasted document produces. */
export function searchHit(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    chunkId: 'chk_1',
    documentId: 'doc_1',
    documentTitle: 'Document',
    sourceName: null,
    workspaceId: null,
    heading: '',
    text: 'Du texte.',
    score: 1,
    pageUnit: null,
    pageStart: null,
    pageEnd: null,
    lineStart: null,
    lineEnd: null,
    ...overrides,
  };
}
