/**
 * The diff a revision proposal carries.
 *
 * Produced server-side and stored in the payload, so the card renders it
 * without a dependency and without recomputing anything: what the operator
 * approves is exactly the diff they were shown. The web app has rendered
 * unified diffs since the git panel shipped, so the format is not a choice —
 * `parseDiff` in `apps/web/src/lib/markdown.ts` is the consumer, and
 * `unified-diff-renders.test.ts` holds the two together.
 */

import { describe, expect, it } from 'vitest';
import { changedLineRatio, parseDiff, unifiedDiff } from './diff.js';

/** Just the changed lines, which is what most assertions here are about. */
const changes = (patch: string): string[] =>
  patch.split('\n').filter((line) => /^[+-]/.test(line));

describe('unifiedDiff', () => {
  it('says nothing when nothing changed', () => {
    expect(unifiedDiff('same\ntext', 'same\ntext')).toBe('');
  });

  it('says nothing for two empty texts', () => {
    expect(unifiedDiff('', '')).toBe('');
  });

  it('renders a pure addition', () => {
    const patch = unifiedDiff('one\ntwo', 'one\ntwo\nthree');

    expect(changes(patch)).toEqual(['+three']);
    expect(patch).toContain('@@');
  });

  it('renders a pure deletion', () => {
    expect(changes(unifiedDiff('one\ntwo\nthree', 'one\nthree'))).toEqual(['-two']);
  });

  it('renders a replacement as a deletion and an addition', () => {
    expect(changes(unifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree'))).toEqual(['-two', '+TWO']);
  });

  it('renders writing into an empty text', () => {
    expect(changes(unifiedDiff('', 'first line'))).toEqual(['+first line']);
  });

  it('renders emptying a text', () => {
    expect(changes(unifiedDiff('only line', ''))).toEqual(['-only line']);
  });

  /**
   * Context is what makes a diff readable: a lone `+` line says what changed
   * and never where. Three lines each side is the convention every tool uses
   * and the one the renderer was written against.
   */
  it('carries three lines of context each side of a change, and no more', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'TARGET', 'f', 'g', 'h', 'i'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'e', 'CHANGED', 'f', 'g', 'h', 'i'].join('\n');

    const lines = unifiedDiff(before, after).split('\n');
    // The three each side are in…
    expect(lines).toContain(' c');
    expect(lines).toContain(' e');
    expect(lines).toContain(' f');
    expect(lines).toContain(' h');
    // …and the fourth is not.
    expect(lines).not.toContain(' b');
    expect(lines).not.toContain(' i');
  });

  it('opens each hunk with the line numbers it covers', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 10', 'CHANGED');

    const header = unifiedDiff(before, after).split('\n').find((line) => line.startsWith('@@'));
    expect(header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  /**
   * Two changes far apart are two hunks, not one hunk spanning the untouched
   * middle. A single hunk would print the whole document to show two words.
   */
  it('splits distant changes into separate hunks', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 2', 'FIRST').replace('line 35', 'SECOND');

    const hunks = unifiedDiff(before, after).split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks).toHaveLength(2);
  });

  it('joins near changes into one hunk', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 8', 'FIRST').replace('line 10', 'SECOND');

    const hunks = unifiedDiff(before, after).split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks).toHaveLength(1);
  });

  /**
   * A text that does not end in a newline is the common case here: these are
   * prompt fields typed into a textarea, not files. Treating the absence as a
   * change would make every diff of such a text open with a phantom edit.
   */
  it('does not invent a change from a missing trailing newline', () => {
    expect(unifiedDiff('one\ntwo', 'one\ntwo')).toBe('');
    expect(changes(unifiedDiff('one\ntwo\n', 'one\ntwo\nthree'))).toEqual(['+three']);
  });

  it('survives CRLF on one side and not the other', () => {
    expect(unifiedDiff('one\r\ntwo', 'one\ntwo')).toBe('');
  });

  it('handles a text with no line breaks at all', () => {
    expect(changes(unifiedDiff('before', 'after'))).toEqual(['-before', '+after']);
  });

  /**
   * A very long text still has to produce a bounded patch: the payload travels
   * to the browser and is stored on the row. Past the ceiling the diff says so
   * rather than growing without limit.
   */
  it('stops at a ceiling and says that it did', () => {
    const before = Array.from({ length: 4000 }, (_, index) => `line ${index}`).join('\n');
    const after = Array.from({ length: 4000 }, (_, index) => `changed ${index}`).join('\n');

    const patch = unifiedDiff(before, after, { maxLines: 100 });
    expect(patch.split('\n').length).toBeLessThanOrEqual(101);
    expect(patch).toMatch(/truncated/i);
  });
});

