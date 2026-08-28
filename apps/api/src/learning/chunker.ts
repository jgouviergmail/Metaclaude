/**
 * Split a document into retrieval chunks.
 *
 * The design follows what actually improves retrieval on a corpus like this
 * one, not what a tokenizer makes convenient:
 *
 *  - **Paragraphs first.** A paragraph is the author's own unit of meaning;
 *    chunks are built by packing whole paragraphs toward a target size and
 *    only splitting inside one when it alone exceeds the ceiling — first at
 *    sentence boundaries, then, for a wall of text with no punctuation, at a
 *    word boundary near the limit.
 *  - **Headings travel with their text.** A chunk that says "45 jours" is
 *    useless unless it still knows it came from *Résiliation — préavis*. The
 *    nearest markdown heading above each chunk is carried beside it, embedded
 *    with it, and indexed with it — the cheap version of contextual retrieval,
 *    and the part of it that pays.
 *  - **Overlap at the seams.** The tail of each chunk is prepended to the
 *    next, cut at a word boundary, so a sentence that straddles a boundary is
 *    findable from either side. ~13% of the target, in the usual 10–20% band.
 *
 * Sizes are in characters, deliberately: every consumer here (the hashing
 * embedder, fts5, the context budget) measures characters, and a token count
 * would be an estimate of an estimate. ~1100 characters is ~250 tokens, the
 * middle of the range retrieval work keeps converging on.
 */

export interface Chunk {
  seq: number;
  /** The nearest markdown heading above this chunk; '' when there is none. */
  heading: string;
  text: string;
}

export const CHUNK_TARGET = 1100;
export const CHUNK_MAX = 1600;
export const CHUNK_OVERLAP = 150;

const HEADING = /^(#{1,6})\s+(.*)$/;

/** The last CHUNK_OVERLAP characters, cut forward to a word boundary. */
function tailOf(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text;
  const slice = text.slice(-CHUNK_OVERLAP);
  const firstSpace = slice.search(/\s/u);
  return firstSpace === -1 ? slice : slice.slice(firstSpace + 1);
}

/** Split one oversized paragraph at sentence, then word, then raw boundaries. */
function splitLong(paragraph: string): string[] {
  if (paragraph.length <= CHUNK_MAX) return [paragraph];

  // Sentence boundaries, unicode-aware: the punctuation plus following space.
  // French quotation and ellipsis included — this corpus is written in both
  // languages.
  const sentences = paragraph.split(/(?<=[.!?…»])\s+/u);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > CHUNK_MAX) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);

  // A "sentence" longer than the ceiling is a wall of text with no
  // punctuation; cut it at word boundaries, and only then by force.
  return pieces.flatMap((piece) => {
    if (piece.length <= CHUNK_MAX) return [piece];
    const words = piece.split(/\s+/u);
    const out: string[] = [];
    let run = '';
    for (const word of words) {
      if (run && run.length + word.length + 1 > CHUNK_MAX) {
        out.push(run);
        run = word;
      } else {
        run = run ? `${run} ${word}` : word;
      }
      // A single "word" beyond the ceiling (a base64 blob, a minified line)
      // is sliced raw: indexing it in pieces beats refusing the document.
      while (run.length > CHUNK_MAX) {
        out.push(run.slice(0, CHUNK_MAX));
        run = run.slice(CHUNK_MAX);
      }
    }
    if (run) out.push(run);
    return out;
  });
}

export function chunkDocument(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = '';
  let headingOfChunk = '';
  let parts: string[] = [];
  let length = 0;
  let overlap = '';

  const flush = (): void => {
    const text = parts.join('\n\n').trim();
    if (text.length > 0) {
      chunks.push({ seq: chunks.length, heading: headingOfChunk, text });
      overlap = tailOf(text);
    }
    parts = [];
    length = 0;
  };

  // Paragraphs: blank-line separated blocks, whatever the line endings.
  for (const raw of content.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const paragraph = raw.trim();
    if (paragraph.length === 0) continue;

    // A heading flushes the chunk in progress: a chunk should not straddle
    // two sections, or its heading label lies about half of it.
    const lines = paragraph.split('\n');
    const headingMatch = lines[0] ? HEADING.exec(lines[0]) : null;
    if (headingMatch) {
      flush();
      heading = headingMatch[2]!.trim();
      overlap = '';
      const rest = lines.slice(1).join('\n').trim();
      if (rest.length === 0) continue;
      for (const piece of splitLong(rest)) {
        pack(piece);
      }
      continue;
    }

    for (const piece of splitLong(paragraph)) pack(piece);
  }
  flush();
  return chunks;

  function pack(piece: string): void {
    if (length > 0 && length + piece.length + 2 > CHUNK_TARGET) flush();
    if (parts.length === 0) {
      headingOfChunk = heading;
      // The seam: carry the previous chunk's tail so a thought cut at the
      // boundary is findable from either side. Never across a heading —
      // `overlap` is cleared there.
      if (overlap) {
        parts.push(`… ${overlap}`);
        length += overlap.length + 4;
      }
    }
    parts.push(piece);
    length += piece.length + 2;
  }
}

/**
 * The text a chunk is embedded and displayed with: the document's title and
 * the section heading, then the body. Prepending the context is what lets
 * "the notice period is 45 days" match a query about *terminating the lease*
 * — the chunk alone never says what it is about.
 */
export function chunkEmbeddingText(docTitle: string, chunk: Chunk): string {
  const context = [docTitle.trim(), chunk.heading.trim()].filter(Boolean).join(' — ');
  return context ? `${context}\n${chunk.text}` : chunk.text;
}
