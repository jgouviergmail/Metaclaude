import { describe, expect, it } from 'vitest';
import { deriveTitle } from './kernel.js';

/**
 * Only the pure helper is exercised here.
 *
 * The reason used to be recorded as "everything else needs a live Claude CLI",
 * which was never true — the supervisor is an injected dependency and is now
 * tested with a fake `query` in supervisor.test.ts. What the kernel actually
 * needs is a fixture for its ten collaborators, which is a piece of work in its
 * own right and is tracked as one. Leaving a false reason in place is how a gap
 * stops being noticed.
 */
describe('deriveTitle', () => {
  it('uses the first meaningful line', () => {
    expect(deriveTitle('Fix the login bug\nand then deploy')).toBe('Fix the login bug');
    expect(deriveTitle('\n\n  \nFix the login bug')).toBe('Fix the login bug');
    expect(deriveTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('strips markdown heading markers', () => {
    expect(deriveTitle('# Heading here\nbody')).toBe('Heading here');
    expect(deriveTitle('###### Deep heading')).toBe('Deep heading');
    expect(deriveTitle('#Tight heading')).toBe('Tight heading');
  });

  it('strips list markers', () => {
    expect(deriveTitle('- item one\nitem two')).toBe('item one');
    expect(deriveTitle('* item one')).toBe('item one');
    expect(deriveTitle('-   spaced item')).toBe('spaced item');
  });

  it('skips lines that are nothing but markers', () => {
    expect(deriveTitle('#\n## Real title')).toBe('Real title');
    expect(deriveTitle('>\n* \nActual line')).toBe('Actual line');
    expect(deriveTitle('---\nAfter the rule')).toBe('After the rule');
    expect(deriveTitle('1.\nNumbered follow-up')).toBe('Numbered follow-up');
  });

  it('collapses runs of whitespace', () => {
    expect(deriveTitle('hello    world\t\tagain')).toBe('hello world again');
    expect(deriveTitle('   padded   title   ')).toBe('padded title');
  });

  it('returns "New session" for empty or whitespace-only input', () => {
    expect(deriveTitle('')).toBe('New session');
    expect(deriveTitle('   ')).toBe('New session');
    expect(deriveTitle('\n\n\n')).toBe('New session');
    expect(deriveTitle('\t \n \t')).toBe('New session');
  });

  it('leaves a title that already fits untouched', () => {
    const exactly = 'x'.repeat(60);
    expect(deriveTitle(exactly)).toBe(exactly);
    expect(deriveTitle(exactly).endsWith('…')).toBe(false);
  });

  it('truncates on a word boundary and appends an ellipsis', () => {
    const title = deriveTitle(
      'Please refactor the authentication service so that it stops leaking sessions',
    );
    expect(title).toBe('Please refactor the authentication service so that it stops…');
    expect(title.endsWith('…')).toBe(true);
    // Cut on whitespace, so the visible part is a whole number of words.
    expect(title.slice(0, -1)).toBe(title.slice(0, -1).trimEnd());
    expect(
      'Please refactor the authentication service so that it stops leaking sessions'.startsWith(
        title.slice(0, -1),
      ),
    ).toBe(true);
  });

  it('falls back to a hard cut when there is no usable word boundary', () => {
    const title = deriveTitle('a'.repeat(80));
    expect(title).toBe(`${'a'.repeat(60)}…`);
    expect(title).toHaveLength(61);
  });

  it('honours a custom maximum length', () => {
    expect(deriveTitle('one two three four five six seven', 20)).toBe('one two three four…');
    expect(deriveTitle('one two three four five six seven', 20).length).toBeLessThanOrEqual(21);
    expect(deriveTitle('short', 20)).toBe('short');
  });

  it('does not cut mid-word when the last space is very early', () => {
    // The final space sits below 60% of the limit, so a hard cut is preferred
    // over an uselessly short title.
    const title = deriveTitle(`ab ${'c'.repeat(120)}`);
    expect(title).toHaveLength(61);
    expect(title.startsWith('ab ccc')).toBe(true);
  });

  it('handles a realistic multi-line markdown prompt', () => {
    const prompt = [
      '# Task',
      '',
      '- Investigate the flaky test in `crypto.test.ts`',
      '- Then fix it',
    ].join('\n');
    expect(deriveTitle(prompt)).toBe('Task');
  });

  it('never returns an empty string', () => {
    for (const prompt of ['', ' ', '#', '# ', '- ', '\n#\n', '>>>', '...']) {
      expect(deriveTitle(prompt).length).toBeGreaterThan(0);
    }
  });
});