describe('changedLineRatio', () => {
  it('is zero for an unchanged text', () => {
    expect(changedLineRatio('a\nb\nc', 'a\nb\nc')).toBe(0);
  });

  it('is one when every line changed', () => {
    expect(changedLineRatio('a\nb', 'x\ny')).toBe(1);
  });

  it('measures a small edit as small', () => {
    const before = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 3', 'CHANGED');

    expect(changedLineRatio(before, after)).toBeLessThan(0.25);
    expect(changedLineRatio(before, after)).toBeGreaterThan(0);
  });

  /**
   * Appending to a short text is a large *ratio* and a small edit. The measure
   * is against the larger of the two sides for exactly that reason: a rule
   * phrased "no more than 40% of the lines may change" must not refuse adding
   * two sentences to a two-sentence prompt while allowing a rewrite of a long
   * one.
   */
  it('measures against the longer side, so appending is not a rewrite', () => {
    const before = 'one rule';
    const after = ['one rule', 'two rule', 'three rule', 'four rule'].join('\n');

    expect(changedLineRatio(before, after)).toBeLessThan(1);
  });

  it('is one when a text is written from nothing', () => {
    expect(changedLineRatio('', 'a\nb')).toBe(1);
  });

  it('is zero for two empty texts rather than dividing by nothing', () => {
    expect(changedLineRatio('', '')).toBe(0);
  });
});

describe('parseDiff', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    'index 1111111..2222222 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -3,4 +3,5 @@ function f() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
  ].join('\n');

  it('classifies each line and tracks both line numbers', () => {
    const lines = parseDiff(diff);
    const kinds = lines.map((line) => line.type);
    expect(kinds.filter((k) => k === 'add')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'remove')).toHaveLength(1);
    expect(kinds).toContain('hunk');
    expect(kinds).toContain('meta');

    const context = lines.find((line) => line.type === 'context');
    expect(context?.oldLine).toBe(3);
    expect(context?.newLine).toBe(3);

    const removed = lines.find((line) => line.type === 'remove');
    expect(removed?.oldLine).toBe(4);
    expect(removed?.newLine).toBeNull();

    const added = lines.filter((line) => line.type === 'add');
    expect(added[0]?.newLine).toBe(4);
    expect(added[1]?.newLine).toBe(5);
    expect(added[0]?.oldLine).toBeNull();
  });

  it('handles an empty diff and a malformed hunk header', () => {
    // No hunk header means no line origin, so the counters stay at zero.
    expect(parseDiff('')).toEqual([{ type: 'context', text: '', oldLine: 0, newLine: 0 }]);
    expect(() => parseDiff('@@ nonsense @@\n+x')).not.toThrow();
  });
});

/**
 * The writer, read by the reader.
 *
 * The whole reason both live in this module. A patch the API produces and the
 * browser renders is a contract between two packages, and the way that breaks
 * is not a crash — it is a card that draws a change on the wrong line, or
 * silently drops one, while every test on each side stays green. So the
 * assertion is the round trip rather than the shape of either half.
 */
describe('what unifiedDiff writes, parseDiff reads', () => {
  const roundTrip = (before: string, after: string) => parseDiff(unifiedDiff(before, after));

  it('renders a replacement as one removal and one addition', () => {
    const lines = roundTrip('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');

    expect(lines.filter((line) => line.type === 'remove').map((line) => line.text)).toEqual(['beta']);
    expect(lines.filter((line) => line.type === 'add').map((line) => line.text)).toEqual(['BETA']);
  });

  it('numbers the gutters from the hunk header the writer emitted', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 10', 'CHANGED');

    const lines = roundTrip(before, after);
    // `line 10` is the eleventh line, so both gutters point at 11.
    expect(lines.find((line) => line.type === 'remove')?.oldLine).toBe(11);
    expect(lines.find((line) => line.type === 'add')?.newLine).toBe(11);
  });

  it('keeps every context line intact rather than eating its first character', () => {
    const lines = roundTrip('  indented\nchanged\n  indented too', '  indented\nCHANGED\n  indented too');

    expect(lines.filter((line) => line.type === 'context').map((line) => line.text)).toEqual([
      '  indented',
      '  indented too',
    ]);
  });

  it('renders an added line that itself begins with a plus or a minus', () => {
    const lines = roundTrip('a', 'a\n- a bullet\n+ another');

    expect(lines.filter((line) => line.type === 'add').map((line) => line.text)).toEqual([
      '- a bullet',
      '+ another',
    ]);
  });

  it('renders two distant edits as two hunks the reader can tell apart', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 2', 'FIRST').replace('line 35', 'SECOND');

    const lines = roundTrip(before, after);
    expect(lines.filter((line) => line.type === 'hunk')).toHaveLength(2);
    expect(lines.filter((line) => line.type === 'add').map((line) => line.text)).toEqual([
      'FIRST',
      'SECOND',
    ]);
  });
});

