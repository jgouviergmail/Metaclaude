/**
 * The fixtures are captured, not composed.
 *
 * Every payload below came off the wire from Claude Code against a
 * subscription whose Fable bucket was genuinely at 100% and whose global weekly
 * window was at 97%. That distinction is the feature, and a fixture invented
 * from the SDK's type declaration would have agreed with two discriminators
 * that measurement refuted.
 */
import { describe, expect, it } from 'vitest';
import { chooseReplacement, classifyQuotaRejection } from './quota.js';

/** Captured: the warning that precedes the refusal. Not a refusal itself. */
const WARNING = {
  status: 'allowed_warning',
  resetsAt: 1788883200,
  rateLimitType: 'seven_day',
  utilization: 0.97,
  unifiedWindows: {
    five_hour: { utilization: 0.07, resetsAt: 1788861600 },
    seven_day: { utilization: 0.97, resetsAt: 1788883200 },
  },
};

/** Captured: Fable refused while Sonnet went on answering. */
const FABLE_REFUSED = {
  status: 'rejected',
  resetsAt: 1788883200,
  rateLimitType: 'seven_day_overage_included',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  unifiedWindows: {
    five_hour: { utilization: 0.07, resetsAt: 1788861600 },
    seven_day: { utilization: 0.97, resetsAt: 1788883200 },
    seven_day_overage_included: { utilization: 1, resetsAt: 1788883200 },
  },
};

/** The same refusal, but with the global weekly window itself spent. */
const EVERYTHING_SPENT = {
  ...FABLE_REFUSED,
  unifiedWindows: {
    five_hour: { utilization: 0.4, resetsAt: 1788861600 },
    seven_day: { utilization: 1, resetsAt: 1788883200 },
  },
};

describe('classifyQuotaRejection', () => {
  it('says nothing when nothing was refused', () => {
    // An `allowed_warning` is the CLI saying a window is filling up. Treating
    // it as a refusal would switch models on a run that was about to succeed.
    expect(classifyQuotaRejection({ model: 'fable', rateLimits: [WARNING] })).toBeNull();
    expect(classifyQuotaRejection({ model: 'fable', rateLimits: [] })).toBeNull();
  });

  it('calls a refusal model-scoped while the global windows still have room', () => {
    // The measured case: Fable at 100%, the weekly window at 97% and serving.
    // `rateLimitType` is `seven_day_overage_included` — it names no model, which
    // is exactly why the first discriminator could never have worked.
    const block = classifyQuotaRejection({
      model: 'fable',
      rateLimits: [WARNING, FABLE_REFUSED],
    });
    expect(block).toEqual({
      model: 'fable',
      scope: 'model',
      resetsAt: 1788883200 * 1000,
    });
  });

  it('calls it global when a window every model draws on is spent', () => {
    const block = classifyQuotaRejection({ model: 'fable', rateLimits: [EVERYTHING_SPENT] });
    expect(block?.scope).toBe('global');
  });

  it('falls back to the usage snapshot when the event does not carry the windows', () => {
    // `unifiedWindows` is on the wire but absent from the SDK's declared type,
    // so a CLI may stop sending it without the compiler noticing.
    const bare = { status: 'rejected', resetsAt: 1788883200 };

    expect(
      classifyQuotaRejection({
        model: 'fable',
        rateLimits: [bare],
        windows: [
          { key: 'five_hour', label: '', utilization: 7, resetsAt: null },
          { key: 'seven_day', label: '', utilization: 97, resetsAt: null },
          { key: 'model:Fable', label: 'Fable', utilization: 100, resetsAt: null },
        ],
      })?.scope,
    ).toBe('model');

    expect(
      classifyQuotaRejection({
        model: 'fable',
        rateLimits: [bare],
        windows: [{ key: 'seven_day', label: '', utilization: 100, resetsAt: null }],
      })?.scope,
    ).toBe('global');
  });

  it('takes each source scale from the source, never from the magnitude', () => {
    // The event speaks a fraction, the usage payload a percentage, and the
    // value cannot say which it is on. Sniffing with `u > 1 ? u / 100 : u` is
    // unambiguous for 97 and catastrophic for 1: measured on this deployment,
    // `rate_limits.five_hour` reported `utilization: 1` meaning **one percent**,
    // which the sniffing rule read as a spent window - classifying every
    // model-scoped refusal as global, so the switch would never have fired.
    const fromWindow = (utilization: number) =>
      classifyQuotaRejection({
        model: 'fable',
        rateLimits: [{ status: 'rejected' }],
        windows: [{ key: 'five_hour', label: '', utilization, resetsAt: null }],
      })?.scope;

    expect(fromWindow(1)).toBe('model'); // one percent - room to spare
    expect(fromWindow(97)).toBe('model'); // ninety-seven percent - still serving
    expect(fromWindow(100)).toBe('global'); // spent

    // And the event's own fraction keeps its meaning.
    const fromEvent = (utilization: number) =>
      classifyQuotaRejection({
        model: 'fable',
        rateLimits: [{ status: 'rejected', unifiedWindows: { five_hour: { utilization } } }],
      })?.scope;
    expect(fromEvent(0.01)).toBe('model');
    expect(fromEvent(1)).toBe('global');
  });

  it('guesses model-scoped when it cannot tell, because that is the cheap mistake', () => {
    // Wrongly switching costs three refusals the CLI answers before reaching
    // the API. Wrongly failing costs a run that would have worked.
    const block = classifyQuotaRejection({ model: 'fable', rateLimits: [{ status: 'rejected' }] });
    expect(block?.scope).toBe('model');
    expect(block?.resetsAt).toBeNull();
  });

  it('reads the last refusal, not the first', () => {
    const block = classifyQuotaRejection({
      model: 'fable',
      rateLimits: [FABLE_REFUSED, EVERYTHING_SPENT],
    });
    expect(block?.scope).toBe('global');
  });

  it('never throws on a payload it cannot parse', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { status: 'rejected', unifiedWindows: 7 }]) {
      expect(() => classifyQuotaRejection({ model: 'x', rateLimits: [junk] })).not.toThrow();
    }
  });
});

describe('chooseReplacement', () => {
  const ranked = [
    { model: 'haiku', effort: null },
    { model: 'sonnet', effort: 'low' },
    { model: 'opus', effort: 'high' },
  ];

  it('takes the learner’s best arm that is still available', () => {
    expect(chooseReplacement({ ranked, unavailable: new Set(['haiku']) })).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('carries the arm’s effort, not just its model', () => {
    // An arm is a (model, effort) pair; replacing only the model would run
    // sonnet at whatever effort the refused arm happened to carry.
    expect(chooseReplacement({ ranked, unavailable: new Set(['haiku', 'sonnet']) })).toEqual({
      model: 'opus',
      effort: 'high',
    });
  });

  it('answers null rather than looping when everything is spent', () => {
    expect(
      chooseReplacement({ ranked, unavailable: new Set(['haiku', 'sonnet', 'opus']) }),
    ).toBeNull();
  });
});
