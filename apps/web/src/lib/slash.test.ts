/**
 * The slash-suggestion rule: when the list appears, what it contains, and —
 * as important — when it stays away.
 */

import { describe, expect, it } from 'vitest';
import { completeSlash, slashMatches } from './slash';

const COMMANDS = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'compare', description: 'Compare things' },
  { name: 'review', description: 'Review the diff' },
];

describe('slashMatches', () => {
  it('offers everything on a bare slash, filtered as the token grows', () => {
    expect(slashMatches(COMMANDS, '/').map((c) => c.name)).toEqual([
      'compact',
      'compare',
      'review',
    ]);
    expect(slashMatches(COMMANDS, '/comp').map((c) => c.name)).toEqual(['compact', 'compare']);
    expect(slashMatches(COMMANDS, '/COMPA').map((c) => c.name)).toEqual(['compact', 'compare']);
    expect(slashMatches(COMMANDS, '/x')).toEqual([]);
  });

  it('stays away once the command is chosen or the slash is mid-sentence', () => {
    // A space means the operator is writing arguments now.
    expect(slashMatches(COMMANDS, '/review the diff')).toEqual([]);
    // A slash inside prose (a path, a fraction) is not a command.
    expect(slashMatches(COMMANDS, 'look at src/lib')).toEqual([]);
    expect(slashMatches(COMMANDS, '')).toEqual([]);
  });

  it('caps the list, because a menu of forty is a wall', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `cmd${i}`, description: '' }));
    expect(slashMatches(many, '/').length).toBe(8);
  });
});

describe('completeSlash', () => {
  it('leaves the caret ready for arguments', () => {
    expect(completeSlash('review')).toBe('/review ');
  });
});