/**
 * Where the second hunk starts, once the first has changed the line count.
 *
 * Written because a sabotage that reversed the writer's own counting rule —
 * crediting a removal to the new side and an addition to the old — left every
 * other test in this file green. Nothing before it exercised a prefix that
 * *contained* a change, so the two gutters never had a chance to diverge.
 * Here the first hunk adds two lines, so from the second hunk on the new side
 * runs two ahead of the old, and only a writer that counts each side
 * separately gets both right.
 */
describe('line numbers once an earlier hunk has shifted them', () => {
  it('keeps the two gutters apart across hunks', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before
      .replace('line 2', 'line 2\nEXTRA A\nEXTRA B')
      .replace('line 30', 'CHANGED');

    const lines = parseDiff(unifiedDiff(before, after));
    const changed = lines.find((line) => line.type === 'remove' && line.text === 'line 30');
    const replacement = lines.find((line) => line.type === 'add' && line.text === 'CHANGED');

    // `line 30` is the thirty-first line of the original…
    expect(changed?.oldLine).toBe(31);
    // …and the thirty-third of the revision, two having been inserted above.
    expect(replacement?.newLine).toBe(33);
  });

  it('counts a deletion in an earlier hunk the other way', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 2\n', '').replace('line 30', 'CHANGED');

    const lines = parseDiff(unifiedDiff(before, after));
    expect(lines.find((line) => line.type === 'remove' && line.text === 'line 30')?.oldLine).toBe(31);
    expect(lines.find((line) => line.type === 'add' && line.text === 'CHANGED')?.newLine).toBe(30);
  });
});

/**
 * The counts in a hunk header, which nothing in this product reads.
 *
 * `parseDiff` takes the two *origins* out of the header and ignores the two
 * counts — its regex does not even capture them — so no round trip can see
 * them wrong, and a sabotage of the arithmetic left every other test here
 * green. They are pinned anyway because the patch is a text an operator can
 * copy: a header whose counts disagree with its body is refused by `git apply`
 * and by every other tool that reads the format, and "renders correctly in our
 * own viewer" is a smaller promise than the one a unified diff makes.
 */
describe('the hunk header counts', () => {
  it('states how many lines each side contributes to the hunk', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 10', 'line 10\nEXTRA');

    const patch = unifiedDiff(before, after);
    const header = patch.split('\n').find((line) => line.startsWith('@@')) as string;
    const [, oldCount, newCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(header) as RegExpExecArray;

    const body = patch.split('\n').filter((line) => /^[ +-]/.test(line));
    expect(Number(oldCount)).toBe(body.filter((line) => !line.startsWith('+')).length);
    expect(Number(newCount)).toBe(body.filter((line) => !line.startsWith('-')).length);
  });
});

/**
 * The measure has to mean one thing whatever shape the edit takes.
 *
 * Its first version counted the edit script's own entries, which scores a
 * replaced line twice — once removed, once added. Replacing five lines of
 * twenty came out at 0.5 and appending five to twenty at 0.2, so a single
 * ceiling meant two different things depending on the shape of the change, and
 * a rule phrased "no more than two fifths may change" refused a quarter of a
 * replacement while allowing a fifth of an append. It is the share of the
 * larger side *not shared* instead, which is monotone in both directions.
 */
