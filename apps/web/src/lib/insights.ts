/**
 * What an insight *is*, said once for the two screens that show them.
 *
 * The Memory page renders the review queue and the Dashboard renders a
 * five-row digest of it, and they had two spellings of the same mapping: an
 * exhaustive `Record` on one side, a ternary chain on the other. The ternary
 * gave a `consolidation` proposal the same tone as a lesson, because a chain
 * has no compiler to notice a new case — which is the whole reason the
 * `Record` on the other side did notice.
 */

import type { Insight } from '@metaclaude/shared';

export type InsightTone = 'info' | 'accent' | 'danger' | 'success' | 'thinking';

/**
 * Exhaustive on purpose: a new kind fails the build here rather than picking
 * up a default nobody chose.
 */
export const INSIGHT_TONE: Record<Insight['kind'], InsightTone> = {
  lesson: 'info',
  pattern: 'accent',
  failure: 'danger',
  preference: 'success',
  skill_proposal: 'thinking',
  consolidation: 'accent',
};

/**
 * Whether an insight is something the reflexion pass *learned*.
 *
 * A consolidation proposal is filed in the same queue and carries the same
 * status machinery, but it is not a lesson — it is a request to delete rows.
 * Under a heading that reads "Recently learned", above copy promising
 * "anything worth remembering", it is simply the wrong thing, and it would
 * push actual lessons out of a list capped at five.
 */
export function isLearned(insight: Pick<Insight, 'kind'>): boolean {
  return insight.kind !== 'consolidation';
}
