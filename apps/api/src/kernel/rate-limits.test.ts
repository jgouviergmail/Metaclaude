/**
 * The fixture is a captured production payload, not a hand-written one.
 *
 * That is the whole point of this file: the shape was invented in the SDK's
 * type declaration and believed, and the wire disagreed. A fixture written from
 * the type would pass against the very defect it exists to catch.
 */
import { describe, expect, it } from 'vitest';
import { modelWindowKey, readRateLimitWindows } from './rate-limits.js';

/** Captured from Claude Code in production, 2026-09-08, trimmed of noise. */
const WIRE_SHAPE = {
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 4,
      severity: 'normal',
      resets_at: '2026-09-08T10:00:00.312940+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 97,
      severity: 'critical',
      resets_at: '2026-09-08T16:00:00.312969+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-09-08T16:00:00.313304+00:00',
      scope: { model: { id: null, display_name: 'Fable' } },
      is_active: true,
    },
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0 },
};

/** The shape the SDK's own type declares. */
const DECLARED_SHAPE = {
  five_hour: { utilization: 42, resets_at: '2026-08-26T15:00:00.000Z' },
  seven_day: { utilization: 61, resets_at: '2026-08-30T00:00:00.000Z' },
  seven_day_opus: null,
  model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: '2026-08-30T00:00:00.000Z' }],
};

describe('readRateLimitWindows', () => {
  it('reads the shape the CLI actually sends', () => {
    const windows = readRateLimitWindows(WIRE_SHAPE);

    // The CLI sends the declared object keys *and* this array. The mapping this
    // replaces read only the former, so the two global windows were fine and
    // every model-scoped bucket was invisible - Fable at 100% among them.
    expect(windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day', modelWindowKey('Fable')]);
    expect(windows.map((w) => w.utilization)).toEqual([4, 97, 100]);
    expect(windows[0]?.resetsAt).toBe(Date.parse('2026-09-08T10:00:00.312940+00:00'));
  });

  it('names a model-scoped window after its model, which is what makes it usable', () => {
    const fable = readRateLimitWindows(WIRE_SHAPE).find((w) => w.key === modelWindowKey('Fable'));
    expect(fable).toBeDefined();
    expect(fable?.label).toBe('Fable');
    expect(fable?.utilization).toBe(100);
  });

  it('still reads the shape the SDK declares', () => {
    const windows = readRateLimitWindows(DECLARED_SHAPE);
    expect(windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day', modelWindowKey('Fable')]);
    expect(windows.map((w) => w.utilization)).toEqual([42, 61, 12]);
  });

  it('drops a bucket the plan does not have rather than showing it at zero', () => {
    // `seven_day_opus: null` is "no such bucket here", not "unused".
    expect(readRateLimitWindows(DECLARED_SHAPE).some((w) => w.key === 'seven_day_opus')).toBe(false);
  });

  it('answers with nothing for a payload it cannot read, and never throws', () => {
    for (const input of [null, undefined, 42, 'nope', [], {}, { limits: 'not an array' }]) {
      expect(readRateLimitWindows(input)).toEqual([]);
    }
  });

  it('skips a row that names neither a known window nor a model', () => {
    const windows = readRateLimitWindows({
      limits: [{ kind: 'something_new', percent: 50, scope: null }],
    });
    expect(windows).toEqual([]);
  });

  it('reads a model-scoped row whose kind it has never seen', () => {
    // The scope is what identifies it, not the kind — so a new kind carrying a
    // model still lands, which is how `weekly_scoped` was found in the first place.
    const windows = readRateLimitWindows({
      limits: [{ kind: 'monthly_scoped', percent: 100, scope: { model: { display_name: 'Opus' } } }],
    });
    expect(windows).toEqual([
      { key: modelWindowKey('Opus'), label: 'Opus', utilization: 100, resetsAt: null },
    ]);
  });
});
