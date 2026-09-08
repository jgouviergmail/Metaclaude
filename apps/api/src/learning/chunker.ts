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
  /**
   * Where this chunk's *own* text begins and ends in the normalised content —
   * what makes a retrieved passage citable as "lines 40–52" and openable at
   * the right place.
   *
   * Own text, so the `… ` seam prefix is excluded: it is a copy of the
   * previous chunk's tail and belongs to it, and counting it would make every
   * citation after the first one start too early.
   *
   * `content.slice(start, end)` is the chunk's body verbatim in the ordinary
   * case. It is a *span* rather than a string match for the one case where it
   * cannot be both: the pieces of a paragraph longer than `CHUNK_MAX` are
   * re-joined with single spaces, so a paragraph that wrapped across lines
   * has a body no substring of the content equals. The span still bounds it,
   * which is what a line number needs.
   */
  start: number;
  end: number;
}

/** One unit of text — a sentence, a word run, a raw slice — and where it sits. */
interface Piece {
  text: string;
  start: number;
  end: number;
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

/**
 * Locate each unit of `units` inside `source`, in order, from a moving cursor.
 *
 * The units come from splitting `source` itself, so each one *is* there; the
 * cursor is what keeps a repeated sentence from matching its first occurrence
 * every time. A unit that somehow does not match leaves the cursor where it
 * was rather than throwing: a wrong-by-a-few-characters line number is a far
 * better outcome than refusing to index the document.
 */
function locate(source: string, units: readonly string[], from = 0): Piece[] {
  let cursor = from;
  return units.map((unit) => {
    const at = source.indexOf(unit, cursor);
    const start = at === -1 ? cursor : at;
    cursor = start + unit.length;
    return { text: unit, start, end: cursor };
  });
}

/**
 * Split one oversized paragraph at sentence, then word, then raw boundaries.
 *
 * Offsets are relative to the paragraph; `pack` adds the paragraph's own
 * position in the document.
 */
function splitLong(paragraph: string): Piece[] {
  if (paragraph.length <= CHUNK_MAX) {
    return [{ text: paragraph, start: 0, end: paragraph.length }];
  }

  // Sentence boundaries, unicode-aware: the punctuation plus following space.
  // French quotation and ellipsis included — this corpus is written in both
  // languages.
  const sentences = locate(paragraph, paragraph.split(/(?<=[.!?…»])\s+/u));
  const pieces: Piece[] = [];
  let current: Piece | null = null;
  for (const sentence of sentences) {
    if (current && current.text.length + sentence.text.length + 1 > CHUNK_MAX) {
      pieces.push(current);
      current = { ...sentence };
    } else {
      current = current
        ? { text: `${current.text} ${sentence.text}`, start: current.start, end: sentence.end }
        : { ...sentence };
    }
  }
  if (current) pieces.push(current);

  // A "sentence" longer than the ceiling is a wall of text with no
  // punctuation; cut it at word boundaries, and only then by force.
  return pieces.flatMap((piece) => {
    if (piece.text.length <= CHUNK_MAX) return [piece];
    const words = locate(paragraph, piece.text.split(/\s+/u), piece.start);
    const out: Piece[] = [];
    let run: Piece | null = null;
    for (const word of words) {
      if (run && run.text.length + word.text.length + 1 > CHUNK_MAX) {
        out.push(run);
        run = { ...word };
      } else {
        run = run
          ? { text: `${run.text} ${word.text}`, start: run.start, end: word.end }
          : { ...word };
      }
      // A single "word" beyond the ceiling (a base64 blob, a minified line)
      // is sliced raw: indexing it in pieces beats refusing the document.
      while (run.text.length > CHUNK_MAX) {
        out.push({ text: run.text.slice(0, CHUNK_MAX), start: run.start, end: run.start + CHUNK_MAX });
        run = { text: run.text.slice(CHUNK_MAX), start: run.start + CHUNK_MAX, end: run.end };
      }
    }
    if (run) out.push(run);
    return out;
  });
}

export function chunkDocument(rawContent: string): Chunk[] {
  // Normalised once, and every offset below indexes *this* string — which is
  // also what the store writes, so a line number means the same thing on both
  // sides. Offsets into the CRLF original would be wrong by one per line.
  const content = rawContent.replace(/\r\n?/g, '\n');

  const chunks: Chunk[] = [];
  let heading = '';
  let headingOfChunk = '';
  let parts: string[] = [];
  let length = 0;
  let overlap = '';
  let chunkStart = 0;
  let chunkEnd = 0;

  const flush = (): void => {
    const text = parts.join('\n\n').trim();
    if (text.length > 0) {
      chunks.push({
        seq: chunks.length,
        heading: headingOfChunk,
        text,
        start: chunkStart,
        end: chunkEnd,
      });
      overlap = tailOf(text);
    }
    parts = [];
    length = 0;
  };

  // Paragraphs: blank-line separated blocks, each remembering where it starts.
  // `exec` in a loop rather than `split`, because a split discards the
  // positions this whole pass exists to keep.
  const separator = /\n{2,}/g;
  let cursor = 0;
  for (;;) {
    const match = separator.exec(content);
    const raw = content.slice(cursor, match ? match.index : content.length);
    const paragraph = raw.trim();
    const paragraphStart = cursor + (raw.length - raw.trimStart().length);

    if (paragraph.length > 0) {
      // A heading flushes the chunk in progress: a chunk should not straddle
      // two sections, or its heading label lies about half of it.
      const lines = paragraph.split('\n');
      const headingMatch = lines[0] ? HEADING.exec(lines[0]) : null;
      if (headingMatch) {
        flush();
        heading = headingMatch[2]!.trim();
        overlap = '';
        const after = paragraph.slice(lines[0]!.length);
        const rest = after.trim();
        if (rest.length > 0) {
          const restStart =
            paragraphStart + lines[0]!.length + (after.length - after.trimStart().length);
          for (const piece of splitLong(rest)) pack(piece, restStart);
        }
      } else {
        for (const piece of splitLong(paragraph)) pack(piece, paragraphStart);
      }
    }

    if (!match) break;
    cursor = match.index + match[0].length;
  }
  flush();
  return chunks;

  function pack(piece: Piece, base: number): void {
    if (length > 0 && length + piece.text.length + 2 > CHUNK_TARGET) flush();
    if (parts.length === 0) {
      headingOfChunk = heading;
      // The chunk begins at its own first piece, never at the seam below:
      // the overlap is a copy of the previous chunk's tail and is cited there.
      chunkStart = base + piece.start;
      // The seam: carry the previous chunk's tail so a thought cut at the
      // boundary is findable from either side. Never across a heading —
      // `overlap` is cleared there.
      if (overlap) {
        parts.push(`… ${overlap}`);
        length += overlap.length + 4;
      }
    }
    parts.push(piece.text);
    length += piece.text.length + 2;
    chunkEnd = base + piece.end;
  }
}

/**
 * The text a chunk is embedded and displayed with: the document's title and
 * the section heading, then the body. Prepending the context is what lets
 * "the notice period is 45 days" match a query about *terminating the lease*
 * — the chunk alone never says what it is about.
 */
export function chunkEmbeddingText(
  docTitle: string,
  // What it actually reads, so a caller with a heading and a text — a test, a
  // re-index reading rows back — need not invent offsets to call it.
  chunk: Pick<Chunk, 'heading' | 'text'>,
): string {
  const context = [docTitle.trim(), chunk.heading.trim()].filter(Boolean).join(' — ');
  return context ? `${context}\n${chunk.text}` : chunk.text;
}
