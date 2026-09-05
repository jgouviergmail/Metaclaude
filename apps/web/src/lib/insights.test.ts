/**
 * One mapping, and one rule about where a consolidation belongs.
 *
 * Both exist because the two screens that render insights had drifted: an
 * exhaustive `Record` on the Memory page, a ternary chain on the Dashboard,
 * and a new kind that only one of them could notice.
 */

import { describe, expect, it } from 'vitest';
import type { Insight } from '@metaclaude/shared';
import { INSIGHT_TONE, isLearned } from './insights';

const KINDS: Insight['kind'][] = [
  'lesson',
  'pattern',
  'failure',
  'preference',
  'skill_proposal',
  'consolidation',
];

describe('INSIGHT_TONE', () => {
  it('covers every kind, with no gap to fall through', () => {
    for (const kind of KINDS) expect(INSIGHT_TONE[kind]).toBeTruthy();
    expect(Object.keys(INSIGHT_TONE).sort()).toEqual([...KINDS].sort());
  });

  it('keeps a failure visually distinct from a lesson', () => {
    expect(INSIGHT_TONE.failure).toBe('danger');
    expect(INSIGHT_TONE.failure).not.toBe(INSIGHT_TONE.lesson);
  });
});

describe('isLearned', () => {
  it('admits everything the reflexion pass distilled', () => {
    for (const kind of KINDS.filter((k) => k !== 'consolidation')) {
      expect(isLearned({ kind })).toBe(true);
    }
  });

  /**
   * A consolidation is a request to delete rows, not something remembered.
   * The digest it would appear in is capped at five, so including it costs an
   * actual lesson its place.
   */
  it('excludes a consolidation proposal', () => {
    expect(isLearned({ kind: 'consolidation' })).toBe(false);
  });
});
