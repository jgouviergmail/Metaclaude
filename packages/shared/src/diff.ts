/**
 * The unified-diff format, read and written.
 *
 * In `packages/shared` because both sides genuinely need it now and the format
 * is the contract between them: the API *produces* the patch a revision
 * proposal carries — so that what an operator approves is exactly what they
 * were shown, the same discipline as a consolidation's fingerprint — and the
 * web *renders* it. Two implementations of one text format is how a card comes
 * to disagree with the row behind it, and `diff.test.ts` drives the writer
 * through the reader so they cannot.
 *
 * Pure text handling, no dependency, no Zod: a plain module Rollup can
 * tree-shake, so the browser carries the reader and drops the writer.
 */

/**
 * One line of a unified diff, with the kind that decides how it is drawn.
 * `oldLine` and `newLine` are the numbers each side shows in its gutter.
 */
export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'meta' | 'hunk';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      // Hunk header: `@@ -oldStart,oldCount +newStart,newCount @@`
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      lines.push({ type: 'hunk', text: raw, oldLine: null, newLine: null });
      continue;
    }

    if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('similarity ') ||
      raw.startsWith('rename ')
    ) {
      lines.push({ type: 'meta', text: raw, oldLine: null, newLine: null });
      continue;
    }

    if (raw.startsWith('+')) {
      lines.push({ type: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'remove', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      lines.push({ type: 'meta', text: raw, oldLine: null, newLine: null });
    } else {
      lines.push({
        type: 'context',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** Lines of context each side of a change. The convention every tool uses. */
const CONTEXT = 3;

/** Beyond this many lines on either side, the texts are compared as blocks. */
const LCS_MAX_LINES = 2000;

/** Split into lines, tolerating CRLF and a missing trailing newline. */
function lines(text: string): string[] {
  if (text === '') return [];
  const normalised = text.replace(/\r\n/g, '\n');
  const split = normalised.split('\n');
  // A trailing newline yields a final empty element that is not a line: these
  // are textarea fields, and treating "ends with a newline" as content would
  // put a phantom edit at the bottom of every diff.
  if (split.length > 0 && split[split.length - 1] === '') split.pop();
  return split;
}

type Op = { type: ' ' | '-' | '+'; text: string };

/**
 * The edit script between two line lists.
 *
 * Quadratic in the number of lines, which is right for the inputs this has —
 * a workspace's instructions cap at 20 000 characters and a skill body at
 * 200 000, so a few thousand lines is the worst case. Past `LCS_MAX_LINES` the
 * table would be tens of millions of cells, so the comparison degrades to
 * "everything was replaced", which is honest and bounded rather than slow.
 */
function editScript(before: string[], after: string[]): Op[] {
  if (before.length > LCS_MAX_LINES || after.length > LCS_MAX_LINES) {
    return [
      ...before.map((text) => ({ type: '-' as const, text })),
      ...after.map((text) => ({ type: '+' as const, text })),
    ];
  }

  // Trim the common head and tail first: two prompts that differ by one line
  // share almost everything, and this takes the table from n² to nearly
  // nothing in the case that actually occurs.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const middleBefore = before.slice(head, before.length - tail);
  const middleAfter = after.slice(head, after.length - tail);

  const rows = middleBefore.length;
  const columns = middleAfter.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row]![column] =
        middleBefore[row] === middleAfter[column]
          ? table[row + 1]![column + 1]! + 1
          : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
    }
  }

  const middle: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (middleBefore[row] === middleAfter[column]) {
      middle.push({ type: ' ', text: middleBefore[row] as string });
      row += 1;
      column += 1;
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      middle.push({ type: '-', text: middleBefore[row] as string });
      row += 1;
    } else {
      middle.push({ type: '+', text: middleAfter[column] as string });
      column += 1;
    }
  }
  while (row < rows) middle.push({ type: '-', text: middleBefore[row++] as string });
  while (column < columns) middle.push({ type: '+', text: middleAfter[column++] as string });

  return [
    ...before.slice(0, head).map((text) => ({ type: ' ' as const, text })),
    ...middle,
    ...before.slice(before.length - tail).map((text) => ({ type: ' ' as const, text })),
  ];
}

/**
 * Render an edit script as unified-diff hunks.
 *
 * Changes closer together than twice the context share a hunk; anything
 * further apart gets its own, so two edits at opposite ends of a long prompt
 * do not print everything between them.
 */
function toHunks(ops: Op[], maxLines: number): string {
  const changed = ops
    .map((op, index) => (op.type === ' ' ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return '';

  const groups: Array<{ from: number; to: number }> = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last && index - last.to <= CONTEXT * 2) {
      last.to = index;
    } else {
      groups.push({ from: index, to: index });
    }
  }

  const out: string[] = [];
  let truncated = false;
  for (const group of groups) {
    const from = Math.max(0, group.from - CONTEXT);
    const to = Math.min(ops.length - 1, group.to + CONTEXT);

    // Line numbers are 1-based and count only the side each belongs to.
    let oldStart = 1;
    let newStart = 1;
    for (let index = 0; index < from; index += 1) {
      const type = ops[index]!.type;
      if (type !== '+') oldStart += 1;
      if (type !== '-') newStart += 1;
    }
    /*
     * How much of this hunk there is room for.
     *
     * Cut rather than skipped, which is the whole point: the budget used to be
     * checked before the hunk was emitted, so a single hunk larger than it was
     * dropped entire — and a wholesale rewrite is exactly one such hunk. The
     * revision card then showed nothing but the truncation notice, which is a
     * *description* of the change, on a screen whose premise is that an
     * operator approves the text itself. Showing the beginning of it and
     * saying so is strictly better than showing none of it and saying so.
     *
     * Two lines are reserved: this hunk's header, and the notice at the end.
     */
    const room = maxLines - out.length - 2;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const last = Math.min(to, from + room - 1);
    if (last < to) truncated = true;

    // Counted over the lines actually emitted, not over the whole group: a
    // header claiming more than follows it is a malformed hunk, and this
    // string is parsed again by `parseDiff` to be rendered.
    let oldCount = 0;
    let newCount = 0;
    for (let index = from; index <= last; index += 1) {
      const type = ops[index]!.type;
      if (type !== '+') oldCount += 1;
      if (type !== '-') newCount += 1;
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let index = from; index <= last; index += 1) {
      const op = ops[index]!;
      out.push(`${op.type}${op.text}`);
    }
    if (truncated) break;
  }

  if (truncated) {
    // Said out loud rather than cut silently: a diff the operator cannot see
    // the end of is one they must not approve believing they have. It names
    // the proposal rather than the target, because the target holds the text
    // being replaced and reading it would answer the wrong question.
    out.push('… diff truncated — the rest of the change is not shown.');
  }
  return out.join('\n');
}

/**
 * The patch from `before` to `after`, or an empty string when they agree.
 *
 * `maxLines` bounds the result because the payload travels to the browser and
 * is stored on a row; past it the patch says it was truncated rather than
 * growing without limit.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: { maxLines?: number } = {},
): string {
  return toHunks(editScript(lines(before), lines(after)), options.maxLines ?? 400);
}

/**
 * How much of the text a revision rewrites, in [0, 1].
 *
 * Against the *longer* of the two sides, so appending two sentences to a
 * two-sentence prompt is not scored as a rewrite while replacing half a long
 * one is. The rule this feeds — a revision is minimal or it is not a revision
 * — is a rule about how much of the operator's own writing a machine may
 * displace, and dividing by the shorter side would get that backwards in the
 * one case where it matters.
 */
export function changedLineRatio(before: string, after: string): number {
  const from = lines(before);
  const to = lines(after);
  const span = Math.max(from.length, to.length);
  if (span === 0) return 0;

  // The share of the larger side that is *not* shared. Counting the edit
  // script's own entries instead scores a replacement twice — once as a
  // removal, once as an addition — so replacing five lines of twenty came out
  // at 0.5 while appending five to twenty came out at 0.2, and the same
  // ceiling then meant two different things depending on the shape of the
  // edit. Not-kept is monotone: nothing kept is 1, everything kept is 0.
  const script = editScript(from, to);
  const kept = script.filter((op) => op.type === ' ').length;
  return Math.min(1, Math.max(0, (span - kept) / span));
}
