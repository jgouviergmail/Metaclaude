/**
 * `cn`, and the type scale surviving it.
 *
 * tailwind-merge knows nothing of the `@theme` block that defines the six
 * roles, so it classified `text-caption` as a text *colour* and dropped it as
 * conflicting with the `text-muted` beside it. Every role in the app was being
 * deleted before it reached the DOM wherever a colour followed it in the same
 * class list — which is nearly everywhere, since prose is muted.
 *
 * Nothing else could have caught it. The ratchet counts roles in the *source*
 * and was reporting a steadily improving number while none of them applied; no
 * test happened to assert a size and a colour on one element; and a paragraph
 * that silently inherits its size still looks like a paragraph. It surfaced
 * only when a new primitive's test compared a select's classes against an
 * input's and found the size missing from both.
 */

import { describe, expect, it } from 'vitest';
import { cn, formatRelative, formatUntil } from './utils';

describe('cn and the type scale', () => {
  const ROLES = ['display', 'title', 'heading', 'body', 'label', 'caption'];

  it('keeps a role beside a colour, which is how prose is written', () => {
    for (const role of ROLES) {
      expect(cn(`text-${role} text-muted`), role).toBe(`text-${role} text-muted`);
    }
  });

  it('keeps a role beside a colour across separate arguments', () => {
    // The conditional form — `cn(BASE, active && 'text-accent')` — is the one
    // the app writes most, and the merge sees the joined list either way.
    for (const role of ROLES) {
      expect(cn(`text-${role}`, 'text-ink'), role).toBe(`text-${role} text-ink`);
    }
  });

  it('still lets one role replace another, which is what the merge is for', () => {
    expect(cn('text-caption', 'text-body')).toBe('text-body');
    expect(cn('text-body text-heading')).toBe('text-heading');
  });

  it('still lets one colour replace another', () => {
    expect(cn('text-muted', 'text-ink')).toBe('text-ink');
  });

  it('still treats a Tailwind size as a size, so a role can override it', () => {
    expect(cn('text-sm', 'text-body')).toBe('text-body');
    expect(cn('text-body', 'text-sm')).toBe('text-sm');
  });
});

/**
 * The density spacing tokens, for a different reason.
 *
 * `p-gutter` was not misclassified — it was not classified at all, so
 * `cn('p-gutter', 'p-4')` emitted both and the stylesheet's order decided
 * which won. Nothing overrode one when this was written, which is exactly when
 * to fix it: the same trap as the sizes above, one step earlier.
 */
describe('cn and the density spacing', () => {
  it('lets an override replace the token, and the token replace a step', () => {
    expect(cn('p-gutter', 'p-4')).toBe('p-4');
    expect(cn('p-4', 'p-gutter')).toBe('p-gutter');
  });

  it('teaches every spacing group at once, not only padding', () => {
    expect(cn('space-y-4 space-y-section')).toBe('space-y-section');
    expect(cn('mt-2 mt-stack')).toBe('mt-stack');
  });

  it('leaves a token that names a different axis alone', () => {
    // `px` and `py` are separate groups; a gutter on one must not eat the other.
    expect(cn('px-gutter py-2')).toBe('px-gutter py-2');
  });
});

/**
 * The colour tokens, which were fine — asserted so a future extension of the
 * merge config cannot quietly break them while fixing something else.
 */
describe('cn and the colour tokens', () => {
  it('still merges one surface or border colour into another', () => {
    expect(cn('bg-raised bg-surface')).toBe('bg-surface');
    expect(cn('border-line border-accent')).toBe('border-accent');
  });

  it('keeps a role beside every state colour, not only the neutral ones', () => {
    for (const colour of ['accent', 'danger', 'success', 'warning', 'info']) {
      expect(cn(`text-caption text-${colour}`), colour).toBe(`text-caption text-${colour}`);
    }
  });
});

/**
 * Counting down, which `formatRelative` could not do.
 *
 * Its first branch catches every negative delta and answers "just now", by
 * design — a recorded event in the future is a clock disagreement. Four call
 * sites were deadlines: the credential countdown, which read "just now"
 * whether a token had four days or a year left, and the automations list,
 * which said the next run was "just now" for every schedule on it. Both are
 * plausible sentences, which is why nothing caught them.
 */
describe('formatUntil', () => {
  const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

  it('counts forward where formatRelative counted nothing', () => {
    const inFourDays = NOW + 4 * 86_400_000;
    expect(formatUntil(inFourDays, NOW)).toBe('in 4d');
    // The defect this exists for, pinned rather than described.
    expect(formatRelative(inFourDays, NOW)).toBe('just now');
  });

  it('walks the whole scale', () => {
    expect(formatUntil(NOW + 20 * 60_000, NOW)).toBe('in 20m');
    expect(formatUntil(NOW + 5 * 3_600_000, NOW)).toBe('in 5h');
    expect(formatUntil(NOW + 3 * 86_400_000, NOW)).toBe('in 3d');
  });

  it('falls back to a date once "in N days" stops helping', () => {
    // A year out is where the paired token sits, and "in 365d" helps nobody.
    expect(formatUntil(NOW + 365 * 86_400_000, NOW)).toMatch(/2027/);
  });

  it('says "any moment" for something due, rather than counting backwards', () => {
    expect(formatUntil(NOW + 10_000, NOW)).toBe('any moment now');
    expect(formatUntil(NOW - 86_400_000, NOW)).toBe('any moment now');
  });
});