describe('changedLineRatio across shapes of edit', () => {
  const twenty = Array.from({ length: 20 }, (_, index) => `rule ${index}`).join('\n');

  it('scores replacing a quarter of the lines as a quarter', () => {
    const after = twenty.split('\n').map((line, index) => (index < 5 ? `CHANGED ${index}` : line)).join('\n');

    expect(changedLineRatio(twenty, after)).toBeCloseTo(0.25, 5);
  });

  it('scores appending five lines to twenty as a fifth', () => {
    const after = `${twenty}\n${Array.from({ length: 5 }, (_, index) => `extra ${index}`).join('\n')}`;

    expect(changedLineRatio(twenty, after)).toBeCloseTo(0.2, 5);
  });

  it('scores deleting five of twenty as a quarter', () => {
    const after = twenty.split('\n').slice(0, 15).join('\n');

    expect(changedLineRatio(twenty, after)).toBeCloseTo(0.25, 5);
  });

  it('never exceeds one, or falls below zero', () => {
    for (const [before, after] of [
      [twenty, ''],
      ['', twenty],
      [twenty, `${twenty}\n${twenty}`],
      ['a', 'b'],
    ] as const) {
      const ratio = changedLineRatio(before, after);
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
  });
});

/*
 * A diff too long to show whole must still show something.
 *
 * The revision card's whole premise is that an operator approves *the text*
 * rather than a description of it — `docs/SECURITY.md` calls that the boundary
 * the feature rests on. The budget was checked before a hunk was emitted and
 * a single oversized one is skipped entirely, so a wholesale rewrite rendered
 * as nothing but the truncation notice: the description, not the text. Worse,
 * that notice says "open the target to read the rest", and the target holds
 * the text being *replaced*.
 */
describe('a diff larger than the budget', () => {
  /**
   * Many small edits scattered through a long text — the shape that actually
   * reaches this. A wholesale replacement is refused before it becomes a
   * proposal (`isRewrite`), so the case worth bounding is the honest edit that
   * simply touches more places than a card can hold.
   */
  const scattered = (n: number) => {
    const before = Array.from({ length: n }, (_, index) => `line ${index}`);
    const after = before.map((line, index) => (index % 20 === 0 ? `${line} changed` : line));
    return { before: before.join('\n'), after: after.join('\n') };
  };

  it('shows as much as it can rather than nothing at all', () => {
    const { before, after } = scattered(1000);
    const diff = unifiedDiff(before, after);
    const rows = diff.split('\n');

    expect(diff).toMatch(/^@@/m);
    expect(rows.filter((line) => line.startsWith('-')).length).toBeGreaterThan(10);
    expect(rows.filter((line) => line.startsWith('+')).length).toBeGreaterThan(10);
    expect(diff).toMatch(/truncated/);
  });

  it('stays inside its budget', () => {
    const { before, after } = scattered(1000);
    expect(unifiedDiff(before, after, { maxLines: 40 }).split('\n').length).toBeLessThanOrEqual(41);
  });

  /**
   * One hunk bigger than the whole budget used to render as nothing but the
   * truncation notice — the budget was checked before the hunk was emitted, so
   * an oversized one was skipped entire. On the revision card that is a
   * *description* of the change on a screen whose premise is that the operator
   * approves the text itself.
   */
  it('cuts a single oversized hunk rather than dropping it', () => {
    // One contiguous block of changes in the middle: a single hunk of about a
    // hundred lines, larger than the budget given here, and therefore the
    // exact shape that used to render as the notice and nothing else.
    const rows = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const before = rows.join('\n');
    const after = rows
      .map((line, index) => (index >= 100 && index < 200 ? `${line} changed` : line))
      .join('\n');
    const diff = unifiedDiff(before, after, { maxLines: 20 });

    expect(diff).toMatch(/^@@/m);
    // The budget buys leading context before it buys changes, so what is
    // asserted is that some of the change is shown at all, not which side.
    expect(diff).toMatch(/^[-+]/m);
    expect(diff).toMatch(/truncated/);
    expect(diff.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('counts only the lines it actually shows in the hunk header', () => {
    // A header claiming more lines than follow it is a malformed hunk, and
    // this string is parsed again by `parseDiff` to be rendered.
    const { before, after } = scattered(1000);
    const diff = unifiedDiff(before, after, { maxLines: 30 });
    const header = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/m.exec(diff);
    expect(header).not.toBeNull();

    const rows = diff.split('\n');
    const firstHunk = rows.indexOf(header![0]);
    const nextHunk = rows.findIndex((line, index) => index > firstHunk && line.startsWith('@@'));
    const body = rows
      .slice(firstHunk + 1, nextHunk === -1 ? undefined : nextHunk)
      .filter((line) => /^[-+ ]/.test(line));
    const old = body.filter((line) => line.startsWith('-') || line.startsWith(' ')).length;
    const now = body.filter((line) => line.startsWith('+') || line.startsWith(' ')).length;
    expect(Number(header![1])).toBe(old);
    expect(Number(header![2])).toBe(now);
  });
});
